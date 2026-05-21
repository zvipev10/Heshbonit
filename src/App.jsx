import { useState, useEffect, useRef } from 'react'
import { put } from '@vercel/blob/client'
import './App.css'

const API_URL = import.meta.env.VITE_API_URL ?? '/api/invoices/upload'
const API_BASE = import.meta.env.VITE_API_URL?.replace('/upload', '') ?? '/api/invoices'
const GMAIL_API_BASE = import.meta.env.VITE_GMAIL_API_URL ?? '/api/gmail'
const VAT_RATE = 0.18
const BLOB_UPLOAD_MAX_BYTES = 50 * 1024 * 1024
const ALLOWED_UPLOAD_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
const TAB_PENDING = 'pending'
const TAB_APPROVED = 'approved'
const APPROVED_PAGE_SIZE = 50
const EMPTY_LIST_META = {
  page: 1,
  pageSize: APPROVED_PAGE_SIZE,
  totalCount: 0,
  unfilteredCount: 0,
  totals: {
    totalWithoutVat: 0,
    vat: 0,
    totalWithVat: 0,
  },
}

const getUploadContentType = (file) => {
  if (file.type) return file.type

  const lowerName = file.name.toLowerCase()
  if (lowerName.endsWith('.pdf')) return 'application/pdf'
  if (lowerName.endsWith('.png')) return 'image/png'
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg'
  if (lowerName.endsWith('.webp')) return 'image/webp'
  return 'application/octet-stream'
}

function App() {
  const [processing, setProcessing] = useState(false)
  const [result, setResult] = useState([])
  const [error, setError] = useState(null)
  const [duplicateNotice, setDuplicateNotice] = useState(null)
  const [activeTab, setActiveTab] = useState(TAB_PENDING)
  const [selectedRows, setSelectedRows] = useState(new Set())
  const [saving, setSaving] = useState(false)
  const [editingCell, setEditingCell] = useState(null)
  const [gmailSummary, setGmailSummary] = useState(null)
  const [gmailLoading, setGmailLoading] = useState(false)
  const [morningSending, setMorningSending] = useState(false)
  const [dbLoaded, setDbLoaded] = useState(false)
  const [loadingInvoices, setLoadingInvoices] = useState(false)
  const [morningCategories, setMorningCategories] = useState([])
  const [searchDraft, setSearchDraft] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [dateFromDraft, setDateFromDraft] = useState('')
  const [dateToDraft, setDateToDraft] = useState('')
  const [appliedDateFrom, setAppliedDateFrom] = useState('')
  const [appliedDateTo, setAppliedDateTo] = useState('')
  const [filterMenuOpen, setFilterMenuOpen] = useState(false)
  const [activeFilterPanel, setActiveFilterPanel] = useState(null)
  const [approvedPage, setApprovedPage] = useState(1)
  const [listMeta, setListMeta] = useState(EMPTY_LIST_META)
  const uploadInputRef = useRef(null)
  const cameraInputRef = useRef(null)
  const blobUrlsRef = useRef(new Set())
  const invoiceLoadRequestRef = useRef(0)

  const registerBlobUrl = (url) => {
    if (url?.startsWith('blob:')) {
      blobUrlsRef.current.add(url)
    }
    return url
  }

  const revokeBlobUrl = (url) => {
    if (url?.startsWith('blob:')) {
      URL.revokeObjectURL(url)
      blobUrlsRef.current.delete(url)
    }
  }

  const createLocalRowKey = () => {
    return `local:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${Math.random().toString(36).slice(2)}`}`
  }

  const parseDisplayDate = (value) => {
    if (!value || value === '—') return null
    const normalized = value.replace(/[/.]/g, '-').trim()
    const parts = normalized.split('-')
    if (parts.length !== 3) return null
    const [day, month, year] = parts
    const parsed = new Date(Number(year), Number(month) - 1, Number(day))
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }

  const sortResultsByDateDesc = (items) => {
    return [...items].sort((a, b) => {
      if (a.failed) return 1
      if (b.failed) return -1
      const dateA = parseDisplayDate(a.date)
      const dateB = parseDisplayDate(b.date)
      if (!dateA) return 1
      if (!dateB) return -1
      return dateB - dateA
    })
  }

  const normalizeAmount = (value) => {
    if (value === null || value === undefined || value === '') return ''
    const numeric = typeof value === 'number' ? value : parseFloat(value)
    if (Number.isNaN(numeric)) return ''
    return numeric.toFixed(2)
  }

  const roundMoney = (value) => Math.round((value + Number.EPSILON) * 100) / 100

  const getMorningStatus = (row) => {
    if (!row.isStoredRecord) return '—'
    if (row.morningSyncStatus === 'sent' && row.morningFileSyncStatus !== 'failed') return 'עבר למורנינג'
    return 'לא עבר למורנינג'
  }

  const getCategoryLabel = (category) => {
    return category?.name || category?.title || ''
  }

  const isDuplicateResult = (item) => Boolean(item?.duplicate)

  const formatDuplicateMessage = (item) => {
    const existing = item.existingInvoice || {}
    const vendor = existing.vendorName || item.data?.vendorName || '—'
    const date = item.data?.date
      ? new Date(item.data.date).toLocaleDateString('he-IL')
      : (existing.date ? new Date(existing.date).toLocaleDateString('he-IL') : '—')
    const total = normalizeAmount(item.data?.totalWithVat ?? existing.totalWithVat)
    return `${item.filename || item.fileName || 'invoice'} — כבר קיימת חשבונית עבור ${vendor}, ${date}, ₪${total}`
  }

  const buildDuplicateMessage = (duplicates) => {
    if (!duplicates.length) return null
    return `חשבוניות כפולות שלא נוספו לטבלה:\n${duplicates.map(formatDuplicateMessage).join('\n')}`
  }

  const base64ToBlobUrl = (base64, mimeType) => {
    try {
      const binary = atob(base64)
      let resolvedMimeType = mimeType || 'application/octet-stream'
      if (!mimeType || mimeType === 'application/octet-stream') {
        if (binary.startsWith('%PDF-')) {
          resolvedMimeType = 'application/pdf'
        } else if (binary.charCodeAt(0) === 0x89 && binary.slice(1, 4) === 'PNG') {
          resolvedMimeType = 'image/png'
        } else if (binary.charCodeAt(0) === 0xff && binary.charCodeAt(1) === 0xd8 && binary.charCodeAt(2) === 0xff) {
          resolvedMimeType = 'image/jpeg'
        }
      }
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i)
      }
      const blob = new Blob([bytes], { type: resolvedMimeType })
      return registerBlobUrl(URL.createObjectURL(blob))
    } catch (err) {
      console.error('Failed to create blob URL from base64:', err)
      return null
    }
  }

  const mapInvoiceFromDatabase = (inv) => {
    let hebrewDate = '—'
    if (inv.date) {
      try {
        const [year, month, day] = inv.date.split('-')
        hebrewDate = new Date(year, parseInt(month, 10) - 1, day).toLocaleDateString('he-IL')
      } catch {
        hebrewDate = '—'
      }
    }

    return {
      ...inv,
      rowKey: inv.id ? `db:${inv.id}` : createLocalRowKey(),
      failed: false,
      fileUrl: inv.id ? `${API_BASE}/file/${inv.id}` : null,
      supplier: inv.vendorName ?? '—',
      date: hebrewDate,
      payment: inv.totalWithoutVat,
      vat: inv.vat,
      total: inv.totalWithVat,
      originalTotalWithVat: inv.originalTotalWithVat ?? inv.totalWithVat,
      printed: inv.printed || 'לא',
      status: inv.status || TAB_APPROVED,
      fileName: inv.fileName,
      isStoredRecord: true,
      isDirty: false,
      isNewUpload: false,
      source: inv.source || 'database',
      morningCategoryId: inv.morningCategoryId || null,
      morningCategoryName: inv.morningCategoryName || null,
      morningCategoryCode: inv.morningCategoryCode ?? null,
    }
  }

  const loadDataFromDatabase = async (status = activeTab, options = {}) => {
    const requestId = invoiceLoadRequestRef.current + 1
    invoiceLoadRequestRef.current = requestId
    const page = options.page ?? (status === TAB_APPROVED ? approvedPage : 1)
    const search = options.search ?? appliedSearch
    const fromDate = options.fromDate ?? appliedDateFrom
    const toDate = options.toDate ?? appliedDateTo
    const tabLabel = status === TAB_PENDING ? 'חדשות' : 'מאושרות'
    try {
      setError(null)
      setLoadingInvoices(true)
      setResult([])
      const params = new URLSearchParams({ status })
      if (status === TAB_APPROVED) {
        params.set('page', String(page))
        params.set('pageSize', String(APPROVED_PAGE_SIZE))
        if (search) params.set('vendor', search)
        if (fromDate) params.set('fromDate', fromDate)
        if (toDate) params.set('toDate', toDate)
      }
      const response = await fetch(`${API_BASE}/list?${params.toString()}`, { cache: 'no-store' })
      const json = await response.json().catch(() => null)
      if (!response.ok || !json?.success) {
        throw new Error(json?.error || 'Failed to load data from database')
      }
      if (json.success && json.invoices) {
        if (requestId !== invoiceLoadRequestRef.current) return
        const mappedInvoices = json.invoices.map(mapInvoiceFromDatabase)
        setResult(sortResultsByDateDesc(mappedInvoices))
        if (status === TAB_APPROVED) {
          setApprovedPage(json.page || page)
          setListMeta({
            page: json.page || page,
            pageSize: json.pageSize || APPROVED_PAGE_SIZE,
            totalCount: json.totalCount ?? mappedInvoices.length,
            unfilteredCount: json.unfilteredCount ?? json.totalCount ?? mappedInvoices.length,
            totals: json.totals || EMPTY_LIST_META.totals,
          })
        } else {
          setListMeta({
            ...EMPTY_LIST_META,
            totalCount: mappedInvoices.length,
            unfilteredCount: mappedInvoices.length,
          })
        }
      }
    } catch (err) {
      if (requestId !== invoiceLoadRequestRef.current) return
      console.error('Failed to load data from database:', err)
      const message = err instanceof Error ? err.message : String(err)
      setError(
        message === 'Load failed'
          ? `טעינת חשבוניות ${tabLabel} נכשלה. בדוק חיבור ונסה שוב.`
          : message,
      )
    } finally {
      if (requestId === invoiceLoadRequestRef.current) {
        setLoadingInvoices(false)
        setDbLoaded(true)
      }
    }
  }

  useEffect(() => {
    loadDataFromDatabase(TAB_PENDING)
  }, [])

  const openTab = (status) => {
    setActiveTab(status)
    setApprovedPage(1)
    setSelectedRows(new Set())
    setEditingCell(null)
    resetFilters()
    setError(null)
    setDuplicateNotice(null)
    setGmailSummary(null)
    loadDataFromDatabase(status, { page: 1, search: '', fromDate: '', toDate: '' })
  }

  useEffect(() => {
    const loadMorningCategories = async () => {
      try {
        const response = await fetch(`${API_BASE}/morning/accounting-classifications`)
        const json = await response.json()
        if (json.success && Array.isArray(json.options)) {
          setMorningCategories(json.options)
        }
      } catch (err) {
        console.error('Failed to load Morning categories:', err)
      }
    }

    loadMorningCategories()
  }, [])

  useEffect(() => {
    if (!dbLoaded) return

    const params = new URLSearchParams(window.location.search)

    if (params.get('gmail_connected') === '1') {
      window.history.replaceState({}, document.title, window.location.pathname)
      handleGmailSync()
    }
  }, [dbLoaded])

  useEffect(() => {
    const createdBlobUrls = blobUrlsRef.current

    return () => {
      createdBlobUrls.forEach((url) => {
        URL.revokeObjectURL(url)
      })
      createdBlobUrls.clear()
    }
  }, [])

  const processFiles = async (selectedFiles) => {
    if (!selectedFiles.length) return

    setProcessing(true)
    setSelectedRows(new Set())
    setError(null)
    setDuplicateNotice(null)

    const fileUrls = selectedFiles.map(file => registerBlobUrl(URL.createObjectURL(file)))

    try {
      const results = []
      const duplicates = []

      for (const [i, file] of selectedFiles.entries()) {
        try {
          const contentType = getUploadContentType(file)

          if (file.size > BLOB_UPLOAD_MAX_BYTES) {
            throw new Error('הקובץ גדול מדי')
          }

          if (!ALLOWED_UPLOAD_TYPES.has(contentType)) {
            throw new Error('סוג קובץ לא נתמך')
          }

          const tokenResponse = await fetch(`${API_BASE}/blob-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              filename: file.name,
              contentType,
              size: file.size,
            }),
          })
          const tokenJson = await tokenResponse.json().catch(() => null)

          if (!tokenResponse.ok || !tokenJson?.success) {
            throw new Error(tokenJson?.error || 'Failed to prepare file upload')
          }

          const blob = await put(tokenJson.pathname, file, {
            access: 'public',
            token: tokenJson.token,
            contentType,
            multipart: true,
          })

          const processResponse = await fetch(`${API_BASE}/process-blob`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: blob.url,
              filename: file.name,
              mimeType: contentType || blob.contentType || 'application/octet-stream',
            }),
          })
          const processJson = await processResponse.json().catch(() => null)

          if (!processResponse.ok || !processJson?.success) {
            throw new Error(processJson?.error || 'Failed to process uploaded file')
          }

          const r = processJson.result
          if (isDuplicateResult(r)) {
            duplicates.push(r)
            continue
          }

          if (!r?.success) {
            results.push({
              rowKey: createLocalRowKey(),
              failed: true,
              fileName: r?.filename || file.name,
              fileUrl: fileUrls[i] ?? null,
              error: r?.error || 'Failed to process uploaded file',
            })
            continue
          }

          const { vendorName, date, totalWithVat, originalTotalWithVat, totalWithoutVat, morningCategoryId, morningCategoryName, morningCategoryCode } = r.data
          const vat = totalWithVat != null && totalWithoutVat != null ? totalWithVat - totalWithoutVat : null

          results.push({
            rowKey: typeof r.id === 'number' ? `db:${r.id}` : createLocalRowKey(),
            id: typeof r.id === 'number' ? r.id : null,
            failed: false,
            fileName: r.filename,
            fileUrl: typeof r.id === 'number' ? `${API_BASE}/file/${r.id}` : (fileUrls[i] ?? null),
            fileData: r.fileData,
            mimeType: r.mimeType,
            supplier: vendorName ?? '—',
            date: date ? new Date(date).toLocaleDateString('he-IL') : '—',
            payment: totalWithoutVat,
            vat,
            total: totalWithVat,
            originalTotalWithVat: originalTotalWithVat ?? totalWithVat,
            printed: 'לא',
            status: TAB_PENDING,
            morningCategoryId: morningCategoryId || null,
            morningCategoryName: morningCategoryName || null,
            morningCategoryCode: morningCategoryCode ?? null,
            isStoredRecord: typeof r.id === 'number',
            isDirty: typeof r.id !== 'number',
            isNewUpload: typeof r.id === 'number',
            source: 'upload',
          })
        } catch (fileError) {
          results.push({
            rowKey: createLocalRowKey(),
            failed: true,
            fileName: file.name,
            fileUrl: fileUrls[i] ?? null,
            error: fileError instanceof Error ? fileError.message : 'Failed to process uploaded file',
          })
        }
      }

      setResult(prev => sortResultsByDateDesc([...prev, ...results].filter(item => !isDuplicateResult(item))))
      const duplicateMessage = buildDuplicateMessage(duplicates)
      if (duplicateMessage) setDuplicateNotice(duplicateMessage)
    } catch (err) {
      setError(err.message)
    } finally {
      setProcessing(false)
    }
  }

  const handleGmailSync = async () => {
    setGmailLoading(true)
    setError(null)
    setDuplicateNotice(null)

    try {
      const res = await fetch(`${GMAIL_API_BASE}/sync`, { method: 'POST' })
      const json = await res.json().catch(() => null)

      if (res.status === 401 || json?.error === 'Gmail not connected') {
        window.location.href = `${GMAIL_API_BASE}/connect`
        return
      }

      if (!res.ok || !json?.success) {
        throw new Error(json?.error || 'סנכרון Gmail נכשל')
      }

      setGmailSummary({ count: json.total ?? json.results?.length ?? 0 })

      const results = []
      const duplicates = []
      for (const r of json.results) {
        if (!r.success) {
          if (isDuplicateResult(r)) {
            duplicates.push(r)
            continue
          }

          const rowKey = createLocalRowKey()
          const sourceUrl = r.gmailSourceUrl || r.gmailDebug?.selectedLink || null

          if (!sourceUrl) {
            results.push(mapFailedGmailResult(r, rowKey))
            continue
          }

        try {
          const capturedResult = await captureFailedGmailResult(r, rowKey)
          if (isDuplicateResult(capturedResult)) {
            duplicates.push(capturedResult)
          } else {
            results.push(capturedResult)
          }
        } catch (captureError) {
          results.push(mapFailedGmailResult(
            r,
            rowKey,
            captureError.message
          ))
        }
          continue
        }

        const { vendorName, date, totalWithVat, originalTotalWithVat, totalWithoutVat, morningCategoryId, morningCategoryName, morningCategoryCode } = r.data
        const vat = totalWithVat != null && totalWithoutVat != null ? totalWithVat - totalWithoutVat : null
        const fileUrl = typeof r.id === 'number' ? `${API_BASE}/file/${r.id}` : (r.fileData ? base64ToBlobUrl(r.fileData, r.mimeType) : r.gmailSourceUrl || null)

        results.push({
          rowKey: typeof r.id === 'number' ? `db:${r.id}` : createLocalRowKey(),
          id: typeof r.id === 'number' ? r.id : null,
          failed: false,
          fileName: r.filename,
          fileUrl,
          fileData: r.fileData,
          mimeType: r.mimeType,
          gmailResolution: r.gmailResolution,
          gmailSourceUrl: r.gmailSourceUrl,
          supplier: vendorName ?? '—',
          date: date ? new Date(date).toLocaleDateString('he-IL') : '—',
          payment: totalWithoutVat,
          vat,
          total: totalWithVat,
          originalTotalWithVat: originalTotalWithVat ?? totalWithVat,
          printed: 'לא',
          status: TAB_PENDING,
          morningCategoryId: morningCategoryId || null,
          morningCategoryName: morningCategoryName || null,
          morningCategoryCode: morningCategoryCode ?? null,
          isStoredRecord: typeof r.id === 'number',
          isDirty: typeof r.id !== 'number',
          isNewUpload: typeof r.id === 'number',
          source: 'gmail'
        })
      }

      setResult(prev => sortResultsByDateDesc([...prev, ...results].filter(item => !isDuplicateResult(item))))
      const duplicateMessage = buildDuplicateMessage(duplicates)
      if (duplicateMessage) setDuplicateNotice(duplicateMessage)
    } catch (err) {
      setError(err.message)
    } finally {
      setGmailLoading(false)
    }
  }

  const requestExtensionCapture = ({ url, fileName }) => {
    return new Promise((resolve, reject) => {
      const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${Math.random()}`
      const timeout = window.setTimeout(() => {
        window.removeEventListener('message', handleResponse)
        reject(new Error('Heshbonit browser capture extension did not respond'))
      }, 120000)

      function handleResponse(event) {
        if (event.source !== window) return
        if (event.data?.type !== 'HESHBONIT_CAPTURE_RESPONSE') return
        if (event.data?.requestId !== requestId) return

        window.clearTimeout(timeout)
        window.removeEventListener('message', handleResponse)

        const payload = event.data.payload
        if (!payload?.success) {
          const error = new Error(payload?.error || 'Browser capture failed')
          reject(error)
          return
        }

        resolve(payload)
      }

      window.addEventListener('message', handleResponse)
      window.postMessage({
        type: 'HESHBONIT_CAPTURE_REQUEST',
        payload: {
          type: 'CAPTURE_INVOICE_LINK',
          requestId,
          url,
          uploadUrl: new URL(API_URL, window.location.origin).href,
          fileName: fileName || 'captured-invoice.pdf'
        }
      }, '*')
    })
  }

  const mapProcessedGmailResult = (r, rowKey = createLocalRowKey(), fallbackSourceUrl = null) => {
    const { vendorName, date, totalWithVat, originalTotalWithVat, totalWithoutVat, morningCategoryId, morningCategoryName, morningCategoryCode } = r.data
    const vat = totalWithVat != null && totalWithoutVat != null ? totalWithVat - totalWithoutVat : null
    const fileUrl = typeof r.id === 'number' ? `${API_BASE}/file/${r.id}` : (r.fileData ? base64ToBlobUrl(r.fileData, r.mimeType) : (r.gmailSourceUrl || fallbackSourceUrl || null))

    return {
      rowKey: typeof r.id === 'number' ? `db:${r.id}` : rowKey,
      id: typeof r.id === 'number' ? r.id : null,
      failed: false,
      fileName: r.filename,
      fileUrl,
      fileData: r.fileData,
      mimeType: r.mimeType,
      gmailResolution: r.gmailResolution,
      gmailSourceUrl: r.gmailSourceUrl || fallbackSourceUrl,
      supplier: vendorName ?? '—',
      date: date ? new Date(date).toLocaleDateString('he-IL') : '—',
      payment: totalWithoutVat,
      vat,
      total: totalWithVat,
      originalTotalWithVat: originalTotalWithVat ?? totalWithVat,
      printed: 'לא',
      status: TAB_PENDING,
      morningCategoryId: morningCategoryId || null,
      morningCategoryName: morningCategoryName || null,
      morningCategoryCode: morningCategoryCode ?? null,
      isStoredRecord: typeof r.id === 'number',
      isDirty: typeof r.id !== 'number',
      isNewUpload: typeof r.id === 'number',
      source: 'gmail'
    }
  }

  const mapFailedGmailResult = (r, rowKey = createLocalRowKey(), overrideError = null) => ({
    rowKey,
    failed: true,
    fileName: r.filename,
    error: overrideError || r.error,
    source: 'gmail',
    gmailDebug: r.gmailDebug,
    gmailSourceUrl: r.gmailSourceUrl || r.gmailDebug?.selectedLink || null,
  })

  const captureFailedGmailResult = async (r, rowKey = createLocalRowKey()) => {
    const sourceUrl = r.gmailSourceUrl || r.gmailDebug?.selectedLink || null
    if (!sourceUrl) return mapFailedGmailResult(r, rowKey)

    const capture = await requestExtensionCapture({
      url: sourceUrl,
      fileName: r.filename || 'captured-invoice.pdf'
    })
    const processedResult = capture.uploadResult?.results?.[0]

    if (isDuplicateResult(processedResult)) {
      return processedResult
    }

    if (!processedResult?.success) {
      const error = new Error(processedResult?.error || 'Captured file extraction failed')
      throw error
    }

    return mapProcessedGmailResult({
      ...processedResult,
      gmailResolution: 'extension_capture',
      gmailSourceUrl: sourceUrl
    }, rowKey, sourceUrl)
  }

  const handleFileChange = (e) => {
    const selectedFiles = Array.from(e.target.files)
    processFiles(selectedFiles)
    e.target.value = ''
  }

  const openUploadPicker = () => {
    if (!processing) uploadInputRef.current?.click()
  }

  const openCameraPicker = () => {
    if (!processing) cameraInputRef.current?.click()
  }

  const toggleRow = (rowKey) => {
    setSelectedRows(prev => {
      const next = new Set(prev)
      next.has(rowKey) ? next.delete(rowKey) : next.add(rowKey)
      return next
    })
  }

  const resetFilters = () => {
    setSearchDraft('')
    setAppliedSearch('')
    setDateFromDraft('')
    setDateToDraft('')
    setAppliedDateFrom('')
    setAppliedDateTo('')
    setFilterMenuOpen(false)
    setActiveFilterPanel(null)
  }

  const dateToISO = (hebrewDate) => {
    if (!hebrewDate || hebrewDate === '—' || hebrewDate === 'â€”') return null
    const parts = String(hebrewDate).split('.')
    if (parts.length === 3) {
      const day = parts[0].padStart(2, '0')
      const month = parts[1].padStart(2, '0')
      const year = parts[2]
      return `${year}-${month}-${day}`
    }
    return hebrewDate
  }

  const normalizeNumber = (value) => {
    if (value === '' || value === null || value === undefined) return null
    const numeric = typeof value === 'number' ? value : parseFloat(value)
    return Number.isFinite(numeric) ? numeric : null
  }

  const toInvoicePatchFields = (row) => ({
    vendorName: row.supplier === '—' || row.supplier === 'â€”' ? null : row.supplier,
    date: dateToISO(row.date),
    totalWithVat: normalizeNumber(row.total),
    totalWithoutVat: normalizeNumber(row.payment),
    vat: normalizeNumber(row.vat),
    printed: row.printed || 'לא',
    morningCategoryId: row.morningCategoryId || null,
    morningCategoryName: row.morningCategoryName || null,
    morningCategoryCode: row.morningCategoryCode ?? null,
  })

  const buildChangedInvoicePatch = (before, after) => {
    const current = toInvoicePatchFields(before)
    const next = toInvoicePatchFields(after)
    return Object.fromEntries(
      Object.entries(next).filter(([key, value]) => current[key] !== value)
    )
  }

  const patchInvoice = async (id, patch) => {
    const response = await fetch(`${API_BASE}/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const json = await response.json().catch(() => null)
    if (!response.ok || !json?.success) {
      throw new Error(json?.error || 'Failed to update invoice')
    }
  }

  const buildEditedFieldPatch = (row, field) => {
    if (field === 'supplier') {
      return {
        vendorName: row.supplier === '—' || row.supplier === 'â€”' || row.supplier === '' ? null : row.supplier,
      }
    }
    if (field === 'date') {
      return { date: dateToISO(row.date) }
    }
    if (field === 'payment') {
      return { totalWithoutVat: normalizeNumber(row.payment) }
    }
    if (field === 'vat') {
      return { vat: normalizeNumber(row.vat) }
    }
    if (field === 'total') {
      return { totalWithVat: normalizeNumber(row.total) }
    }
    if (field === 'morningCategoryId') {
      return {
        morningCategoryId: row.morningCategoryId || null,
        morningCategoryName: row.morningCategoryName || null,
        morningCategoryCode: row.morningCategoryCode ?? null,
      }
    }
    return {}
  }

  const applyRowUpdates = async (rowKeys, transformRow) => {
    const patches = []
    const totalsDelta = { totalWithoutVat: 0, vat: 0, totalWithVat: 0 }
    const nextResult = result.map((row) => {
      if (!rowKeys.has(row.rowKey) || row.failed) return row
      const updated = { ...transformRow(row), isDirty: false }
      if (activeTab === TAB_APPROVED) {
        totalsDelta.totalWithoutVat += (normalizeNumber(updated.payment) || 0) - (normalizeNumber(row.payment) || 0)
        totalsDelta.vat += (normalizeNumber(updated.vat) || 0) - (normalizeNumber(row.vat) || 0)
        totalsDelta.totalWithVat += (normalizeNumber(updated.total) || 0) - (normalizeNumber(row.total) || 0)
      }
      if (row.isStoredRecord && typeof row.id === 'number') {
        const patch = buildChangedInvoicePatch(row, updated)
        if (Object.keys(patch).length > 0) {
          patches.push({ rowKey: row.rowKey, id: row.id, patch })
        }
      }
      return updated
    })

    if (patches.length === 0) {
      setResult(nextResult)
      if (activeTab === TAB_APPROVED) {
        setListMeta(prev => ({
          ...prev,
          totals: {
            totalWithoutVat: prev.totals.totalWithoutVat + totalsDelta.totalWithoutVat,
            vat: prev.totals.vat + totalsDelta.vat,
            totalWithVat: prev.totals.totalWithVat + totalsDelta.totalWithVat,
          },
        }))
      }
      return
    }

    setSaving(true)
    setError(null)
    setResult(nextResult)
    if (activeTab === TAB_APPROVED) {
      setListMeta(prev => ({
        ...prev,
        totals: {
          totalWithoutVat: prev.totals.totalWithoutVat + totalsDelta.totalWithoutVat,
          vat: prev.totals.vat + totalsDelta.vat,
          totalWithVat: prev.totals.totalWithVat + totalsDelta.totalWithVat,
        },
      }))
    }

    try {
      await Promise.all(patches.map(({ id, patch }) => patchInvoice(id, patch)))
    } catch (err) {
      setError(err.message)
      const failedKeys = new Set(patches.map(({ rowKey }) => rowKey))
      setResult(prev => prev.map(row => failedKeys.has(row.rowKey) ? { ...row, isDirty: true } : row))
      if (activeTab === TAB_APPROVED) {
        setListMeta(prev => ({
          ...prev,
          totals: {
            totalWithoutVat: prev.totals.totalWithoutVat - totalsDelta.totalWithoutVat,
            vat: prev.totals.vat - totalsDelta.vat,
            totalWithVat: prev.totals.totalWithVat - totalsDelta.totalWithVat,
          },
        }))
      }
    } finally {
      setSaving(false)
    }
  }

  const updateRowValueInRow = (row, field, value) => {
    const updated = { ...row }
    if (field === 'supplier') {
      updated.supplier = value === '' ? '—' : value
    } else if (field === 'morningCategoryId') {
      const selected = morningCategories.find(category => category.id === value)
      updated.morningCategoryId = selected?.id || null
      updated.morningCategoryName = selected?.name || selected?.title || null
      updated.morningCategoryCode = selected?.code ?? null
    } else if (field === 'payment' || field === 'vat' || field === 'total') {
      updated[field] = value === '' || value === null ? null : parseFloat(value)
    } else if (field === 'date') {
      updated.date = value
    }
    return updated
  }

  const handleCopyWithoutVat = async (rowKeys = selectedRows) => {
    await applyRowUpdates(rowKeys, (res) => ({ ...res, payment: res.total, vat: 0 }))
  }

  const handleCalculateWithVat = async (rowKeys = selectedRows) => {
    await applyRowUpdates(rowKeys, (res) => {
      const total = typeof res.total === 'number' ? res.total : parseFloat(res.total)
      if (!Number.isFinite(total)) return { ...res }
      const payment = roundMoney(total / (1 + VAT_RATE))
      return { ...res, payment, vat: roundMoney(total - payment) }
    })
  }

  const handleMarkPrinted = async (rowKeys = selectedRows) => {
    await applyRowUpdates(rowKeys, (res) => ({ ...res, printed: 'כן' }))
  }

  const handleApplyFraction = async (fraction, rowKeys = selectedRows) => {
    await applyRowUpdates(rowKeys, (res) => {
      const fractions = { '2/3': 2 / 3, '1/2': 0.5, '1/3': 1 / 3, '1/4': 0.25 }
      const multiplier = fractions[fraction] || 1
      return {
        ...res,
        payment: res.payment != null ? res.payment * multiplier : null,
        vat: res.vat != null ? res.vat * multiplier : null,
        total: res.total != null ? res.total * multiplier : null,
      }
    })
  }

  const handleRestoreOriginalTotal = async (rowKeys = selectedRows) => {
    await applyRowUpdates(rowKeys, (res) => {
      const originalTotal = typeof res.originalTotalWithVat === 'number'
        ? res.originalTotalWithVat
        : parseFloat(res.originalTotalWithVat)
      if (!Number.isFinite(originalTotal)) return { ...res }
      return { ...res, total: originalTotal }
    })
  }

  const handleDeleteSelected = async (rowKeys = selectedRows) => {
    const removed = result.filter(row => rowKeys.has(row.rowKey))
    const kept = result.filter(row => !rowKeys.has(row.rowKey))
    const storedRows = removed.filter(row => row.isStoredRecord && typeof row.id === 'number')

    setSaving(true)
    setError(null)

    try {
      await Promise.all(storedRows.map(async (row) => {
        const response = await fetch(`${API_BASE}/${row.id}`, { method: 'DELETE' })
        const json = await response.json().catch(() => null)
        if (!response.ok || !json?.success) {
          throw new Error(json?.error || 'Failed to delete invoice')
        }
      }))

      removed.forEach(res => {
        if (res.fileUrl && !kept.some(row => row.fileUrl === res.fileUrl)) {
          revokeBlobUrl(res.fileUrl)
        }
      })

      setResult(kept)
      if (activeTab === TAB_APPROVED) {
        const removedTotals = removed.reduce((totals, row) => ({
          totalWithoutVat: totals.totalWithoutVat + (normalizeNumber(row.payment) || 0),
          vat: totals.vat + (normalizeNumber(row.vat) || 0),
          totalWithVat: totals.totalWithVat + (normalizeNumber(row.total) || 0),
        }), { totalWithoutVat: 0, vat: 0, totalWithVat: 0 })
        setListMeta(prev => ({
          ...prev,
          totalCount: Math.max(0, prev.totalCount - removed.length),
          unfilteredCount: Math.max(0, prev.unfilteredCount - removed.length),
          totals: {
            totalWithoutVat: prev.totals.totalWithoutVat - removedTotals.totalWithoutVat,
            vat: prev.totals.vat - removedTotals.vat,
            totalWithVat: prev.totals.totalWithVat - removedTotals.totalWithVat,
          },
        }))
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }

    if (editingCell?.rowKey && rowKeys.has(editingCell.rowKey)) {
      setEditingCell(null)
    }
    setSelectedRows(prev => {
      if (rowKeys === selectedRows) return new Set()
      const next = new Set(prev)
      rowKeys.forEach(rowKey => next.delete(rowKey))
      return next
    })
  }

  const handleSendToMorning = async (rowKeys = selectedRows) => {
    const selectedStoredRows = result.filter(row => rowKeys.has(row.rowKey) && row.isStoredRecord && typeof row.id === 'number' && !row.failed)

    if (selectedStoredRows.length === 0) {
      setError('Select saved database rows before sending to Morning')
      return
    }

    const rowsMissingCategory = selectedStoredRows.filter(row => !row.morningCategoryId)
    if (rowsMissingCategory.length > 0) {
      setError('בחר קטגוריית Morning לכל החשבוניות המסומנות לפני השליחה')
      return
    }

    setMorningSending(true)
    setError(null)

    try {
      const response = await fetch(`${API_BASE}/send-to-morning`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceIds: selectedStoredRows.map(row => row.id) }),
      })
      const json = await response.json()

      if (!response.ok || !json.success) {
        throw new Error(json.error || 'Failed to send invoices to Morning')
      }

      const statuses = new Map(json.results.map(item => [item.invoiceId, item]))
      setResult(prev => prev.map(row => {
        const status = statuses.get(row.id)
        if (!status) return row

        return {
          ...row,
          morningSyncStatus: status.success ? 'sent' : 'failed',
          morningExpenseId: status.morningExpenseId || row.morningExpenseId || null,
          morningSyncError: status.error || null,
          morningFileSyncStatus: status.morningFileSyncStatus || row.morningFileSyncStatus || null,
          morningFileSyncError: status.morningFileSyncError || null,
        }
      }))
      const failedResults = json.results.filter(item => !item.success)
      const fileFailedResults = json.results.filter(item => item.morningFileSyncStatus === 'failed')
      const failureDetails = failedResults.length > 0
        ? `\n${failedResults.slice(0, 3).map(item => `Invoice ${item.invoiceId}: ${item.error}`).join('\n')}`
        : ''
      const fileFailureDetails = fileFailedResults.length > 0
        ? `\nFile upload failed:\n${fileFailedResults.slice(0, 3).map(item => `Invoice ${item.invoiceId}: ${item.morningFileSyncError}`).join('\n')}`
        : ''
      alert(`Morning sync completed: ${json.successCount} sent, ${json.failedCount} failed, ${json.fileFailedCount || 0} file uploads failed${failureDetails}${fileFailureDetails}`)
    } catch (err) {
      setError(err.message)
    } finally {
      setMorningSending(false)
    }
  }

  const handleApproveRows = async (rowKeys = selectedRows) => {
    const rowsToApprove = result.filter(row => rowKeys.has(row.rowKey) && row.status === TAB_PENDING && typeof row.id === 'number' && !row.failed)

    if (rowsToApprove.length === 0) {
      setError('בחר חשבוניות לאישור')
      return
    }

    setError(null)

    try {
      const response = await fetch(`${API_BASE}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceIds: rowsToApprove.map(row => row.id) }),
      })
      const json = await response.json().catch(() => null)

      if (!response.ok || !json?.success) {
        throw new Error(json?.error || 'אישור החשבוניות נכשל')
      }

      setResult(prev => prev.filter(row => !rowsToApprove.some(approved => approved.rowKey === row.rowKey)))
      setSelectedRows(prev => {
        const next = new Set(prev)
        rowsToApprove.forEach(row => next.delete(row.rowKey))
        return next
      })
    } catch (err) {
      setError(err.message)
    }
  }

  const updateRowValue = (index, field, value) => {
    setResult(prev => {
      const updated = [...prev]
      updated[index] = { ...updateRowValueInRow(updated[index], field, value), isDirty: true }
      return updated
    })
  }

  const persistEditedValue = async (rowIndex, field, value) => {
    const row = result[rowIndex]
    if (!row) return
    const updatedRow = { ...updateRowValueInRow(row, field, value), isDirty: false }
    const patch = buildEditedFieldPatch(updatedRow, field)
    const totalsDelta = {
      totalWithoutVat: (normalizeNumber(updatedRow.payment) || 0) - (normalizeNumber(row.payment) || 0),
      vat: (normalizeNumber(updatedRow.vat) || 0) - (normalizeNumber(row.vat) || 0),
      totalWithVat: (normalizeNumber(updatedRow.total) || 0) - (normalizeNumber(row.total) || 0),
    }

    setResult(prev => prev.map(item => item.rowKey === row.rowKey ? updatedRow : item))
    if (activeTab === TAB_APPROVED) {
      setListMeta(prev => ({
        ...prev,
        totals: {
          totalWithoutVat: prev.totals.totalWithoutVat + totalsDelta.totalWithoutVat,
          vat: prev.totals.vat + totalsDelta.vat,
          totalWithVat: prev.totals.totalWithVat + totalsDelta.totalWithVat,
        },
      }))
    }

    if (!row.isStoredRecord || typeof row.id !== 'number' || Object.keys(patch).length === 0) return

    setSaving(true)
    setError(null)
    try {
      await patchInvoice(row.id, patch)
    } catch (err) {
      setError(err.message)
      setResult(prev => prev.map(item => item.rowKey === row.rowKey ? { ...item, isDirty: true } : item))
      if (activeTab === TAB_APPROVED) {
        setListMeta(prev => ({
          ...prev,
          totals: {
            totalWithoutVat: prev.totals.totalWithoutVat - totalsDelta.totalWithoutVat,
            vat: prev.totals.vat - totalsDelta.vat,
            totalWithVat: prev.totals.totalWithVat - totalsDelta.totalWithVat,
          },
        }))
      }
    } finally {
      setSaving(false)
    }
  }

  const getRowClassName = (row) => {
    const classes = []
    if (selectedRows.has(row.rowKey)) classes.push('row-selected')
    if (row.isDirty) classes.push('row-dirty')
    if (row.isNewUpload) classes.push('row-new-upload')
    return classes.join(' ')
  }

  const renderEditableCell = (rowIndex, field, displayValue, inputType = 'text') => {
    const row = result[rowIndex]
    const isEditing = editingCell?.rowKey === row?.rowKey && editingCell?.field === field
    if (isEditing) {
      const inputValue = field === 'supplier' && row[field] === '—'
        ? ''
        : (row[field] ?? '')

      return (
        <input
          autoFocus
          type={inputType}
          value={inputValue}
          onChange={(e) => updateRowValue(rowIndex, field, e.target.value)}
          onBlur={(e) => {
            setEditingCell(null)
            persistEditedValue(rowIndex, field, e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setEditingCell(null)
              persistEditedValue(rowIndex, field, e.currentTarget.value)
            }
            if (e.key === 'Escape') setEditingCell(null)
          }}
          className="cell-input"
          placeholder={inputType === 'number' ? '0.00' : ''}
          step={inputType === 'number' ? '0.01' : undefined}
        />
      )
    }

    return (
      <span onClick={() => setEditingCell({ rowKey: row.rowKey, field })} className="editable-cell" title="לחץ לעריכה">
        {displayValue}
      </span>
    )
  }

  const renderCategorySelect = (rowIndex) => {
    const row = result[rowIndex]
    const isEditing = editingCell?.rowKey === row?.rowKey && editingCell?.field === 'morningCategoryId'
    const hasCategoryOutsideList = row.morningCategoryId && !morningCategories.some(category => category.id === row.morningCategoryId)
    const fallbackCategoryLabel = row.morningCategoryName || ''

    if (!isEditing) {
      return (
        <span
          onClick={() => setEditingCell({ rowKey: row.rowKey, field: 'morningCategoryId' })}
          className="editable-cell category-display-cell"
          title="לחץ לעריכה"
        >
          {row.morningCategoryName || '—'}
        </span>
      )
    }

    return (
      <select
          autoFocus
          value={row.morningCategoryId || ''}
          onChange={(e) => {
            updateRowValue(rowIndex, 'morningCategoryId', e.target.value)
            setEditingCell(null)
            persistEditedValue(rowIndex, 'morningCategoryId', e.target.value)
          }}
          onBlur={() => setEditingCell(null)}
          className="category-select"
        >
          {!row.morningCategoryId && <option value="" disabled hidden />}
          {hasCategoryOutsideList && fallbackCategoryLabel && (
            <option value={row.morningCategoryId}>{fallbackCategoryLabel}</option>
          )}
          {morningCategories
            .filter(category => getCategoryLabel(category))
            .map(category => (
              <option key={category.id} value={category.id}>
                {getCategoryLabel(category)}
              </option>
            ))}
        </select>
    )
  }

  const renderBulkActions = () => (
    <div className="bulk-actions" role="toolbar" aria-label="פעולות על פריטים שנבחרו">
      <button
        type="button"
        onClick={() => setSelectedRows(new Set())}
        className="bulk-action-dismiss"
        disabled={saving}
        aria-label="נקה בחירה"
        title="נקה בחירה"
      >
        ×
      </button>
      <span className="bulk-actions-info">בחרת {selectedRows.size} פריטים</span>
      <button type="button" onClick={() => handleCopyWithoutVat()} className="app-button app-button-outline bulk-action-button bulk-action-without-vat" disabled={saving}>ללא מע"מ</button>
      <button type="button" onClick={() => handleCalculateWithVat()} className="app-button app-button-outline bulk-action-button" disabled={saving}>עם מע"מ</button>
      <div className="bulk-action-dropdown-wrapper">
        <select onChange={(e) => {
          if (e.target.value) handleApplyFraction(e.target.value)
          e.target.value = ''
        }} defaultValue="" className="app-button app-button-outline bulk-action-dropdown" disabled={saving}>
          <option value="">סכום חלקי</option>
          <option value="2/3">2/3</option>
          <option value="1/2">1/2</option>
          <option value="1/3">1/3</option>
          <option value="1/4">1/4</option>
        </select>
      </div>
      <button type="button" onClick={() => handleMarkPrinted()} className="app-button app-button-outline bulk-action-button" disabled={saving}>מודפס</button>
      <button type="button" onClick={() => handleRestoreOriginalTotal()} className="app-button app-button-outline bulk-action-button" disabled={saving}>שחזר סכום</button>
      {activeTab === TAB_PENDING && (
        <button type="button" onClick={() => handleApproveRows()} className="app-button app-button-success bulk-action-button bulk-action-approve" disabled={saving}>אשר</button>
      )}
      <button type="button" onClick={() => handleSendToMorning()} className="app-button app-button-integration bulk-action-button bulk-action-morning" disabled={selectedStoredRowsCount === 0 || morningSending || saving}>
        {morningSending ? 'Sending...' : 'Send to Morning'}
      </button>
      <button type="button" onClick={() => handleDeleteSelected()} className="app-button app-button-danger bulk-action-button bulk-action-delete" disabled={saving}>מחק</button>
    </div>
  )

  const getResultIndexByRowKey = (rowKey) => result.findIndex(row => row.rowKey === rowKey)

  const parseFilterDate = (value) => {
    if (!value) return null
    const parsed = new Date(`${value}T00:00:00`)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }

  const applySearchFilter = (event) => {
    event?.preventDefault()
    const nextSearch = searchDraft.trim().toLowerCase()
    setAppliedSearch(nextSearch)
    setAppliedDateFrom('')
    setAppliedDateTo('')
    setDateFromDraft('')
    setDateToDraft('')
    setActiveFilterPanel(null)
    setFilterMenuOpen(false)
    setSelectedRows(new Set())
    if (activeTab === TAB_APPROVED) {
      setApprovedPage(1)
      loadDataFromDatabase(TAB_APPROVED, { page: 1, search: nextSearch, fromDate: '', toDate: '' })
    }
  }

  const applyDateFilter = (event) => {
    event?.preventDefault()
    setAppliedSearch('')
    setSearchDraft('')
    setAppliedDateFrom(dateFromDraft)
    setAppliedDateTo(dateToDraft)
    setActiveFilterPanel(null)
    setFilterMenuOpen(false)
    setSelectedRows(new Set())
    if (activeTab === TAB_APPROVED) {
      setApprovedPage(1)
      loadDataFromDatabase(TAB_APPROVED, { page: 1, search: '', fromDate: dateFromDraft, toDate: dateToDraft })
    }
  }

  const clearFilters = () => {
    resetFilters()
    setSelectedRows(new Set())
    if (activeTab === TAB_APPROVED) {
      setApprovedPage(1)
      loadDataFromDatabase(TAB_APPROVED, { page: 1, search: '', fromDate: '', toDate: '' })
    }
  }

  const openFilterPanel = (panel) => {
    setActiveFilterPanel(panel)
    setFilterMenuOpen(false)
  }

  const renderMobileInvoiceCard = (res, displayIndex) => {
    const rowIndex = getResultIndexByRowKey(res.rowKey)

    if (res.failed) {
      return (
        <article key={res.rowKey} className="invoice-card invoice-card-failed">
          <div className="invoice-card-topline">
            <span>#{displayIndex + 1}</span>
            <input type="checkbox" checked={selectedRows.has(res.rowKey)} onChange={() => toggleRow(res.rowKey)} />
          </div>
          <p className="invoice-card-error">{res.fileName} — {res.error}</p>
        </article>
      )
    }

    return (
      <article key={res.rowKey} className={`invoice-card ${getRowClassName(res)}`}>
        <div className="invoice-card-topline">
          <div className="invoice-card-controls">
            <input type="checkbox" checked={selectedRows.has(res.rowKey)} onChange={() => toggleRow(res.rowKey)} />
            <span className="invoice-card-number">#{displayIndex + 1}</span>
            {res.fileUrl && (
              <a
                href={res.fileUrl}
                target="_blank"
                rel="noreferrer"
                className="file-link"
                title={`פתח את ${res.fileName}`}
                aria-label={`פתח את ${res.fileName}`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 5h5v5" />
                  <path d="M10 14L19 5" />
                  <path d="M19 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1.5 1.5 0 0 1 1-1h4" />
                </svg>
              </a>
            )}
          </div>

          <div className="invoice-card-title">
            <strong>{renderEditableCell(rowIndex, 'supplier', res.supplier === '—' ? '—' : res.supplier)}</strong>
          </div>
        </div>
        <div className="invoice-card-meta">
          <span className="invoice-card-value">{renderEditableCell(rowIndex, 'date', res.date)}</span>
          <div className="invoice-card-category">
            {renderCategorySelect(rowIndex)}
          </div>
          <span className={`morning-table-status ${getMorningStatus(res) === 'עבר למורנינג' ? 'morning-table-status-pass' : 'morning-table-status-fail'}`}>
            {getMorningStatus(res)}
          </span>
        </div>

        <div className="invoice-card-amounts">
          <div>
            <span>סה"כ</span>
            <strong className="invoice-card-value">{renderEditableCell(rowIndex, 'total', res.total != null ? `₪${res.total.toFixed(2)}` : '—', 'number')}</strong>
          </div>
          <div>
            <span>מע"מ</span>
            <strong className="invoice-card-value">{renderEditableCell(rowIndex, 'vat', res.vat != null ? `₪${res.vat.toFixed(2)}` : '—', 'number')}</strong>
          </div>
          <div>
            <span>לפני מע"מ</span>
            <strong className="invoice-card-value">{renderEditableCell(rowIndex, 'payment', res.payment != null ? `₪${res.payment.toFixed(2)}` : '—', 'number')}</strong>
          </div>
        </div>
      </article>
    )
  }

  const visibleResults = result.filter(r => !isDuplicateResult(r))
  const filteredResults = visibleResults.filter((row) => {
    if (appliedSearch) {
      const supplier = String(row.supplier || '').toLowerCase()
      if (!supplier.includes(appliedSearch)) return false
    }

    const fromDate = parseFilterDate(appliedDateFrom)
    const toDate = parseFilterDate(appliedDateTo)
    if (fromDate || toDate) {
      const rowDate = parseDisplayDate(row.date)
      if (!rowDate) return false
      if (fromDate && rowDate < fromDate) return false
      if (toDate && rowDate > toDate) return false
    }

    return true
  })
  const successResults = filteredResults.filter(r => !r.failed)
  const isApprovedTab = activeTab === TAB_APPROVED
  const listTotalCount = isApprovedTab ? listMeta.totalCount : filteredResults.length
  const unfilteredTotalCount = isApprovedTab ? listMeta.unfilteredCount : visibleResults.length
  const totalPages = isApprovedTab ? Math.max(1, Math.ceil((listMeta.totalCount || 0) / (listMeta.pageSize || APPROVED_PAGE_SIZE))) : 1
  const pageRowOffset = isApprovedTab ? ((listMeta.page || 1) - 1) * (listMeta.pageSize || APPROVED_PAGE_SIZE) : 0
  const summaryTotals = isApprovedTab
    ? listMeta.totals
    : {
        totalWithoutVat: successResults.reduce((sum, res) => sum + (res.payment ?? 0), 0),
        vat: successResults.reduce((sum, res) => sum + (res.vat ?? 0), 0),
        totalWithVat: successResults.reduce((sum, res) => sum + (res.total ?? 0), 0),
      }
  const hasSelectedRows = selectedRows.size > 0
  const selectedStoredRowsCount = visibleResults.filter(row => selectedRows.has(row.rowKey) && row.isStoredRecord && typeof row.id === 'number' && !row.failed).length
  const allSelected = filteredResults.length > 0 && filteredResults.every(row => selectedRows.has(row.rowKey))
  const hasActiveFilters = Boolean(appliedSearch || appliedDateFrom || appliedDateTo)
  const activeFilterText = appliedSearch
    ? `ספק מכיל: ${appliedSearch}`
    : [appliedDateFrom && `מתאריך ${appliedDateFrom}`, appliedDateTo && `עד ${appliedDateTo}`].filter(Boolean).join(' · ')
  const toggleAll = () => {
    setSelectedRows(allSelected ? new Set() : new Set(filteredResults.map(row => row.rowKey)))
  }
  const goToApprovedPage = (page) => {
    const nextPage = Math.max(1, Math.min(page, totalPages))
    setSelectedRows(new Set())
    setApprovedPage(nextPage)
    loadDataFromDatabase(TAB_APPROVED, {
      page: nextPage,
      search: appliedSearch,
      fromDate: appliedDateFrom,
      toDate: appliedDateTo,
    })
  }

  return (
    <div className="container">
      <header className="page-header">
        <div className="header-copy">
          <h1>דוח חשבוניות חכם</h1>
          <p className="header-subtitle">העלה תמונה או PDF של חשבונית או סנכרן Gmail כדי לטעון חשבוניות מתויגות</p>
        </div>
        <div className="header-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3.75h6l4.25 4.25V19.5A1.5 1.5 0 0 1 16.75 21h-8.5a1.5 1.5 0 0 1-1.5-1.5v-14A1.5 1.5 0 0 1 8.25 4h-.25Z" />
            <path d="M14 3.75V8h4.25" />
            <path d="M9.5 12h5" />
            <path d="M9.5 15.5h5" />
          </svg>
        </div>
      </header>

      <div className="invoice-tabs">
        <button
          type="button"
          className={`invoice-tab ${activeTab === TAB_PENDING ? 'invoice-tab-active' : ''}`}
          onClick={() => openTab(TAB_PENDING)}
        >
          חשבוניות חדשות
        </button>
        <button
          type="button"
          className={`invoice-tab ${activeTab === TAB_APPROVED ? 'invoice-tab-active' : ''}`}
          onClick={() => openTab(TAB_APPROVED)}
        >
          חשבוניות מאושרות
        </button>
      </div>

      {activeTab === TAB_PENDING && (
        <section className="upload-section">
          <input ref={uploadInputRef} type="file" onChange={handleFileChange} accept="image/*,.pdf" multiple id="upload-input" />
          <input ref={cameraInputRef} type="file" onChange={handleFileChange} accept="image/*" capture="environment" id="camera-input" />

          <div className="upload-panel-copy">
            <p className="upload-panel-text">העלה תמונה או PDF של חשבונית או סנכרן Gmail כדי לטעון חשבוניות מתויגות</p>
          </div>

          <div className="upload-actions upload-actions-primary">
            <button type="button" onClick={openUploadPicker} className="app-button app-button-primary upload-button" disabled={processing}>
              {processing ? 'מעבד...' : 'העלה קבצים / תמונות'}
            </button>
            <button type="button" onClick={openCameraPicker} className="app-button app-button-primary upload-button" disabled={processing}>
              צלם חשבונית
            </button>
            <button type="button" onClick={handleGmailSync} className="app-button app-button-primary upload-button" disabled={gmailLoading}>
              {gmailLoading ? 'מסנכרן...' : 'סנכרן Gmail'}
            </button>
          </div>

          {duplicateNotice && (
            <div className="duplicate-notice">
              <p>{duplicateNotice}</p>
            </div>
          )}
        </section>
      )}

      {processing && (
        <div className="processing">
          <div className="spinner"></div>
          <p>מנתח חשבונית...</p>
        </div>
      )}

      {gmailLoading && (
        <div className="processing">
          <div className="spinner"></div>
          <p>מסנכרן Gmail...</p>
        </div>
      )}

      {error && (
        <div className="error-banner">
          <p>{error}</p>
        </div>
      )}

      {loadingInvoices && (
        <section className="results results-loading">
          <div className="invoice-loading">טוען...</div>
        </section>
      )}

      {!loadingInvoices && visibleResults.length > 0 && (
        <section className="results">
          <div className="results-header">
            <div className="results-title-row">
              <h2>דוח חשבוניות ({listTotalCount})</h2>
              {hasActiveFilters && (
                <span className="filter-count">מתוך {unfilteredTotalCount}</span>
              )}
              {hasActiveFilters && (
                <span className="active-filter-chip">
                  {activeFilterText}
                  <button type="button" onClick={clearFilters} aria-label="נקה סינון">×</button>
                </span>
              )}
            </div>
            <div className="filter-menu-wrapper">
              <button
                type="button"
                className={`filter-icon-button ${filterMenuOpen || activeFilterPanel ? 'filter-icon-button-active' : ''}`}
                onClick={() => {
                  setFilterMenuOpen(prev => !prev)
                  setActiveFilterPanel(null)
                }}
                aria-label="סינון"
                title="סינון"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 5h16" />
                  <path d="M7 12h10" />
                  <path d="M10 19h4" />
                </svg>
              </button>

              {filterMenuOpen && (
                <div className="filter-menu" role="menu">
                  <button type="button" onClick={() => openFilterPanel('search')}>ספק</button>
                  <button type="button" onClick={() => openFilterPanel('dates')}>תאריכים</button>
                </div>
              )}
            </div>
          </div>

          {activeFilterPanel === 'search' && (
            <form className="filter-group filter-search" onSubmit={applySearchFilter}>
              <input
                id="invoice-search"
                type="search"
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder="חפש לפי ספק"
              />
              <button type="submit" className="app-button app-button-outline filter-button">סנן</button>
            </form>
          )}

          {activeFilterPanel === 'dates' && (
            <form className="filter-group filter-dates" onSubmit={applyDateFilter}>
              <label>
                <span>מתאריך</span>
                <input
                  type="date"
                  value={dateFromDraft}
                  onChange={(event) => setDateFromDraft(event.target.value)}
                />
              </label>
              <label>
                <span>עד תאריך</span>
                <input
                  type="date"
                  value={dateToDraft}
                  onChange={(event) => setDateToDraft(event.target.value)}
                />
              </label>
              <button type="submit" className="app-button app-button-outline filter-button">סנן</button>
            </form>
          )}

          {gmailSummary && (
            <div className="gmail-summary">
              נטענו {gmailSummary.count} חשבוניות מ-Gmail
            </div>
          )}

          {activeTab === TAB_APPROVED && (
            <div className="summary-cards">
              <div className="summary-card summary-card-before-vat">
                <span className="summary-label">לפני מע"מ</span>
                <strong>₪{(summaryTotals.totalWithoutVat || 0).toFixed(2)}</strong>
              </div>
              <div className="summary-card summary-card-vat">
                <span className="summary-label">מע"מ</span>
                <strong>₪{(summaryTotals.vat || 0).toFixed(2)}</strong>
              </div>
              <div className="summary-card summary-card-total">
                <span className="summary-label">סה"כ</span>
                <strong>₪{(summaryTotals.totalWithVat || 0).toFixed(2)}</strong>
              </div>
            </div>
          )}

          <div className="table-scroll">
            {filteredResults.length === 0 ? (
              <div className="empty-filter-results">לא נמצאו חשבוניות מתאימות לסינון</div>
            ) : (
              <table className="results-table">
                <thead>
                  <tr>
                    <th><input type="checkbox" checked={allSelected} onChange={toggleAll} /></th>
                    <th>#</th>
                    <th>תאריך</th>
                    <th>ספק</th>
                    <th>קטגוריה</th>
                    <th>לפני מע"מ</th>
                    <th>מע"מ</th>
                    <th>סה"כ</th>
                    <th>מודפס</th>
                    <th>מורנינג</th>
                    <th>קובץ</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredResults.map((res, i) => {
                    const rowIndex = getResultIndexByRowKey(res.rowKey)
                    return res.failed ? (
                      <tr key={res.rowKey} className="row-failed">
                        <td><input type="checkbox" checked={selectedRows.has(res.rowKey)} onChange={() => toggleRow(res.rowKey)} /></td>
                        <td>{pageRowOffset + i + 1}</td>
                        <td colSpan={6} className="failed-cell">{res.fileName} — {res.error}</td>
                        <td></td>
                        <td></td>
                        <td></td>
                      </tr>
                    ) : (
                      <tr
                        key={res.rowKey}
                        className={getRowClassName(res)}
                      >
                        <td><input type="checkbox" checked={selectedRows.has(res.rowKey)} onChange={() => toggleRow(res.rowKey)} /></td>
                        <td>{pageRowOffset + i + 1}</td>
                        <td>{renderEditableCell(rowIndex, 'date', res.date)}</td>
                        <td>
                          <div className="supplier-cell">
                            <div className="supplier-line">
                              {renderEditableCell(rowIndex, 'supplier', res.supplier === '—' ? '—' : res.supplier)}
                              {res.source === 'gmail' && <span className="gmail-source-badge">Gmail</span>}
                            </div>
                          </div>
                        </td>
                        <td>{renderCategorySelect(rowIndex)}</td>
                        <td>{renderEditableCell(rowIndex, 'payment', res.payment != null ? `₪${res.payment.toFixed(2)}` : '—', 'number')}</td>
                        <td>{renderEditableCell(rowIndex, 'vat', res.vat != null ? `₪${res.vat.toFixed(2)}` : '—', 'number')}</td>
                        <td>{renderEditableCell(rowIndex, 'total', res.total != null ? `₪${res.total.toFixed(2)}` : '—', 'number')}</td>
                        <td>{res.printed || 'לא'}</td>
                        <td>
                          <span className={`morning-table-status ${getMorningStatus(res) === 'עבר למורנינג' ? 'morning-table-status-pass' : 'morning-table-status-fail'}`}>
                            {getMorningStatus(res)}
                          </span>
                        </td>
                        <td>
                          <div className="row-actions">
                            {res.fileUrl && (
                              <a
                                href={res.fileUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="file-link"
                                title={`פתח את ${res.fileName}`}
                                aria-label={`פתח את ${res.fileName}`}
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M14 5h5v5" />
                                  <path d="M10 14L19 5" />
                                  <path d="M19 14v4a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1V6a1.5 1.5 0 0 1 1-1h4" />
                                </svg>
                              </a>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>

          {filteredResults.length > 0 && (
            <div className="invoice-card-list">
              {filteredResults.map((row, index) => renderMobileInvoiceCard(row, pageRowOffset + index))}
            </div>
          )}

          {isApprovedTab && totalPages > 1 && (
            <nav className="pagination-bar" aria-label="עמודי חשבוניות">
              <button
                type="button"
                className="app-button app-button-outline pagination-button"
                onClick={() => goToApprovedPage((listMeta.page || 1) - 1)}
                disabled={(listMeta.page || 1) <= 1 || loadingInvoices}
              >
                הקודם</button>
              <span className="pagination-status">
                עמוד {listMeta.page || 1} מתוך {totalPages}</span>
              <button
                type="button"
                className="app-button app-button-outline pagination-button"
                onClick={() => goToApprovedPage((listMeta.page || 1) + 1)}
                disabled={(listMeta.page || 1) >= totalPages || loadingInvoices}
              >
                הבא</button>
            </nav>
          )}
        </section>
      )}

      {hasSelectedRows && renderBulkActions()}
    </div>
  )
}

export default App

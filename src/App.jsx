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
  const [openRowMenuKey, setOpenRowMenuKey] = useState(null)
  const [openFractionMenuKey, setOpenFractionMenuKey] = useState(null)
  const [gmailSummary, setGmailSummary] = useState(null)
  const [gmailLoading, setGmailLoading] = useState(false)
  const [morningSending, setMorningSending] = useState(false)
  const [dbLoaded, setDbLoaded] = useState(false)
  const [morningCategories, setMorningCategories] = useState([])
  const uploadInputRef = useRef(null)
  const cameraInputRef = useRef(null)
  const blobUrlsRef = useRef(new Set())

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

  const sortResultsByDateAsc = (items) => {
    return [...items].sort((a, b) => {
      if (a.failed) return 1
      if (b.failed) return -1
      const dateA = parseDisplayDate(a.date)
      const dateB = parseDisplayDate(b.date)
      if (!dateA) return 1
      if (!dateB) return -1
      return dateA - dateB
    })
  }

  const normalizeAmount = (value) => {
    if (value === null || value === undefined || value === '') return ''
    const numeric = typeof value === 'number' ? value : parseFloat(value)
    if (Number.isNaN(numeric)) return ''
    return numeric.toFixed(2)
  }

  const roundMoney = (value) => Math.round((value + Number.EPSILON) * 100) / 100

  const displayDateToISO = (value) => {
    if (!value || value === '—') return ''
    const parsed = parseDisplayDate(value)
    if (!parsed) return ''
    const year = parsed.getFullYear()
    const month = String(parsed.getMonth() + 1).padStart(2, '0')
    const day = String(parsed.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  const getMorningStatus = (row) => {
    if (!row.isStoredRecord) return '—'
    if (row.morningSyncStatus === 'sent' && row.morningFileSyncStatus !== 'failed') return 'עבר'
    return 'לא עבר'
  }

  const getCategoryLabel = (category) => {
    return category?.name || category?.title || ''
  }

  const buildDuplicateKey = (invoice) => {
    const dateKey = displayDateToISO(invoice.date)
    const totalKey = normalizeAmount(invoice.total)
    if (!dateKey || !totalKey) return null
    return `${dateKey}|${totalKey}`
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

  const loadDataFromDatabase = async (status = activeTab) => {
    const tabLabel = status === TAB_PENDING ? 'חדשות' : 'מאושרות'
    try {
      setError(null)
      const response = await fetch(`${API_BASE}/list?status=${encodeURIComponent(status)}`, { cache: 'no-store' })
      const json = await response.json().catch(() => null)
      if (!response.ok || !json?.success) {
        throw new Error(json?.error || 'Failed to load data from database')
      }
      if (json.success && json.invoices) {
        const mappedInvoices = json.invoices.map(mapInvoiceFromDatabase)
        setResult(sortResultsByDateAsc(mappedInvoices))
      }
    } catch (err) {
      console.error('Failed to load data from database:', err)
      const message = err instanceof Error ? err.message : String(err)
      setError(
        message === 'Load failed'
          ? `טעינת חשבוניות ${tabLabel} נכשלה. בדוק חיבור ונסה שוב.`
          : message,
      )
    } finally {
      setDbLoaded(true)
    }
  }

  useEffect(() => {
    loadDataFromDatabase(TAB_PENDING)
  }, [])

  const openTab = (status) => {
    setActiveTab(status)
    setSelectedRows(new Set())
    setEditingCell(null)
    closeRowMenu()
    setError(null)
    setDuplicateNotice(null)
    setGmailSummary(null)
    loadDataFromDatabase(status)
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

  useEffect(() => {
    if (!openRowMenuKey) return

    const handlePointerDown = (event) => {
      if (event.target?.closest?.('.row-menu-wrapper')) return
      closeRowMenu()
    }

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closeRowMenu()
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [openRowMenuKey])

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

          const { vendorName, date, totalWithVat, originalTotalWithVat, totalWithoutVat, confidence, morningCategoryId, morningCategoryName, morningCategoryCode } = r.data
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
            confidence,
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

      setResult(prev => sortResultsByDateAsc([...prev, ...results].filter(item => !isDuplicateResult(item))))
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

        const { vendorName, date, totalWithVat, originalTotalWithVat, totalWithoutVat, confidence, morningCategoryId, morningCategoryName, morningCategoryCode } = r.data
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
          confidence,
          morningCategoryId: morningCategoryId || null,
          morningCategoryName: morningCategoryName || null,
          morningCategoryCode: morningCategoryCode ?? null,
          isStoredRecord: typeof r.id === 'number',
          isDirty: typeof r.id !== 'number',
          isNewUpload: typeof r.id === 'number',
          source: 'gmail'
        })
      }

      setResult(prev => sortResultsByDateAsc([...prev, ...results].filter(item => !isDuplicateResult(item))))
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
    const { vendorName, date, totalWithVat, originalTotalWithVat, totalWithoutVat, confidence, morningCategoryId, morningCategoryName, morningCategoryCode } = r.data
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
      confidence,
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

  const allSelected = result.length > 0 && result.every(row => selectedRows.has(row.rowKey))
  const toggleAll = () => {
    setSelectedRows(allSelected ? new Set() : new Set(result.map(row => row.rowKey)))
  }

  const closeRowMenu = () => {
    setOpenRowMenuKey(null)
    setOpenFractionMenuKey(null)
  }

  const rowKeySet = (rowKey) => new Set([rowKey])

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

  const applyRowUpdates = async (rowKeys, transformRow) => {
    const patches = []
    const nextResult = result.map((row) => {
      if (!rowKeys.has(row.rowKey) || row.failed) return row
      const updated = { ...transformRow(row), isDirty: false }
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
      return
    }

    setSaving(true)
    setError(null)
    setResult(nextResult)

    try {
      await Promise.all(patches.map(({ id, patch }) => patchInvoice(id, patch)))
    } catch (err) {
      setError(err.message)
      const failedKeys = new Set(patches.map(({ rowKey }) => rowKey))
      setResult(prev => prev.map(row => failedKeys.has(row.rowKey) ? { ...row, isDirty: true } : row))
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
    closeRowMenu()
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
      closeRowMenu()
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
      closeRowMenu()
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
    await applyRowUpdates(rowKeySet(row.rowKey), (currentRow) => {
      const sourceRow = currentRow.rowKey === row.rowKey ? currentRow : row
      return updateRowValueInRow(sourceRow, field, value)
    })
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

  const handleSaveToDatabase = async () => {
    setSaving(true)
    setError(null)
    setDuplicateNotice(null)

    try {
      const duplicateGroups = new Map()

      result.forEach((res, index) => {
        if (res.failed) return
        const key = buildDuplicateKey(res)
        if (!key) return
        if (!duplicateGroups.has(key)) duplicateGroups.set(key, [])
        duplicateGroups.get(key).push({
          index,
          rowNumber: index + 1,
          fileName: res.fileName,
          isStoredRecord: !!res.isStoredRecord,
          supplier: res.supplier,
          date: res.date,
          total: res.total,
        })
      })

      const duplicateEntries = Array.from(duplicateGroups.values()).filter(
        (group) => group.length > 1 && group.some((item) => item.isStoredRecord) && group.some((item) => !item.isStoredRecord)
      )

      if (duplicateEntries.length > 0) {
        const duplicateRows = duplicateEntries.flatMap((group) => group.filter((item) => !item.isStoredRecord)).sort((a, b) => a.rowNumber - b.rowNumber)
        const duplicateSummary = duplicateRows
          .map((item) => `שורה ${item.rowNumber}: ${item.fileName} | ${item.date} | ₪${normalizeAmount(item.total)}`)
          .join('\n')
        throw new Error(`נמצאו ${duplicateRows.length} חשבוניות כפולות שכבר קיימות בבסיס הנתונים:\n${duplicateSummary}`)
      }

      const dateToISO = (hebrewDate) => {
        if (!hebrewDate || hebrewDate === '—') return null
        const parts = hebrewDate.split('.')
        if (parts.length === 3) {
          const day = parts[0].padStart(2, '0')
          const month = parts[1].padStart(2, '0')
          const year = parts[2]
          return `${year}-${month}-${day}`
        }
        return hebrewDate
      }

      const invoicesToSave = result
        .filter(res => !res.failed)
        .map(res => ({
          id: typeof res.id === 'number' ? res.id : null,
          fileName: res.fileName,
          mimeType: res.mimeType || null,
          ...(res.isStoredRecord ? {} : { fileData: res.fileData || null }),
          vendorName: res.supplier === '—' ? null : res.supplier,
          date: dateToISO(res.date),
          totalWithVat: res.total,
          originalTotalWithVat: res.originalTotalWithVat ?? res.total,
          totalWithoutVat: res.payment,
          vat: res.vat,
          printed: res.printed || 'לא',
          status: res.status || activeTab,
          morningCategoryId: res.morningCategoryId || null,
          morningCategoryName: res.morningCategoryName || null,
          morningCategoryCode: res.morningCategoryCode ?? null,
          currency: 'ILS',
          confidence: res.confidence || 'medium',
        }))

      const response = await fetch(`${API_BASE}/save-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoices: invoicesToSave, status: activeTab }),
      })

      const json = await response.json()
      if (!response.ok || !json.success) {
        throw new Error(json.error || 'Failed to save to database')
      }

      const listResponse = await fetch(`${API_BASE}/list?status=${encodeURIComponent(activeTab)}`, { cache: 'no-store' })
      const listJson = await listResponse.json()
      if (listJson.success && listJson.invoices) {
        const mappedInvoices = listJson.invoices.map(mapInvoiceFromDatabase)
        setResult(sortResultsByDateAsc(mappedInvoices))
        setSelectedRows(new Set())
        setEditingCell(null)
      }

      setError(null)
      alert(`בסיס הנתונים עודכן: ${json.savedCount} נשמרו/עודכנו, ${json.deletedCount || 0} נמחקו`)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const visibleResults = result.filter(r => !isDuplicateResult(r))
  const successResults = visibleResults.filter(r => !r.failed)
  const hasSelectedRows = selectedRows.size > 0
  const selectedStoredRowsCount = visibleResults.filter(row => selectedRows.has(row.rowKey) && row.isStoredRecord && typeof row.id === 'number' && !row.failed).length

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
            <button type="button" onClick={openUploadPicker} className="upload-button" disabled={processing}>
              {processing ? 'מעבד...' : 'העלה קבצים / תמונות'}
            </button>
            <button type="button" onClick={openCameraPicker} className="upload-button" disabled={processing}>
              צלם חשבונית
            </button>
            <button type="button" onClick={handleGmailSync} className="upload-button" disabled={gmailLoading}>
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

      {visibleResults.length > 0 && (
        <section className="results">
          <div className="results-header">
            <h2>דוח חשבוניות ({visibleResults.length})</h2>
          </div>

          {gmailSummary && (
            <div className="gmail-summary">
              נטענו {gmailSummary.count} חשבוניות מ-Gmail
            </div>
          )}

          <div className="summary-cards">
            <div className="summary-card summary-card-before-vat">
              <span className="summary-label">לפני מע"מ</span>
              <strong>₪{successResults.reduce((sum, res) => sum + (res.payment ?? 0), 0).toFixed(2)}</strong>
            </div>
            <div className="summary-card summary-card-vat">
              <span className="summary-label">מע"מ</span>
              <strong>₪{successResults.reduce((sum, res) => sum + (res.vat ?? 0), 0).toFixed(2)}</strong>
            </div>
            <div className="summary-card summary-card-total">
              <span className="summary-label">סה"כ</span>
              <strong>₪{successResults.reduce((sum, res) => sum + (res.total ?? 0), 0).toFixed(2)}</strong>
            </div>
          </div>

          <div className="bulk-actions">
            <span className="bulk-actions-info">בחרת {selectedRows.size} פריטים</span>
            <button type="button" onClick={() => handleCopyWithoutVat()} className="bulk-action-button bulk-action-without-vat" disabled={!hasSelectedRows || saving}>ללא מע"מ</button>
            <button type="button" onClick={() => handleCalculateWithVat()} className="bulk-action-button" disabled={!hasSelectedRows || saving}>עם מע"מ</button>
            <button type="button" onClick={() => handleMarkPrinted()} className="bulk-action-button" disabled={!hasSelectedRows || saving}>מודפס</button>
            <button type="button" onClick={() => handleRestoreOriginalTotal()} className="bulk-action-button" disabled={!hasSelectedRows || saving}>שחזר סכום</button>
            {activeTab === TAB_PENDING && (
              <button type="button" onClick={() => handleApproveRows()} className="bulk-action-button bulk-action-approve" disabled={!hasSelectedRows || saving}>אשר</button>
            )}
            <button type="button" onClick={() => handleSendToMorning()} className="bulk-action-button bulk-action-morning" disabled={selectedStoredRowsCount === 0 || morningSending || saving}>
              {morningSending ? 'Sending...' : 'Send to Morning'}
            </button>
            <div className="bulk-action-dropdown-wrapper">
              <select onChange={(e) => {
                if (e.target.value) handleApplyFraction(e.target.value)
                e.target.value = ''
              }} defaultValue="" className="bulk-action-dropdown" disabled={!hasSelectedRows || saving}>
                <option value="">סכום חלקי</option>
                <option value="2/3">2/3</option>
                <option value="1/2">1/2</option>
                <option value="1/3">1/3</option>
                <option value="1/4">1/4</option>
              </select>
            </div>
            <button type="button" onClick={() => handleDeleteSelected()} className="bulk-action-button bulk-action-delete" disabled={!hasSelectedRows || saving}>מחק</button>
          </div>

          <div className="table-scroll">
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
                  <th>פעולות</th>
                </tr>
              </thead>
              <tbody>
                {visibleResults.map((res, i) => res.failed ? (
                  <tr key={res.rowKey} className="row-failed">
                    <td><input type="checkbox" checked={selectedRows.has(res.rowKey)} onChange={() => toggleRow(res.rowKey)} /></td>
                    <td>{i + 1}</td>
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
                    <td>{i + 1}</td>
                    <td>{renderEditableCell(i, 'date', result[i].date)}</td>
                    <td>
                      <div className="supplier-cell">
                        <div className="supplier-line">
                          {renderEditableCell(i, 'supplier', result[i].supplier === '—' ? '—' : result[i].supplier)}
                          {result[i].source === 'gmail' && <span className="gmail-source-badge">Gmail</span>}
                        </div>
                        {result[i].confidence !== 'high' && (
                          <span className={`confidence-badge confidence-${result[i].confidence}`}>
                            {result[i].confidence === 'medium' ? 'בינוני' : 'נמוך'} — יש לאמת
                          </span>
                        )}
                      </div>
                    </td>
                    <td>{renderCategorySelect(i)}</td>
                    <td>{renderEditableCell(i, 'payment', result[i].payment != null ? `₪${result[i].payment.toFixed(2)}` : '—', 'number')}</td>
                    <td>{renderEditableCell(i, 'vat', result[i].vat != null ? `₪${result[i].vat.toFixed(2)}` : '—', 'number')}</td>
                    <td>{renderEditableCell(i, 'total', result[i].total != null ? `₪${result[i].total.toFixed(2)}` : '—', 'number')}</td>
                    <td>{result[i].printed || 'לא'}</td>
                    <td>
                      <span className={`morning-table-status ${getMorningStatus(result[i]) === 'עבר' ? 'morning-table-status-pass' : 'morning-table-status-fail'}`}>
                        {getMorningStatus(result[i])}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        {result[i].fileUrl && (
                          <a
                            href={result[i].fileUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="file-link"
                            title={`פתח את ${result[i].fileName}`}
                            aria-label={`פתח את ${result[i].fileName}`}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M14 5h5v5" />
                              <path d="M10 14L19 5" />
                              <path d="M19 14v4a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1V6a1.5 1.5 0 0 1 1-1h4" />
                            </svg>
                          </a>
                        )}
                        <div className="row-menu-wrapper">
                          <button
                            type="button"
                            className="row-menu-button"
                            onClick={() => {
                              setOpenRowMenuKey(openRowMenuKey === res.rowKey ? null : res.rowKey)
                              setOpenFractionMenuKey(null)
                            }}
                            aria-label="פעולות לשורה"
                            title="פעולות"
                          >
                            ⋮
                          </button>
                          {openRowMenuKey === res.rowKey && (
                            <div className="row-menu">
                              <button
                                type="button"
                                onClick={() => {
                                  handleCopyWithoutVat(rowKeySet(res.rowKey))
                                  closeRowMenu()
                                }}
                              >
                                ללא מע"מ
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  handleCalculateWithVat(rowKeySet(res.rowKey))
                                  closeRowMenu()
                                }}
                              >
                                עם מע"מ
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  handleMarkPrinted(rowKeySet(res.rowKey))
                                  closeRowMenu()
                                }}
                              >
                                מודפס
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  handleRestoreOriginalTotal(rowKeySet(res.rowKey))
                                  closeRowMenu()
                                }}
                              >
                                שחזר סכום
                              </button>
                              {activeTab === TAB_PENDING && (
                                <button
                                  type="button"
                                  onClick={() => handleApproveRows(rowKeySet(res.rowKey))}
                                >
                                  אשר
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={!res.isStoredRecord || typeof res.id !== 'number' || morningSending}
                                onClick={() => handleSendToMorning(rowKeySet(res.rowKey))}
                              >
                                {morningSending ? 'Sending...' : 'Send to Morning'}
                              </button>
                              <button
                                type="button"
                                className="row-menu-fraction-trigger"
                                onClick={() => setOpenFractionMenuKey(openFractionMenuKey === res.rowKey ? null : res.rowKey)}
                              >
                                סכום חלקי
                              </button>
                              {openFractionMenuKey === res.rowKey && (
                                <div className="row-fraction-options">
                                  {['2/3', '1/2', '1/3', '1/4'].map((fraction) => (
                                    <button
                                      key={fraction}
                                      type="button"
                                      onClick={() => {
                                        handleApplyFraction(fraction, rowKeySet(res.rowKey))
                                        closeRowMenu()
                                      }}
                                    >
                                      {fraction}
                                    </button>
                                  ))}
                                </div>
                              )}
                              <button
                                type="button"
                                className="row-menu-delete"
                                onClick={() => handleDeleteSelected(rowKeySet(res.rowKey))}
                              >
                                מחק
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}

export default App

import { useState, useEffect, useRef } from 'react'
import './App.css'

const API_URL = import.meta.env.VITE_API_URL ?? '/api/invoices/upload'
const API_BASE = import.meta.env.VITE_API_URL?.replace('/upload', '') ?? '/api/invoices'

function App() {
  const [processing, setProcessing] = useState(false)
  const [result, setResult] = useState([])
  const [error, setError] = useState(null)
  const [selectedRows, setSelectedRows] = useState(new Set())
  const [saving, setSaving] = useState(false)
  const [editingCell, setEditingCell] = useState(null) // {rowIndex, field}
  const uploadInputRef = useRef(null)
  const cameraInputRef = useRef(null)

  const parseDisplayDate = (value) => {
    if (!value || value === '—') return null

    const normalized = value.replace(/[\/.]/g, '-').trim()
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

  const displayDateToISO = (value) => {
    if (!value || value === '—') return ''
    const parsed = parseDisplayDate(value)
    if (!parsed) return ''

    const year = parsed.getFullYear()
    const month = String(parsed.getMonth() + 1).padStart(2, '0')
    const day = String(parsed.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  const buildDuplicateKey = (invoice) => {
    const dateKey = displayDateToISO(invoice.date)
    const totalKey = normalizeAmount(invoice.total)

    if (!dateKey || !totalKey) return null
    return `${dateKey}|${totalKey}`
  }

  const mapInvoiceFromDatabase = (inv) => {
    let hebrewDate = '—'
    if (inv.date) {
      try {
        const [year, month, day] = inv.date.split('-')
        hebrewDate = new Date(year, parseInt(month, 10) - 1, day).toLocaleDateString('he-IL')
      } catch (e) {
        hebrewDate = '—'
      }
    }

    const fileUrl = inv.id ? `${API_BASE}/file/${inv.id}` : null
    console.log(`Invoice ${inv.fileName}: id=${inv.id}, fileUrl=${fileUrl}`)

    return {
      ...inv,
      failed: false,
      fileUrl,
      supplier: inv.vendorName ?? '—',
      date: hebrewDate,
      payment: inv.totalWithoutVat,
      vat: inv.vat,
      total: inv.totalWithVat,
      fileName: inv.fileName,
      isStoredRecord: true,
    }
  }

  useEffect(() => {
    const loadDataFromDatabase = async () => {
      try {
        const response = await fetch(`${API_BASE}/list`)
        const json = await response.json()

        if (json.success && json.invoices) {
          console.log('Loaded invoices from DB:', json.invoices)
          const mappedInvoices = json.invoices.map(mapInvoiceFromDatabase)
          setResult(sortResultsByDateDesc(mappedInvoices))
        }
      } catch (err) {
        console.error('Failed to load data from database:', err)
      }
    }

    loadDataFromDatabase()
  }, [])

  useEffect(() => {
    return () => {
      result.forEach((res) => {
        if (res.fileUrl && res.fileUrl.startsWith('blob:')) {
          URL.revokeObjectURL(res.fileUrl)
        }
      })
    }
  }, [result])

  const processFiles = async (selectedFiles) => {
    if (!selectedFiles.length) return

    setProcessing(true)
    setSelectedRows(new Set())
    setError(null)

    const formData = new FormData()
    selectedFiles.forEach(file => formData.append('invoices', file))

    const fileUrls = selectedFiles.map(file => URL.createObjectURL(file))

    try {
      const response = await fetch(API_URL, { method: 'POST', body: formData })
      const json = await response.json()

      if (!response.ok || !json.success) {
        throw new Error(json.error || 'שגיאה בעיבוד החשבוניות')
      }

      const results = json.results.map((r, i) => {
        if (!r.success) {
          return {
            failed: true,
            fileName: r.filename,
            fileUrl: fileUrls[i] ?? null,
            error: r.error,
          }
        }

        const { vendorName, date, totalWithVat, totalWithoutVat, confidence } = r.data
        const vat = totalWithVat != null && totalWithoutVat != null
          ? totalWithVat - totalWithoutVat
          : null

        return {
          failed: false,
          fileName: r.filename,
          fileUrl: fileUrls[i] ?? null,
          fileData: r.fileData,
          mimeType: r.mimeType,
          supplier: vendorName ?? '—',
          date: date ? new Date(date).toLocaleDateString('he-IL') : '—',
          payment: totalWithoutVat,
          vat,
          total: totalWithVat,
          confidence,
          isStoredRecord: false,
        }
      })

      setResult(prev => sortResultsByDateDesc([...prev, ...results]))
    } catch (err) {
      setError(err.message)
    } finally {
      setProcessing(false)
    }
  }

  const handleFileChange = (e) => {
    const selectedFiles = Array.from(e.target.files)
    processFiles(selectedFiles)
    e.target.value = ''
  }

  const openUploadPicker = () => {
    if (processing) return
    uploadInputRef.current?.click()
  }

  const openCameraPicker = () => {
    if (processing) return
    cameraInputRef.current?.click()
  }

  const toggleRow = (index) => {
    setSelectedRows(prev => {
      const next = new Set(prev)
      next.has(index) ? next.delete(index) : next.add(index)
      return next
    })
  }

  const allSelected = result.length > 0 && selectedRows.size === result.length
  const toggleAll = () => {
    setSelectedRows(allSelected ? new Set() : new Set(result.map((_, i) => i)))
  }

  const handleCopyWithoutVat = () => {
    setResult(prev => prev.map((res, i) => {
      if (!selectedRows.has(i) || res.failed) return res
      return { ...res, payment: res.total, vat: 0 }
    }))
  }

  const handleApplyFraction = (fraction) => {
    setResult(prev => prev.map((res, i) => {
      if (!selectedRows.has(i) || res.failed) return res

      const fractions = {
        '2/3': 2 / 3,
        '1/2': 0.5,
        '1/3': 1 / 3,
        '1/4': 0.25,
      }
      const multiplier = fractions[fraction] || 1

      return {
        ...res,
        payment: res.payment != null ? res.payment * multiplier : null,
        vat: res.vat != null ? res.vat * multiplier : null,
        total: res.total != null ? res.total * multiplier : null,
      }
    }))
  }

  const handleDeleteSelected = () => {
    setResult(prev => {
      const filtered = prev.filter((_, i) => !selectedRows.has(i))
      filtered.forEach(res => {
        if (
          res.fileUrl &&
          res.fileUrl.startsWith('blob:') &&
          !prev.find((r, idx) => r.fileUrl === res.fileUrl && !selectedRows.has(idx))
        ) {
          URL.revokeObjectURL(res.fileUrl)
        }
      })
      return filtered
    })
    setSelectedRows(new Set())
  }

  const updateRowValue = (index, field, value) => {
    setResult(prev => {
      const updated = [...prev]
      if (field === 'supplier') {
        updated[index].supplier = value === '' ? '—' : value
      } else if (field === 'payment' || field === 'vat' || field === 'total') {
        updated[index][field] = value === '' || value === null ? null : parseFloat(value)
      } else if (field === 'date') {
        updated[index].date = value
      }
      return updated
    })
  }

  const renderEditableCell = (rowIndex, field, displayValue, inputType = 'text') => {
    const isEditing = editingCell?.rowIndex === rowIndex && editingCell?.field === field

    if (isEditing) {
      return (
        <input
          autoFocus
          type={inputType}
          value={result[rowIndex][field] ?? ''}
          onChange={(e) => updateRowValue(rowIndex, field, e.target.value)}
          onBlur={() => setEditingCell(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setEditingCell(null)
            if (e.key === 'Escape') setEditingCell(null)
          }}
          className="cell-input"
          placeholder={inputType === 'number' ? '0.00' : ''}
          step={inputType === 'number' ? '0.01' : undefined}
        />
      )
    }

    return (
      <span
        onClick={() => setEditingCell({ rowIndex, field })}
        className="editable-cell"
        title="לחץ לעריכה"
      >
        {displayValue}
      </span>
    )
  }

  const handleSaveToDatabase = async () => {
    setSaving(true)
    setError(null)

    try {
      const duplicateGroups = new Map()

      result.forEach((res, index) => {
        if (res.failed) return

        const key = buildDuplicateKey(res)
        if (!key) return

        if (!duplicateGroups.has(key)) {
          duplicateGroups.set(key, [])
        }

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
        const duplicateRows = duplicateEntries
          .flatMap((group) => group.filter((item) => !item.isStoredRecord))
          .sort((a, b) => a.rowNumber - b.rowNumber)

        const duplicateSummary = duplicateRows
          .map((item) => `שורה ${item.rowNumber}: ${item.fileName} | ${item.date} | ₪${normalizeAmount(item.total)}`)
          .join('\n')

        throw new Error(
          `נמצאו ${duplicateRows.length} חשבוניות כפולות שכבר קיימות בבסיס הנתונים:\n${duplicateSummary}`
        )
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
          id: res.id || null,
          fileName: res.fileName,
          mimeType: res.mimeType || null,
          fileData: res.fileData || null,
          vendorName: res.supplier === '—' ? null : res.supplier,
          date: dateToISO(res.date),
          totalWithVat: res.total,
          totalWithoutVat: res.payment,
          vat: res.vat,
          currency: 'ILS',
          confidence: res.confidence || 'medium',
        }))

      const response = await fetch(`${API_BASE}/save-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoices: invoicesToSave }),
      })

      const json = await response.json()

      if (!response.ok || !json.success) {
        throw new Error(json.error || 'Failed to save to database')
      }

      const listResponse = await fetch(`${API_BASE}/list`)
      const listJson = await listResponse.json()

      if (listJson.success && listJson.invoices) {
        const mappedInvoices = listJson.invoices.map(mapInvoiceFromDatabase)
        setResult(sortResultsByDateDesc(mappedInvoices))
      }

      setError(null)
      alert(`בסיס הנתונים עודכן בהצלחה! ${json.savedCount} חשבוניות נשמרו`)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const successResults = result.filter(r => !r.failed)

  return (
    <div className="container">
      <header className="page-header">
        <div className="header-copy">
          <h1>דוח חשבוניות חכם</h1>
          <p className="header-subtitle">העלה חשבוניות וצפה בדוח מסכם</p>
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

      <section className="upload-section">
        <input
          ref={uploadInputRef}
          type="file"
          onChange={handleFileChange}
          accept="image/*,.pdf"
          multiple
          id="upload-input"
        />
        <input
          ref={cameraInputRef}
          type="file"
          onChange={handleFileChange}
          accept="image/*"
          capture="environment"
          id="camera-input"
        />

        <div className="upload-panel-copy">
          <p className="upload-panel-text">העלה תמונה או PDF של חשבונית — הנתונים יחולצו אוטומטית</p>
        </div>

        <div className="upload-actions">
          <button type="button" onClick={openUploadPicker} className="upload-button" disabled={processing}>
            {processing ? 'מעבד...' : 'העלה קבצים / תמונות'}
          </button>

          <button type="button" onClick={openCameraPicker} className="file-label" disabled={processing}>
            צלם חשבונית
          </button>
        </div>

        <div className="save-section">
          <button
            type="button"
            onClick={handleSaveToDatabase}
            className="save-button"
            disabled={saving}
          >
            {saving ? 'שומר...' : 'עדכן בסיס נתונים'}
          </button>
        </div>
      </section>

      {processing && (
        <div className="processing">
          <div className="spinner"></div>
          <p>מנתח חשבונית...</p>
        </div>
      )}

      {error && (
        <div className="error-banner">
          <p>{error}</p>
        </div>
      )}

      {result.length > 0 && (
        <section className="results">
          <div className="results-header">
            <h2>דוח חשבוניות ({result.length})</h2>
          </div>

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

          {selectedRows.size > 0 && (
            <div className="bulk-actions">
              <span className="bulk-actions-info">בחרת {selectedRows.size} פריטים</span>
              <button type="button" onClick={handleCopyWithoutVat} className="bulk-action-button bulk-action-without-vat">
                ללא מע"מ
              </button>
              <div className="bulk-action-dropdown-wrapper">
                <select onChange={(e) => e.target.value && handleApplyFraction(e.target.value)} defaultValue="" className="bulk-action-dropdown">
                  <option value="">סכום חלקי</option>
                  <option value="2/3">2/3</option>
                  <option value="1/2">1/2</option>
                  <option value="1/3">1/3</option>
                  <option value="1/4">1/4</option>
                </select>
              </div>
              <button type="button" onClick={handleDeleteSelected} className="bulk-action-button bulk-action-delete">
                מחק
              </button>
            </div>
          )}

          <table className="results-table">
            <thead>
              <tr>
                <th>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                </th>
                <th>#</th>
                <th>תאריך</th>
                <th>ספק</th>
                <th>לפני מע"מ</th>
                <th>מע"מ</th>
                <th>סה"כ</th>
                <th>פעולות</th>
              </tr>
            </thead>
            <tbody>
              {result.map((res, i) => res.failed ? (
                <tr key={i} className="row-failed">
                  <td>
                    <input type="checkbox" checked={selectedRows.has(i)} onChange={() => toggleRow(i)} />
                  </td>
                  <td>{i + 1}</td>
                  <td colSpan={4} className="failed-cell">{res.fileName} — {res.error}</td>
                  <td></td>
                  <td></td>
                </tr>
              ) : (
                <tr key={i} className={selectedRows.has(i) ? 'row-selected' : ''}>
                  <td>
                    <input type="checkbox" checked={selectedRows.has(i)} onChange={() => toggleRow(i)} />
                  </td>
                  <td>{i + 1}</td>
                  <td>{renderEditableCell(i, 'date', result[i].date)}</td>
                  <td>
                    <div className="supplier-cell">
                      {renderEditableCell(i, 'supplier', result[i].supplier === '—' ? '—' : result[i].supplier)}
                      {result[i].confidence !== 'high' && (
                        <span className={`confidence-badge confidence-${result[i].confidence}`}>
                          {result[i].confidence === 'medium' ? 'בינוני' : 'נמוך'} — יש לאמת
                        </span>
                      )}
                    </div>
                  </td>
                  <td>
                    {renderEditableCell(i, 'payment', result[i].payment != null ? `₪${result[i].payment.toFixed(2)}` : '—', 'number')}
                  </td>
                  <td>
                    {renderEditableCell(i, 'vat', result[i].vat != null ? `₪${result[i].vat.toFixed(2)}` : '—', 'number')}
                  </td>
                  <td>
                    {renderEditableCell(i, 'total', result[i].total != null ? `₪${result[i].total.toFixed(2)}` : '—', 'number')}
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
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}

export default App

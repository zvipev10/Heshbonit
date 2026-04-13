import { useState, useEffect, useRef } from 'react'
import './App.css'

const API_URL = import.meta.env.VITE_API_URL ?? '/api/invoices/upload'

function App() {
  const [processing, setProcessing] = useState(false)
  const [result, setResult] = useState([])
  const [error, setError] = useState(null)
  const [selectedRows, setSelectedRows] = useState(new Set())
  const uploadInputRef = useRef(null)
  const cameraInputRef = useRef(null)

  useEffect(() => {
    return () => {
      result.forEach((res) => {
        if (res.fileUrl) {
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
          supplier: vendorName ?? '—',
          date: date ? new Date(date).toLocaleDateString('he-IL') : '—',
          payment: totalWithoutVat,
          vat,
          total: totalWithVat,
          confidence,
        }
      })

      setResult(prev => {
        const combined = [...prev, ...results]
        return combined.sort((a, b) => {
          if (a.failed) return 1
          if (b.failed) return -1
          if (!a.date || a.date === '—') return 1
          if (!b.date || b.date === '—') return -1
        const dateA = new Date(a.date.split('.').reverse().join('-'))
        const dateB = new Date(b.date.split('.').reverse().join('-'))
        return dateA - dateB
        })
      })
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
      return { ...res, payment: res.total }
    }))
  }

  const handleApplyFraction = (fraction) => {
    setResult(prev => prev.map((res, i) => {
      if (!selectedRows.has(i) || res.failed) return res
      const multiplier = eval(fraction)
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
        if (res.fileUrl && !prev.find((r, idx) => r.fileUrl === res.fileUrl && !selectedRows.has(idx))) {
          URL.revokeObjectURL(res.fileUrl)
        }
      })
      return filtered
    })
    setSelectedRows(new Set())
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
                  <td>{res.date}</td>
                  <td>
                    <div className="supplier-cell">
                      <span className="supplier-name">{res.supplier}</span>
                      {res.confidence !== 'high' && (
                        <span className={`confidence-badge confidence-${res.confidence}`}>
                          {res.confidence === 'medium' ? 'בינוני' : 'נמוך'} — יש לאמת
                        </span>
                      )}
                    </div>
                  </td>
                  <td>₪{res.payment != null ? res.payment.toFixed(2) : '—'}</td>
                  <td>₪{res.vat != null ? res.vat.toFixed(2) : '—'}</td>
                  <td>₪{res.total != null ? res.total.toFixed(2) : '—'}</td>
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
                            <path d="M19 14v4a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4" />
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

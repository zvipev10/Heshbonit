import { useState, useEffect, useRef } from 'react'
import './App.css'

function App() {
  const [processing, setProcessing] = useState(false)
  const [result, setResult] = useState([])
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

  const processFiles = (selectedFiles) => {
    if (!selectedFiles.length) {
      return
    }

    console.log('Starting upload process...')
    setProcessing(true)
    setResult([])

    setTimeout(() => {
      console.log('Processing complete, showing results...')
      const results = selectedFiles.map((file, index) => ({
        date: new Date().toLocaleDateString('he-IL'),
        payment: 1250.00 + (index * 100),
        vat: (1250.00 + (index * 100)) * 0.15,
        total: (1250.00 + (index * 100)) * 1.15,
        invoiceNumber: `INV-2024-00${index + 1}`,
        supplier: `ספק ${index + 1}`,
        fileName: file.name,
        fileUrl: URL.createObjectURL(file)
      }))

      setResult(results)
      setProcessing(false)
      console.log('Results displayed:', results)
    }, 2000)
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

      {result && result.length > 0 && (
        <section className="results">
          {console.log('Rendering results:', result)}
          <div className="results-header">
            <h2>דוח חשבוניות ({result.length})</h2>
          </div>

          <div className="summary-cards">
            <div className="summary-card summary-card-before-vat">
              <span className="summary-label">לפני מע"מ</span>
              <strong>₪{result.reduce((sum, res) => sum + res.payment, 0).toFixed(2)}</strong>
            </div>
            <div className="summary-card summary-card-vat">
              <span className="summary-label">מע"מ</span>
              <strong>₪{result.reduce((sum, res) => sum + res.vat, 0).toFixed(2)}</strong>
            </div>
            <div className="summary-card summary-card-total">
              <span className="summary-label">סה"כ</span>
              <strong>₪{result.reduce((sum, res) => sum + res.total, 0).toFixed(2)}</strong>
            </div>
          </div>

          <table className="results-table">
            <thead>
              <tr>
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
              {result.map((res, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{res.date}</td>
                  <td>
                    <div className="supplier-cell">
                      <span className="supplier-name">{res.supplier}</span>
                      <span className="supplier-meta">{res.invoiceNumber}</span>
                    </div>
                  </td>
                  <td>₪{res.payment.toFixed(2)}</td>
                  <td>₪{res.vat.toFixed(2)}</td>
                  <td>₪{res.total.toFixed(2)}</td>
                  <td>
                    <div className="row-actions">
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
                      <button
                        type="button"
                        className="action-button action-button-delete"
                        title={`מחק את ${res.fileName}`}
                        aria-label={`מחק את ${res.fileName}`}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 6h18" />
                          <path d="M8 6V4.75A1.75 1.75 0 0 1 9.75 3h4.5A1.75 1.75 0 0 1 16 4.75V6" />
                          <path d="M6.5 6l1 12.25A1.75 1.75 0 0 0 9.24 20h5.52a1.75 1.75 0 0 0 1.74-1.75L17.5 6" />
                          <path d="M10 10.25v5.5" />
                          <path d="M14 10.25v5.5" />
                        </svg>
                      </button>
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

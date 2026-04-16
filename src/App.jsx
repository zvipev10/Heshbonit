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
  const [editingCell, setEditingCell] = useState(null)
  const uploadInputRef = useRef(null)
  const cameraInputRef = useRef(null)

  // ✅ Shared sorting: newest → oldest
  const sortResults = (arr) => {
    return [...arr].sort((a, b) => {
      if (a.failed) return 1
      if (b.failed) return -1
      if (!a.date || a.date === '—') return 1
      if (!b.date || b.date === '—') return -1

      const dateA = new Date(a.date.split('.').reverse().join('-'))
      const dateB = new Date(b.date.split('.').reverse().join('-'))

      return dateB - dateA // 🔥 newest first
    })
  }

  // Load data from DB
  useEffect(() => {
    const loadDataFromDatabase = async () => {
      try {
        const response = await fetch(`${API_BASE}/list`)
        const json = await response.json()

        if (json.success && json.invoices) {
          const mapped = json.invoices.map(inv => {
            let hebrewDate = '—'
            if (inv.date) {
              try {
                const [year, month, day] = inv.date.split('-')
                hebrewDate = new Date(year, month - 1, day).toLocaleDateString('he-IL')
              } catch {
                hebrewDate = '—'
              }
            }

            return {
              ...inv,
              failed: false,
              fileUrl: inv.id ? `${API_BASE}/file/${inv.id}` : null,
              supplier: inv.vendorName ?? '—',
              date: hebrewDate,
              payment: inv.totalWithoutVat,
              vat: inv.vat,
              total: inv.totalWithVat,
            }
          })

          setResult(sortResults(mapped))
        }
      } catch (err) {
        console.error(err)
      }
    }

    loadDataFromDatabase()
  }, [])

  useEffect(() => {
    return () => {
      result.forEach((res) => {
        if (res.fileUrl) URL.revokeObjectURL(res.fileUrl)
      })
    }
  }, [result])

  const processFiles = async (files) => {
    if (!files.length) return

    setProcessing(true)
    setSelectedRows(new Set())
    setError(null)

    const formData = new FormData()
    files.forEach(f => formData.append('invoices', f))

    const fileUrls = files.map(f => URL.createObjectURL(f))

    try {
      const res = await fetch(API_URL, { method: 'POST', body: formData })
      const json = await res.json()

      if (!res.ok || !json.success) throw new Error(json.error)

      const results = json.results.map((r, i) => {
        if (!r.success) {
          return { failed: true, fileName: r.filename, fileUrl: fileUrls[i], error: r.error }
        }

        const { vendorName, date, totalWithVat, totalWithoutVat, confidence } = r.data

        return {
          failed: false,
          fileName: r.filename,
          fileUrl: fileUrls[i],
          supplier: vendorName ?? '—',
          date: date ? new Date(date).toLocaleDateString('he-IL') : '—',
          payment: totalWithoutVat,
          vat: totalWithVat - totalWithoutVat,
          total: totalWithVat,
          confidence
        }
      })

      setResult(prev => sortResults([...prev, ...results]))

    } catch (err) {
      setError(err.message)
    } finally {
      setProcessing(false)
    }
  }

  const handleFileChange = (e) => {
    processFiles(Array.from(e.target.files))
    e.target.value = ''
  }

  const openUploadPicker = () => uploadInputRef.current?.click()
  const openCameraPicker = () => cameraInputRef.current?.click()

  const toggleRow = (i) => {
    setSelectedRows(prev => {
      const next = new Set(prev)
      next.has(i) ? next.delete(i) : next.add(i)
      return next
    })
  }

  const handleSaveToDatabase = async () => {
    setSaving(true)
    setError(null)

    const dateToISO = (d) => {
      if (!d || d === '—') return null
      const [day, month, year] = d.split('.')
      return `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`
    }

    try {
      const payload = result.map(r => ({
        fileName: r.fileName,
        vendorName: r.supplier === '—' ? null : r.supplier,
        date: dateToISO(r.date),
        totalWithVat: r.total,
        totalWithoutVat: r.payment,
        vat: r.vat,
        currency: 'ILS',
        confidence: r.confidence || 'medium'
      }))

      await fetch(`${API_BASE}/save-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoices: payload })
      })

      // reload + sort
      const res = await fetch(`${API_BASE}/list`)
      const json = await res.json()

      if (json.success && json.invoices) {
        const mapped = json.invoices.map(inv => ({
          ...inv,
          failed: false,
          fileUrl: inv.id ? `${API_BASE}/file/${inv.id}` : null,
          supplier: inv.vendorName ?? '—',
          date: inv.date ? new Date(inv.date).toLocaleDateString('he-IL') : '—',
          payment: inv.totalWithoutVat,
          vat: inv.vat,
          total: inv.totalWithVat
        }))

        setResult(sortResults(mapped))
      }

      alert('נשמר בהצלחה')
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="container">
      <h1>דוח חשבוניות</h1>

      <input ref={uploadInputRef} type="file" multiple onChange={handleFileChange}/>
      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" onChange={handleFileChange}/>

      <button onClick={openUploadPicker}>Upload</button>
      <button onClick={openCameraPicker}>Camera</button>

      {processing && <p>Processing...</p>}
      {error && <p>{error}</p>}

      <button onClick={handleSaveToDatabase} disabled={saving}>
        {saving ? 'Saving...' : 'Save'}
      </button>

      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>תאריך</th>
            <th>ספק</th>
            <th>לפני מע"מ</th>
            <th>מע"מ</th>
            <th>סה"כ</th>
          </tr>
        </thead>
        <tbody>
          {result.map((r, i) => (
            <tr key={i}>
              <td>{i+1}</td>
              <td>{r.date}</td>
              <td>{r.supplier}</td>
              <td>{r.payment}</td>
              <td>{r.vat}</td>
              <td>{r.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default App
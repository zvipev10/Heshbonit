// ONLY RELEVANT CHANGE

  const handleGmailSync = async () => {
    setGmailLoading(true)
    setError(null)

    try {
      const res = await fetch(`${GMAIL_API_BASE}/sync`, { method: 'POST' })
      const json = await res.json()

      if (!res.ok || !json.success) {
        throw new Error(json.error || 'סנכרון Gmail נכשל')
      }

      const results = json.results.map((r, i) => {
        if (!r.success) {
          return {
            failed: true,
            fileName: r.filename,
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
          supplier: vendorName ?? '—',
          date: date ? new Date(date).toLocaleDateString('he-IL') : '—',
          payment: totalWithoutVat,
          vat,
          total: totalWithVat,
          confidence,
          isStoredRecord: false,
          isGmail: true,
          source: 'gmail'
        }
      })

      setResult(prev => sortResultsByDateDesc([...prev, ...results]))

    } catch (err) {
      setError(err.message)
    } finally {
      setGmailLoading(false)
    }
  }

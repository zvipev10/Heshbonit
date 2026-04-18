// ADD THIS useEffect RIGHT AFTER OTHER useEffects

useEffect(() => {
  const params = new URLSearchParams(window.location.search)

  if (params.get('gmail_connected') === '1') {
    // clean URL
    window.history.replaceState({}, document.title, window.location.pathname)

    // trigger sync automatically
    handleGmailSync()
  }
}, [])

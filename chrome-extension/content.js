/* global chrome */
const REQUEST = 'HESHBONIT_CAPTURE_REQUEST';
const RESPONSE = 'HESHBONIT_CAPTURE_RESPONSE';

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.type !== REQUEST) return;

  if (!globalThis.chrome?.runtime?.sendMessage) {
    window.postMessage({
      type: RESPONSE,
      requestId: event.data.payload?.requestId,
      payload: {
        success: false,
        error: 'Browser capture extension context is unavailable. Refresh this page after reloading the extension.'
      }
    }, '*');
    return;
  }

  chrome.runtime.sendMessage(event.data.payload, (response) => {
    const runtimeError = chrome.runtime.lastError?.message;
    window.postMessage({
      type: RESPONSE,
      requestId: event.data.payload?.requestId,
      payload: response || { success: false, error: runtimeError || 'Extension did not respond' }
    }, '*');
  });
});


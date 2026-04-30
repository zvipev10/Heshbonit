/* global chrome */
const REQUEST = 'HESHBONIT_CAPTURE_REQUEST';
const RESPONSE = 'HESHBONIT_CAPTURE_RESPONSE';

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.type !== REQUEST) return;

  chrome.runtime.sendMessage(event.data.payload, (response) => {
    window.postMessage({
      type: RESPONSE,
      requestId: event.data.payload?.requestId,
      payload: response || { success: false, error: chrome.runtime.lastError?.message || 'Extension did not respond' }
    }, '*');
  });
});


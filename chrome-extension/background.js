/* global chrome */
const DEBUGGER_VERSION = '1.3';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendDebuggerCommand(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function createTab(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tab);
    });
  });
}

function removeTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.remove(tabId, () => resolve());
  });
}

function attachDebugger(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, DEBUGGER_VERSION, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function detachDebugger(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => resolve());
  });
}

function waitForTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function capturePagePdf(url) {
  const tab = await createTab(url);
  const target = { tabId: tab.id };
  let attached = false;

  try {
    await waitForTabComplete(tab.id, 45000);
    await delay(4000);

    await attachDebugger(target);
    attached = true;

    await sendDebuggerCommand(target, 'Page.enable');
    await sendDebuggerCommand(target, 'Emulation.setEmulatedMedia', { media: 'screen' });

    const pdf = await sendDebuggerCommand(target, 'Page.printToPDF', {
      printBackground: true,
      paperWidth: 8.27,
      paperHeight: 11.69,
      marginTop: 0.35,
      marginBottom: 0.35,
      marginLeft: 0.35,
      marginRight: 0.35
    });

    return {
      tabUrl: tab.url,
      pdfBase64: pdf.data
    };
  } finally {
    if (attached) await detachDebugger(target);
    await removeTab(tab.id);
  }
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

async function uploadCapturedPdf({ pdfBase64, uploadUrl, fileName }) {
  const formData = new FormData();
  const blob = base64ToBlob(pdfBase64, 'application/pdf');
  formData.append('invoices', blob, fileName || 'captured-invoice.pdf');

  const response = await fetch(uploadUrl, {
    method: 'POST',
    body: formData
  });

  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.success) {
    throw new Error(json?.error || `Upload failed with status ${response.status}`);
  }

  return json;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'CAPTURE_INVOICE_LINK') return false;

  (async () => {
    const captured = await capturePagePdf(message.url);
    const uploadResult = await uploadCapturedPdf({
      pdfBase64: captured.pdfBase64,
      uploadUrl: message.uploadUrl,
      fileName: message.fileName
    });

    sendResponse({
      success: true,
      tabUrl: captured.tabUrl,
      uploadResult
    });
  })().catch((error) => {
    sendResponse({
      success: false,
      error: error instanceof Error ? error.message : String(error)
    });
  });

  return true;
});


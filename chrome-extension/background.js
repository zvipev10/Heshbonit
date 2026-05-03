/* global chrome */
const DEBUGGER_VERSION = '1.3';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFileNameFromUrl(url, fallbackName) {
  try {
    const parsed = new URL(url);
    const lastSegment = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    return lastSegment || fallbackName || 'captured-invoice.pdf';
  } catch {
    return fallbackName || 'captured-invoice.pdf';
  }
}

function extensionFromMimeType(mimeType) {
  if (mimeType === 'application/pdf') return '.pdf';
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/webp') return '.webp';
  return '';
}

function withExpectedExtension(fileName, mimeType) {
  const extension = extensionFromMimeType(mimeType);
  if (!extension || fileName.toLowerCase().endsWith(extension)) return fileName;
  return `${fileName.replace(/\.[^.]+$/, '')}${extension}`;
}

function detectMimeType(bytes, contentType) {
  const normalizedContentType = (contentType || '').split(';')[0].trim().toLowerCase();
  if (normalizedContentType === 'application/pdf' || normalizedContentType.startsWith('image/')) {
    return normalizedContentType;
  }

  if (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return 'application/pdf';
  }

  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
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

async function fetchDirectInvoiceFile(url, fallbackName) {
  const response = await fetch(url, {
    credentials: 'include',
    redirect: 'follow',
    cache: 'no-store'
  });

  if (!response.ok) {
    throw new Error(`Direct file fetch failed with status ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer.slice(0, 16));
  const mimeType = detectMimeType(bytes, response.headers.get('content-type'));

  if (!mimeType) {
    throw new Error('Direct fetch did not return a PDF or image file');
  }

  return {
    finalUrl: response.url,
    blob: new Blob([arrayBuffer], { type: mimeType }),
    mimeType,
    fileName: withExpectedExtension(getFileNameFromUrl(response.url, fallbackName), mimeType)
  };
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

async function uploadCapturedBlob({ blob, uploadUrl, fileName }) {
  const formData = new FormData();
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
    try {
      const directFile = await fetchDirectInvoiceFile(message.url, message.fileName);
      const uploadResult = await uploadCapturedBlob({
        blob: directFile.blob,
        uploadUrl: message.uploadUrl,
        fileName: directFile.fileName
      });

      sendResponse({
        success: true,
        captureMethod: 'direct_file',
        tabUrl: directFile.finalUrl,
        uploadResult
      });
      return;
    } catch {
      // Not a direct file link, or browser fetch was blocked. Fall back to visual page capture.
    }

    const captured = await capturePagePdf(message.url);
    const uploadResult = await uploadCapturedPdf({
      pdfBase64: captured.pdfBase64,
      uploadUrl: message.uploadUrl,
      fileName: message.fileName
    });

    sendResponse({
      success: true,
      captureMethod: 'page_print',
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


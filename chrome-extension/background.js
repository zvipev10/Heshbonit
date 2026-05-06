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

function mimeTypeFromFileName(fileName) {
  const normalized = (fileName || '').toLowerCase();
  if (normalized.endsWith('.pdf')) return 'application/pdf';
  if (normalized.endsWith('.png')) return 'image/png';
  if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg')) return 'image/jpeg';
  if (normalized.endsWith('.webp')) return 'image/webp';
  return null;
}

function getBlobContentType(blob, fileName) {
  return blob.type || mimeTypeFromFileName(fileName) || 'application/pdf';
}

function getApiBaseFromUploadUrl(uploadUrl) {
  const parsed = new URL(uploadUrl);
  parsed.pathname = parsed.pathname.replace(/\/upload\/?$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function createBlobRequestId(clientToken) {
  const [, , , storeId = ''] = clientToken.split('_');
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const random = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${storeId}:${Date.now()}:${random}`;
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

function detectMimeTypeFromBytes(bytes) {
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

function bytesFromBodyResult(bodyResult) {
  if (bodyResult.base64Encoded) {
    const binary = atob(bodyResult.body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  const bytes = new Uint8Array(bodyResult.body.length);
  for (let i = 0; i < bodyResult.body.length; i += 1) {
    bytes[i] = bodyResult.body.charCodeAt(i) & 0xff;
  }
  return bytes;
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

function getTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve({ error: error.message });
        return;
      }
      resolve({
        id: tab.id,
        url: tab.url || '',
        pendingUrl: tab.pendingUrl || '',
        title: tab.title || '',
        status: tab.status || ''
      });
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
      resolve({ completed: false, reason: 'timeout' });
    }, timeoutMs);

    const listener = async (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ completed: true, tab: await getTab(tabId) });
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function startNetworkCapture(target) {
  const candidateResponses = new Map();
  let resolveCapturedFile;
  let capturedFileResolved = false;
  const capturedFilePromise = new Promise((resolve) => {
    resolveCapturedFile = resolve;
  });
  const resolveOnce = (file) => {
    if (capturedFileResolved) return;
    capturedFileResolved = true;
    resolveCapturedFile(file);
  };
  const timeout = setTimeout(() => resolveOnce(null), 45000);

  const listener = (source, method, params) => {
    if (source.tabId !== target.tabId) return;

    if (method === 'Fetch.requestPaused') {
      const responseHeaders = params.responseHeaders || [];
      const headerMap = Object.fromEntries(responseHeaders.map((header) => [header.name.toLowerCase(), header.value]));
      const url = params.request?.url || '';
      const status = params.responseStatusCode || null;
      const contentType = headerMap['content-type'] || '';
      const contentDisposition = headerMap['content-disposition'] || '';

      const shouldTryBody =
        status >= 200 &&
        status < 300 &&
        (
          contentType.toLowerCase().includes('application/pdf') ||
          contentDisposition.toLowerCase().includes('.pdf')
        );

      (async () => {
        try {
          if (shouldTryBody) {
            const bodyResult = await sendDebuggerCommand(target, 'Fetch.getResponseBody', { requestId: params.requestId });
            const bytes = bytesFromBodyResult(bodyResult);
            const mimeType = detectMimeTypeFromBytes(bytes);

            if (mimeType === 'application/pdf') {
              resolveOnce({
                finalUrl: url,
                blob: new Blob([bytes], { type: mimeType }),
                mimeType,
                fileName: withExpectedExtension(getFileNameFromUrl(url, 'captured-invoice.pdf'), mimeType)
              });
            }
          }
        } catch {
          // Ignore unreadable responses and keep the page loading.
        } finally {
          await sendDebuggerCommand(target, 'Fetch.continueRequest', { requestId: params.requestId }).catch(() => null);
        }
      })();
    }

    if (method === 'Network.responseReceived') {
      const response = params.response || {};
      const headers = response.headers || {};
      const responseInfo = {
        url: response.url || '',
        status: response.status,
        mimeType: response.mimeType || '',
        contentType: headers['content-type'] || headers['Content-Type'] || '',
        contentDisposition: headers['content-disposition'] || headers['Content-Disposition'] || ''
      };

      if (
        response.status >= 200 &&
        response.status < 300 &&
        (
          responseInfo.mimeType === 'application/pdf' ||
          responseInfo.contentType.toLowerCase().includes('application/pdf') ||
          responseInfo.contentDisposition.toLowerCase().includes('.pdf')
        )
      ) {
        candidateResponses.set(params.requestId, responseInfo);
      }
    }

    if (method === 'Network.loadingFinished') {
      if (candidateResponses.has(params.requestId)) {
        const candidate = candidateResponses.get(params.requestId);
        sendDebuggerCommand(target, 'Network.getResponseBody', { requestId: params.requestId })
          .then((bodyResult) => {
            const bytes = bytesFromBodyResult(bodyResult);
            const mimeType = detectMimeTypeFromBytes(bytes);

            if (mimeType !== 'application/pdf') return;

            resolveOnce({
              finalUrl: candidate.url,
              blob: new Blob([bytes], { type: mimeType }),
              mimeType,
              fileName: withExpectedExtension(getFileNameFromUrl(candidate.url, 'captured-invoice.pdf'), mimeType)
            });
          })
          .catch(() => null);
      }
    }
  };

  chrome.debugger.onEvent.addListener(listener);
  return {
    capturedFilePromise,
    stop: () => {
      clearTimeout(timeout);
      chrome.debugger.onEvent.removeListener(listener);
      resolveOnce(null);
    }
  };
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
  const tab = await createTab('about:blank');
  const target = { tabId: tab.id };
  let attached = false;
  let networkCapture = null;

  try {
    await attachDebugger(target);
    attached = true;

    await sendDebuggerCommand(target, 'Page.enable');
    await sendDebuggerCommand(target, 'Network.enable');
    await sendDebuggerCommand(target, 'Fetch.enable', {
      patterns: [
        { urlPattern: '*', requestStage: 'Response' }
      ]
    });
    await sendDebuggerCommand(target, 'Emulation.setEmulatedMedia', { media: 'screen' });
    networkCapture = startNetworkCapture(target);

    const completionPromise = waitForTabComplete(tab.id, 45000);
    await sendDebuggerCommand(target, 'Page.navigate', { url });
    await completionPromise;
    await delay(4000);

    const capturedNetworkFile = await Promise.race([
      networkCapture.capturedFilePromise,
      delay(1000).then(() => null)
    ]);

    if (capturedNetworkFile) {
      const currentTab = await getTab(tab.id);

      return {
        tabUrl: currentTab?.url || capturedNetworkFile.finalUrl,
        blob: capturedNetworkFile.blob,
        mimeType: capturedNetworkFile.mimeType,
        fileName: capturedNetworkFile.fileName
      };
    }

    const pdf = await sendDebuggerCommand(target, 'Page.printToPDF', {
      printBackground: true,
      paperWidth: 8.27,
      paperHeight: 11.69,
      marginTop: 0.35,
      marginBottom: 0.35,
      marginLeft: 0.35,
      marginRight: 0.35
    });
    const currentTab = await getTab(tab.id);

    return {
      tabUrl: currentTab?.url || tab.url,
      pdfBase64: pdf.data
    };
  } finally {
    if (networkCapture) networkCapture.stop();
    if (attached) {
      await sendDebuggerCommand(target, 'Fetch.disable').catch(() => null);
    }
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

async function uploadCapturedBlobViaBlob({ blob, uploadUrl, fileName }) {
  const apiBase = getApiBaseFromUploadUrl(uploadUrl);
  const contentType = getBlobContentType(blob, fileName);
  const safeFileName = withExpectedExtension(fileName || 'captured-invoice.pdf', contentType);

  const tokenResponse = await fetch(`${apiBase}/blob-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: safeFileName,
      contentType,
      size: blob.size
    })
  });

  const tokenJson = await tokenResponse.json().catch(() => null);
  if (!tokenResponse.ok || !tokenJson?.token || !tokenJson?.pathname) {
    throw new Error(tokenJson?.error || `Blob token request failed with status ${tokenResponse.status}`);
  }

  const uploadResponse = await fetch(`https://vercel.com/api/blob/?pathname=${encodeURIComponent(tokenJson.pathname)}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${tokenJson.token}`,
      'x-api-version': '12',
      'x-api-blob-request-id': createBlobRequestId(tokenJson.token),
      'x-api-blob-request-attempt': '0',
      'x-vercel-blob-access': 'public',
      'x-content-type': contentType
    },
    body: blob
  });

  const uploadJson = await uploadResponse.json().catch(() => null);
  if (!uploadResponse.ok || !uploadJson?.url) {
    throw new Error(uploadJson?.error?.message || uploadJson?.error || `Blob upload failed with status ${uploadResponse.status}`);
  }

  const processResponse = await fetch(`${apiBase}/process-blob`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: uploadJson.url,
      filename: safeFileName,
      mimeType: contentType
    })
  });

  const processJson = await processResponse.json().catch(() => null);
  if (!processResponse.ok || !processJson?.success) {
    throw new Error(processJson?.error || `Blob processing failed with status ${processResponse.status}`);
  }

  return {
    success: true,
    total: 1,
    results: [processJson.result]
  };
}

async function uploadCapturedBlobViaUploadEndpoint({ blob, uploadUrl, fileName }) {
  const contentType = getBlobContentType(blob, fileName);
  const safeFileName = withExpectedExtension(fileName || 'captured-invoice.pdf', contentType);
  const formData = new FormData();
  formData.append('invoices', blob, safeFileName);

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

async function uploadCapturedPdf({ pdfBase64, uploadUrl, fileName }) {
  const blob = base64ToBlob(pdfBase64, 'application/pdf');
  return uploadCapturedBlob({
    blob,
    uploadUrl,
    fileName: fileName || 'captured-invoice.pdf'
  });
}

async function uploadCapturedBlob({ blob, uploadUrl, fileName }) {
  try {
    return await uploadCapturedBlobViaBlob({ blob, uploadUrl, fileName });
  } catch (error) {
    console.warn('Heshbonit Blob upload failed, falling back to direct upload.', error);
    return uploadCapturedBlobViaUploadEndpoint({ blob, uploadUrl, fileName });
  }
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
    const uploadResult = captured.blob
      ? await uploadCapturedBlob({
        blob: captured.blob,
        uploadUrl: message.uploadUrl,
        fileName: captured.fileName || message.fileName
      })
      : await uploadCapturedPdf({
        pdfBase64: captured.pdfBase64,
        uploadUrl: message.uploadUrl,
        fileName: message.fileName
      });

    sendResponse({
      success: true,
      captureMethod: captured.blob ? 'browser_network_file' : 'page_print',
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


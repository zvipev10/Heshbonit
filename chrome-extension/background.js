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

function decodeHtmlAttribute(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractAutoSubmitForm(html, baseUrl) {
  const formMatch = html.match(/<form\b[^>]*>/i);
  if (!formMatch) return null;

  const formTag = formMatch[0];
  const actionMatch = formTag.match(/\baction=["']([^"']+)["']/i);
  const methodMatch = formTag.match(/\bmethod=["']([^"']+)["']/i);
  const action = actionMatch ? decodeHtmlAttribute(actionMatch[1]) : baseUrl;
  const method = (methodMatch ? methodMatch[1] : 'GET').toUpperCase();
  const fields = new URLSearchParams();

  for (const inputMatch of html.matchAll(/<input\b[^>]*>/gi)) {
    const inputTag = inputMatch[0];
    const nameMatch = inputTag.match(/\bname=["']([^"']+)["']/i);
    if (!nameMatch) continue;

    const valueMatch = inputTag.match(/\bvalue=["']([^"']*)["']/i);
    fields.append(
      decodeHtmlAttribute(nameMatch[1]),
      valueMatch ? decodeHtmlAttribute(valueMatch[1]) : ''
    );
  }

  return {
    action: new URL(action, baseUrl).href,
    method,
    fields
  };
}

async function readDirectFileResponse(response, fallbackName) {
  if (!response.ok) {
    throw new Error(`Direct file fetch failed with status ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer.slice(0, 16));
  const mimeType = detectMimeType(bytes, response.headers.get('content-type'));

  if (!mimeType) return null;

  return {
    finalUrl: response.url,
    blob: new Blob([arrayBuffer], { type: mimeType }),
    mimeType,
    fileName: withExpectedExtension(getFileNameFromUrl(response.url, fallbackName), mimeType)
  };
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
    chrome.tabs.get(tabId, (tab) => resolve(tab));
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

async function getPageSnapshot(target, tabId) {
  const tab = await getTab(tabId);
  const runtimeResult = await sendDebuggerCommand(target, 'Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const bodyText = document.body ? document.body.innerText || document.body.textContent || '' : '';
      return {
        readyState: document.readyState,
        title: document.title || '',
        bodyLength: bodyText.trim().length,
        hasPdfViewer: Boolean(document.querySelector('embed[type="application/pdf"], iframe[src*=".pdf"], pdf-viewer')),
        hasForm: Boolean(document.querySelector('form')),
        locationHref: location.href
      };
    })()`
  });

  return {
    url: tab?.url || runtimeResult.result?.value?.locationHref || '',
    status: tab?.status || '',
    ...(runtimeResult.result?.value || {})
  };
}

async function waitForPageToSettle(target, tabId, timeoutMs = 90000, stableMs = 10000) {
  const startedAt = Date.now();
  let lastSignature = '';
  let stableSince = Date.now();
  let latestSnapshot = null;

  while (Date.now() - startedAt < timeoutMs) {
    await delay(1000);

    let snapshot;
    try {
      snapshot = await getPageSnapshot(target, tabId);
    } catch {
      stableSince = Date.now();
      continue;
    }

    latestSnapshot = snapshot;
    const signature = [
      snapshot.url,
      snapshot.status,
      snapshot.readyState,
      snapshot.title,
      snapshot.bodyLength,
      snapshot.hasPdfViewer,
      snapshot.hasForm
    ].join('|');

    if (signature !== lastSignature) {
      lastSignature = signature;
      stableSince = Date.now();
      continue;
    }

    if (
      Date.now() - stableSince >= stableMs &&
      snapshot.status === 'complete' &&
      snapshot.readyState === 'complete'
    ) {
      return snapshot;
    }
  }

  return latestSnapshot;
}

function isFileLikeNetworkResponse(response) {
  const mimeType = (response.mimeType || '').toLowerCase();
  const responseUrl = (response.url || '').toLowerCase();
  const headers = response.headers || {};
  const contentDisposition = String(headers['content-disposition'] || headers['Content-Disposition'] || '').toLowerCase();

  return (
    mimeType === 'application/pdf' ||
    mimeType.startsWith('image/') ||
    mimeType === 'application/octet-stream' ||
    mimeType === 'binary/octet-stream' ||
    contentDisposition.includes('attachment') ||
    contentDisposition.includes('filename') ||
    contentDisposition.includes('.pdf') ||
    responseUrl.endsWith('.pdf') ||
    responseUrl.endsWith('.png') ||
    responseUrl.endsWith('.jpg') ||
    responseUrl.endsWith('.jpeg') ||
    responseUrl.endsWith('.webp')
  );
}

function waitForNetworkInvoiceFile(target, fallbackName, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const candidateResponses = new Map();
    let done = false;

    const finish = (file) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      chrome.debugger.onEvent.removeListener(listener);
      resolve(file);
    };

    const timeout = setTimeout(() => finish(null), timeoutMs);

    const listener = (source, method, params) => {
      if (source.tabId !== target.tabId) return;

      if (method === 'Network.responseReceived' && isFileLikeNetworkResponse(params.response)) {
        candidateResponses.set(params.requestId, {
          url: params.response.url,
          mimeType: (params.response.mimeType || '').split(';')[0].trim().toLowerCase(),
          contentType: params.response.headers?.['content-type'] || params.response.headers?.['Content-Type'] || ''
        });
      }

      if (method === 'Network.loadingFinished' && candidateResponses.has(params.requestId)) {
        const candidate = candidateResponses.get(params.requestId);
        sendDebuggerCommand(target, 'Network.getResponseBody', { requestId: params.requestId })
          .then((bodyResult) => {
            const bytes = bytesFromBodyResult(bodyResult);
            const detectedMimeType = detectMimeType(bytes, candidate.contentType || candidate.mimeType);
            if (!detectedMimeType) {
              candidateResponses.delete(params.requestId);
              return;
            }

            finish({
              finalUrl: candidate.url,
              blob: new Blob([bytes], { type: detectedMimeType }),
              mimeType: detectedMimeType,
              fileName: withExpectedExtension(getFileNameFromUrl(candidate.url, fallbackName), detectedMimeType)
            });
          })
          .catch(() => {
            candidateResponses.delete(params.requestId);
          });
      }
    };

    chrome.debugger.onEvent.addListener(listener);
  });
}

async function fetchDirectInvoiceFile(url, fallbackName) {
  const response = await fetch(url, {
    credentials: 'include',
    redirect: 'follow',
    cache: 'no-store',
    headers: {
      Accept: 'application/pdf,image/*,text/html,*/*'
    }
  });

  const directFile = await readDirectFileResponse(response, fallbackName);
  if (directFile) return directFile;

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('text/html')) {
    throw new Error('Direct fetch did not return a PDF or image file');
  }

  const html = await response.text();
  const autoSubmitForm = extractAutoSubmitForm(html, response.url);
  if (!autoSubmitForm) {
    throw new Error('Direct fetch returned HTML without an auto-submit form');
  }

  const formResponse = await fetch(
    autoSubmitForm.method === 'GET'
      ? `${autoSubmitForm.action}${autoSubmitForm.action.includes('?') ? '&' : '?'}${autoSubmitForm.fields.toString()}`
      : autoSubmitForm.action,
    {
      method: autoSubmitForm.method === 'GET' ? 'GET' : 'POST',
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        Accept: 'application/pdf,image/*,*/*',
        ...(autoSubmitForm.method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' })
      },
      body: autoSubmitForm.method === 'GET' ? undefined : autoSubmitForm.fields
    }
  );

  const formFile = await readDirectFileResponse(formResponse, fallbackName);
  if (!formFile) {
    throw new Error('Auto-submit form did not return a PDF or image file');
  }

  return formFile;
}

async function capturePagePdf(url) {
  const tab = await createTab('about:blank');
  const target = { tabId: tab.id };
  let attached = false;

  try {
    await attachDebugger(target);
    attached = true;

    await sendDebuggerCommand(target, 'Page.enable');
    await sendDebuggerCommand(target, 'Network.enable');
    await sendDebuggerCommand(target, 'Emulation.setEmulatedMedia', { media: 'screen' });

    const networkFilePromise = waitForNetworkInvoiceFile(target, 'captured-invoice.pdf', 90000);

    await sendDebuggerCommand(target, 'Page.navigate', { url });
    await waitForPageToSettle(target, tab.id);

    const networkFile = await networkFilePromise;
    if (networkFile) {
      const currentTab = await getTab(tab.id);
      return {
        tabUrl: currentTab?.url || networkFile.finalUrl,
        blob: networkFile.blob,
        mimeType: networkFile.mimeType,
        fileName: networkFile.fileName,
        captureMethod: 'browser_network_file'
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
      pdfBase64: pdf.data,
      captureMethod: 'page_print'
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
      captureMethod: captured.captureMethod || 'page_print',
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


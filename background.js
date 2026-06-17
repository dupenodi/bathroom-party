// background.js — Service worker
// Owns capture state. All audio work happens in the offscreen doc.

let isCapturing = false;
let capturedTabId = null;

async function persistCaptureState() {
  await chrome.storage.local.set({
    captureState: { isCapturing, capturedTabId }
  });
}

// Offscreen doc is the source of truth — SW memory resets when it sleeps.
async function reconcileCaptureState() {
  const exists = await offscreenExists();
  if (exists) {
    if (!isCapturing) {
      const stored = await chrome.storage.local.get(['captureState']);
      isCapturing = true;
      capturedTabId = stored.captureState?.capturedTabId ?? null;
    }
  } else if (isCapturing) {
    isCapturing = false;
    capturedTabId = null;
    await persistCaptureState();
  }
  return { isCapturing, capturedTabId };
}

reconcileCaptureState();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    reconcileCaptureState().then(sendResponse);
    return true;
  }
  if (msg.type === 'START_CAPTURE') {
    startCapture(msg.tabId, msg.settings).then(sendResponse);
    return true;
  }
  if (msg.type === 'STOP_CAPTURE') {
    stopCapture().then(sendResponse);
    return true;
  }
  if (msg.type === 'UPDATE_SETTINGS') {
    forwardToOffscreen({ type: 'OFFSCREEN_UPDATE_SETTINGS', settings: msg.settings })
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
});

async function offscreenExists() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await offscreenExists()) return;
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: ['USER_MEDIA'],
    justification: 'Bathroom reverb audio processing'
  });
  // Give it a moment to boot before we message it
  await new Promise(r => setTimeout(r, 80));
}

async function destroyOffscreen() {
  if (await offscreenExists()) {
    await chrome.offscreen.closeDocument();
  }
}

// Retry-aware messenger to offscreen
async function forwardToOffscreen(msg, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await chrome.runtime.sendMessage(msg);
      return resp;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 60));
    }
  }
}

async function startCapture(tabId, settings) {
  try {
    // Always start clean — tear down any stale offscreen
    await destroyOffscreen();

    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      });
    });

    await ensureOffscreen();

    const response = await forwardToOffscreen({ type: 'OFFSCREEN_START', streamId, settings });

    if (response?.success) {
      isCapturing = true;
      capturedTabId = tabId;
      await persistCaptureState();
      return { success: true };
    }
    await destroyOffscreen();
    return { success: false, error: response?.error || 'Audio processor failed to start' };
  } catch (err) {
    await destroyOffscreen();
    return { success: false, error: err.message };
  }
}

async function stopCapture() {
  try {
    if (await offscreenExists()) {
      try { await forwardToOffscreen({ type: 'OFFSCREEN_STOP' }); } catch (_) {}
    }
    await destroyOffscreen();
    isCapturing = false;
    capturedTabId = null;
    await persistCaptureState();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

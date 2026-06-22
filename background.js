// background.js — Service worker
// Owns capture state for every tab. All audio work happens in the offscreen doc.
// Multiple tabs can be processed at once (e.g. Spotify + YouTube); each has its
// own DSP session inside the single offscreen document.

let capturedTabs = new Set(); // tabIds currently being processed

async function persistState() {
  await chrome.storage.local.set({ capturedTabs: [...capturedTabs] });
}

// The offscreen doc is the source of truth — SW memory resets when it sleeps.
async function reconcileState() {
  if (await offscreenExists()) {
    try {
      const resp = await forwardToOffscreen({ type: 'OFFSCREEN_QUERY' });
      capturedTabs = new Set(resp?.tabs ?? []);
    } catch (_) {
      // Offscreen not answering yet — keep whatever we have
    }
  } else {
    capturedTabs = new Set();
  }
  await persistState();
  return [...capturedTabs];
}

reconcileState();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    reconcileState().then((tabs) => {
      const tabId = msg.tabId;
      sendResponse({
        isCapturing: tabId != null && capturedTabs.has(tabId),
        activeCount: tabs.length,
        tabs
      });
    });
    return true;
  }
  if (msg.type === 'START_CAPTURE') {
    startCapture(msg.tabId, msg.settings).then(sendResponse);
    return true;
  }
  if (msg.type === 'STOP_CAPTURE') {
    stopCapture(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.type === 'UPDATE_SETTINGS') {
    forwardToOffscreen({ type: 'OFFSCREEN_UPDATE_SETTINGS', settings: msg.settings })
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (msg.type === 'SESSION_ENDED') {
    // Offscreen tells us a tab's stream ended (tab closed or navigated away)
    handleSessionEnded(msg.tabId).then(() => sendResponse({ success: true }));
    return true;
  }
});

// A captured tab being closed should free its session.
chrome.tabs.onRemoved.addListener((tabId) => {
  if (capturedTabs.has(tabId)) stopCapture(tabId);
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
    // Don't tear down the offscreen doc — other tabs may be playing through it.
    await ensureOffscreen();

    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      });
    });

    const response = await forwardToOffscreen({
      type: 'OFFSCREEN_START', tabId, streamId, settings
    });

    if (response?.success) {
      capturedTabs.add(tabId);
      await persistState();
      return { success: true, activeCount: capturedTabs.size };
    }

    // Failed to start this tab; only tear down if nothing else is running.
    if (capturedTabs.size === 0) await destroyOffscreen();
    return { success: false, error: response?.error || 'Audio processor failed to start' };
  } catch (err) {
    if (capturedTabs.size === 0) await destroyOffscreen();
    return { success: false, error: err.message };
  }
}

async function stopCapture(tabId) {
  try {
    if (await offscreenExists()) {
      try { await forwardToOffscreen({ type: 'OFFSCREEN_STOP', tabId }); } catch (_) {}
    }
    capturedTabs.delete(tabId);

    // Free the offscreen document once the last tab stops.
    if (capturedTabs.size === 0) await destroyOffscreen();

    await persistState();
    return { success: true, activeCount: capturedTabs.size };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleSessionEnded(tabId) {
  capturedTabs.delete(tabId);
  if (capturedTabs.size === 0) await destroyOffscreen();
  await persistState();
}

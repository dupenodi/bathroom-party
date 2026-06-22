// background.js — Service worker
// Owns capture state for every tab. All audio work happens in the offscreen doc.
// Multiple tabs can be processed at once (e.g. Spotify + YouTube); each has its
// own DSP session inside the single offscreen document.

let capturedTabs = new Set(); // tabIds currently being processed

function broadcastState() {
  const tabs = [...capturedTabs];
  chrome.runtime.sendMessage({
    type: 'STATE_CHANGED',
    capturedTabs: tabs,
    activeCount: tabs.length
  }).catch(() => {});
  updateBadge();
}

// Toolbar badge: gold count of tabs currently in the bathroom.
function updateBadge() {
  const count = capturedTabs.size;
  try {
    chrome.action.setBadgeText({ text: count ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#c9a84c' });
    chrome.action.setBadgeTextColor?.({ color: '#0a0a08' });
  } catch (_) {}
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
  updateBadge();
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
  if (msg.type === 'GET_LEVEL') {
    // Popup visualizer poll — forward to the offscreen analyser.
    forwardToOffscreen({ type: 'OFFSCREEN_GET_LEVEL', tabId: msg.tabId })
      .then(resp => sendResponse({ level: resp?.level ?? 0 }))
      .catch(() => sendResponse({ level: 0 }));
    return true;
  }
});

// Always attempt cleanup — capturedTabs may be empty if the SW slept.
chrome.tabs.onRemoved.addListener((tabId) => {
  stopCapture(tabId);
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
  await waitForOffscreenReady();
}

async function waitForOffscreenReady(maxMs = 500) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_QUERY' });
      if (resp?.tabs !== undefined) return;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 40));
  }
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
      await reconcileState();
      broadcastState();
      return { success: true, activeCount: capturedTabs.size };
    }

    await reconcileState();
    if (capturedTabs.size === 0) await destroyOffscreen();
    return { success: false, error: response?.error || 'Audio processor failed to start' };
  } catch (err) {
    await reconcileState();
    if (capturedTabs.size === 0) await destroyOffscreen();
    return { success: false, error: err.message };
  }
}

async function stopCapture(tabId) {
  try {
    if (await offscreenExists()) {
      try { await forwardToOffscreen({ type: 'OFFSCREEN_STOP', tabId }); } catch (_) {}
    }
    await reconcileState();

    if (capturedTabs.size === 0) await destroyOffscreen();

    broadcastState();
    return { success: true, activeCount: capturedTabs.size };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleSessionEnded(_tabId) {
  await reconcileState();
  if (capturedTabs.size === 0) await destroyOffscreen();
  broadcastState();
}

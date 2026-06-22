let capturedTabs = new Set();
const tabMuteState = new Map(); // tabId -> wasMuted before we captured

function broadcastState() {
  const tabs = [...capturedTabs];
  chrome.runtime.sendMessage({
    type: 'STATE_CHANGED',
    capturedTabs: tabs,
    activeCount: tabs.length
  }).catch(() => {});
  updateBadge();
}

function updateBadge() {
  const count = capturedTabs.size;
  try {
    chrome.action.setBadgeText({ text: count ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#c9a84c' });
    chrome.action.setBadgeTextColor?.({ color: '#0a0a08' });
  } catch (_) {}
}

async function reconcileState() {
  if (await offscreenExists()) {
    try {
      const resp = await forwardToOffscreen({ type: 'OFFSCREEN_QUERY' });
      capturedTabs = new Set(resp?.tabs ?? []);
    } catch (_) {}
  } else {
    capturedTabs = new Set();
  }
  updateBadge();
  return [...capturedTabs];
}

reconcileState();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    reconcileState().then((tabs) => {
      sendResponse({
        isCapturing: msg.tabId != null && capturedTabs.has(msg.tabId),
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
    handleSessionEnded(msg.tabId).then(() => sendResponse({ success: true }));
    return true;
  }
  if (msg.type === 'GET_LEVEL') {
    forwardToOffscreen({ type: 'OFFSCREEN_GET_LEVEL', tabId: msg.tabId })
      .then(resp => sendResponse(resp ?? { level: 0, bands: [] }))
      .catch(() => sendResponse({ level: 0, bands: [] }));
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  restoreTabMute(tabId);
  stopCapture(tabId);
});

// Mute the source tab so users hear only the processed output (no double audio).
async function muteCapturedTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const wasMuted = tab.mutedInfo?.muted ?? false;
    tabMuteState.set(tabId, wasMuted);
    if (!wasMuted) await chrome.tabs.update(tabId, { muted: true });
  } catch (_) {}
}

async function restoreTabMute(tabId) {
  try {
    const wasMuted = tabMuteState.get(tabId);
    tabMuteState.delete(tabId);
    if (wasMuted === false) await chrome.tabs.update(tabId, { muted: false });
  } catch (_) {}
}

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
  if (await offscreenExists()) await chrome.offscreen.closeDocument();
}

async function forwardToOffscreen(msg, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 60));
    }
  }
}

async function startCapture(tabId, settings) {
  try {
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
      await muteCapturedTab(tabId);
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
    await restoreTabMute(tabId);
    await reconcileState();

    if (capturedTabs.size === 0) await destroyOffscreen();

    broadcastState();
    return { success: true, activeCount: capturedTabs.size };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleSessionEnded(tabId) {
  await restoreTabMute(tabId);
  await reconcileState();
  if (capturedTabs.size === 0) await destroyOffscreen();
  broadcastState();
}

let capturedTabs = new Set();
const tabMuteState = new Map(); // tabId -> wasMuted before capture

async function saveMuteState() {
  try {
    await chrome.storage.session.set({ _tabMuteState: Object.fromEntries(tabMuteState) });
  } catch (_) {}
}

async function loadMuteState() {
  try {
    const data = await chrome.storage.session.get('_tabMuteState');
    const obj = data?._tabMuteState ?? {};
    tabMuteState.clear();
    for (const [k, v] of Object.entries(obj)) tabMuteState.set(Number(k), v);
  } catch (_) {}
}

function isOffscreenGoneError(err) {
  const msg = (err?.message || String(err)).toLowerCase();
  return msg.includes('receiving end does not exist')
    || msg.includes('extension context invalidated')
    || msg.includes('message port closed');
}

async function resetCaptureState() {
  await Promise.all([...tabMuteState.entries()].map(([id, wasMuted]) =>
    wasMuted === false ? chrome.tabs.update(id, { muted: false }).catch(() => {}) : Promise.resolve()
  ));
  capturedTabs = new Set();
  tabMuteState.clear();
  await saveMuteState();
  try { await destroyOffscreen(); } catch (_) {}
  updateBadge();
}

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

(async () => {
  await loadMuteState();
  await reconcileState();
  // After a SW restart, restore mutes for tabs that were tracked but are no longer captured
  for (const [tabId] of [...tabMuteState]) {
    if (!capturedTabs.has(tabId)) await restoreTabMute(tabId);
  }
})();

chrome.runtime.onInstalled.addListener(() => {
  resetCaptureState().then(() => broadcastState()).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  reconcileState().catch(() => {});
});

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

async function muteCapturedTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const wasMuted = tab.mutedInfo?.muted ?? false;
    tabMuteState.set(tabId, wasMuted);
    await saveMuteState();
    if (!wasMuted) await chrome.tabs.update(tabId, { muted: true });
  } catch (_) {}
}

async function restoreTabMute(tabId) {
  try {
    const wasMuted = tabMuteState.get(tabId);
    tabMuteState.delete(tabId);
    await saveMuteState();
    if (wasMuted === false) await chrome.tabs.update(tabId, { muted: false });
  } catch (_) {}
}

function isRetryableCaptureError(err) {
  const msg = (err || '').toLowerCase();
  return msg.includes('invalid state')
    || msg.includes('no audio track')
    || msg.includes('could not open tab audio')
    || msg.includes('no tab audio')
    || msg.includes('start playback');
}

function getStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (!id) reject(new Error('no tab audio — start playback first'));
      else resolve(id);
    });
  });
}

async function startOffscreen(tabId, streamId, settings) {
  try {
    return await forwardToOffscreen({
      type: 'OFFSCREEN_START', tabId, streamId, settings
    });
  } catch (e) {
    if (isOffscreenGoneError(e)) {
      await resetCaptureState();
      await ensureOffscreen();
      return forwardToOffscreen({
        type: 'OFFSCREEN_START', tabId, streamId, settings
      });
    }
    throw e;
  }
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
    justification: 'Tab audio effect processing'
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
      if (!(await offscreenExists()) && msg.type !== 'OFFSCREEN_START') {
        return msg.type === 'OFFSCREEN_QUERY' ? { tabs: [] } : { success: true };
      }
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (isOffscreenGoneError(e)) {
        capturedTabs = new Set();
        if (msg.type !== 'OFFSCREEN_START') {
          try { await destroyOffscreen(); } catch (_) {}
        }
      }
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 60));
    }
  }
}

async function startCapture(tabId, settings) {
  try {
    if (tabId == null) return { success: false, error: 'no tab selected' };

    await ensureOffscreen();

    let lastError = 'Audio processor failed to start';

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 160 * attempt));

      let streamId;
      try {
        streamId = await getStreamId(tabId);
      } catch (e) {
        lastError = e.message;
        if (attempt < 2 && isRetryableCaptureError(e.message)) continue;
        return { success: false, error: lastError };
      }

      const response = await startOffscreen(tabId, streamId, settings);

      if (response?.success) {
        await muteCapturedTab(tabId);
        await reconcileState();
        broadcastState();
        return { success: true, activeCount: capturedTabs.size };
      }

      lastError = response?.error || lastError;
      if (attempt < 2 && isRetryableCaptureError(lastError)) continue;

      await restoreTabMute(tabId);
      await reconcileState();
      if (capturedTabs.size === 0) await destroyOffscreen();
      return { success: false, error: lastError };
    }

    await restoreTabMute(tabId);
    return { success: false, error: lastError };
  } catch (err) {
    await restoreTabMute(tabId);
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

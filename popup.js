const LEGACY_PRESETS = {
  bathroom: 'party', party: 'party', 'party-a': 'party', 'party-b': 'party', 'party-c': 'party',
  hall: 'hall', 'hall-a': 'hall', 'hall-b': 'hall', 'hall-c': 'hall',
  lofi: 'lofi', 'lofi-a': 'lofi', 'lofi-b': 'lofi', 'lofi-c': 'lofi'
};

const toggle     = document.getElementById('toggle');
const powerSub   = document.getElementById('powerSub');
const meter      = document.getElementById('meter');
const vizStatus  = document.getElementById('vizStatus');
const statusDot  = document.getElementById('statusDot');
const footerText = document.getElementById('footerText');
const bars       = document.getElementById('bars');
const presetsEl  = document.getElementById('presets');

const depthSlider  = document.getElementById('depthSlider');
const muffleSlider = document.getElementById('muffleSlider');
const bassSlider   = document.getElementById('bassSlider');
const depthVal     = document.getElementById('depthVal');
const muffleVal    = document.getElementById('muffleVal');
const bassVal      = document.getElementById('bassVal');
const depthName    = document.getElementById('depthName');
const muffleName   = document.getElementById('muffleName');
const bassName     = document.getElementById('bassName');
const depthHint    = document.getElementById('depthHint');
const muffleHint   = document.getElementById('muffleHint');
const bassHint     = document.getElementById('bassHint');
const resetBtn     = document.getElementById('resetBtn');
const rememberToggle = document.getElementById('rememberToggle');
const rememberText   = document.getElementById('rememberText');

const allSliders = [depthSlider, muffleSlider, bassSlider];
const barEls     = [...bars.querySelectorAll('.bar')];

let isActive    = false;
let isLoading   = false;
let ready       = false;
let activeTabId = null;
let activeCount = 0;
let host        = null;
let remember    = false;
let presetId    = DEFAULT_PRESET_ID;

const viz = { timer: null, smooth: barEls.map(() => 0) };

function currentPreset() {
  return getPresetDef(presetId);
}

function isCustomized() {
  const p = currentPreset();
  return +depthSlider.value !== p.depth ||
         +muffleSlider.value !== p.muffle ||
         +bassSlider.value !== p.bass;
}

function normalizePresetId(id) {
  if (!id) return DEFAULT_PRESET_ID;
  if (LEGACY_PRESETS[id]) return LEGACY_PRESETS[id];
  return PRESET_CATALOG.some(p => p.id === id) ? id : DEFAULT_PRESET_ID;
}

function presetUI() {
  return currentPreset().ui;
}

function refreshPowerLabels() {
  if (isLoading) return;
  const ui = presetUI();
  powerSub.textContent = isActive ? ui.on : ui.off;
  powerSub.className = isActive ? 'power-status on' : 'power-status';
  updateVizStatus();
}

function updatePresetCopy() {
  const ui = presetUI();
  depthName.textContent  = ui.sliders.depth[0];
  muffleName.textContent = ui.sliders.muffle[0];
  bassName.textContent   = ui.sliders.bass[0];
  depthHint.textContent  = ' — ' + ui.sliders.depth[1];
  muffleHint.textContent = ' — ' + ui.sliders.muffle[1];
  bassHint.textContent   = ' — ' + ui.sliders.bass[1];
  refreshPowerLabels();
}

async function init() {
  buildPresets();
  await initActiveTab();
  await loadSettings();
  updatePresetCopy();
  ready = true;
  updateVisualizer();
}

init();

async function initActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  host = hostFromUrl(tab?.url);

  if (!host) rememberToggle.style.display = 'none';
  else rememberText.textContent = 'save for ' + host;

  let state = await sendMessage({ type: 'GET_STATE', tabId: activeTabId });
  if (!state) {
    await new Promise(r => setTimeout(r, 100));
    state = await sendMessage({ type: 'GET_STATE', tabId: activeTabId });
  }
  if (!state) return;
  activeCount = state.activeCount || 0;
  setActive(!!state.isCapturing);
}

async function loadSettings() {
  const { settings, siteProfiles } = await chrome.storage.local.get(['settings', 'siteProfiles']);
  const saved = (host && siteProfiles?.[host]) || settings;
  if (saved) {
    saved.preset = normalizePresetId(saved.preset);
    applySettings(saved);
  } else {
    applyPreset(getPresetDef(DEFAULT_PRESET_ID), false);
  }
  remember = !!(host && siteProfiles?.[host]);
  refreshRemember();
  refreshUI();
}

function hostFromUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.hostname : null;
  } catch (_) { return null; }
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(resp);
    });
  });
}

function getSettings() {
  return {
    preset: presetId,
    depth:  depthSlider.value / 100,
    muffle: muffleSlider.value / 100,
    bass:   bassSlider.value / 100
  };
}

function applySettings(s) {
  const prev = presetId;
  if (s.preset) presetId = normalizePresetId(s.preset);
  if (s.depth  != null) depthSlider.value  = Math.round(s.depth  * 100);
  if (s.muffle != null) muffleSlider.value = Math.round(s.muffle * 100);
  if (s.bass   != null) bassSlider.value   = Math.round(s.bass   * 100);
  if (presetId !== prev) updatePresetCopy();
}

function saveSettings() {
  const settings = getSettings();
  if (remember && host) {
    chrome.storage.local.get(['siteProfiles'], ({ siteProfiles }) => {
      const profiles = siteProfiles || {};
      profiles[host] = settings;
      chrome.storage.local.set({ siteProfiles: profiles });
    });
  } else {
    chrome.storage.local.set({ settings });
  }
}

function pushLive() {
  if (ready && isActive) {
    chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: getSettings() });
  }
}

function buildPresets() {
  const row = document.createElement('div');
  row.className = 'preset-row';
  for (const p of PRESET_CATALOG) {
    const el = document.createElement('button');
    el.className = 'preset';
    el.type = 'button';
    el.textContent = p.label;
    el.title = p.group;
    el.dataset.id = p.id;
    el.addEventListener('click', () => onPresetClick(p));
    row.appendChild(el);
  }
  presetsEl.appendChild(row);
}

function onPresetClick(p) {
  if (p.id === presetId && !isCustomized()) return;
  applyPreset(p);
}

function applyPreset(p, persist = true) {
  const switching = p.id !== presetId;
  presetId = p.id;
  depthSlider.value  = p.depth;
  muffleSlider.value = p.muffle;
  bassSlider.value   = p.bass;
  if (switching) updatePresetCopy();
  else refreshPowerLabels();
  refreshUI();
  if (persist) {
    saveSettings();
    pushLive();
  }
}

function resetToPresetDefaults() {
  if (!isCustomized()) return;
  applyPreset(currentPreset());
}

function highlightPreset() {
  const customized = isCustomized();
  for (const el of presetsEl.querySelectorAll('.preset')) {
    el.classList.toggle('selected', el.dataset.id === presetId);
  }
  resetBtn.disabled = !customized;
  const label = currentPreset().label;
  resetBtn.title = customized
    ? `Reset sliders to ${label} defaults`
    : `${label} sliders at defaults`;
  resetBtn.setAttribute('aria-label', customized
    ? `Reset sliders to ${label} defaults`
    : `${label} sliders at defaults`);
}

function refreshRemember() {
  rememberToggle.classList.toggle('on', remember);
}

rememberToggle.addEventListener('click', () => {
  if (!host) return;
  remember = !remember;
  refreshRemember();
  if (remember) saveSettings();
  else {
    chrome.storage.local.get(['siteProfiles'], ({ siteProfiles }) => {
      if (!siteProfiles?.[host]) return;
      delete siteProfiles[host];
      chrome.storage.local.set({ siteProfiles });
    });
  }
});

function refreshUI() {
  depthVal.textContent  = depthSlider.value + '%';
  muffleVal.textContent = muffleSlider.value + '%';
  bassVal.textContent   = bassSlider.value + '%';
  allSliders.forEach(el => {
    const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
    el.style.setProperty('--fill', pct + '%');
  });
  highlightPreset();
}

function updateFooter() {
  if (isActive) {
    footerText.textContent = 'processing';
    footerText.className = 'status-text on';
  } else {
    const others = Math.max(0, activeCount - (isActive ? 1 : 0));
    if (others > 0) {
      footerText.textContent = others + (others === 1 ? ' other tab' : ' other tabs');
      footerText.className = 'status-text on';
    } else {
      footerText.textContent = 'idle';
      footerText.className = 'status-text';
    }
  }
}

function updateVizStatus(live = false) {
  const ui = presetUI();
  if (live) {
    vizStatus.textContent = ui.vizLive;
    return;
  }
  vizStatus.textContent = isActive ? ui.vizActive : ui.vizIdle;
}

function setActive(active) {
  isActive = active;
  toggle.classList.toggle('on', active);
  toggle.setAttribute('aria-checked', active ? 'true' : 'false');
  meter.classList.toggle('on', active);
  statusDot.classList.toggle('on', active);
  allSliders.forEach(s => s.classList.toggle('live', active));

  refreshPowerLabels();
  updateFooter();
  updateVisualizer();
}

function setLoading(loading, msg = '') {
  isLoading = loading;
  toggle.classList.toggle('loading', loading);
  if (msg) {
    powerSub.textContent = msg;
    powerSub.className = 'power-status';
    vizStatus.textContent = msg;
  } else {
    refreshPowerLabels();
  }
}

function formatCaptureError(raw) {
  const msg = (raw || '').toLowerCase();
  if (!raw) return 'something went wrong — try again';
  if (msg.includes('activetab') || msg.includes('gesture'))
    return 'click the page first, then try again';
  if (msg.includes('chrome://') || msg.includes('cannot access'))
    return "this page can't be captured";
  if (msg.includes('no tab') || msg.includes('invalid tab'))
    return 'tab closed — refresh and try again';
  if (msg.includes('processor') || msg.includes('offscreen'))
    return "audio didn't start — toggle off and on";
  if (msg.includes('stream') || msg.includes('not found'))
    return 'press play on the tab first';
  return "couldn't connect — click the page and try again";
}

function updateVisualizer() {
  const run = isActive && activeTabId != null;
  if (run && !viz.timer) {
    meter.classList.remove('idle');
    viz.timer = setInterval(pollLevel, 50);
  } else if (!run && viz.timer) {
    clearInterval(viz.timer);
    viz.timer = null;
    viz.smooth = barEls.map(() => 0);
    meter.classList.remove('live', 'idle');
    barEls.forEach(b => { b.style.height = ''; });
  } else if (run) {
    meter.classList.add('idle');
  }
}

async function pollLevel() {
  const resp = await sendMessage({ type: 'GET_LEVEL', tabId: activeTabId });
  const bands = resp?.bands ?? [];
  const level = resp?.level ?? 0;
  let anySignal = false;

  barEls.forEach((b, i) => {
    const target = bands[i] ?? level;
    viz.smooth[i] = viz.smooth[i] * 0.45 + target * 0.55;
    if (viz.smooth[i] > 0.03) anySignal = true;
    const h = 2 + viz.smooth[i] * 32;
    b.style.height = Math.max(2, Math.min(34, h)).toFixed(1) + 'px';
  });

  meter.classList.toggle('live', anySignal);
  meter.classList.toggle('idle', !anySignal);
  if (anySignal) updateVizStatus(true);
  else if (!isLoading) updateVizStatus();
}

window.addEventListener('unload', () => {
  if (viz.timer) clearInterval(viz.timer);
});

toggle.addEventListener('click', async () => {
  if (!ready || isLoading) return;

  const wantEnable = !isActive;
  const ui = presetUI();
  const state = await sendMessage({ type: 'GET_STATE', tabId: activeTabId });
  if (state) {
    activeCount = state.activeCount || 0;
    const capturing = !!state.isCapturing;
    if (wantEnable && capturing) { setActive(true); return; }
    if (!wantEnable && !capturing) { setActive(false); return; }
  }

  if (!wantEnable) {
    setLoading(true, ui.stopping);
    const resp = await sendMessage({ type: 'STOP_CAPTURE', tabId: activeTabId });
    setLoading(false);
    if (resp?.success) {
      activeCount = resp.activeCount ?? Math.max(0, activeCount - 1);
      setActive(false);
    } else {
      powerSub.textContent = "couldn't stop — reopen the popup";
      powerSub.className = 'power-status err';
    }
    return;
  }

  setLoading(true, ui.loading);
  if (activeTabId == null) {
    setLoading(false);
    powerSub.textContent = 'open a tab with audio first';
    powerSub.className = 'power-status err';
    return;
  }

  const resp = await sendMessage({
    type: 'START_CAPTURE',
    tabId: activeTabId,
    settings: getSettings()
  });
  setLoading(false);

  if (resp?.success) {
    activeCount = resp.activeCount ?? activeCount + 1;
    setActive(true);
  } else {
    powerSub.textContent = formatCaptureError(resp?.error);
    powerSub.className = 'power-status err';
  }
});

function onSliderInput() {
  refreshUI();
  if (!ready) return;
  saveSettings();
  pushLive();
}

allSliders.forEach(s => s.addEventListener('input', onSliderInput));
resetBtn.addEventListener('click', () => resetToPresetDefaults());

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'STATE_CHANGED') return;
  activeCount = msg.activeCount ?? 0;
  const capturing = activeTabId != null && (msg.capturedTabs ?? []).includes(activeTabId);
  if (capturing !== isActive) setActive(capturing);
  else updateFooter();
});

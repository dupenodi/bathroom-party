// popup.js

// Slider units are 0..100; stored settings are 0..1.
const DEFAULTS = { depth: 78, muffle: 65, bass: 65, room: 45 };

// Three distinct vibes — each should be immediately obvious on any source.
const PRESETS = [
  { id: 'bathroom', name: 'Bathroom Party',
    s: { depth: 78, muffle: 65, bass: 65, room: 45 } },  // signature: wall + thump
  { id: 'slow',     name: 'Slow Reverb',
    s: { depth: 92, muffle: 18, bass: 35, room: 100 } }, // lush open tail, almost no wall
  { id: 'lofi',     name: 'Lo-fi',
    s: { depth: 38, muffle: 82, bass: 42, room: 18 } }   // warm base + dedicated lo-fi DSP
];

const toggle    = document.getElementById('toggle');
const powerSub  = document.getElementById('powerSub');
const statusDot = document.getElementById('statusDot');
const footerText= document.getElementById('footerText');
const bars      = document.getElementById('bars');
const presetsEl = document.getElementById('presets');

const depthSlider  = document.getElementById('depthSlider');
const muffleSlider = document.getElementById('muffleSlider');
const bassSlider   = document.getElementById('bassSlider');
const roomSlider   = document.getElementById('roomSlider');
const depthVal     = document.getElementById('depthVal');
const muffleVal    = document.getElementById('muffleVal');
const bassVal      = document.getElementById('bassVal');
const roomVal      = document.getElementById('roomVal');
const resetBtn     = document.getElementById('resetBtn');
const rememberToggle = document.getElementById('rememberToggle');
const rememberText   = document.getElementById('rememberText');

const allSliders = [depthSlider, muffleSlider, bassSlider, roomSlider];

let isActive    = false;
let isLoading   = false;
let ready       = false;
let activeTabId = null;   // the tab this popup controls
let activeCount = 0;      // total tabs currently in the bathroom
let host        = null;   // hostname of the active tab (for per-site memory)
let remember    = false;  // is this site's profile being remembered?
let activePresetId = 'bathroom'; // drives lo-fi DSP when === 'lofi'

const viz = { timer: null }; // visualizer poll handle
const barEls    = [...bars.querySelectorAll('.bar')];
const barScale  = [0.55, 0.9, 0.7, 1.0, 0.6]; // per-bar liveliness

// ── Init ─────────────────────────────────────────────────────────────
async function init() {
  buildPresets();
  await initActiveTab();   // sets host first so settings load can be site-aware
  await loadInitialSettings();
  ready = true;
  updateVisualizer();
}

init();

async function initActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  host = hostFromUrl(tab?.url);
  if (!host) {
    rememberToggle.style.display = 'none';
  } else {
    rememberText.textContent = 'remember ' + host;
  }

  let state = await sendMessage({ type: 'GET_STATE', tabId: activeTabId });
  if (!state) {
    await new Promise(r => setTimeout(r, 100));
    state = await sendMessage({ type: 'GET_STATE', tabId: activeTabId });
  }
  if (!state) return;
  activeCount = state.activeCount || 0;
  setActive(!!state.isCapturing);
}

async function loadInitialSettings() {
  const { settings, siteProfiles } = await chrome.storage.local.get(['settings', 'siteProfiles']);
  const profile = host && siteProfiles ? siteProfiles[host] : null;

  if (profile) {
    remember = true;
    applySliderSettings(profile);
    activePresetId = profile.preset ?? null;
  } else if (settings) {
    applySliderSettings(settings);
    activePresetId = settings.preset ?? null;
  }
  syncActivePresetFromSliders();
  refreshRemember();
  refreshDisplays();
}

function hostFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname;
  } catch (_) { return null; }
}

// Promise wrapper that swallows disconnected-port errors
function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(resp);
    });
  });
}

// ── Settings <-> sliders ──────────────────────────────────────────────
function getSettings() {
  return {
    depth:  depthSlider.value  / 100,
    muffle: muffleSlider.value / 100,
    bass:   bassSlider.value   / 100,
    room:   roomSlider.value   / 100,
    preset: activePresetId
  };
}

// Accepts a 0..1 settings object and writes the sliders.
function applySliderSettings(s) {
  if (s.depth  != null) depthSlider.value  = Math.round(s.depth  * 100);
  if (s.muffle != null) muffleSlider.value = Math.round(s.muffle * 100);
  if (s.bass   != null) bassSlider.value   = Math.round(s.bass   * 100);
  if (s.room   != null) roomSlider.value   = Math.round(s.room   * 100);
}

// Persist current settings to the right place (per-site profile or global).
function persistSettings() {
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
  if (ready && activeCount > 0) {
    chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: getSettings() });
  }
}

function applyDefaults() {
  activePresetId = 'bathroom';
  applySliderSettings({
    depth:  DEFAULTS.depth  / 100,
    muffle: DEFAULTS.muffle / 100,
    bass:   DEFAULTS.bass   / 100,
    room:   DEFAULTS.room   / 100
  });
  refreshDisplays();
  persistSettings();
  pushLive();
}

// ── Presets ───────────────────────────────────────────────────────────
function buildPresets() {
  for (const p of PRESETS) {
    const el = document.createElement('button');
    el.className = 'preset';
    el.type = 'button';
    el.textContent = p.name;
    el.dataset.id = p.id;
    el.addEventListener('click', () => applyPreset(p));
    presetsEl.appendChild(el);
  }
}

function applyPreset(p) {
  activePresetId = p.id;
  depthSlider.value  = p.s.depth;
  muffleSlider.value = p.s.muffle;
  bassSlider.value   = p.s.bass;
  roomSlider.value   = p.s.room;
  refreshDisplays();
  persistSettings();
  pushLive();
}

function syncActivePresetFromSliders() {
  const cur = { depth: +depthSlider.value, muffle: +muffleSlider.value,
                bass: +bassSlider.value, room: +roomSlider.value };
  const match = PRESETS.find(p =>
    p.s.depth === cur.depth && p.s.muffle === cur.muffle &&
    p.s.bass === cur.bass && p.s.room === cur.room
  );
  if (match) activePresetId = match.id;
  else if (activePresetId && !match) activePresetId = null;
}

function highlightActivePreset() {
  syncActivePresetFromSliders();
  for (const el of presetsEl.children) {
    el.classList.toggle('selected', el.dataset.id === activePresetId);
  }
}

// ── Per-site remember toggle ──────────────────────────────────────────
function refreshRemember() {
  rememberToggle.classList.toggle('on', remember);
}

rememberToggle.addEventListener('click', () => {
  if (!host) return;
  remember = !remember;
  refreshRemember();

  if (remember) {
    persistSettings(); // snapshot current into the site profile
  } else {
    chrome.storage.local.get(['siteProfiles'], ({ siteProfiles }) => {
      if (!siteProfiles) return;
      delete siteProfiles[host];
      chrome.storage.local.set({ siteProfiles });
    });
  }
});

// ── Displays ──────────────────────────────────────────────────────────
function refreshDisplays() {
  depthVal.textContent  = depthSlider.value  + '%';
  muffleVal.textContent = muffleSlider.value + '%';
  bassVal.textContent   = bassSlider.value   + '%';
  roomVal.textContent   = roomSlider.value   + '%';
  allSliders.forEach(updateFill);
  highlightActivePreset();
}

function updateFill(el) {
  const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
  el.style.setProperty('--fill', pct + '%');
}

function otherActiveCount() {
  return Math.max(0, activeCount - (isActive ? 1 : 0));
}

function updateFooter() {
  if (isActive) {
    footerText.textContent = 'processing';
    footerText.className   = 'footer-text active';
  } else {
    const others = otherActiveCount();
    if (others > 0) {
      footerText.textContent = others + (others === 1 ? ' other tab' : ' other tabs');
      footerText.className    = 'footer-text active';
    } else {
      footerText.textContent = 'idle';
      footerText.className    = 'footer-text';
    }
  }
}

function setActive(active) {
  isActive = active;
  toggle.classList.toggle('on', active);
  statusDot.classList.toggle('active', active);
  bars.classList.toggle('active', active);

  if (active) {
    powerSub.textContent  = 'you\'re in the bathroom';
    powerSub.className    = 'power-sub on';
    allSliders.forEach(s => s.classList.add('live'));
  } else {
    powerSub.textContent  = 'off — tap to enter';
    powerSub.className    = 'power-sub';
    allSliders.forEach(s => s.classList.remove('live'));
  }
  updateFooter();
  updateVisualizer();
}

function setLoading(loading, msg = '') {
  isLoading = loading;
  toggle.classList.toggle('loading', loading);
  if (msg) {
    powerSub.textContent = msg;
    powerSub.className   = 'power-sub';
  }
}

// ── Live visualizer ───────────────────────────────────────────────────
// Polls the offscreen analyser only while this tab is active and the popup
// is open. Bars react to real output loudness; CSS animation is the fallback.
function updateVisualizer() {
  const shouldRun = isActive && activeTabId != null;
  if (shouldRun && !viz.timer) {
    bars.classList.add('live-meter'); // JS drives heights; disables CSS animation
    viz.timer = setInterval(pollLevel, 90);
  } else if (!shouldRun && viz.timer) {
    clearInterval(viz.timer);
    viz.timer = null;
    bars.classList.remove('live-meter');
    barEls.forEach(b => { b.style.height = ''; });
  }
}

async function pollLevel() {
  const resp = await sendMessage({ type: 'GET_LEVEL', tabId: activeTabId });
  const level = resp?.level ?? 0;
  barEls.forEach((b, i) => {
    const h = 2 + level * 11 * barScale[i % barScale.length];
    b.style.height = Math.max(2, Math.min(12, h)).toFixed(1) + 'px';
  });
}

window.addEventListener('unload', () => {
  if (viz.timer) clearInterval(viz.timer);
});

// ── Toggle click ─────────────────────────────────────────────────────
toggle.addEventListener('click', async () => {
  if (!ready || isLoading) return;

  const wantEnable = !isActive; // user intent before any background sync

  const state = await sendMessage({ type: 'GET_STATE', tabId: activeTabId });
  if (state) {
    activeCount = state.activeCount || 0;
    const actuallyCapturing = !!state.isCapturing;
    // Already in the desired state — just fix UI drift
    if (wantEnable && actuallyCapturing) { setActive(true); return; }
    if (!wantEnable && !actuallyCapturing) { setActive(false); return; }
  }

  if (!wantEnable) {
    setLoading(true, 'stepping out...');
    const resp = await sendMessage({ type: 'STOP_CAPTURE', tabId: activeTabId });
    setLoading(false);
    if (resp?.success) {
      activeCount = resp.activeCount ?? Math.max(0, activeCount - 1);
      setActive(false);
    } else {
      powerSub.textContent = 'error stopping';
      powerSub.className   = 'power-sub err';
    }
    return;
  }

  setLoading(true, 'finding the bathroom...');

  if (activeTabId == null) {
    setLoading(false);
    powerSub.textContent = 'no active tab';
    powerSub.className   = 'power-sub err';
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
    let msg = resp?.error || 'unknown error';
    if (msg.includes('activeTab') || msg.includes('gesture'))
      msg = 'click on the page first, then try again';
    else if (msg.includes('Cannot access') || msg.includes('chrome://'))
      msg = 'can\'t capture this tab type';
    else if (msg.includes('already') || msg.includes('capture'))
      msg = 'already captured — disable & retry';

    powerSub.textContent = msg;
    powerSub.className   = 'power-sub err';
  }
});

// ── Slider live updates ───────────────────────────────────────────────
function onSliderInput() {
  refreshDisplays();
  if (!ready) return;
  persistSettings();
  pushLive();
}

allSliders.forEach(s => s.addEventListener('input', onSliderInput));

resetBtn.addEventListener('click', applyDefaults);

// Stay in sync when a tab's capture ends (navigation, close, etc.)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'STATE_CHANGED') return;
  activeCount = msg.activeCount ?? 0;
  const capturing = activeTabId != null && (msg.capturedTabs ?? []).includes(activeTabId);
  if (capturing !== isActive) setActive(capturing);
  else updateFooter();
});

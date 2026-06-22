// popup.js

const DEFAULTS = { depth: 78, muffle: 65, bass: 65 };

const toggle    = document.getElementById('toggle');
const powerSub  = document.getElementById('powerSub');
const sliders   = document.getElementById('sliders');
const statusDot = document.getElementById('statusDot');
const footerText= document.getElementById('footerText');
const bars      = document.getElementById('bars');

const depthSlider  = document.getElementById('depthSlider');
const muffleSlider = document.getElementById('muffleSlider');
const bassSlider   = document.getElementById('bassSlider');
const depthVal     = document.getElementById('depthVal');
const muffleVal    = document.getElementById('muffleVal');
const bassVal      = document.getElementById('bassVal');
const resetBtn     = document.getElementById('resetBtn');

let isActive    = false;
let isLoading   = false;
let activeTabId = null;   // the tab this popup controls
let activeCount = 0;      // total tabs currently in the bathroom

// ── Init ─────────────────────────────────────────────────────────────
chrome.storage.local.get(['settings'], ({ settings }) => {
  if (settings) {
    depthSlider.value  = Math.round(settings.depth  * 100);
    muffleSlider.value = Math.round(settings.muffle * 100);
    bassSlider.value   = Math.round(settings.bass   * 100);
  }
  refreshDisplays();
});

initActiveTab();

async function initActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;

  const state = await sendMessage({ type: 'GET_STATE', tabId: activeTabId });
  if (!state) return;
  activeCount = state.activeCount || 0;
  setActive(!!state.isCapturing);
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

// ── Helpers ───────────────────────────────────────────────────────────
function getSettings() {
  return {
    depth:  depthSlider.value  / 100,
    muffle: muffleSlider.value / 100,
    bass:   bassSlider.value   / 100
  };
}

function applyDefaults() {
  depthSlider.value  = DEFAULTS.depth;
  muffleSlider.value = DEFAULTS.muffle;
  bassSlider.value   = DEFAULTS.bass;
  refreshDisplays();

  const settings = getSettings();
  chrome.storage.local.set({ settings });

  if (isActive) {
    chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings });
  }
}

function refreshDisplays() {
  depthVal.textContent  = depthSlider.value  + '%';
  muffleVal.textContent = muffleSlider.value + '%';
  bassVal.textContent   = bassSlider.value   + '%';

  // Track fill: --fill CSS var drives the gradient in .live class
  updateFill(depthSlider);
  updateFill(muffleSlider);
  updateFill(bassSlider);
}

function updateFill(el) {
  const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
  el.style.setProperty('--fill', pct + '%');
}

// How many OTHER tabs are active besides this one
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
  sliders.classList.toggle('locked', !active);
  statusDot.classList.toggle('active', active);
  bars.classList.toggle('active', active);

  if (active) {
    powerSub.textContent  = 'you\'re in the bathroom';
    powerSub.className    = 'power-sub on';
    [depthSlider, muffleSlider, bassSlider].forEach(s => s.classList.add('live'));
  } else {
    powerSub.textContent  = 'off — tap to enter';
    powerSub.className    = 'power-sub';
    [depthSlider, muffleSlider, bassSlider].forEach(s => s.classList.remove('live'));
  }
  updateFooter();
}

function setLoading(loading, msg = '') {
  isLoading = loading;
  toggle.classList.toggle('loading', loading);
  if (msg) {
    powerSub.textContent = msg;
    powerSub.className   = 'power-sub';
  }
}

// ── Toggle click ─────────────────────────────────────────────────────
toggle.addEventListener('click', async () => {
  if (isLoading) return;

  // Re-sync with the real per-tab state before acting (SW may have slept)
  const state = await sendMessage({ type: 'GET_STATE', tabId: activeTabId });
  if (state) {
    activeCount = state.activeCount || 0;
    if (!!state.isCapturing !== isActive) setActive(!!state.isCapturing);
  }

  if (isActive) {
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
// Settings are global — they apply to every tab currently in the bathroom.
function onSliderInput() {
  refreshDisplays();

  const settings = getSettings();
  chrome.storage.local.set({ settings });

  if (activeCount > 0) {
    chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings });
  }
}

depthSlider.addEventListener('input',  onSliderInput);
muffleSlider.addEventListener('input', onSliderInput);
bassSlider.addEventListener('input',   onSliderInput);

resetBtn.addEventListener('click', applyDefaults);

refreshDisplays();

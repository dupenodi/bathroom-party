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

let isActive  = false;
let isLoading = false;

// ── Init ─────────────────────────────────────────────────────────────
chrome.storage.local.get(['settings'], ({ settings }) => {
  if (settings) {
    depthSlider.value  = Math.round(settings.depth  * 100);
    muffleSlider.value = Math.round(settings.muffle * 100);
    bassSlider.value   = Math.round(settings.bass   * 100);
  }
  refreshDisplays();
});

chrome.runtime.sendMessage({ type: 'GET_STATE' }, (resp) => {
  if (chrome.runtime.lastError) return;
  if (resp?.isCapturing) setActive(true);
});

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

function setActive(active) {
  isActive = active;
  toggle.classList.toggle('on', active);
  sliders.classList.toggle('locked', !active);
  statusDot.classList.toggle('active', active);
  bars.classList.toggle('active', active);

  if (active) {
    powerSub.textContent  = 'you\'re in the bathroom';
    powerSub.className    = 'power-sub on';
    footerText.textContent = 'processing';
    footerText.className   = 'footer-text active';
    // Give sliders the live fill treatment
    [depthSlider, muffleSlider, bassSlider].forEach(s => s.classList.add('live'));
  } else {
    powerSub.textContent  = 'off — tap to enter';
    powerSub.className    = 'power-sub';
    footerText.textContent = 'idle';
    footerText.className   = 'footer-text';
    [depthSlider, muffleSlider, bassSlider].forEach(s => s.classList.remove('live'));
  }
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

  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  const actuallyCapturing = !chrome.runtime.lastError && state?.isCapturing;
  if (actuallyCapturing !== isActive) setActive(actuallyCapturing);

  if (actuallyCapturing) {
    setLoading(true, 'stepping out...');
    const resp = await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
    setLoading(false);
    if (resp?.success) {
      setActive(false);
    } else {
      powerSub.textContent = 'error stopping';
      powerSub.className   = 'power-sub err';
    }
    return;
  }

  setLoading(true, 'finding the bathroom...');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setLoading(false);
    powerSub.textContent = 'no active tab';
    powerSub.className   = 'power-sub err';
    return;
  }

  const resp = await chrome.runtime.sendMessage({
    type: 'START_CAPTURE',
    tabId: tab.id,
    settings: getSettings()
  });

  setLoading(false);

  if (resp?.success) {
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
// These fire on every input event (continuous drag) and immediately
// update the running audio nodes via offscreen message
function onSliderInput(e) {
  refreshDisplays();
  if (!isActive) return;

  const settings = getSettings();
  chrome.storage.local.set({ settings });

  // Send directly — background forwards to offscreen which updates nodes in-place
  chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings });
}

depthSlider.addEventListener('input',  onSliderInput);
muffleSlider.addEventListener('input', onSliderInput);
bassSlider.addEventListener('input',   onSliderInput);

resetBtn.addEventListener('click', applyDefaults);

refreshDisplays();

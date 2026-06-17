// offscreen.js — Audio DSP chain lives here
// Receives messages from background.js via chrome.runtime

let audioCtx = null;
let sourceNode = null;
let mediaStream = null;

// DSP nodes — kept as module-level refs so applySettings can reach them live
let lowpassNode   = null;
let bassBoostNode = null;
let hiCutNode     = null;   // second lowpass for steeper roll-off
let convolverNode = null;
let dryGainNode   = null;
let wetGainNode   = null;
let compNode      = null;   // post-reverb compressor — keeps volume consistent
let masterGainNode = null;

let currentSettings = {
  depth:  0.78,
  bass:   0.65,
  muffle: 0.65
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_START') {
    startProcessing(msg.streamId, msg.settings)
      .then(() => sendResponse({ success: true }))
      .catch(e  => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (msg.type === 'OFFSCREEN_STOP') {
    stopProcessing();
    sendResponse({ success: true });
    return true;
  }
  if (msg.type === 'OFFSCREEN_UPDATE_SETTINGS') {
    // THIS is the live-update path — directly mutates running nodes
    if (msg.settings) {
      currentSettings = { ...currentSettings, ...msg.settings };
      applySettings();
    }
    sendResponse({ success: true });
    return true;
  }
});

async function startProcessing(streamId, settings) {
  if (settings) currentSettings = { ...currentSettings, ...settings };

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  audioCtx = new AudioContext({ sampleRate: 44100 });

  // Resume in case browser suspended it
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  sourceNode = audioCtx.createMediaStreamSource(mediaStream);

  buildDSPChain();
  applySettings();
}

function buildDSPChain() {
  const ctx = audioCtx;

  // ── Filter chain (wet path) ──────────────────────────────────────────
  // 1. First lowpass — main muffling
  lowpassNode = ctx.createBiquadFilter();
  lowpassNode.type = 'lowpass';
  lowpassNode.Q.value = 0.9;

  // 2. Second lowpass in series — steeper roll-off for convincing wall effect
  hiCutNode = ctx.createBiquadFilter();
  hiCutNode.type = 'lowpass';
  hiCutNode.frequency.value = 2200;
  hiCutNode.Q.value = 0.5;

  // 3. Bass shelf boost — the kick/bass thumps through walls
  bassBoostNode = ctx.createBiquadFilter();
  bassBoostNode.type = 'lowshelf';
  bassBoostNode.frequency.value = 90;

  // ── Reverb ───────────────────────────────────────────────────────────
  convolverNode = ctx.createConvolver();
  convolverNode.buffer = generateBathroomIR(ctx);

  // ── Gain nodes ───────────────────────────────────────────────────────
  wetGainNode  = ctx.createGain();
  dryGainNode  = ctx.createGain();

  // Post-mix dynamics compressor: evens out level spikes from reverb
  // Keeps perceived volume consistent regardless of effect depth
  compNode = ctx.createDynamicsCompressor();
  compNode.threshold.value = -18;
  compNode.knee.value      =  8;
  compNode.ratio.value     =  4;
  compNode.attack.value    =  0.004;
  compNode.release.value   =  0.18;

  // Makeup gain after compression to restore perceived loudness
  masterGainNode = ctx.createGain();
  masterGainNode.gain.value = 1.6;

  // ── Routing ──────────────────────────────────────────────────────────
  //
  //  source ─┬─► lowpass ─► hiCut ─► bass ─► convolver ─► wetGain ─┐
  //          │                                                       ├─► compressor ─► master ─► out
  //          └─────────────────────────────────────────► dryGain ───┘
  //
  // The dry path passes unfiltered signal (tiny amount) so there's
  // just a ghost of the original — like sound sneaking under the door.

  sourceNode.connect(lowpassNode);
  lowpassNode.connect(hiCutNode);
  hiCutNode.connect(bassBoostNode);
  bassBoostNode.connect(convolverNode);
  convolverNode.connect(wetGainNode);
  wetGainNode.connect(compNode);

  sourceNode.connect(dryGainNode);
  dryGainNode.connect(compNode);

  compNode.connect(masterGainNode);
  masterGainNode.connect(ctx.destination);
}

function applySettings() {
  if (!audioCtx || !lowpassNode) return;

  const t   = audioCtx.currentTime;
  const tau = 0.04; // smooth transition constant (40ms)
  const { depth, bass, muffle } = currentSettings;

  // ── Wet/dry mix ─────────────────────────────────────────────────────
  // wet: 0.55–1.1, dry: 0.18–0.0
  // At full depth: almost all wet, dry vanishes
  const wetLevel = 0.55 + depth * 0.55;
  const dryLevel = 0.18 * (1 - depth * 0.95);
  wetGainNode.gain.setTargetAtTime(wetLevel, t, tau);
  dryGainNode.gain.setTargetAtTime(dryLevel, t, tau);

  // ── Lowpass cutoff ──────────────────────────────────────────────────
  // muffle=0 → 1600Hz (mild), muffle=1 → 380Hz (deep in the stall)
  const lpFreq = 1600 - muffle * 1220;
  lowpassNode.frequency.setTargetAtTime(lpFreq, t, tau);

  // ── Bass shelf gain ─────────────────────────────────────────────────
  // bass=0 → +3dB, bass=1 → +14dB (real thump)
  const bassGain = 3 + bass * 11;
  bassBoostNode.gain.setTargetAtTime(bassGain, t, tau);

  // ── Master makeup gain ──────────────────────────────────────────────
  // Slightly bump master when dry signal is low so volume stays stable
  const makeup = 1.4 + depth * 0.35;
  masterGainNode.gain.setTargetAtTime(makeup, t, tau);
}

function stopProcessing() {
  try {
    if (sourceNode)    { sourceNode.disconnect(); sourceNode = null; }
    if (audioCtx)      { audioCtx.close();       audioCtx   = null; }
    if (mediaStream)   { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  } catch (_) {}
  lowpassNode = hiCutNode = bassBoostNode = convolverNode = null;
  wetGainNode = dryGainNode = compNode = masterGainNode = null;
}

// ── Bathroom IR generator ──────────────────────────────────────────────
// Models a small tiled room (~2.5m²): dense early reflections at 6–15ms,
// bright initial decay, rapid high-frequency absorption, ~0.9s total decay
function generateBathroomIR(ctx) {
  const sr     = ctx.sampleRate;
  const dur    = 0.9;             // slightly longer for more 'room' feel
  const length = Math.floor(sr * dur);
  const ir     = ctx.createBuffer(2, length, sr);

  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);

    for (let i = 0; i < length; i++) {
      const t = i / sr;

      // White noise base
      let s = Math.random() * 2 - 1;

      // Early reflections: dense cluster 6–18ms (tile walls close together)
      const er = t < 0.018
        ? Math.exp(-t * 140) * 2.2
        : 0;

      // Main exponential decay — tuned for a ~0.9s RT60
      const decay = Math.exp(-t * 7.5);

      // High-frequency air absorption: tiles reflect highs but air absorbs them
      // Approximate by rolling off a portion of the signal at higher time values
      const hfDamp = t > 0.05
        ? Math.pow(0.5, t * 5.5)   // HF content halves roughly every 125ms
        : 1.0;

      // Combine: early reflections bright, tail increasingly dull
      const hfComponent = s * decay * hfDamp;
      const lfComponent = s * decay;
      s = hfComponent * 0.4 + lfComponent * 0.6;

      data[i] = (s + er * (Math.random() * 2 - 1)) * 0.28;
    }

    // Right channel: slight delay (~0.7ms = 30 samples) for stereo width
    // Simulates slightly different path lengths to left/right ear in a room
    if (ch === 1) {
      const delay = 30;
      for (let i = length - 1; i >= delay; i--) {
        data[i] = data[i] * 0.8 + data[i - delay] * 0.2;
      }
      // Also slightly attenuate to simulate asymmetric room shape
      for (let i = 0; i < length; i++) data[i] *= 0.88;
    }
  }

  return ir;
}

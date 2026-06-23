const WOW_DELAY_MAX = 0.04;
const HALL_PRE_DELAY_MAX = 0.14;

const sessions = new Map();
// Track which AudioContexts have had the worklet module loaded.
// A singleton promise breaks when the AudioContext is closed and recreated —
// the old resolved promise prevents addModule being called on the new context.
const workletContexts = new WeakSet();

let currentSettings = {
  preset: DEFAULT_PRESET_ID,
  depth: 0.55,
  muffle: 0.60,
  bass: 0.60
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (payload) => {
    try { sendResponse(payload); } catch (_) {}
  };

  try {
    if (msg.type === 'OFFSCREEN_START') {
      startProcessing(msg.tabId, msg.streamId, msg.settings)
        .then(() => reply({ success: true }))
        .catch(e => reply({ success: false, error: e?.message || 'start failed' }));
      return true;
    }
    if (msg.type === 'OFFSCREEN_STOP') {
      stopProcessing(msg.tabId)
        .then(() => reply({ success: true }))
        .catch(e => reply({ success: false, error: e?.message || 'stop failed' }));
      return true;
    }
    if (msg.type === 'OFFSCREEN_UPDATE_SETTINGS') {
      if (msg.settings) {
        currentSettings = { ...currentSettings, ...msg.settings };
        for (const session of sessions.values()) syncSession(session);
      }
      reply({ success: true });
      return true;
    }
    if (msg.type === 'OFFSCREEN_QUERY') {
      reply({ tabs: [...sessions.keys()] });
      return true;
    }
    if (msg.type === 'OFFSCREEN_GET_LEVEL') {
      reply(readMeter(msg.tabId));
      return true;
    }
  } catch (e) {
    reply({ success: false, error: e?.message || 'offscreen handler error' });
    return true;
  }
});

async function ensureWorklet(ctx) {
  if (!workletContexts.has(ctx)) {
    await ctx.audioWorklet.addModule(chrome.runtime.getURL('pitch-processor.js'));
    workletContexts.add(ctx);
  }
}

async function startProcessing(tabId, streamId, settings) {
  if (tabId == null || !streamId) throw new Error('invalid capture request');

  await stopProcessing(tabId, true);
  if (settings) currentSettings = { ...currentSettings, ...settings };

  let mediaStream;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false
    });
  } catch (e) {
    const raw = e?.message || '';
    if (raw.includes('Invalid state') || raw.includes('invalid state'))
      throw new Error('stream expired — toggle off and on');
    if (raw.includes('Error starting capture') || raw.includes('Could not start'))
      throw new Error('no tab audio — start playback first');
    throw new Error(raw || 'could not open tab audio');
  }

  const track = mediaStream.getAudioTracks()[0];
  if (!track) {
    mediaStream.getTracks().forEach(tr => tr.stop());
    throw new Error('no audio track in tab stream');
  }

  const nativeRate = track.getSettings?.().sampleRate;
  const audioCtx = nativeRate
    ? new AudioContext({ sampleRate: nativeRate, latencyHint: 'playback' })
    : new AudioContext({ latencyHint: 'playback' });

  try {
    await ensureWorklet(audioCtx);
  } catch (e) {
    mediaStream.getTracks().forEach(tr => tr.stop());
    await audioCtx.close().catch(() => {});
    throw new Error(e?.message || 'audio processor failed to load');
  }

  const session = { tabId, audioCtx, mediaStream, nodes: [] };
  session.sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  buildEngine(session);
  applyEngineSettings(session);
  sessions.set(tabId, session);

  await ensureRunning(audioCtx);
  audioCtx.addEventListener('statechange', () => {
    if (audioCtx.state === 'suspended') ensureRunning(audioCtx);
  });

  track.addEventListener('ended', () => {
    stopProcessing(tabId).finally(() => {
      try { chrome.runtime.sendMessage({ type: 'SESSION_ENDED', tabId }); } catch (_) {}
    });
  });
}

function syncSession(s) {
  const presetId = currentSettings.preset ?? s.presetId ?? DEFAULT_PRESET_ID;
  const family = getPresetFamily(presetId);
  if (family !== s.family) buildEngine(s);
  applyEngineSettings(s);
}

async function ensureRunning(ctx, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    if (ctx.state === 'running' || ctx.state === 'closed') return;
    try { await ctx.resume(); } catch (_) {}
    if (ctx.state === 'running') return;
    await new Promise(r => setTimeout(r, 70));
  }
}

function buildEngine(s) {
  stopWow(s);
  try { s.sourceNode?.disconnect(); } catch (_) {}
  try { s.inputTrim?.disconnect(); } catch (_) {}
  try { s.fadeGain?.disconnect(); } catch (_) {}
  s.nodes = [];

  const presetId = currentSettings.preset ?? DEFAULT_PRESET_ID;
  s.presetId = presetId;
  s.family = getPresetFamily(presetId);

  const ctx = s.audioCtx;
  s.inputTrim = gain(ctx, 1);
  s.fadeGain = gain(ctx, 1);
  s.limiter = ctx.createDynamicsCompressor();
  s.limiter.threshold.value = -6;
  s.limiter.knee.value = 10;
  s.limiter.ratio.value = 3;
  s.limiter.attack.value = 0.005;
  s.limiter.release.value = 0.12;
  s.analyser = ctx.createAnalyser();
  s.analyser.fftSize = 512;
  s.analyser.smoothingTimeConstant = 0.35;

  s.fadeGain.connect(s.limiter);
  s.limiter.connect(ctx.destination);
  s.limiter.connect(s.analyser);

  if (s.family === 'nightcore') buildNightcoreEngine(s);
  else if (s.family === 'hall') buildHallEngine(s);
  else if (s.family === 'lofi') buildLofiEngine(s);
  else buildBathroomEngine(s);

  s.sourceNode.connect(s.inputTrim);
}

function makePitchNode(ctx, pitch) {
  return new AudioWorkletNode(ctx, 'pitch-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    parameterData: { pitch: clamp(pitch, 0.5, 2.0) }
  });
}

// ─────────────────────────────────────────────────
// BATHROOM — through-the-wall room reverb
//
// Signal path:
//   bass (LP 130Hz)                              → bassGain → mix
//   mids/highs (HP 130Hz) → wallLP (muffle) → bodyGain → mix
//   full → preDelay → conv (bathroom IR) → revLP → wetGain → mix
// ─────────────────────────────────────────────────
function buildBathroomEngine(s) {
  const ctx = s.audioCtx;

  // bass split — lows travel through walls with little attenuation
  s.bassLP = filter(ctx, 'lowpass', 130, 0.6);
  s.bassGain = gain(ctx);

  // mid/hi body — goes through a wall LP (muffle control)
  s.bodyHP = filter(ctx, 'highpass', 130, 0.6);
  s.wallLP = filter(ctx, 'lowpass', 3500, 0.55);
  s.bodyGain = gain(ctx);

  // reverb — full range into pre-delay then convolver
  s.revPreDelay = ctx.createDelay(0.06);
  s.revPreDelay.delayTime.value = 0.015;
  s.convolver = ctx.createConvolver();
  s.convolver.normalize = false;
  s.convolver.buffer = buildBathroomIR(ctx);
  s.revLP = filter(ctx, 'lowpass', 6000, 0.5);
  s.wetGain = gain(ctx);

  s.mixGain = gain(ctx, 1);

  wire(s.inputTrim, s.bassLP, s.bassGain, s.mixGain);
  wire(s.inputTrim, s.bodyHP, s.wallLP, s.bodyGain, s.mixGain);
  wire(s.inputTrim, s.revPreDelay, s.convolver, s.revLP, s.wetGain, s.mixGain);
  wire(s.mixGain, s.fadeGain);
}

// ─────────────────────────────────────────────────
// HALL — large reverberant space
//
// Signal path:
//   dry → dryGain → mix
//   → preDelay → hallHP → 4 Schroeder combs → combBus → dampLP → earlyGain → mix
//   → preDelay → hallHP → conv (long hall IR) → convWet → mix
// ─────────────────────────────────────────────────
function buildHallEngine(s) {
  const ctx = s.audioCtx;
  const sr = ctx.sampleRate;
  const scale = sr / 44100;

  s.dryGain = gain(ctx);
  s.mixGain = gain(ctx);

  s.preDelayMax = HALL_PRE_DELAY_MAX;
  s.preDelay = ctx.createDelay(HALL_PRE_DELAY_MAX);
  s.preDelay.delayTime.value = 0.072;

  s.hallHP = filter(ctx, 'highpass', 80, 0.5);
  s.dampLP = filter(ctx, 'lowpass', 5000, 0.5);
  s.earlyGain = gain(ctx);

  s.combBus = gain(ctx);
  const combTimes = [0.0297, 0.0371, 0.0417, 0.0443, 0.0517, 0.0561];
  s._combInputs = [];
  for (const base of combTimes) {
    const comb = makeComb(ctx, base * scale, 0.76, 3600);
    comb.output.connect(s.combBus);
    s._combInputs.push(comb.input);
  }

  s.hallConv = ctx.createConvolver();
  s.hallConv.normalize = false;
  s.hallConv.buffer = buildHallIR(ctx);
  s.convWet = gain(ctx);

  wire(s.inputTrim, s.dryGain, s.mixGain);
  wire(s.inputTrim, s.preDelay, s.hallHP);
  wire(s.combBus, s.dampLP, s.earlyGain, s.mixGain);
  wire(s.hallHP, s.hallConv, s.convWet, s.mixGain);
  wire(s.mixGain, s.fadeGain);
  for (const inp of s._combInputs) s.hallHP.connect(inp);
}

// ─────────────────────────────────────────────────
// LO-FI — degraded tape / vinyl
//
// Signal path:
//   → hipassHP (remove sub rumble)
//   → warmLP (roll off highs like tape)
//   → tapeWarm (mid warmth bump)
//   → wowDelay (flutter) + wowDry → wowBus
//   → crush (bit reduction) → lofiGain → mix
//   hiss → hissHP → hissGain → mix
// ─────────────────────────────────────────────────
function buildLofiEngine(s) {
  const ctx = s.audioCtx;
  const profile = PRESET_DSP.lofi;

  s.hipassHP = filter(ctx, 'highpass', 80, 0.6);
  s.warmLP = filter(ctx, 'lowpass', 3500, 0.55);
  s.tapeWarm = filter(ctx, 'peaking', 380, 0.6);
  s.tapeWarm.gain.value = 3;

  s.wowDelayMax = WOW_DELAY_MAX;
  s.wowDelay = ctx.createDelay(WOW_DELAY_MAX);
  s.wowDelay.delayTime.value = 0.008;
  s.wowDry = gain(ctx, 0.6);
  s.wowWet = gain(ctx, 0.5);
  s.wowBus = gain(ctx);

  s.crush = ctx.createWaveShaper();
  s.crush.curve = makeCrushCurve(profile.crushBits);
  s.crush.oversample = '2x';

  s.lofiGain = gain(ctx);
  s.mixGain = gain(ctx);

  s.hiss = makeHiss(ctx, profile.seed);
  s.hissHP = filter(ctx, 'highpass', 3200, 0.7);
  s.hissGain = gain(ctx, profile.hiss);

  wire(s.inputTrim, s.hipassHP, s.warmLP, s.tapeWarm);
  s.tapeWarm.connect(s.wowDelay);
  s.tapeWarm.connect(s.wowDry);
  wire(s.wowDelay, s.wowWet, s.wowBus);
  wire(s.wowDry, s.wowBus);
  wire(s.wowBus, s.crush, s.lofiGain, s.mixGain);
  wire(s.hiss, s.hissHP, s.hissGain, s.mixGain);
  wire(s.mixGain, s.fadeGain);

  s.hiss.start(0);
  startWow(s);
}

// ─────────────────────────────────────────────────
// NIGHTCORE — pitch shift only (tempo unchanged), bright anime EQ
// Uses OLA pitch processor: voices sound higher, song speed stays the same
// ─────────────────────────────────────────────────
function buildNightcoreEngine(s) {
  const ctx = s.audioCtx;
  const profile = PRESET_DSP[s.presetId] ?? PRESET_DSP.nightcore;

  s.pitchNode = makePitchNode(ctx, profile.baseRate);
  s.ncBright  = filter(ctx, 'highshelf', profile.brightHz, 0.7);
  s.ncBright.gain.value = 0;
  s.ncBody = gain(ctx);
  s.ncMix  = gain(ctx);

  wire(s.inputTrim, s.pitchNode, s.ncBright, s.ncBody, s.ncMix, s.fadeGain);
}

// ─────────────────────────────────────────────────
// SETTINGS APPLICATION
// ─────────────────────────────────────────────────
function applyEngineSettings(s) {
  if (!s?.audioCtx) return;
  const t = s.audioCtx.currentTime;
  const tau = 0.05;
  const { depth, muffle, bass, preset: presetIn } = currentSettings;
  const presetId = presetIn ?? s.presetId ?? DEFAULT_PRESET_ID;
  s.presetId = presetId;

  const d = clamp01(depth);
  const m = clamp01(muffle);
  const b = clamp01(bass);

  if (s.family === 'party') applyBathroomSettings(s, t, tau, d, m, b);
  else if (s.family === 'hall') applyHallSettings(s, t, tau, d, m, b);
  else if (s.family === 'lofi') applyLofiSettings(s, t, tau, d, m, b);
  else if (s.family === 'nightcore') applyNightcoreSettings(s, t, tau, d, m, b);
}

function applyBathroomSettings(s, t, tau, d, m, b) {
  // wallLP cutoff: muffle=0 → 4000Hz (thin wall), muffle=1 → 300Hz (thick concrete)
  const wallHz = 4000 - m * 3700;
  setFreq(s.wallLP, wallHz, t, tau, s.audioCtx);

  // bass passes through walls well, scaled by bass slider
  s.bassGain.gain.setTargetAtTime(0.5 + b * 0.8, t, tau);

  // body: stays mostly present; depth reduces it (you're farther away)
  s.bodyGain.gain.setTargetAtTime(0.9 - d * 0.45, t, tau);

  // reverb: depth drives how much room sound you hear
  s.wetGain.gain.setTargetAtTime(0.05 + d * 0.65, t, tau);

  // mix unity — limiter handles any peaks
  s.mixGain.gain.setTargetAtTime(0.85, t, tau);
}

function applyHallSettings(s, t, tau, d, m, b) {
  const profile = PRESET_DSP.hall;
  setDelay(s.preDelay, s.preDelayMax ?? HALL_PRE_DELAY_MAX, 0.04 + d * 0.08, t, tau);

  s.dryGain.gain.setTargetAtTime(0.65 - d * 0.5, t, tau);
  s.earlyGain.gain.setTargetAtTime(0.15 + d * 0.6, t, tau);
  s.convWet.gain.setTargetAtTime(0.08 + d * 0.55, t, tau);

  // dampLP: muffle=0 → bright 6kHz, muffle=1 → dark 800Hz
  setFreq(s.dampLP, 6000 - m * 5200, t, tau, s.audioCtx);

  // bass slider cuts low mud in a big hall
  s.hallHP.frequency.setTargetAtTime(40 + b * 140, t, tau);

  s.mixGain.gain.setTargetAtTime(0.88, t, tau);
}

function applyLofiSettings(s, t, tau, d, m, b) {
  // warmth LP: muffle=0 → 4000Hz (warmer tape), muffle=1 → 1200Hz (really rolled off)
  const lpHz = 4000 - m * 2800;
  setFreq(s.warmLP, lpHz, t, tau, s.audioCtx);

  // warmth bump: more muffle = more mid warmth
  s.tapeWarm.gain.setTargetAtTime(2 + m * 5, t, tau);
  setFreq(s.tapeWarm, 280 + b * 200, t, tau, s.audioCtx);

  // gain: depth slider controls overall signal level + saturation feel
  s.lofiGain.gain.setTargetAtTime(0.55 + d * 0.35, t, tau);

  // hiss: always some, more with depth (playing level)
  const profile = PRESET_DSP.lofi;
  s.hissGain.gain.setTargetAtTime(profile.hiss * (0.5 + d * 0.8 + m * 0.4), t, tau);

  s.mixGain.gain.setTargetAtTime(0.9, t, tau);
}

function applyNightcoreSettings(s, t, tau, d, m, b) {
  const profile = PRESET_DSP[s.presetId] ?? PRESET_DSP.nightcore;

  // depth: 0% = pitch 1.0 (no shift), 50% = 1.25 (~5 semitones up), 100% = 1.5 (~7 semitones)
  const pitch = clamp(profile.baseRate + (d - 0.5) * profile.rateDepth * 2, 0.5, 2.0);
  // Drive pitch via port message (most reliable path to the AudioWorklet thread)
  s.pitchNode?.port?.postMessage({ pitch });

  // sparkle: high shelf — 0% = 0dB (no boost), 100% = 14dB
  // frequency sweeps down from 7kHz→5kHz as sparkle increases, widening the boosted treble band
  s.ncBright.gain.setTargetAtTime(m * 14, t, tau);
  setFreq(s.ncBright, profile.brightHz - m * 2000, t, tau, s.audioCtx);

  s.ncBody.gain.setTargetAtTime(0.75 + b * 0.4, t, tau);
  s.ncMix.gain.setTargetAtTime(1.0, t, tau);
}

// ─────────────────────────────────────────────────
// LEVEL METER
// ─────────────────────────────────────────────────
function readMeter(tabId) {
  const s = sessions.get(tabId);
  if (!s?.analyser) return { level: 0, bands: [] };

  const td = s._tdBuf || (s._tdBuf = new Uint8Array(s.analyser.fftSize));
  s.analyser.getByteTimeDomainData(td);
  let sumSq = 0;
  for (let i = 0; i < td.length; i++) {
    const v = (td[i] - 128) / 128;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / td.length);

  const fd = s._fdBuf || (s._fdBuf = new Uint8Array(s.analyser.frequencyBinCount));
  s.analyser.getByteFrequencyData(fd);

  const bandCount = 9;
  const chunk = Math.max(1, Math.floor(fd.length / bandCount));
  const bands = [];
  for (let bi = 0; bi < bandCount; bi++) {
    let sum = 0;
    const start = bi * chunk;
    const end = Math.min(fd.length, start + chunk);
    for (let i = start; i < end; i++) sum += fd[i];
    bands.push(Math.min(1, (sum / (end - start)) / 165));
  }

  return { level: Math.min(1, rms * 3.2), bands };
}

// ─────────────────────────────────────────────────
// SESSION TEARDOWN
// ─────────────────────────────────────────────────
async function stopProcessing(tabId, immediate = false) {
  const s = sessions.get(tabId);
  if (!s) return;
  sessions.delete(tabId);
  stopWow(s);

  if (!immediate && s.fadeGain && s.audioCtx?.state !== 'closed') {
    try {
      const t = s.audioCtx.currentTime;
      s.fadeGain.gain.cancelScheduledValues(t);
      s.fadeGain.gain.setTargetAtTime(0, t, 0.03);
    } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }

  teardownSession(s);
}

function teardownSession(s) {
  stopWow(s);
  try { s.sourceNode?.disconnect(); } catch (_) {}
  try { s.mediaStream?.getTracks().forEach(tr => tr.stop()); } catch (_) {}
  try { if (s.audioCtx?.state !== 'closed') s.audioCtx.close(); } catch (_) {}
}

// ─────────────────────────────────────────────────
// COMB FILTER (for hall reverb)
// ─────────────────────────────────────────────────
function makeComb(ctx, delaySec, feedback, dampHz) {
  const max = Math.max(delaySec + 0.05, delaySec * 1.25);
  const delay = ctx.createDelay(max);
  delay.delayTime.value = Math.min(delaySec, max);
  const fb = gain(ctx, feedback);
  const damp = filter(ctx, 'lowpass', dampHz, 0.5);
  const inp = gain(ctx, 1);
  const out = gain(ctx, 1);
  inp.connect(delay);
  delay.connect(damp);
  damp.connect(fb);
  fb.connect(delay);
  delay.connect(out);
  inp.connect(out);
  return { input: inp, output: out };
}

// ─────────────────────────────────────────────────
// WOW & FLUTTER (lo-fi)
// ─────────────────────────────────────────────────
function startWow(s) {
  stopWow(s);
  if (!s.wowDelay) return;
  const profile = PRESET_DSP.lofi;
  const ctx = s.audioCtx;
  const base = 0.008;
  const depth = profile.wowDepth;
  s.wowPhase = 0;
  s.wowTimer = setInterval(() => {
    if (!s.wowDelay || ctx.state === 'closed') return;
    s.wowPhase += 0.09;
    // two oscillators for organic flutter feel
    const wow   = depth * 0.7 * Math.sin(2 * Math.PI * 0.48 * s.wowPhase);
    const flutter = depth * 0.3 * Math.sin(2 * Math.PI * 6.2 * s.wowPhase);
    const dt = base + wow + flutter;
    try { setDelay(s.wowDelay, s.wowDelayMax ?? WOW_DELAY_MAX, dt, ctx.currentTime, 0.04); } catch (_) {}
  }, 80);
}

function stopWow(s) {
  if (s.wowTimer) { clearInterval(s.wowTimer); s.wowTimer = null; }
}

// ─────────────────────────────────────────────────
// HISS SOURCE (lo-fi)
// ─────────────────────────────────────────────────
function makeHiss(ctx, seed) {
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const rand = seededRandom(seed ^ 0xbad);
  for (let i = 0; i < len; i++) data[i] = (rand() * 2 - 1) * 0.15;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  return src;
}

// ─────────────────────────────────────────────────
// IMPULSE RESPONSE GENERATORS
// ─────────────────────────────────────────────────

// Bathroom IR: small tiled room, RT60 ~0.45s
// Dense noise tail with discrete early reflections off hard walls
function buildBathroomIR(ctx) {
  const sr = ctx.sampleRate;
  const rt60 = 0.45;
  // length: enough for the full decay
  const len = Math.ceil(sr * rt60 * 1.6);
  const buf = ctx.createBuffer(2, len, sr);
  const rand = seededRandom(0x9e3779b1);

  // Discrete early reflections (hard tile, first-order reflections from each wall)
  const erMs = [5, 9, 14, 20, 27, 36, 47, 60];
  const erAmp = [0.72, 0.58, 0.50, 0.44, 0.36, 0.28, 0.22, 0.16];

  // Decay rate for -60dB in rt60 seconds
  const decayRate = Math.log(1000) / rt60;

  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);

    // Early reflections: sharp spikes at specific delays
    for (let e = 0; e < erMs.length; e++) {
      const idx = Math.floor(erMs[e] * sr / 1000);
      // slight stereo difference on alternating reflections
      const stereoSign = (ch === 1 && e % 2 === 0) ? -1 : 1;
      if (idx < len) data[idx] += stereoSign * erAmp[e];
      // tiny smear on adjacent samples for anti-aliasing
      if (idx + 1 < len) data[idx + 1] += stereoSign * erAmp[e] * 0.25;
      if (idx - 1 >= 0) data[idx - 1] += stereoSign * erAmp[e] * 0.1;
    }

    // Dense diffuse tail starting at ~30ms (where discrete reflections
    // become too dense to separate — the reverb cloud)
    const tailStart = Math.floor(0.030 * sr);
    // Slight stereo independence: different rand state per channel
    if (ch === 1) { for (let i = 0; i < 200; i++) rand(); }
    for (let i = tailStart; i < len; i++) {
      const t = i / sr;
      const env = Math.exp(-decayRate * t);
      // HF rolloff in tail (tiles absorb some HF after many bounces)
      const hfFactor = t < 0.1 ? 1 : Math.exp(-(t - 0.1) * 3.5);
      data[i] += (rand() * 2 - 1) * 0.22 * env * hfFactor;
    }
  }

  normalizeBuffer(buf, 0.62);
  return buf;
}

// Hall IR: large concert hall, RT60 ~2.2s
// Long noise tail with pre-delay early reflection cluster
function buildHallIR(ctx) {
  const sr = ctx.sampleRate;
  const rt60 = 2.2;
  const len = Math.ceil(sr * rt60 * 1.2);
  const buf = ctx.createBuffer(2, len, sr);
  const rand = seededRandom(0xc0ffee01);

  const decayRate = Math.log(1000) / rt60;

  // Early reflection cluster (first-order in a large hall)
  const erMs = [12, 22, 35, 52, 74, 102, 138, 180, 230];
  const erAmp = [0.55, 0.44, 0.36, 0.30, 0.25, 0.20, 0.16, 0.12, 0.09];

  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);

    for (let e = 0; e < erMs.length; e++) {
      const idx = Math.floor(erMs[e] * sr / 1000);
      const s2 = ch === 1 ? Math.floor(sr * 0.0012) : 0;
      if (idx + s2 < len) data[idx + s2] += erAmp[e] * (ch === 0 ? 1 : 0.9);
    }

    const tailStart = Math.floor(0.08 * sr);
    if (ch === 1) { for (let i = 0; i < 300; i++) rand(); }
    for (let i = tailStart; i < len; i++) {
      const t = i / sr;
      const env = Math.exp(-decayRate * t);
      // Gradual HF rolloff in long tail
      const hfFactor = Math.exp(-t * 0.8);
      data[i] += (rand() * 2 - 1) * 0.18 * env * (0.4 + hfFactor * 0.6);
    }
  }

  normalizeBuffer(buf, 0.55);
  return buf;
}

// ─────────────────────────────────────────────────
// UTILITY NODES
// ─────────────────────────────────────────────────
function wire(...nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
}

function gain(ctx, v = 1) {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

function filter(ctx, type, freq, q) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function clamp01(v) { return clamp(v ?? 0, 0, 1); }

function setDelay(node, maxSec, sec, t, tau) {
  if (!node) return;
  const v = clamp(sec, 0, maxSec);
  if (t != null && tau != null) node.delayTime.setTargetAtTime(v, t, tau);
  else node.delayTime.value = v;
}


function setFreq(filterNode, hz, t, tau, ctx) {
  const nyquist = ((ctx?.sampleRate) ?? 48000) / 2 - 20;
  filterNode.frequency.setTargetAtTime(clamp(hz, 20, nyquist), t, tau);
}

function makeCrushCurve(bits) {
  const steps = Math.pow(2, bits);
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i * 2) / 255 - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  return curve;
}

function normalizeBuffer(buf, targetPeak) {
  let peak = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  }
  if (peak > 0) {
    const scale = targetPeak / peak;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < data.length; i++) data[i] *= scale;
    }
  }
}

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

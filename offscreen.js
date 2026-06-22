const sessions = new Map();

let currentSettings = {
  preset: DEFAULT_PRESET_ID,
  depth: 0.5,
  muffle: 0.5,
  bass: 0.5
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_START') {
    startProcessing(msg.tabId, msg.streamId, msg.settings)
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (msg.type === 'OFFSCREEN_STOP') {
    stopProcessing(msg.tabId).then(() => sendResponse({ success: true }));
    return true;
  }
  if (msg.type === 'OFFSCREEN_UPDATE_SETTINGS') {
    if (msg.settings) {
      currentSettings = { ...currentSettings, ...msg.settings };
      for (const session of sessions.values()) syncSession(session);
    }
    sendResponse({ success: true });
    return true;
  }
  if (msg.type === 'OFFSCREEN_QUERY') {
    sendResponse({ tabs: [...sessions.keys()] });
    return true;
  }
  if (msg.type === 'OFFSCREEN_GET_LEVEL') {
    sendResponse(readMeter(msg.tabId));
    return true;
  }
});

async function startProcessing(tabId, streamId, settings) {
  await stopProcessing(tabId, true);
  if (settings) currentSettings = { ...currentSettings, ...settings };

  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false
  });

  const track = mediaStream.getAudioTracks()[0];
  const nativeRate = track?.getSettings?.().sampleRate;
  const audioCtx = nativeRate
    ? new AudioContext({ sampleRate: nativeRate, latencyHint: 'playback' })
    : new AudioContext({ latencyHint: 'playback' });

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
  try { s.sourceNode?.disconnect(); } catch (_) {}
  s.nodes = [];

  const presetId = currentSettings.preset ?? DEFAULT_PRESET_ID;
  s.presetId = presetId;
  s.family = getPresetFamily(presetId);

  const ctx = s.audioCtx;
  s.inputTrim = gain(ctx, 1);
  s.fadeGain = gain(ctx, 1);
  s.limiter = ctx.createDynamicsCompressor();
  s.limiter.threshold.value = -9;
  s.limiter.knee.value = 8;
  s.limiter.ratio.value = 4;
  s.limiter.attack.value = 0.006;
  s.limiter.release.value = 0.14;
  s.analyser = ctx.createAnalyser();
  s.analyser.fftSize = 512;
  s.analyser.smoothingTimeConstant = 0.35;

  s.fadeGain.connect(s.limiter);
  s.limiter.connect(ctx.destination);
  s.limiter.connect(s.analyser);

  if (s.family === 'hall') buildHallEngine(s);
  else if (s.family === 'lofi') buildLofiEngine(s);
  else buildPartyEngine(s);

  s.sourceNode.connect(s.inputTrim);
}

// ── Party: through-the-wall crossover (muffled body + tile reverb + bass thump) ──
function buildPartyEngine(s) {
  const ctx = s.audioCtx;
  const profile = PRESET_DSP.party;

  s.bassSplit = filter(ctx, 'lowpass', 165, 0.55);
  s.bodySplit = filter(ctx, 'highpass', 165, 0.55);
  s.wallLP = filter(ctx, 'lowpass', 1400, 0.7);
  s.vocalDip = filter(ctx, 'peaking', 2600, 0.9);
  s.vocalDip.gain.value = -4;
  s.reverbHP = filter(ctx, 'highpass', 220, 0.5);
  s.reverbLP = filter(ctx, 'lowpass', 4200, 0.5);

  s.convolver = ctx.createConvolver();
  s.convolver.normalize = true;
  s.convolver.buffer = buildPartyIR(ctx, profile);

  s.bodyGain = gain(ctx);
  s.wetGain = gain(ctx);
  s.bassGain = gain(ctx);
  s.mixGain = gain(ctx);

  wire(s.inputTrim, s.bassSplit, s.bassGain, s.mixGain);
  wire(s.inputTrim, s.bodySplit, s.wallLP, s.vocalDip, s.bodyGain, s.mixGain);
  wire(s.vocalDip, s.reverbHP, s.convolver, s.reverbLP, s.wetGain, s.mixGain);
  wire(s.mixGain, s.fadeGain);
}

// ── Hall: ambience engine — pre-delay + Schroeder combs + long IR (no wall muffling) ──
function buildHallEngine(s) {
  const ctx = s.audioCtx;
  const sr = ctx.sampleRate;
  const scale = sr / 44100;

  s.dryGain = gain(ctx);
  s.wetGain = gain(ctx);
  s.mixGain = gain(ctx);

  s.preDelay = ctx.createDelay(0.25);
  s.preDelay.delayTime.value = 0.07;

  s.hallHP = filter(ctx, 'highpass', 140, 0.5);
  s.hallDamp = filter(ctx, 'lowpass', 5000, 0.5);

  s.combBus = gain(ctx);
  const combTimes = [0.0297, 0.0371, 0.0411, 0.0437];
  s._combInputs = [];
  for (const base of combTimes) {
    const comb = makeComb(ctx, base * scale, 0.74, 3200);
    comb.output.connect(s.combBus);
    s._combInputs.push(comb.input);
  }

  s.hallConv = ctx.createConvolver();
  s.hallConv.normalize = true;
  s.hallConv.buffer = buildHallIR(ctx);
  s.convWet = gain(ctx);

  wire(s.inputTrim, s.dryGain, s.mixGain);
  wire(s.inputTrim, s.preDelay, s.hallHP);
  wire(s.hallHP, s.hallConv, s.convWet, s.mixGain);
  wire(s.combBus, s.hallDamp, s.wetGain, s.mixGain);
  wire(s.mixGain, s.fadeGain);
  for (const input of s._combInputs) s.hallHP.connect(input);
}

// ── Lo-fi: tape degradation (wow, crush, hiss) + tiny room — not a wall effect ──
function buildLofiEngine(s) {
  const ctx = s.audioCtx;
  const profile = PRESET_DSP.lofi;

  s.lofiLP = filter(ctx, 'lowpass', 3200, 0.6);
  s.lofiBody = gain(ctx);

  s.lofiConv = ctx.createConvolver();
  s.lofiConv.normalize = true;
  s.lofiConv.buffer = buildLofiIR(ctx, profile);
  s.lofiWet = gain(ctx);

  s.wowDelay = ctx.createDelay(0.04);
  s.wowDelay.delayTime.value = 0.009;
  s.wowDry = gain(ctx, 0.65);
  s.wowWet = gain(ctx, 0.45);
  s.wowBus = gain(ctx);

  s.crush = ctx.createWaveShaper();
  s.crush.curve = makeCrushCurve(profile.crushBits);
  s.crush.oversample = '2x';

  s.hiss = makeHiss(ctx, profile.seed);
  s.hissHP = filter(ctx, 'highpass', 2800, 0.7);
  s.hissGain = gain(ctx, profile.hiss);

  s.mixGain = gain(ctx);

  wire(s.inputTrim, s.lofiLP, s.lofiBody, s.mixGain);
  wire(s.lofiLP, s.lofiConv, s.lofiWet, s.mixGain);
  wire(s.lofiLP, s.wowDelay, s.wowWet, s.wowBus);
  wire(s.lofiLP, s.wowDry, s.wowBus);
  wire(s.wowBus, s.crush, s.mixGain);
  wire(s.hiss, s.hissHP, s.hissGain, s.mixGain);
  wire(s.mixGain, s.fadeGain);

  s.hiss.start(0);
  startWow(s);
}

function applyEngineSettings(s) {
  if (!s?.audioCtx) return;
  const t = s.audioCtx.currentTime;
  const tau = 0.05;
  const { depth, muffle, bass, preset: presetIn } = currentSettings;
  const presetId = presetIn ?? s.presetId ?? DEFAULT_PRESET_ID;
  s.presetId = presetId;

  const rawD = clamp01(depth);
  const rawM = clamp01(muffle);
  const rawB = clamp01(bass);

  if (s.family === 'party') {
    const d = Math.pow(partyDrive(rawD), 0.55);
    const m = Math.pow(partyDrive(rawM), 0.35);
    const b = Math.pow(partyDrive(rawB), 0.45);
    applyPartySettings(s, t, tau, d, m, b);
  } else {
    const d = Math.pow(rawD, 0.75);
    const m = Math.pow(rawM, 0.4);
    const b = Math.pow(rawB, 0.55);
    if (s.family === 'hall') applyHallSettings(s, t, tau, d, m, b, presetId);
    else applyLofiSettings(s, t, tau, d, m, b, presetId);
  }
}

// 50% slider = reference intensity; 100% = stronger headroom above reference
function partyDrive(slider01) {
  const t = clamp01(slider01);
  if (t <= 0.5) return t * 2;
  return 1 + (t - 0.5) * 0.8;
}

function applyPartySettings(s, t, tau, d, m, b) {
  const profile = PRESET_DSP.party;
  const mWall = Math.min(m, 1);
  const wallHz = 380 + (1 - mWall) * 3800;
  s.wallLP.frequency.setTargetAtTime(wallHz, t, tau);
  s.wallLP.Q.setTargetAtTime(Math.min(1.7, 0.55 + m * 1.45), t, tau);
  s.vocalDip.gain.setTargetAtTime(-(2 + m * 7.5 + d * 3), t, tau);

  s.bodyGain.gain.setTargetAtTime((0.16 + (1 - d) * 0.62 * (1 - m * 0.5)) * profile.bodyMul, t, tau);
  s.wetGain.gain.setTargetAtTime((0.12 + d * 0.95) * profile.wetMul, t, tau);
  s.bassGain.gain.setTargetAtTime((0.44 + b * 1.22) * profile.bassMul, t, tau);
  s.mixGain.gain.setTargetAtTime(1.06, t, tau);
}

function applyHallSettings(s, t, tau, d, m, b, presetId) {
  const profile = PRESET_DSP.hall;
  const pre = profile.preDelay + d * 0.055;
  s.preDelay.delayTime.setTargetAtTime(pre, t, tau);

  // depth = how far into the hall (wet vs dry), muffle = tail damping, bass = mud cut
  s.dryGain.gain.setTargetAtTime(0.55 - d * 0.42, t, tau);
  s.wetGain.gain.setTargetAtTime((0.2 + d * 0.65) * profile.combMix * 2.2, t, tau);
  s.convWet.gain.setTargetAtTime(0.18 + d * 0.82, t, tau);
  s.hallHP.frequency.setTargetAtTime(100 + b * 120, t, tau);
  s.hallDamp.frequency.setTargetAtTime(profile.dampBase - m * 3400, t, tau);
  s.mixGain.gain.setTargetAtTime(0.9, t, tau);
}

function applyLofiSettings(s, t, tau, d, m, b, presetId) {
  const profile = PRESET_DSP.lofi;
  const lpHz = 900 + (1 - m) * 2800;
  s.lofiLP.frequency.setTargetAtTime(lpHz, t, tau);
  s.lofiBody.gain.setTargetAtTime(0.35 + (1 - d) * 0.4, t, tau);
  s.lofiWet.gain.setTargetAtTime(0.08 + d * 0.35, t, tau);
  s.hissGain.gain.setTargetAtTime(profile.hiss * (0.4 + m * 0.35) * d, t, tau);
  s.mixGain.gain.setTargetAtTime(0.85, t, tau);
}

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
  for (let b = 0; b < bandCount; b++) {
    let sum = 0;
    const start = b * chunk;
    const end = Math.min(fd.length, start + chunk);
    for (let i = start; i < end; i++) sum += fd[i];
    bands.push(Math.min(1, (sum / (end - start)) / 165));
  }

  return { level: Math.min(1, rms * 3.2), bands };
}

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

// ── Hall helpers: Schroeder comb / allpass ──

function makeComb(ctx, delaySec, feedback, dampHz) {
  const max = delaySec + 0.05;
  const delay = ctx.createDelay(max);
  delay.delayTime.value = delaySec;
  const fb = gain(ctx, feedback);
  const damp = filter(ctx, 'lowpass', dampHz, 0.5);
  const input = gain(ctx, 1);
  const output = gain(ctx, 1);
  input.connect(delay);
  delay.connect(damp);
  damp.connect(fb);
  fb.connect(delay);
  delay.connect(output);
  input.connect(output);
  return { input, output };
}

function startWow(s) {
  stopWow(s);
  if (!s.wowDelay) return;
  const profile = PRESET_DSP.lofi;
  const ctx = s.audioCtx;
  const base = 0.009;
  const depth = profile.wowDepth;
  s.wowPhase = 0;
  s.wowTimer = setInterval(() => {
    if (!s.wowDelay || ctx.state === 'closed') return;
    s.wowPhase += 0.09;
    const dt = base + depth * Math.sin(2 * Math.PI * 0.42 * s.wowPhase);
    try { s.wowDelay.delayTime.setTargetAtTime(dt, ctx.currentTime, 0.06); } catch (_) {}
  }, 110);
}

function stopWow(s) {
  if (s.wowTimer) { clearInterval(s.wowTimer); s.wowTimer = null; }
}

function makeHiss(ctx, seed) {
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const rand = seededRandom(seed ^ 0xbad);
  for (let i = 0; i < len; i++) data[i] = (rand() * 2 - 1) * 0.12;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  return src;
}

// ── IR builders ──

function buildPartyIR(ctx, profile) {
  const sr = ctx.sampleRate;
  const dur = 0.42 + profile.irSize * 2.1;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(2, len, sr);
  const decay = 10 - profile.irSize * 6;
  const taps = [0.007, 0.013, 0.021, 0.031, 0.043, 0.057, 0.074, 0.092];

  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    const spread = ch === 0 ? 1 : 1.04;
    for (let i = 0; i < len; i++) {
      const time = i / sr;
      const env = Math.exp(-time * decay);
      let s = 0;
      for (const tap of taps) {
        const t = tap * spread;
        const w = 0.0012;
        if (Math.abs(time - t) < w) {
          s += (1 - Math.abs(time - t) / w) * (0.42 + profile.erMul * 0.32);
        }
      }
      if (time > 0.03) s += Math.sin(i * (0.31 + ch * 0.04)) * 0.008 * env;
      data[i] = s * profile.irGain * Math.min(1, i / (sr * 0.003));
    }
  }
  normalizeBuffer(buf, 0.48);
  return buf;
}

function buildHallIR(ctx) {
  const sr = ctx.sampleRate;
  const dur = 3.6;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(2, len, sr);
  const rand = seededRandom(PRESET_DSP.hall.seed);

  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const time = i / sr;
      const env = Math.exp(-time * 1.8);
      const hf = time > 0.08 ? Math.pow(0.5, time * 2.2) : 1;
      // Sparse cathedral reflections — not dense bathroom tiles
      let er = 0;
      for (const tap of [0.018, 0.031, 0.048, 0.071, 0.11, 0.16, 0.23]) {
        if (Math.abs(time - tap) < 0.002) er += (1 - Math.abs(time - tap) / 0.002) * 0.38;
      }
      let s = er * (0.6 + rand() * 0.15);
      if (time > 0.12) s += Math.sin(i * 0.17 + ch) * 0.012 * env * hf;
      data[i] = s * Math.min(1, i / (sr * 0.006));
    }
    if (ch === 1) {
      const d = Math.floor(sr * 0.0018);
      for (let i = len - 1; i >= d; i--) data[i] = data[i] * 0.78 + data[i - d] * 0.22;
    }
  }
  normalizeBuffer(buf, 0.5);
  return buf;
}

function buildLofiIR(ctx, profile) {
  const sr = ctx.sampleRate;
  const dur = 0.3 + profile.irSize * 0.45;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(2, len, sr);
  const taps = [0.005, 0.011, 0.019];

  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const time = i / sr;
      const env = Math.exp(-time * 16);
      let s = 0;
      for (const tap of taps) {
        if (Math.abs(time - tap) < 0.001) s += (1 - Math.abs(time - tap) / 0.001) * 0.5;
      }
      if (time > 0.02) s += Math.sin(i * 0.43) * 0.006 * env;
      data[i] = s * 0.14 * Math.min(1, i / (sr * 0.003));
    }
  }
  normalizeBuffer(buf, 0.35);
  return buf;
}

function buildNoiseIR(ctx, { dur, decay, gain, erMul, seed, erBright }) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(2, len, sr);
  const rand = seededRandom(seed);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const time = i / sr;
      const env = Math.exp(-time * decay);
      const hf = time > 0.05 ? Math.pow(0.5, time * (erBright ? 3.5 : 5)) : 1;
      const er = time < 0.016 ? Math.exp(-time * 130) * 1.6 * erMul : 0;
      let s = rand() * 2 - 1;
      s = s * env * (0.45 + hf * 0.55) + er * (rand() * 2 - 1) * 0.5;
      data[i] = s * gain * Math.min(1, i / (sr * 0.004));
    }
    if (ch === 1) {
      const d = Math.floor(sr * 0.0007);
      for (let i = len - 1; i >= d; i--) data[i] = data[i] * 0.85 + data[i - d] * 0.15;
    }
  }
  normalizeBuffer(buf, 0.55);
  return buf;
}

// ── utilities ──

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

function clamp01(v) { return Math.max(0, Math.min(1, v ?? 0)); }

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

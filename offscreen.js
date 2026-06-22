// offscreen.js — Audio DSP chains live here, one session per captured tab.
// Receives messages from background.js via chrome.runtime.
//
// A single offscreen document can host several AudioContexts, so each tab
// (e.g. Spotify in one tab, YouTube in another) gets its own isolated chain.
// Settings are global and applied to every active session.

const sessions = new Map(); // tabId -> session object

let currentSettings = {
  depth:  0.78,
  bass:   0.65,
  muffle: 0.65,
  room:   0.45,
  preset: 'bathroom'
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_START') {
    startProcessing(msg.tabId, msg.streamId, msg.settings)
      .then(() => sendResponse({ success: true }))
      .catch(e  => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (msg.type === 'OFFSCREEN_STOP') {
    stopProcessing(msg.tabId)
      .then(() => sendResponse({ success: true }))
      .catch(() => sendResponse({ success: true }));
    return true;
  }
  if (msg.type === 'OFFSCREEN_UPDATE_SETTINGS') {
    // Live-update path — settings are global, push to every running session
    if (msg.settings) {
      currentSettings = { ...currentSettings, ...msg.settings };
      for (const session of sessions.values()) applySettings(session);
    }
    sendResponse({ success: true });
    return true;
  }
  if (msg.type === 'OFFSCREEN_QUERY') {
    // Source of truth for which tabs are actually being processed
    sendResponse({ tabs: [...sessions.keys()] });
    return true;
  }
  if (msg.type === 'OFFSCREEN_GET_LEVEL') {
    // Cheap output-loudness read for the popup visualizer (0..1).
    sendResponse({ level: readLevel(msg.tabId) });
    return true;
  }
});

async function startProcessing(tabId, streamId, settings) {
  // Replace any existing session for this tab (re-toggle / restart)
  await stopProcessing(tabId, true);

  // Only adopt popup settings when this is the first session — otherwise a
  // second tab starting (or a storage race) would overwrite live globals.
  if (settings && sessions.size === 0) {
    currentSettings = { ...currentSettings, ...settings };
  }

  const mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  // Match the AudioContext to the captured stream's native rate.
  // Forcing a different rate (e.g. 44100 on a 48000 stream) makes Chrome
  // resample the live source in real time, which causes crackle/grit.
  const track = mediaStream.getAudioTracks()[0];
  const nativeRate = track?.getSettings?.().sampleRate;
  const audioCtx = nativeRate
    ? new AudioContext({ sampleRate: nativeRate, latencyHint: 'playback' })
    : new AudioContext({ latencyHint: 'playback' });

  const session = { tabId, audioCtx, mediaStream, stopTimer: null };
  session.sourceNode = audioCtx.createMediaStreamSource(mediaStream);

  buildDSPChain(session);
  applySettings(session);

  sessions.set(tabId, session);

  // Resume AFTER the graph is wired. The context can boot suspended; retry and
  // also recover if Chrome suspends it later. This is what removes the old
  // "play audio first, then enable" requirement — capture now works even on a
  // tab that hasn't started playing yet.
  await ensureRunning(audioCtx);
  audioCtx.addEventListener('statechange', () => {
    if (audioCtx.state === 'suspended') ensureRunning(audioCtx);
  });

  // When the tab is closed or navigates away, its capture track ends.
  // Tear down that session and let the background reconcile its state.
  track.addEventListener('ended', () => {
    stopProcessing(tabId).finally(() => {
      try { chrome.runtime.sendMessage({ type: 'SESSION_ENDED', tabId }); } catch (_) {}
    });
  });
}

// Best-effort resume loop. Never throws — a suspended context is recoverable
// and we'd rather keep the session alive than fail the whole capture.
async function ensureRunning(ctx, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    if (ctx.state === 'running' || ctx.state === 'closed') return;
    try { await ctx.resume(); } catch (_) {}
    if (ctx.state === 'running') return;
    await new Promise(r => setTimeout(r, 70));
  }
}

// Output loudness (0..1) for the popup's live bars. Pulls from the per-tab
// analyser; returns 0 when there's no session or no signal.
function readLevel(tabId) {
  const s = sessions.get(tabId);
  if (!s || !s.analyserNode) return 0;
  const buf = s._levelBuf || (s._levelBuf = new Uint8Array(s.analyserNode.frequencyBinCount));
  s.analyserNode.getByteFrequencyData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i];
  return Math.min(1, (sum / buf.length) / 180);
}

function buildDSPChain(s) {
  const ctx = s.audioCtx;

  // ── Filter chain (wet path) ──────────────────────────────────────────
  // 1. First lowpass — main muffling
  s.lowpassNode = ctx.createBiquadFilter();
  s.lowpassNode.type = 'lowpass';
  s.lowpassNode.Q.value = 0.9;

  // 2. Second lowpass in series — cutoff tracks muffle for steeper roll-off
  s.hiCutNode = ctx.createBiquadFilter();
  s.hiCutNode.type = 'lowpass';
  s.hiCutNode.frequency.value = 1200;
  s.hiCutNode.Q.value = 0.5;

  // 3. Vocal dip — peaking cut around the vocal presence band so voices
  //    sit back "behind the wall" instead of staying up front.
  s.vocalDipNode = ctx.createBiquadFilter();
  s.vocalDipNode.type = 'peaking';
  s.vocalDipNode.frequency.value = 2500;
  s.vocalDipNode.Q.value = 1.1;

  // 4. Reverb send high-pass — keep lows OUT of the reverb so the tail
  //    doesn't smear/muddy the bass (real walls pass bass through cleanly).
  s.reverbHPNode = ctx.createBiquadFilter();
  s.reverbHPNode.type = 'highpass';
  s.reverbHPNode.frequency.value = 180;
  s.reverbHPNode.Q.value = 0.5;

  // 5. Dedicated bass path — a clean low-frequency split that bypasses the
  //    reverb and compressor so the thump stays tight and present.
  s.bassPassNode = ctx.createBiquadFilter();
  s.bassPassNode.type = 'lowpass';
  s.bassPassNode.frequency.value = 180;
  s.bassPassNode.Q.value = 0.5;
  s.bassGainNode = ctx.createGain();

  // ── Reverb ───────────────────────────────────────────────────────────
  s.convolverNode = ctx.createConvolver();
  s.convolverNode.buffer = getIR(ctx, currentSettings.room);
  s.currentRoomBucket = roomBucket(currentSettings.room);

  // ── Gain nodes ───────────────────────────────────────────────────────
  s.wetGainNode  = ctx.createGain();
  s.dryGainNode  = ctx.createGain();

  // Post-mix dynamics compressor: evens out level spikes from reverb
  s.compNode = ctx.createDynamicsCompressor();
  s.compNode.threshold.value = -22;
  s.compNode.knee.value      =  10;
  s.compNode.ratio.value     =  3;
  s.compNode.attack.value    =  0.004;
  s.compNode.release.value   =  0.25;

  // Makeup gain — limiter downstream catches peaks so we stay clean
  s.masterGainNode = ctx.createGain();
  s.masterGainNode.gain.value = 1.5;

  // Gentle saturation before brickwall limiter — rounds peaks instead of hard clip
  s.softClipNode = ctx.createWaveShaper();
  s.softClipNode.curve = makeSoftClipCurve(2.4);
  s.softClipNode.oversample = '2x';

  s.limiterNode = ctx.createDynamicsCompressor();
  s.limiterNode.threshold.value = -3;
  s.limiterNode.knee.value      =  2;
  s.limiterNode.ratio.value     = 16;
  s.limiterNode.attack.value    =  0.002;
  s.limiterNode.release.value   =  0.09;

  // Analyser taps the final output — drives the popup's live level bars.
  s.analyserNode = ctx.createAnalyser();
  s.analyserNode.fftSize = 256;
  s.analyserNode.smoothingTimeConstant = 0.6;

  // ── Routing ──────────────────────────────────────────────────────────
  //
  //  source ─┬─► lowpass ─► hiCut ─► vocalDip ─► reverbHP ─► convolver ─► wetGain ─┐
  //          │                                                                      ├─► comp ─► master ─┐
  //          ├─► dryGain ───────────────────────────────────────────────────────────┘                  │
  //          │                                                                                          ├─► softClip ─► limiter ─► out
  //          └─► bassPass ─► bassGain ─────────────────────────────────────────────────────────────────┘
  //
  // Mids/highs are muffled + reverberated; the dedicated bass path stays dry,
  // tight, and uncompressed so the thump comes through the "wall" cleanly.

  s.sourceNode.connect(s.lowpassNode);
  s.lowpassNode.connect(s.hiCutNode);
  s.hiCutNode.connect(s.vocalDipNode);
  s.vocalDipNode.connect(s.reverbHPNode);
  s.reverbHPNode.connect(s.convolverNode);
  s.convolverNode.connect(s.wetGainNode);
  s.wetGainNode.connect(s.compNode);

  s.sourceNode.connect(s.dryGainNode);
  s.dryGainNode.connect(s.compNode);

  s.compNode.connect(s.masterGainNode);
  s.masterGainNode.connect(s.softClipNode);

  // Clean bass path joins after the compressor, straight into the limiter stage
  s.sourceNode.connect(s.bassPassNode);
  s.bassPassNode.connect(s.bassGainNode);
  s.bassGainNode.connect(s.softClipNode);

  s.limiterNode.connect(ctx.destination);
  s.limiterNode.connect(s.analyserNode);

  buildLofiChain(s);
}

function applySettings(s) {
  if (!s || !s.audioCtx || !s.lowpassNode) return;

  const t   = s.audioCtx.currentTime;
  const tau = 0.04; // smooth transition constant (40ms)
  const { depth, bass, muffle } = currentSettings;

  // Curved mapping: effects kick in earlier so defaults feel strong,
  // 0% stays subtle, 100% pushes past the old ceiling.
  const d = Math.pow(depth,  0.8);
  const m = Math.pow(muffle, 0.42);
  const b = Math.pow(bass,   0.62);

  // ── Wet/dry mix ─────────────────────────────────────────────────────
  const wetLevel = 0.12 + d * 0.88;
  const dryLevel = 0.32 * (1 - Math.pow(depth, 1.2)) * (1 - m * 0.9);
  s.wetGainNode.gain.setTargetAtTime(wetLevel, t, tau);
  s.dryGainNode.gain.setTargetAtTime(dryLevel, t, tau);

  // ── Muffle: dual lowpass — cap Q to avoid resonant peaks ────────────
  const lpFreq    = 3100 - m * 2850;
  const hiCutFreq = 4400 - m * 4050;
  s.lowpassNode.frequency.setTargetAtTime(lpFreq, t, tau);
  s.hiCutNode.frequency.setTargetAtTime(hiCutFreq, t, tau);
  s.lowpassNode.Q.setTargetAtTime(0.6 + m * 1.6, t, tau);
  s.hiCutNode.Q.setTargetAtTime(0.4 + m * 1.0, t, tau);

  // ── Vocal dip — deeper as you go further in (more muffle/depth) ─────
  const vocalCut = -(2.5 + m * 4.5 + d * 1.5); // ~ -3dB to -8.5dB
  s.vocalDipNode.gain.setTargetAtTime(vocalCut, t, tau);

  // ── Clean bass path level — controlled by the bass slider ───────────
  // Dedicated low end; not run through muffle/reverb so it stays tight.
  const bassLevel = 0.35 + b * 1.15;
  s.bassGainNode.gain.setTargetAtTime(bassLevel, t, tau);

  // ── Master makeup gain ──────────────────────────────────────────────
  const makeup = 1.35 + d * 0.45;
  s.masterGainNode.gain.setTargetAtTime(makeup, t, tau);

  // ── Room size — swap the convolver IR when the bucket changes ───────
  // (Bucketed + cached so live dragging doesn't rebuild a buffer per frame.)
  const rb = roomBucket(currentSettings.room);
  if (rb !== s.currentRoomBucket && s.convolverNode) {
    s.convolverNode.buffer = getIR(s.audioCtx, currentSettings.room);
    s.currentRoomBucket = rb;
  }

  setLofiEnabled(s, currentSettings.preset === 'lofi');
}

// ── Lo-fi chain (preset-only) ─────────────────────────────────────────
// Sits after the main bathroom DSP: wow/flutter → bit crush → tape sat,
// plus a parallel vinyl-hiss bed. Toggled via settings.preset === 'lofi'.

function buildLofiChain(s) {
  const ctx = s.audioCtx;

  s.lofiDryGain = ctx.createGain();
  s.lofiDryGain.gain.value = 1;

  s.lofiWetGain = ctx.createGain();
  s.lofiWetGain.gain.value = 0;

  // Wow / flutter — short delay, pitch wobble via scheduled delayTime
  s.wowDelay = ctx.createDelay(0.05);
  s.wowDelay.delayTime.value = 0.011;
  s.wowMixDry = ctx.createGain();
  s.wowMixDry.gain.value = 0.7;
  s.wowMixWet = ctx.createGain();
  s.wowMixWet.gain.value = 0.5;

  s.wowBus = ctx.createGain();

  s.lofiCrushNode = ctx.createWaveShaper();
  s.lofiCrushNode.curve = makeBitCrushCurve(7);
  s.lofiCrushNode.oversample = 'none';

  s.lofiTapeNode = ctx.createWaveShaper();
  s.lofiTapeNode.curve = makeSoftClipCurve(3.6);
  s.lofiTapeNode.oversample = '2x';

  // Vinyl hiss + sparse crackle, looped quietly under the mix
  s.hissSource = createHissSource(ctx);
  s.hissHP = ctx.createBiquadFilter();
  s.hissHP.type = 'highpass';
  s.hissHP.frequency.value = 400;
  s.hissLP = ctx.createBiquadFilter();
  s.hissLP.type = 'lowpass';
  s.hissLP.frequency.value = 6800;
  s.hissGain = ctx.createGain();
  s.hissGain.gain.value = 0;

  // Wet FX input — muted unless lo-fi preset is active (keeps dry path clean)
  s.lofiFxInput = ctx.createGain();
  s.lofiFxInput.gain.value = 0;

  s.softClipNode.connect(s.lofiDryGain);
  s.lofiDryGain.connect(s.limiterNode);

  s.softClipNode.connect(s.lofiFxInput);
  s.lofiFxInput.connect(s.wowDelay);
  s.lofiFxInput.connect(s.wowMixDry);
  s.wowDelay.connect(s.wowMixWet);
  s.wowMixDry.connect(s.wowBus);
  s.wowMixWet.connect(s.wowBus);
  s.wowBus.connect(s.lofiCrushNode);
  s.lofiCrushNode.connect(s.lofiTapeNode);
  s.lofiTapeNode.connect(s.lofiWetGain);
  s.lofiWetGain.connect(s.limiterNode);

  s.hissSource.connect(s.hissHP);
  s.hissHP.connect(s.hissLP);
  s.hissLP.connect(s.hissGain);
  s.hissGain.connect(s.limiterNode);

  s.hissSource.start(0);
}

function startWowFlutter(s) {
  stopWowFlutter(s);
  const ctx = s.audioCtx;
  const base = 0.011;
  const depth = 0.003;
  const rate = 0.48;
  s.wowPhase = 0;
  s.wowTimer = setInterval(() => {
    if (!s.wowDelay || ctx.state === 'closed') return;
    s.wowPhase += 0.1;
    const dt = base + depth * Math.sin(2 * Math.PI * rate * s.wowPhase);
    try {
      s.wowDelay.delayTime.setTargetAtTime(dt, ctx.currentTime, 0.05);
    } catch (_) {}
  }, 100);
}

function stopWowFlutter(s) {
  if (s.wowTimer) {
    clearInterval(s.wowTimer);
    s.wowTimer = null;
  }
}

function setLofiEnabled(s, enabled) {
  if (!s.lofiDryGain) return;
  const t = s.audioCtx.currentTime;
  const tau = 0.05;
  s.lofiDryGain.gain.setTargetAtTime(enabled ? 0 : 1, t, tau);
  s.lofiWetGain.gain.setTargetAtTime(enabled ? 1 : 0, t, tau);
  s.lofiFxInput.gain.setTargetAtTime(enabled ? 1 : 0, t, tau);
  s.hissGain.gain.setTargetAtTime(enabled ? 0.026 : 0, t, tau);
  if (enabled) startWowFlutter(s);
  else stopWowFlutter(s);
}

function createHissSource(ctx) {
  const len = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const rand = mulberry32(0xdecafbad);
  for (let i = 0; i < len; i++) {
    let v = (rand() * 2 - 1) * 0.35;
    if (rand() < 0.00012) v += (rand() * 2 - 1) * 2.5;
    data[i] = v;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  return src;
}

function makeBitCrushCurve(bits) {
  const steps = Math.pow(2, bits);
  const samples = 256;
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  return curve;
}

function makeSoftClipCurve(drive) {
  const samples = 256;
  const curve = new Float32Array(samples);
  const norm = Math.tanh(drive);
  for (let i = 0; i < samples; i++) {
    const x = (i * 2) / (samples - 1) - 1;
    curve[i] = Math.tanh(drive * x) / norm;
  }
  return curve;
}

// Stop a single tab's session. `immediate` skips the fade-out (used when a
// session is being replaced or torn down without needing a clean ramp).
async function stopProcessing(tabId, immediate = false) {
  const s = sessions.get(tabId);
  if (!s) return;
  sessions.delete(tabId);

  if (s.stopTimer) {
    clearTimeout(s.stopTimer);
    s.stopTimer = null;
  }

  if (!immediate && s.masterGainNode && s.audioCtx && s.audioCtx.state !== 'closed') {
    try {
      const t = s.audioCtx.currentTime;
      s.masterGainNode.gain.cancelScheduledValues(t);
      s.masterGainNode.gain.setTargetAtTime(0, t, 0.03);
    } catch (_) {}
    await new Promise(r => setTimeout(r, 110));
  }

  teardownSession(s);
}

function teardownSession(s) {
  stopWowFlutter(s);
  try { if (s.sourceNode) s.sourceNode.disconnect(); } catch (_) {}
  try { if (s.mediaStream) s.mediaStream.getTracks().forEach(t => t.stop()); } catch (_) {}
  try { if (s.audioCtx && s.audioCtx.state !== 'closed') s.audioCtx.close(); } catch (_) {}
}

// ── Room IR generator ──────────────────────────────────────────────────
// Builds a synthetic room impulse response. `room` (0..1) scales the space:
//   0 → small tight tiled bathroom (short, fast decay)
//   1 → large reverberant hall (long, slow decay)
// The noise is seeded so the room sounds identical every session, and results
// are cached per (sampleRate, roomBucket) so live dragging is cheap.

const irCache = new Map();

function roomBucket(room) {
  const r = Math.max(0, Math.min(1, room ?? 0.45));
  return Math.round(r * 10) / 10; // quantize to 0.1 steps for caching
}

function getIR(ctx, room) {
  const rb  = roomBucket(room);
  const key = `${ctx.sampleRate}:${rb}`;
  let buf = irCache.get(key);
  if (!buf) {
    buf = generateRoomIR(ctx, rb);
    irCache.set(key, buf);
  }
  return buf;
}

// Small deterministic PRNG (mulberry32) so the reverb is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateRoomIR(ctx, room) {
  const sr     = ctx.sampleRate;
  const dur    = 0.5 + room * 2.1;     // 0.5s (small) … 2.6s (hall)
  const decayK = 9.5 - room * 7.5;     // faster decay for smaller rooms
  const length = Math.floor(sr * dur);
  const ir     = ctx.createBuffer(2, length, sr);
  const rand   = mulberry32(0x9e3779b1);

  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);

    for (let i = 0; i < length; i++) {
      const t = i / sr;

      // Seeded noise base
      let s = rand() * 2 - 1;

      // Early reflections: dense cluster (close walls)
      const er = t < 0.022
        ? Math.exp(-t * 120) * 2.8
        : 0;

      // Main exponential decay — RT60 scales with room size
      const decay = Math.exp(-t * decayK);

      // High-frequency air absorption: tail gets duller over time
      const hfDamp = t > 0.05
        ? Math.pow(0.5, t * 5.5)
        : 1.0;

      const hfComponent = s * decay * hfDamp;
      const lfComponent = s * decay;
      s = hfComponent * 0.35 + lfComponent * 0.65;

      // Short fade-in prevents a click when convolution starts
      const fadeIn = Math.min(1, i / (sr * 0.004));
      data[i] = (s + er * (rand() * 2 - 1)) * 0.36 * fadeIn;
    }

    // Right channel: slight delay (~0.7ms = 30 samples) for stereo width
    if (ch === 1) {
      const delay = 30;
      for (let i = length - 1; i >= delay; i--) {
        data[i] = data[i] * 0.8 + data[i - delay] * 0.2;
      }
      for (let i = 0; i < length; i++) data[i] *= 0.88;
    }
  }

  return ir;
}

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
  muffle: 0.65
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
});

async function startProcessing(tabId, streamId, settings) {
  // Replace any existing session for this tab (re-toggle / restart)
  await stopProcessing(tabId, true);

  if (settings) currentSettings = { ...currentSettings, ...settings };

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

  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const session = { tabId, audioCtx, mediaStream, stopTimer: null };
  session.sourceNode = audioCtx.createMediaStreamSource(mediaStream);

  buildDSPChain(session);
  applySettings(session);

  sessions.set(tabId, session);

  // When the tab is closed or navigates away, its capture track ends.
  // Tear down that session and let the background reconcile its state.
  track.addEventListener('ended', () => {
    stopProcessing(tabId).finally(() => {
      try { chrome.runtime.sendMessage({ type: 'SESSION_ENDED', tabId }); } catch (_) {}
    });
  });
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
  s.convolverNode.buffer = generateBathroomIR(ctx);

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

  s.softClipNode.connect(s.limiterNode);
  s.limiterNode.connect(ctx.destination);
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
  try { if (s.sourceNode) s.sourceNode.disconnect(); } catch (_) {}
  try { if (s.mediaStream) s.mediaStream.getTracks().forEach(t => t.stop()); } catch (_) {}
  try { if (s.audioCtx && s.audioCtx.state !== 'closed') s.audioCtx.close(); } catch (_) {}
}

// ── Bathroom IR generator ──────────────────────────────────────────────
// Models a small tiled room (~2.5m²): dense early reflections at 6–15ms,
// bright initial decay, rapid high-frequency absorption, ~1.1s total decay
function generateBathroomIR(ctx) {
  const sr     = ctx.sampleRate;
  const dur    = 1.1;             // longer tail for a more obvious room
  const length = Math.floor(sr * dur);
  const ir     = ctx.createBuffer(2, length, sr);

  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);

    for (let i = 0; i < length; i++) {
      const t = i / sr;

      // White noise base
      let s = Math.random() * 2 - 1;

      // Early reflections: dense cluster 6–18ms (tile walls close together)
      const er = t < 0.022
        ? Math.exp(-t * 120) * 2.8
        : 0;

      // Main exponential decay — tuned for a ~1.1s RT60
      const decay = Math.exp(-t * 6.2);

      // High-frequency air absorption: tiles reflect highs but air absorbs them
      const hfDamp = t > 0.05
        ? Math.pow(0.5, t * 5.5)
        : 1.0;

      // Combine: early reflections bright, tail increasingly dull
      const hfComponent = s * decay * hfDamp;
      const lfComponent = s * decay;
      s = hfComponent * 0.35 + lfComponent * 0.65;

      // Short fade-in prevents a click when convolution starts
      const fadeIn = Math.min(1, i / (sr * 0.004));
      data[i] = (s + er * (Math.random() * 2 - 1)) * 0.36 * fadeIn;
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

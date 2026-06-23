// Dual-head delay-line pitch shifter.
//
// Two read heads advance through a circular delay buffer at `pitch` samples
// per output sample (vs. write head at 1 sample/output). For pitch > 1 the
// read heads move faster → compressed time → higher pitch. Each head wraps
// every HALF samples; a Hann crossfade between the staggered heads eliminates
// the click at each wrap. No lookahead required — works with live streams.
//
// Latency   : ~HALF/2 samples (~23ms at 44100Hz) during the initial fill.
// Artifact  : mild periodic warble every HALF/|pitch−1| samples
//             (≈186ms at pitch=1.25 — barely perceptible).

const N    = 4096;       // delay buffer size, must be a power of 2
const MASK = N - 1;
const HALF = N >> 1;     // 2048 — each head's wrap interval

// Hann table over [0, HALF] for smooth crossfade
const HANN = new Float32Array(HALF + 1);
for (let k = 0; k <= HALF; k++)
  HANN[k] = 0.5 * (1.0 - Math.cos(2.0 * Math.PI * k / HALF));

class PitchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'pitch', defaultValue: 1.0, minValue: 0.5, maxValue: 2.0, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.bufL = new Float32Array(N);
    this.bufR = new Float32Array(N);
    this.wp   = 0;

    // Two heads staggered by HALF/2 so they remain in quadrature.
    // d = delay of head behind write position, in [0, HALF).
    // At d = HALF/2, Hann weight = 1 (full). At d = 0 or HALF, weight = 0.
    this.d1   = HALF * 0.75;  // head 1: starts at ¾ of range (weight = 0.5)
    this.d2   = HALF * 0.25;  // head 2: starts at ¼ of range (weight = 0.5)

    this._pitch = null;
    this.port.onmessage = e => { if (e.data?.pitch != null) this._pitch = e.data.pitch; };
  }

  process(inputs, outputs, parameters) {
    const pitch = this._pitch ?? parameters.pitch[0] ?? 1.0;
    const inp   = inputs[0];
    const out   = outputs[0];
    if (!out?.[0]) return true;

    const iL  = inp?.[0];
    const iR  = inp?.[1] ?? iL;
    const oL  = out[0];
    const oR  = out[1] ?? out[0];
    const bsz = oL.length;
    const dp  = pitch - 1.0;   // change in delay per sample

    for (let i = 0; i < bsz; i++) {
      // 1. Write input into circular buffer
      const wi = this.wp & MASK;
      this.bufL[wi] = iL ? iL[i] : 0;
      this.bufR[wi] = iR ? iR[i] : 0;
      this.wp++;

      // 2. Shrink delays (for pitch > 1 read heads catch up to write head)
      this.d1 -= dp;
      this.d2 -= dp;

      // 3. Keep delays in [0, HALF) — wrapping is what re-creates pitch
      if (this.d1 <    0) this.d1 += HALF;
      if (this.d1 >= HALF) this.d1 -= HALF;
      if (this.d2 <    0) this.d2 += HALF;
      if (this.d2 >= HALF) this.d2 -= HALF;

      // 4. Fractional read positions behind write head
      const rp1 = this.wp - 1 - this.d1;
      const rp2 = this.wp - 1 - this.d2;

      // 5. Linear interpolation (Math.floor + & MASK handles negatives correctly in JS)
      const fi1 = Math.floor(rp1);
      const a1  = fi1 & MASK, b1 = (a1 + 1) & MASK, t1 = rp1 - fi1;
      const sL1 = this.bufL[a1] + (this.bufL[b1] - this.bufL[a1]) * t1;
      const sR1 = this.bufR[a1] + (this.bufR[b1] - this.bufR[a1]) * t1;

      const fi2 = Math.floor(rp2);
      const a2  = fi2 & MASK, b2 = (a2 + 1) & MASK, t2 = rp2 - fi2;
      const sL2 = this.bufL[a2] + (this.bufL[b2] - this.bufL[a2]) * t2;
      const sR2 = this.bufR[a2] + (this.bufR[b2] - this.bufR[a2]) * t2;

      // 6. Hann crossfade: heads near d≈0 or d≈HALF are faded out,
      //    heads near d≈HALF/2 carry full weight — guarantees smooth wrap
      const w1 = HANN[this.d1 | 0];
      const w2 = HANN[this.d2 | 0];
      const ws = w1 + w2 || 1.0;

      oL[i] = (w1 * sL1 + w2 * sL2) / ws;
      oR[i] = (w1 * sR1 + w2 * sR2) / ws;
    }
    return true;
  }
}

registerProcessor('pitch-processor', PitchProcessor);

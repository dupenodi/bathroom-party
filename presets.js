const PRESET_CATALOG = [
  {
    id: 'party', group: 'Bathroom', label: 'Bathroom', family: 'party',
    depth: 50, muffle: 50, bass: 50,
    dsp: { irSize: 0.38, irGain: 0.32, wetMul: 1.05, bodyMul: 1.0, bassMul: 1.18, erMul: 0.88, seed: 0x9e3779b1 },
    ui: {
      off: 'off',
      on: 'through the wall',
      loading: 'connecting…',
      stopping: 'disconnecting…',
      vizIdle: 'no signal',
      vizActive: 'listening',
      vizLive: 'live',
      sliders: {
        depth:  ['Depth', 'how far in'],
        muffle: ['Muffle', 'wall thickness'],
        bass:   ['Bass', 'thump through walls']
      }
    }
  },
  {
    id: 'hall', group: 'Hall', label: 'Hall', family: 'hall',
    depth: 94, muffle: 14, bass: 30,
    dsp: { preDelay: 0.072, combMix: 0.22, dampBase: 4200, seed: 0xc0ffee01 },
    ui: {
      off: 'off',
      on: 'hall reverb',
      loading: 'connecting…',
      stopping: 'disconnecting…',
      vizIdle: 'silent',
      vizActive: 'listening',
      vizLive: 'live',
      sliders: {
        depth:  ['Distance', 'how deep inside'],
        muffle: ['Damping', 'tail brightness'],
        bass:   ['Low cut', 'keep mud out']
      }
    }
  },
  {
    id: 'lofi', group: 'Lo-fi', label: 'Lo-fi', family: 'lofi',
    depth: 42, muffle: 78, bass: 48,
    dsp: { irSize: 0.12, crushBits: 9, wowDepth: 0.0028, hiss: 0.006, seed: 0x10aded01 },
    ui: {
      off: 'off',
      on: 'lo-fi tape',
      loading: 'connecting…',
      stopping: 'disconnecting…',
      vizIdle: 'silent',
      vizActive: 'listening',
      vizLive: 'live',
      sliders: {
        depth:  ['Room', 'how boxy'],
        muffle: ['Warmth', 'roll off highs'],
        bass:   ['Weight', 'low-end body']
      }
    }
  }
];

const PRESET_DSP = Object.fromEntries(PRESET_CATALOG.map(p => [p.id, { ...p.dsp, family: p.family }]));
const DEFAULT_PRESET_ID = 'party';

function getPresetDef(id) {
  return PRESET_CATALOG.find(p => p.id === id) ?? PRESET_CATALOG[0];
}

function getPresetFamily(id) {
  return getPresetDef(id).family;
}

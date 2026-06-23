const PRESET_CATALOG = [
  {
    id: 'party', group: 'Bathroom', label: 'Bathroom', family: 'party',
    depth: 55, muffle: 60, bass: 60,
    dsp: {},
    ui: {
      off: 'off',
      on: 'through the wall',
      loading: 'connecting…',
      stopping: 'disconnecting…',
      vizIdle: 'no signal',
      vizActive: 'listening',
      vizLive: 'live',
      sliders: {
        depth:  ['Depth', 'how far away'],
        muffle: ['Muffle', 'wall thickness'],
        bass:   ['Bass', 'thump through walls']
      }
    }
  },
  {
    id: 'hall', group: 'Bathroom', label: 'Hall', family: 'hall',
    depth: 70, muffle: 25, bass: 40,
    dsp: { preDelay: 0.072, combMix: 0.22, dampBase: 5000, seed: 0xc0ffee01 },
    ui: {
      off: 'off',
      on: 'hall reverb',
      loading: 'connecting…',
      stopping: 'disconnecting…',
      vizIdle: 'silent',
      vizActive: 'listening',
      vizLive: 'live',
      sliders: {
        depth:  ['Distance', 'how deep in the hall'],
        muffle: ['Damping', 'tail brightness'],
        bass:   ['Low cut', 'remove mud']
      }
    }
  },
  {
    id: 'lofi', group: 'Bathroom', label: 'Lo-fi', family: 'lofi',
    depth: 55, muffle: 65, bass: 50,
    dsp: { crushBits: 9, wowDepth: 0.0038, hiss: 0.009, seed: 0x10aded01 },
    ui: {
      off: 'off',
      on: 'lo-fi tape',
      loading: 'connecting…',
      stopping: 'disconnecting…',
      vizIdle: 'silent',
      vizActive: 'listening',
      vizLive: 'live',
      sliders: {
        depth:  ['Drive', 'tape level'],
        muffle: ['Warmth', 'roll off highs'],
        bass:   ['Body', 'low-end weight']
      }
    }
  },
  {
    id: 'nightcore', group: 'Effects', label: 'Nightcore', family: 'nightcore',
    depth: 50, muffle: 50, bass: 50,
    dsp: { baseRate: 1.25, brightHz: 7000, rateDepth: 0.25, seed: 0x91c0de02 },
    ui: {
      off: 'off',
      on: 'nightcore',
      loading: 'connecting…',
      stopping: 'disconnecting…',
      vizIdle: 'no signal',
      vizActive: 'listening',
      vizLive: 'live',
      sliders: {
        depth:  ['Speed', 'faster & higher pitch'],
        muffle: ['Sparkle', 'anime brightness'],
        bass:   ['Bass', 'low-end weight']
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

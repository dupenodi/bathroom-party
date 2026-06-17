# Bathroom Party

A Chrome extension that makes any tab's audio sound like you're hearing it from
the bathroom at a 2007 house party — muffled through the wall, bass thumping
through, reverb bouncing off the tiles.

## What it does

It captures a tab's audio and runs it through a real-time DSP chain:

- **Depth** — how far into the bathroom you are (dry → fully drowned in reverb)
- **Muffle** — wall thickness (rolls off the highs, pushes vocals back)
- **Bass** — the thump that travels through walls (kept tight on its own clean path)

Each tab is processed independently, so you can have the bathroom effect on
your music tab and a different tab playing normally at the same time.

## How it works

- `popup.html` / `popup.js` — the controls (per-tab toggle + sliders)
- `background.js` — service worker that owns capture state across tabs
- `offscreen.js` — the Web Audio DSP chain (one session per captured tab)

The audio model mirrors real wall acoustics: mids and highs get muffled and
reverberated, while low frequencies split off into a dedicated dry path so the
bass stays punchy instead of turning to mud. A soft clipper + limiter keep the
output clean and crackle-free.

## Install (development)

1. Clone this repo.
2. Go to `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.
5. Open a tab playing audio, click the extension icon, and hit the toggle.

## Notes

- Can't capture `chrome://` pages or the Chrome Web Store (Chrome restriction).
- Click on the page first if Chrome asks for an interaction before capture.

## License

MIT

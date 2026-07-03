# DealInbox

**One extraordinary drop of designer lighting, every day — previewed in interactive 3D.**

A premium daily-deals experience for dealinbox.com. Every listed product can be
explored in a real-time 3D viewer before purchase: orbit it, switch it on and off,
sweep the light temperature from 2200K candlelight to 6500K daylight, and dial the
brightness — all rendered live in WebGL.

## Highlights

- **Interactive 3D lighting previews** — six procedurally modelled designer lamps
  (brass pendant, crystal chandelier, arc floor lamp, Murano mushroom lamp, neon
  sculpture, articulated task lamp) built with Three.js. Physically-inspired
  materials, soft shadows, ACES tone mapping, and a kelvin-accurate light
  temperature control.
- **Live 3D hero** — the crystal chandelier spins in the hero, draggable and zoomable.
- **Real-time card thumbnails** — deal-card imagery is rendered from the actual 3D
  models at page load, so the catalogue and the viewer always match.
- **Warm-dark editorial design** — Fraunces + Inter (self-hosted variable fonts),
  glassmorphism cards, scroll-reveal animations, count-up stats, brand marquee,
  live drop countdowns to midnight.
- **Zero build step, zero external requests** — Three.js and fonts are vendored;
  the site is plain HTML/CSS/ES-modules and works from any static host.
- **Accessible & responsive** — semantic landmarks, dialog focus trap, keyboard
  operable cards and switches, `prefers-reduced-motion` support, fully responsive
  down to 390px.
- **Graceful degradation** — if WebGL is unavailable the site falls back to a clean
  2D experience automatically.

## Running locally

No build required — serve the folder with any static server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Structure

```
index.html        — single-page site (import map maps 'three' to the vendored build)
css/style.css     — design system + all component styles
js/main.js        — catalogue data, cards, countdowns, viewer modal wiring
js/viewer3d.js    — 3D engine: procedural lamp models, ProductViewer, thumbnails
vendor/           — three.module.min.js, three.core.min.js, OrbitControls.js
fonts/            — self-hosted Fraunces & Inter variable fonts
```

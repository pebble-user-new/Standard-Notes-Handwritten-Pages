# Handwritten Pages for Standard Notes

A paper-notebook style handwriting editor for [Standard Notes](https://standardnotes.com). Each note is a notebook of **A4 pages** you write on with a stylus, finger or mouse.

- **Paper:** blank, lined, grid or dotted (narrow / medium / wide spacing; white, cream or grey paper)
- **Pinch to zoom** in to write small, zoom out to see several pages side by side
- **Swipe sideways** to turn the page, or use the arrows, the page counter (all-pages overview) or the keyboard
- **Pen, highlighter and eraser** (rub-out or whole-stroke), pressure-sensitive with a stylus, undo / redo
- **Everything lives in one note**, stored as compact text, so it syncs, encrypts and backs up like any other note
- Follows your Standard Notes theme (light / dark); the paper stays paper-coloured

It is a small, dependency-free canvas app (about 53 KB of JavaScript), not a wrapper around Excalidraw.

## Install

The plugin is a static web page that Standard Notes loads from a URL.

1. Host the built `dist/` folder somewhere reachable over HTTPS (see [Hosting](#hosting)).
2. In Standard Notes: **Preferences → General → Advanced Settings → Install Custom Plugin**, and paste the link to `ext.json`, e.g.
   `https://pebble-user-new.github.io/Standard-Notes-Handwritten-Pages/ext.json`
3. Open a note, choose the editor menu, pick **Handwritten Pages**.

Once installed on the web or desktop app the plugin syncs to your other devices (including mobile) with your account. Standard Notes may require a paid plan for custom plugins.

> **Heads up:** changing an existing text note to this editor does not convert it. The plugin refuses to overwrite a note that isn't one of its notebooks (it offers an explicit "erase and start a notebook" button instead). Use a new note.

## Using it

| Do this | To |
| --- | --- |
| Pen / stylus on the page | Draw |
| Pinch with two fingers | Zoom in and out (zoomed out shows several pages) |
| Swipe sideways with two fingers (or one finger in *Pen only* mode) | Turn the page |
| Tap a page while zoomed out | Open that page |
| Tap the `3 / 12` counter | All-pages overview (tap a page to open it, or add one at the end) |
| `+` in the top bar | Add a page after the current one |
| Page icon in the top bar | Paper style, spacing, colour, duplicate / delete page |
| `⋯` in the top bar | Touch mode, save the page as an image, fit page |
| Tap the active tool again, or the colour dot | Colour and size |

**Touch mode** (menu): *Auto* lets fingers draw until a stylus has been used on this device, after which only the pen draws and fingers scroll and zoom (palm rejection). *Fingers draw* and *Pen only* force one behaviour.

Desktop: mouse draws; scroll wheel pans; ctrl/⌘+wheel or trackpad pinch zooms; hold Space or use the middle/right button to pan; `←` `→` / PageUp / PageDown turn pages; `Ctrl/⌘+Z`, `Ctrl/⌘+Shift+Z` undo and redo; `P` `H` `E` pick pen, highlighter, eraser; `0` fits the page.

## How it is stored

The note text is JSON (`"app":"sn-handwritten-pages"`). Coordinates are in points on an A4 page (595 × 842), in tenths of a point, delta-encoded; strokes are simplified (Ramer–Douglas–Peucker, 0.12 pt) before saving. A page of dense handwriting is typically tens of KB. Opening a note never changes it; the first edit writes it. See `src/codec.ts` for the format. The note preview in the list reads "Handwritten notebook · N pages".

Per-device settings (current tool, colours, sizes, touch mode) are kept in the browser's `localStorage`, not in the note, so they never dirty a note.

## Development

```sh
npm install
npm run dev          # build + watch, serve http://localhost:8085 (mock Standard Notes host at /host.html)
npm run typecheck
npm test             # unit tests (codec, geometry, viewport)
npm run test:e2e     # builds and drives a real Chromium: mouse, stylus and multi-touch input
npm run build        # production build into dist/ (includes ext.json and latest.zip)
```

- `public/local.json` installs your local dev server into Standard Notes under a separate identifier.
- The e2e tests need Playwright with a Chromium build (`npm i -D playwright && npx playwright install chromium`, or point `PLAYWRIGHT_BROWSERS_PATH` at an existing install). Screenshots are written to `test/e2e/out/`.
- Open `…/index.html?debug` to expose the app as `window.__hp` for poking around in dev tools.

### Layout

```
src/model.ts      A4 page, notebook, stroke types
src/codec.ts      compact JSON save format, decode validation
src/geometry.ts   stroke simplification, eraser splitting
src/viewport.ts   page strip, zoom / pan / clamp math (pure, unit-tested)
src/camera.ts     animations, momentum, page snapping
src/draw.ts       paper patterns and stroke rendering
src/renderer.ts   base canvas (pages) + live canvas (stroke in progress)
src/input.ts      pen / touch / mouse / wheel / keyboard handling
src/app.ts        controller: tools, editing, history, saving, external updates
src/ui.ts         bars, popovers, overview, toasts
src/host.ts       Standard Notes bridge (sn-extension-api) with a localStorage fallback
dev/host.html     mock Standard Notes host for local testing
```

## Hosting

`.github/workflows/deploy.yml` builds on every push to `main` and publishes `dist/` to the `gh-pages` branch. To use GitHub Pages: repository **Settings → Pages → Deploy from branch → `gh-pages` / root**. Note that GitHub Pages for a **private** repository needs a paid GitHub plan; on the free plan make the repository public, or host `dist/` on any static host (Cloudflare Pages, Netlify, …), then update the URLs in `public/ext.json`.

`latest.zip` (in `dist/`) is the same build zipped, for the desktop app's offline install.

## Status

Tested in headless Chromium with emulated touch, stylus and mouse against a mock Standard Notes host. Not yet verified inside the real Standard Notes web, desktop or mobile apps; see the project notes for what to check first.

MIT licensed.

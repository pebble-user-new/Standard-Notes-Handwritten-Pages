# Handwritten Pages for Standard Notes

A paper-notebook style handwriting editor for [Standard Notes](https://standardnotes.com). Each note is a notebook of **A4, A5 or A6 pages** you write on with a stylus, finger or mouse.

- **Paper:** blank, lined, grid or dotted (narrow / medium / wide spacing; white, cream or grey paper), in **A4, A5 or A6** (pocket-notebook) sizes, optionally **50 / 75 / 100 % taller** for screens of other shapes
- **Pinch to zoom** in to write small, zoom out to see several pages side by side
- **Swipe sideways** to turn the page, or use the arrows, the page counter (all-pages overview) or the keyboard
- **Pen, highlighter and eraser** (rub-out or whole-stroke), pressure-sensitive with a stylus, undo / redo
- **Presets:** a row of quick-pick pens (left) and highlighters (right), three of each to start with and up to six, with the eraser in the middle. The bottom bar has the Pen and Highlighter buttons, undo / redo in the centre and an add-page button on the right. Pen colours come in 7 hues (including cyan), each with two lighter shades (orange's lightest is yellow)
- **Focus mode:** double-tap with a finger to hide the top toolbar and the bottom bar (the preset row stays, and the browser is asked for fullscreen); a single tap brings the toolbars back over the page
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
| Tap a dot in the preset row | Pick that pen / highlighter preset (tapping the selected one again does nothing) |
| Tap the selected Pen / Highlighter button (bottom bar) or Eraser | Colour and size (or eraser options) for the selected preset, plus *Remove this preset*; tap again to close |
| `+` next to the pens / highlighters | Add a preset (up to six each) and open its colour and size |
| Double-tap with a finger | Focus mode on / off |
| Single tap in focus mode | Show / hide the top toolbar and the bottom bar as an overlay |
| Page icon on the bottom bar | Add a page after the current one |

**Touch mode** (menu): *Pen only* (the default) means only a stylus or mouse draws; fingers scroll, zoom and turn pages. *Auto* lets fingers draw until a stylus has been used on this device, after which only the pen draws. *Fingers draw* always lets fingers draw. A quick finger tap never leaves a dot, so double-tapping is safe in every mode.

**Paper size** (page-style panel): A4 (595 × 842 pt), A5 (420 × 595 pt) or A6 (298 × 420 pt). The size applies to the whole notebook; changing it scales your existing writing to fit, and Undo puts it back. **Taller paper** (Standard, +50 %, +75 %, +100 %) lengthens every page and keeps its width, with any size (A6 + 50 % is 105 × 222 mm, close to the DL envelope size). Your writing is left alone; making the paper shorter again only hides what is below the new bottom edge, and making it taller brings it back.

**Focus mode and Standard Notes' own toolbars:** a plugin cannot hide the app around it. On entering focus mode the plugin asks the browser for fullscreen, which removes the Standard Notes chrome on the web and desktop apps if the app allows it (it cannot on the mobile apps or iPhone); leaving fullscreen with Esc also leaves focus mode.

Desktop: mouse draws; scroll wheel pans; ctrl/⌘+wheel or trackpad pinch zooms; hold Space or use the middle/right button to pan; `←` `→` / PageUp / PageDown turn pages; `Ctrl/⌘+Z`, `Ctrl/⌘+Shift+Z` undo and redo; `P` `H` `E` pick pen, highlighter, eraser; `F` toggles focus mode (Esc leaves it); `0` fits the page.

## How it is stored

The note text is JSON (`"app":"sn-handwritten-pages"`). Coordinates are in points on the page (A4 is 595 × 842), in tenths of a point, delta-encoded; strokes are simplified (Ramer–Douglas–Peucker, 0.12 pt) before saving. A page of dense handwriting is typically tens of KB. Opening a note never changes it; the first edit writes it. A4 notebooks of standard length are written as format `v:1`; others as `v:2` with `sz` (size) and `ln` (extra length, percent) fields, so an older cached copy of the plugin refuses them ("newer notebook format") instead of opening them as A4 and overwriting them. See `src/codec.ts` for the format. The note preview in the list reads "Handwritten notebook · N pages".

The pen and highlighter **presets are saved with the plugin's own synced settings** in Standard Notes (the plugin's `extensionMeta` / component data), so they follow you to your other devices and are shared by all your notes, without touching any note's text. They are written a moment after you change them, never just for opening a note. (A browser copy is kept as a fallback.) Everything else per device (current tool and selected preset, sizes, touch mode) is kept in the browser's `localStorage`, so it never dirties a note.

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
src/model.ts      page sizes (A4/A5/A6), notebook, stroke types
src/codec.ts      compact JSON save format, decode validation
src/geometry.ts   stroke simplification, eraser splitting
src/viewport.ts   page strip, zoom / pan / clamp math (pure, unit-tested)
src/camera.ts     animations, momentum, page snapping
src/draw.ts       paper patterns and stroke rendering
src/renderer.ts   base canvas (pages) + live canvas (stroke in progress)
src/input.ts      pen / touch / mouse / wheel / keyboard handling
src/app.ts        controller: tools, editing, history, saving, external updates
src/ui.ts         toolbars, preset row, popovers, overview, toasts, focus mode
src/prefs.ts      per-device preferences, colour palette, presets
src/host.ts       Standard Notes bridge (sn-extension-api) with a localStorage fallback
dev/host.html     mock Standard Notes host for local testing
```

## Hosting

`.github/workflows/deploy.yml` builds on every push to `main` and publishes `dist/` to the `gh-pages` branch. To use GitHub Pages: repository **Settings → Pages → Deploy from branch → `gh-pages` / root**. Note that GitHub Pages for a **private** repository needs a paid GitHub plan; on the free plan make the repository public, or host `dist/` on any static host (Cloudflare Pages, Netlify, …), then update the URLs in `public/ext.json`.

`latest.zip` (in `dist/`) is the same build zipped, for the desktop app's offline install.

## Status

Tested in headless Chromium with emulated touch, stylus and mouse against a mock Standard Notes host. Not yet verified inside the real Standard Notes web, desktop or mobile apps; see the project notes for what to check first.

MIT licensed.

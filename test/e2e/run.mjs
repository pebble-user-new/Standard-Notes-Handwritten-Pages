// End-to-end tests: builds the plugin, serves it with a mock Standard Notes host and drives it in
// a real Chromium (touch, stylus and mouse input via the DevTools protocol).
//
//   npm run test:e2e
//
// Needs Playwright with a Chromium build (not a dependency of this repo, it is large):
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test/e2e/run.mjs      (any Playwright install works)
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = join(ROOT, 'test/e2e/out');
mkdirSync(OUT, { recursive: true });

async function loadPlaywright() {
  for (const spec of ['playwright', '/opt/npm-tools/node_modules/playwright/index.mjs']) {
    try {
      return await import(spec.startsWith('/') ? pathToFileURL(spec).href : spec);
    } catch {
      /* try next */
    }
  }
  throw new Error('Playwright not found. Install it (npm i -D playwright) or run where it is preinstalled.');
}

execFileSync('node', ['build.mjs', '--dev'], { cwd: ROOT, stdio: 'inherit' });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.zip': 'application/zip' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const file = normalize(join(ROOT, 'dist', url.pathname === '/' ? 'host.html' : url.pathname));
  if (!file.startsWith(join(ROOT, 'dist')) || !existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const { chromium } = await loadPlaywright();
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';
const browser = await chromium.launch();

let failures = 0;
let passed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open the mock host in a new context and return helpers bound to it. */
async function open(label, { mobile = true, query = 'fresh=1', width = 390, height = 800, dsf = 2, init } = {}) {
  console.log(`\n# ${label}`);
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dsf,
    hasTouch: mobile,
    isMobile: mobile,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  // the one-time gesture hint would otherwise pop up in every fresh context
  await page.addInitScript(() => {
    try {
      localStorage.setItem('handwritten-pages:hint-v1', '1');
    } catch {
      /* ignore */
    }
  });
  if (init) await page.addInitScript(init);
  await page.goto(`${BASE}/host.html?${query}`);
  const frame = page.frames().find((f) => f !== page.mainFrame()) ?? (await page.waitForSelector('iframe').then((h) => h.contentFrame()));
  await frame.waitForSelector('.stage canvas.base');
  await frame.waitForFunction(() => window.__hp && window.__hp.vp.vw > 10);
  await sleep(150);
  const cdp = await context.newCDPSession(page);

  const h = {
    context,
    page,
    frame,
    cdp,
    errors,
    sleep,
    ev: (fn, arg) => frame.evaluate(fn, arg),
    state: () =>
      frame.evaluate(() => {
        const a = window.__hp;
        return {
          s: a.vp.s,
          fit: a.vp.fit(),
          ratio: a.vp.ratio(),
          cur: a.curPage(),
          pages: a.nb.pages.length,
          strokes: a.nb.pages.map((p) => p.strokes.length),
          tool: a.prefs.tool,
          template: a.nb.template,
          penSeen: a.prefs.penSeen,
          canUndo: a.history.canUndo,
          unsupported: a.unsupported,
        };
      }),
    saved: () => page.evaluate(() => ({ text: window.mock.note.text, saves: window.mock.saves, preview: window.mock.note.preview })),
    /** screen coordinates (page space) of a point on page `pageIndex` in page-local points */
    toScreen: (px, py, pageIndex = null) =>
      frame.evaluate(
        ([px, py, pi]) => {
          const a = window.__hp;
          const i = pi ?? a.curPage();
          const r = document.querySelector('.stage').getBoundingClientRect();
          const f = window.frameElement ? window.frameElement.getBoundingClientRect() : { left: 0, top: 0 };
          return { x: r.left + f.left + (a.vp.pageX(i) + px) * a.vp.s + a.vp.tx, y: r.top + f.top + py * a.vp.s + a.vp.ty };
        },
        [px, py, pageIndex],
      ),
    click: async (selector) => {
      await frame.click(selector);
      await sleep(60);
    },
    // --- input helpers (page-space coordinates)
    mouseStroke: async (pts) => {
      await page.mouse.move(pts[0].x, pts[0].y);
      await page.mouse.down();
      for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y, { steps: 3 });
      await page.mouse.up();
      await sleep(40);
    },
    penStroke: async (pts, forces) => {
      const send = (type, p, f) => cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: type === 'mouseMoved' && f === 0 ? 'none' : 'left', buttons: f ? 1 : 0, clickCount: 1, pointerType: 'pen', force: f });
      await send('mouseMoved', pts[0], 0);
      await send('mousePressed', pts[0], forces[0]);
      for (let i = 1; i < pts.length; i++) await send('mouseMoved', pts[i], forces[i]);
      await send('mouseReleased', pts[pts.length - 1], 0);
      await sleep(40);
    },
    touch: async (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i, radiusX: 4, radiusY: 4, force: 0.5 })) }),
    touchStroke: async (pts) => {
      await h.touch('touchStart', [pts[0]]);
      for (const p of pts.slice(1)) {
        await h.touch('touchMove', [p]);
        await sleep(8);
      }
      await h.touch('touchEnd', []);
      await sleep(40);
    },
    /** two-finger gesture from (a0,b0) to (a1,b1) in n steps */
    twoFinger: async (a0, b0, a1, b1, n = 12, hold = 0) => {
      await h.touch('touchStart', [{ ...a0, id: 1 }, { ...b0, id: 2 }]);
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const lerp = (p, q) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
        await h.touch('touchMove', [{ ...lerp(a0, a1), id: 1 }, { ...lerp(b0, b1), id: 2 }]);
        await sleep(10);
      }
      if (hold) await sleep(hold);
      await h.touch('touchEnd', []);
      await sleep(420);
    },
    shot: (name) => page.screenshot({ path: join(OUT, `${name}.png`) }),
    close: async () => {
      await context.close();
    },
  };
  return h;
}

function line(x0, y0, x1, y1, n = 8) {
  return Array.from({ length: n }, (_, i) => ({ x: x0 + ((x1 - x0) * i) / (n - 1), y: y0 + ((y1 - y0) * i) / (n - 1) }));
}

try {
  // ------------------------------------------------------------------ 1. boot + mouse drawing + saving
  {
    const t = await open('boot, mouse drawing and saving', { mobile: false, width: 900, height: 760, dsf: 1 });
    let s = await t.state();
    check('boots with one page and no errors', s.pages === 1 && s.cur === 0 && t.errors.length === 0, JSON.stringify({ s, errors: t.errors }));
    check('page fits the screen on load', Math.abs(s.ratio - 1) < 0.01, `ratio ${s.ratio}`);
    check('page label shows 1 / 1', (await t.frame.textContent('.page-label')) === '1 / 1');
    const a = await t.toScreen(100, 200);
    const b = await t.toScreen(400, 260);
    await t.mouseStroke(line(a.x, a.y, b.x, b.y, 10));
    s = await t.state();
    check('mouse drag draws one stroke', s.strokes[0] === 1, JSON.stringify(s.strokes));
    check('stroke can be undone', s.canUndo);
    await sleep(1200);
    const saved = await t.saved();
    const doc = saved.text ? JSON.parse(saved.text) : null;
    check('note text was saved in the compact format', doc && doc.app === 'sn-handwritten-pages' && doc.pages[0].s.length === 1, saved.text.slice(0, 120));
    check('preview text is set', saved.preview === 'Handwritten notebook · 1 page', saved.preview);
    check('a single stroke produced a single save (no echo loop)', saved.saves === 1, `saves ${saved.saves}`);
    await t.shot('01-desktop-drawing');
    await t.close();
  }

  // ------------------------------------------------------------------ 2. stylus with pressure, palm rejection
  {
    const t = await open('stylus pressure and palm rejection');
    const pts = line(...Object.values(await t.toScreen(80, 300)), ...Object.values(await t.toScreen(300, 340)), 14);
    const forces = pts.map((_, i) => 0.15 + (i / (pts.length - 1)) * 0.8);
    await t.penStroke(pts, forces);
    let st = await t.ev(() => {
      const s = window.__hp.nb.pages[0].strokes[0];
      return s ? { pressure: s.pressure, n: s.pts.length / 3, first: s.pts[2], last: s.pts[s.pts.length - 1] } : null;
    });
    check('stylus stroke records pressure', st && st.pressure === true && st.last > st.first + 0.3, JSON.stringify(st));
    check('stylus use is remembered (penSeen)', (await t.state()).penSeen === true);
    // now a finger drag should scroll rather than draw (auto mode after a pen was seen)
    const before = (await t.state()).strokes[0];
    const a = await t.toScreen(100, 500);
    const b = await t.toScreen(300, 500);
    await t.touchStroke(line(a.x, a.y, b.x, b.y, 6));
    const after = await t.state();
    check('after a stylus, a finger no longer draws', after.strokes[0] === before, JSON.stringify(after.strokes));
    await t.shot('02-stylus');
    await t.close();
  }

  // ------------------------------------------------------------------ 3. finger drawing + pinch
  {
    const t = await open('finger drawing and pinch zoom');
    const a = await t.toScreen(100, 200);
    const b = await t.toScreen(350, 230);
    await t.touchStroke(line(a.x, a.y, b.x, b.y, 8));
    let s = await t.state();
    check('one finger draws when no stylus has been used', s.strokes[0] === 1, JSON.stringify(s.strokes));

    // pinch out around the middle of the screen
    const cx = 195;
    const cy = 420;
    await t.twoFinger({ x: cx - 40, y: cy }, { x: cx + 40, y: cy }, { x: cx - 120, y: cy }, { x: cx + 120, y: cy }, 14, 60);
    s = await t.state();
    check('pinching out zooms in', s.ratio > 2, `ratio ${s.ratio.toFixed(2)}`);
    check('pinch did not draw anything', s.strokes[0] === 1, JSON.stringify(s.strokes));
    await t.shot('03-zoomed-in');

    // pinch back in to just above fit (ratio ~1.03) -> should snap to exactly fit
    const half = 120 / (s.ratio / 1.03);
    await t.twoFinger({ x: cx - 120, y: cy }, { x: cx + 120, y: cy }, { x: cx - half, y: cy }, { x: cx + half, y: cy }, 14, 60);
    s = await t.state();
    check('pinching back in near fit snaps to a whole page', Math.abs(s.ratio - 1) < 0.01, `ratio ${s.ratio.toFixed(3)}`);

    // zoom well out: several pages should become visible and drawing is disabled
    await t.click('button[aria-label="Add page after this one"]');
    await t.click('button[aria-label="Add page after this one"]');
    await sleep(350);
    s = await t.state();
    check('added pages navigate to the new page', s.pages === 3 && s.cur === 2, JSON.stringify(s));
    await t.twoFinger({ x: cx - 100, y: cy }, { x: cx + 100, y: cy }, { x: cx - 25, y: cy }, { x: cx + 25, y: cy }, 14, 60);
    s = await t.state();
    check('pinching out far shows an overview (ratio < 0.8)', s.ratio < 0.8, `ratio ${s.ratio.toFixed(2)}`);
    await t.shot('04-overview-zoomed-out');
    // a stroke attempt in overview mode must not draw
    await t.touchStroke(line(150, 300, 250, 330, 5));
    s = await t.state();
    check('drawing is disabled while zoomed out', s.strokes.reduce((x, y) => x + y, 0) === 1, JSON.stringify(s.strokes));
    // tapping a page opens it
    const tap = await t.toScreen(300, 400, 0);
    await t.touch('touchStart', [tap]);
    await t.touch('touchEnd', []);
    await sleep(420);
    s = await t.state();
    check('tapping a page in the overview opens it', s.cur === 0 && Math.abs(s.ratio - 1) < 0.05, JSON.stringify(s));
    check('no script errors during touch tests', t.errors.length === 0, JSON.stringify(t.errors));
    await t.close();
  }

  // ------------------------------------------------------------------ 4. swiping between pages
  {
    const t = await open('swipe between pages');
    for (let i = 0; i < 2; i++) await t.click('button[aria-label="Add page after this one"]');
    await sleep(400);
    await t.click('button[aria-label="Previous page"]');
    await sleep(400);
    await t.click('button[aria-label="Previous page"]');
    await sleep(400);
    let s = await t.state();
    check('prev button goes back to page 1', s.cur === 0 && s.pages === 3, JSON.stringify(s));
    // two-finger swipe left -> next page
    await t.twoFinger({ x: 300, y: 400 }, { x: 330, y: 400 }, { x: 80, y: 400 }, { x: 110, y: 400 }, 8);
    s = await t.state();
    check('two-finger swipe left turns to the next page', s.cur === 1 && Math.abs(s.ratio - 1) < 0.01, JSON.stringify(s));
    // quick short flick right -> previous page
    await t.twoFinger({ x: 150, y: 400 }, { x: 180, y: 400 }, { x: 230, y: 400 }, { x: 260, y: 400 }, 3);
    s = await t.state();
    check('a quick flick right turns back a page', s.cur === 0, JSON.stringify(s));
    // a small drag springs back
    await t.twoFinger({ x: 150, y: 400 }, { x: 180, y: 400 }, { x: 175, y: 400 }, { x: 205, y: 400 }, 8, 150);
    s = await t.state();
    check('a small drag springs back to the same page', s.cur === 0 && Math.abs(s.ratio - 1) < 0.01, JSON.stringify(s));
    // pen-only mode: a single finger swipes
    await t.click('button[aria-label="More"]');
    await t.frame.click('.pop.menu .seg button:has-text("Pen only")');
    await t.frame.click('.stage', { position: { x: 5, y: 5 }, force: true }).catch(() => {});
    await sleep(200);
    await t.touchStroke(line(320, 400, 60, 400, 8));
    await sleep(400);
    s = await t.state();
    check('in pen-only mode one finger swipes to the next page', s.cur === 1, JSON.stringify(s));
    check('...without drawing', s.strokes.every((n) => n === 0), JSON.stringify(s.strokes));
    check('no script errors', t.errors.length === 0, JSON.stringify(t.errors));
    await t.close();
  }

  // ------------------------------------------------------------------ 4b. zoomed in: sideways scroll settles on one page
  {
    const t = await open('zoomed-in sideways scroll and overview grid');
    await t.click('button[aria-label="Add page after this one"]');
    await sleep(350);
    await t.ev(() => {
      const a = window.__hp;
      // zoomed in 2x on page 1, with its right edge at x = 300 on a 390 px wide screen
      const s = a.vp.fit() * 2;
      a.vp.view = { s, tx: 300 - (a.vp.pageX(0) + 595) * s, ty: 24 };
      a.viewChanged();
    });
    const y = 300;
    // two-finger drag left by 170 px: pushes the page edge to ~130 px, the next page shows on the right
    await t.twoFinger({ x: 300, y }, { x: 340, y }, { x: 130, y }, { x: 170, y }, 10, 120);
    const r = await t.ev(() => {
      const a = window.__hp;
      const x0 = -a.vp.tx / a.vp.s;
      const x1 = (a.vp.vw - a.vp.tx) / a.vp.s;
      return { x0, x1, next: a.vp.pageX(1), edge0: a.vp.pageX(0) + 595, cur: a.curPage(), ratio: a.vp.ratio() };
    });
    check('after scrolling past the edge the view settles on the next page', r.x0 >= r.next - 12 / (r.ratio * 0.6) && r.cur === 1, JSON.stringify(r));
    check('...keeping the zoom level', r.ratio > 1.9 && r.ratio < 2.1, `ratio ${r.ratio}`);

    // overview grid
    await t.click('.page-label');
    check('tapping the page counter opens the overview', await t.frame.isVisible('.overview'));
    const thumbs = await t.frame.locator('.overview .thumb').count();
    check('overview lists every page plus an add tile', thumbs === 3, `thumbs ${thumbs}`);
    await sleep(200);
    await t.shot('04b-overview-grid');
    await t.frame.click('.overview .thumb >> nth=0');
    await sleep(450);
    const s2 = await t.state();
    check('picking a thumbnail opens that page', s2.cur === 0 && !(await t.frame.isVisible('.overview')), JSON.stringify(s2));
    check('no script errors', t.errors.length === 0, JSON.stringify(t.errors));
    await t.close();
  }

  // ------------------------------------------------------------------ 4c. handwriting rendering sample (visual)
  {
    const t = await open('handwriting rendering sample', { mobile: false, width: 900, height: 900, dsf: 2 });
    const word = (ox, oy, seed) => {
      // a looping cursive-ish path in page points
      const pts = [];
      for (let k = 0; k <= 60; k++) {
        const u = k / 60;
        pts.push({ x: ox + u * 150 + Math.sin(u * 22 + seed) * 7, y: oy + Math.cos(u * 22 + seed) * 11 + Math.sin(u * 5) * 4, f: 0.25 + 0.6 * Math.abs(Math.sin(u * 9 + seed)) });
      }
      return pts;
    };
    for (let row = 0; row < 3; row++) {
      const w = word(60, 190 + row * 22, row);
      const scr = await Promise.all(w.map((p) => t.toScreen(p.x, p.y)));
      await t.penStroke(scr, w.map((p) => p.f));
    }
    await t.click('button[aria-label="Highlighter"]');
    const h0 = await t.toScreen(50, 186);
    const h1 = await t.toScreen(230, 186);
    await t.mouseStroke([h0, h1]);
    await t.click('button[aria-label="Pen"]');
    await t.click('button[aria-label="Pen"]'); // open ink popover
    await t.frame.click('.pop.ink .swatch >> nth=1');
    await t.click('button[aria-label="Pen"]'); // close
    const w2 = word(60, 330, 2);
    await t.penStroke(await Promise.all(w2.map((p) => t.toScreen(p.x, p.y))), w2.map((p) => p.f));
    await t.shot('04c-handwriting');
    // zoom in 4x on the writing for a close look
    await t.ev(() => {
      const a = window.__hp;
      const s = a.vp.fit() * 4;
      const c = a.vp.pageX(0) + 140;
      a.vp.view = a.vp.clampView({ s, tx: a.vp.vw / 2 - c * s, ty: a.vp.vh / 2 - 215 * s });
      a.viewChanged();
      a.renderer.flush();
    });
    await t.shot('04d-handwriting-zoom');
    check('no script errors', t.errors.length === 0, JSON.stringify(t.errors));
    await t.close();
  }

  // ------------------------------------------------------------------ 5. eraser, undo/redo, tools
  {
    const t = await open('eraser, undo and redo', { mobile: false, width: 900, height: 760, dsf: 1 });
    const a = await t.toScreen(100, 300);
    const b = await t.toScreen(500, 300);
    await t.mouseStroke(line(a.x, a.y, b.x, b.y, 12));
    await t.click('button[aria-label="Eraser"]');
    const m = await t.toScreen(300, 280);
    const m2 = await t.toScreen(300, 320);
    await t.mouseStroke([m, m2]);
    let s = await t.state();
    check('erasing across a stroke splits it in two', s.strokes[0] === 2, JSON.stringify(s.strokes));
    await t.page.keyboard.press('Control+z');
    await sleep(60);
    s = await t.state();
    check('undo restores the erased stroke as one piece', s.strokes[0] === 1, JSON.stringify(s.strokes));
    await t.page.keyboard.press('Control+Shift+z');
    await sleep(60);
    s = await t.state();
    check('redo re-applies the erase', s.strokes[0] === 2, JSON.stringify(s.strokes));
    // whole-stroke mode
    await t.click('button[aria-label="Eraser"]'); // opens popover
    await t.frame.click('.pop.ink .seg button:has-text("Whole stroke")');
    await t.frame.click('.stage', { position: { x: 3, y: 3 }, force: true, button: 'middle' }).catch(() => {});
    await sleep(100);
    const m3 = await t.toScreen(150, 280);
    const m4 = await t.toScreen(150, 320);
    await t.mouseStroke([m3, m4]);
    s = await t.state();
    check('whole-stroke eraser removes only the stroke it touches', s.strokes[0] === 1, JSON.stringify(s.strokes));
    await t.shot('05-eraser');
    // highlighter
    await t.click('button[aria-label="Highlighter"]');
    const h1 = await t.toScreen(320, 300);
    const h2 = await t.toScreen(520, 300);
    await t.mouseStroke([h1, h2]);
    s = await t.state();
    check('highlighter stroke is added', s.strokes[0] === 2 && s.tool === 'highlighter', JSON.stringify(s));
    const kinds = await t.ev(() => window.__hp.nb.pages[0].strokes.map((x) => x.tool));
    check('highlighter strokes are recorded as such', kinds.includes('highlighter'), JSON.stringify(kinds));
    await t.close();
  }

  // ------------------------------------------------------------------ 6. page style, persistence, reload
  {
    const t = await open('page style and persistence', { mobile: false, width: 900, height: 760, dsf: 1 });
    await t.click('button[aria-label="Page style"]');
    await t.frame.click('.pop.page .tile:has-text("Grid")');
    await t.frame.click('.pop.page .seg button:has-text("Wide")');
    let s = await t.state();
    check('page style can be switched to grid', s.template === 'grid', s.template);
    await t.shot('06-grid-popover');
    await t.frame.click('.pop.page .tile:has-text("Dotted")');
    await t.frame.click('.pop.page .swatch.paper >> nth=1');
    await t.click('button[aria-label="Page style"]'); // close
    const a = await t.toScreen(100, 200);
    const b = await t.toScreen(300, 260);
    await t.mouseStroke(line(a.x, a.y, b.x, b.y, 8));
    await t.click('button[aria-label="Add page after this one"]');
    await sleep(500);
    const c = await t.toScreen(100, 200);
    const d = await t.toScreen(300, 260);
    await t.mouseStroke(line(c.x, c.y, d.x, d.y, 8));
    await t.shot('07-dotted-cream-page2');
    await sleep(1200);
    const saved = await t.saved();
    const doc = JSON.parse(saved.text);
    check('settings and pages are in the saved text', doc.t === 'dots' && doc.sp === 2 && doc.pp === 'cream' && doc.pages.length === 2, JSON.stringify({ t: doc.t, sp: doc.sp, pp: doc.pp, pages: doc.pages.length }));
    check('new page inherits the chosen paper style', doc.pages[1].t === 'dots', doc.pages[1].t);
    // reload: the mock host keeps the note in localStorage
    await t.page.goto(`${BASE}/host.html`);
    await t.page.waitForSelector('iframe');
    const fr = await (await t.page.$('iframe')).contentFrame();
    await fr.waitForFunction(() => window.__hp && window.__hp.nb.pages.length === 2);
    const r = await fr.evaluate(() => ({ cur: window.__hp.curPage(), strokes: window.__hp.nb.pages.map((p) => p.strokes.length), tpl: window.__hp.nb.template, paper: window.__hp.nb.paper }));
    check('notebook is restored after reload', r.strokes.join() === '1,1' && r.tpl === 'dots' && r.paper === 'cream', JSON.stringify(r));
    check('reopens on the last page with ink', r.cur === 1, JSON.stringify(r));
    await t.close();
  }

  // ------------------------------------------------------------------ 7. foreign note, locked note, external change
  {
    const t = await open('foreign text, locked note, external edits', { mobile: false, width: 900, height: 760, dsf: 1 });
    await t.page.evaluate(() => window.mock.setText('# A plain markdown note\n\nHello'));
    await sleep(200);
    let s = await t.state();
    check('a non-notebook note is flagged unsupported', s.unsupported === 'foreign', JSON.stringify(s));
    check('the notice is visible', await t.frame.isVisible('.notice'));
    const before = (await t.saved()).text;
    const a = await t.toScreen(100, 200);
    await t.mouseStroke([a, { x: a.x + 80, y: a.y + 20 }]);
    await sleep(900);
    check('drawing on an unsupported note does not overwrite it', (await t.saved()).text === before && before.startsWith('# A plain'));
    await t.shot('08-unsupported');
    // the erase button needs two taps and then starts a fresh notebook
    await t.frame.click('.notice .primary');
    check('erase needs a second tap to confirm', (await t.state()).unsupported === 'foreign');
    await t.frame.click('.notice .primary');
    await sleep(1000);
    check('second tap starts an empty notebook and saves it', (await t.state()).unsupported === null && JSON.parse((await t.saved()).text).app === 'sn-handwritten-pages');
    // an external update with a valid notebook replaces the view
    const doc = JSON.stringify({ app: 'sn-handwritten-pages', v: 1, t: 'grid', sp: 1, pp: 'white', pages: [{ t: 'grid', s: [[0, '1f4fd8', 14, 0, 1000, 1000, 500, 100]] }, { t: 'blank', s: [] }] });
    await t.page.evaluate((d) => window.mock.setText(d), doc);
    await sleep(250);
    s = await t.state();
    check('an external update loads a valid notebook', s.unsupported === null && s.pages === 2 && s.strokes[0] === 1, JSON.stringify(s));
    // locked
    await t.page.evaluate(() => window.mock.setLocked(true));
    await sleep(200);
    const n0 = (await t.state()).strokes[0];
    const b2 = await t.toScreen(100, 400, 0);
    await t.mouseStroke([b2, { x: b2.x + 100, y: b2.y + 10 }]);
    check('a locked note cannot be drawn on', (await t.state()).strokes[0] === n0);
    check('...and its editing buttons are disabled', await t.frame.isDisabled('button[aria-label="Pen"]'));
    await t.page.evaluate(() => window.mock.setLocked(false));
    await sleep(200);
    check('unlocking re-enables editing', !(await t.frame.isDisabled('button[aria-label="Pen"]')));
    check('no script errors', t.errors.length === 0, JSON.stringify(t.errors));
    await t.close();
  }

  // ------------------------------------------------------------------ 8. performance on a dense page
  {
    const t = await open('dense page performance', { mobile: false, width: 900, height: 760, dsf: 1 });
    const ms = await t.ev(() => {
      const a = window.__hp;
      const strokes = [];
      // ~2400 handwriting-sized strokes (about 4x the ink of a full handwritten page)
      for (let i = 0; i < 2400; i++) {
        const x0 = 20 + (i % 40) * 14;
        const y0 = 40 + Math.floor(i / 40) * 12;
        const pts = [];
        for (let k = 0; k < 14; k++) pts.push(x0 + Math.sin(k * 0.9) * 4 + k * 0.4, y0 + Math.cos(k * 0.7) * 4, 0.3 + 0.5 * Math.abs(Math.sin(k * 0.5)));
        strokes.push({ tool: 'pen', color: '#1c1c1e', width: 1.4, pressure: true, pts });
      }
      a.nb.pages[0].strokes = strokes;
      a.vp.pages = 1;
      const times = [];
      for (let i = 0; i < 12; i++) {
        a.vp.zoomAt(450, 380, a.vp.s * 1.06);
        const t0 = performance.now();
        a.renderer.flush();
        times.push(performance.now() - t0);
        a.viewChanged();
      }
      times.sort((p, q) => p - q);
      return { median: times[6], max: times[11] };
    });
    console.log(`       dense page (2400 pressure strokes) redraw: median ${ms.median.toFixed(1)} ms, max ${ms.max.toFixed(1)} ms (software rendering in headless Chromium)`);
    check('dense-page redraw stays under 100 ms even in software rendering', ms.median < 100, JSON.stringify(ms));
    await t.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);

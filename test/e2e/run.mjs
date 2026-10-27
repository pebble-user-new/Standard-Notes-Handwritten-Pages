// End-to-end tests: builds the plugin, serves it with a mock Standard Notes host and drives it in
// a real Chromium (touch, stylus and mouse input via the DevTools protocol).
//
//   npm run test:e2e
//
// Needs Playwright with a Chromium build (not a dependency of this repo, it is large):
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test/e2e/run.mjs      (any Playwright install works)
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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

// E2E_PROD=1 runs the suite against the minified production bundle instead of the dev build
const prod = process.env.E2E_PROD === '1';
execFileSync('node', ['build.mjs', ...(prod ? [] : ['--dev'])], { cwd: ROOT, stdio: 'inherit' });
if (prod) copyFileSync(join(ROOT, 'dev/host.html'), join(ROOT, 'dist/host.html'));
console.log(prod ? 'Testing the PRODUCTION bundle' : 'Testing the dev bundle');

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
async function open(label, { mobile = true, query = 'fresh=1', width = 390, height = 800, dsf = 2, init, touch, prefs } = {}) {
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
      localStorage.setItem('handwritten-pages:hint-v2', '1');
    } catch {
      /* ignore */
    }
  });
  if (touch || prefs) {
    await page.addInitScript(
      ([touch, prefs]) => {
        try {
          if (!localStorage.getItem('handwritten-pages:prefs:v1')) localStorage.setItem('handwritten-pages:prefs:v1', JSON.stringify(prefs ?? { v: 2, touch }));
        } catch {
          /* ignore */
        }
      },
      [touch, prefs],
    );
  }
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
          touch: a.prefs.touch,
          focus: a.focus,
          size: a.nb.size,
          pageW: a.vp.pageW,
          pageH: a.vp.pageH,
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
    touch: async (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i, radiusX: p.r ?? 4, radiusY: p.r ?? 4, force: 0.5 })) }),
    touchStroke: async (pts, r) => {
      const pp = r ? pts.map((q) => ({ ...q, r })) : pts;
      await h.touch('touchStart', [pp[0]]);
      for (const p of pp.slice(1)) {
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
    const t = await open('stylus pressure and palm rejection', { touch: 'auto' });
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
    const t = await open('finger drawing and pinch zoom', { touch: 'draw' });
    const a = await t.toScreen(100, 200);
    const b = await t.toScreen(350, 230);
    await t.touchStroke(line(a.x, a.y, b.x, b.y, 8));
    let s = await t.state();
    check('in "fingers draw" mode one finger draws', s.strokes[0] === 1, JSON.stringify(s.strokes));

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
    // pen-only is the default: a single finger swipes
    check('touch mode defaults to pen only', (await t.state()).touch === 'scroll');
    await t.touchStroke(line(320, 400, 60, 400, 8));
    await sleep(400);
    s = await t.state();
    check('by default one finger swipes to the next page', s.cur === 1, JSON.stringify(s));
    check('...without drawing', s.strokes.every((n) => n === 0), JSON.stringify(s.strokes));
    check('no script errors', t.errors.length === 0, JSON.stringify(t.errors));
    await t.close();
  }

  // ------------------------------------------------------------------ 4a. double-tap focus mode
  {
    const t = await open('double-tap focus mode');
    const tapAt = async (x, y) => {
      await t.touch('touchStart', [{ x, y }]);
      await sleep(30);
      await t.touch('touchEnd', []);
    };
    const barsShown = () => t.frame.evaluate(() => [...document.querySelectorAll('.bar.top, .bar.bottom')].every((b) => getComputedStyle(b).visibility !== 'hidden'));
    const c = await t.toScreen(300, 400);
    await tapAt(c.x, c.y);
    await sleep(500);
    check('a single tap does not toggle focus mode', (await t.state()).focus === false && (await barsShown()));
    await tapAt(c.x, c.y);
    await sleep(120);
    await tapAt(c.x + 6, c.y + 4);
    await sleep(450);
    let s = await t.state();
    check('double-tap with a finger enters focus mode', s.focus === true, JSON.stringify(s));
    check('...which hides the top toolbar and the bottom bar', !(await barsShown()));
    check('...and the page gets the whole screen (still fits)', Math.abs(s.ratio - 1) < 0.02, `ratio ${s.ratio}`);
    await sleep(500);
    await tapAt(c.x, c.y);
    await sleep(120);
    await tapAt(c.x, c.y);
    await sleep(450);
    s = await t.state();
    check('double-tap again brings the toolbars back', s.focus === false && (await barsShown()), JSON.stringify(s));
    // too slow / too far apart is not a double tap
    await tapAt(c.x, c.y);
    await sleep(600);
    await tapAt(c.x, c.y);
    await sleep(200);
    check('two slow taps do not toggle', (await t.state()).focus === false);
    await tapAt(c.x - 100, c.y);
    await sleep(100);
    await tapAt(c.x + 100, c.y);
    await sleep(200);
    check('two taps far apart do not toggle', (await t.state()).focus === false);
    // a swipe followed by a tap is not a double tap either
    await t.touchStroke(line(300, 400, 280, 400, 4));
    await tapAt(c.x, c.y);
    await sleep(200);
    check('a drag followed by a tap does not toggle', (await t.state()).focus === false);
    // menu entry + keyboard
    await t.click('button[aria-label="More"]');
    await t.frame.click('.pop.menu .row:has-text("Focus mode")');
    await sleep(150);
    check('the menu has a Focus mode entry', (await t.state()).focus === true);
    await t.page.keyboard.press('Escape');
    await sleep(100);
    check('Escape leaves focus mode', (await t.state()).focus === false);
    check('no script errors', t.errors.length === 0, JSON.stringify(t.errors));
    await t.close();
  }

  // ------------------------------------------------------------------ 4a2. double-tap in "fingers draw" mode leaves no dots
  {
    const t = await open('double-tap while fingers draw', { touch: 'draw' });
    const c = await t.toScreen(300, 400);
    for (let i = 0; i < 2; i++) {
      await t.touch('touchStart', [{ x: c.x, y: c.y }]);
      await sleep(30);
      await t.touch('touchEnd', []);
      await sleep(110);
    }
    await sleep(200);
    const s = await t.state();
    check('double-tap toggles focus even when fingers draw', s.focus === true, JSON.stringify(s));
    check('...and leaves no stray dots', s.strokes[0] === 0, JSON.stringify(s.strokes));
    const a = await t.toScreen(100, 200);
    const b = await t.toScreen(300, 240);
    await t.touchStroke(line(a.x, a.y, b.x, b.y, 8));
    check('fingers still draw normally in focus mode', (await t.state()).strokes[0] === 1);
    await t.close();
  }

  // ------------------------------------------------------------------ 4a3. paper sizes
  {
    const t = await open('paper sizes (A4, A5, A6)', { mobile: false, width: 900, height: 760, dsf: 1 });
    let s = await t.state();
    check('new notebooks are A4', s.size === 'a4' && s.pageW === 595 && s.pageH === 842, JSON.stringify(s));
    const a = await t.toScreen(100, 200);
    const b = await t.toScreen(400, 260);
    await t.mouseStroke(line(a.x, a.y, b.x, b.y, 10));
    await sleep(1100);
    let doc = JSON.parse((await t.saved()).text);
    check('an A4 notebook is saved as v1 with no size field', doc.v === 1 && doc.sz === undefined, JSON.stringify({ v: doc.v, sz: doc.sz }));
    const w0 = await t.ev(() => window.__hp.nb.pages[0].strokes[0].width);
    const x0 = await t.ev(() => window.__hp.nb.pages[0].strokes[0].pts[0]);

    await t.click('button[aria-label="Page style"]');
    await t.frame.click('.pop.page .seg button:has-text("A5")');
    await sleep(500);
    s = await t.state();
    check('choosing A5 resizes the pages', s.size === 'a5' && s.pageW === 420 && s.pageH === 595, JSON.stringify(s));
    check('...and the page still fits the screen', Math.abs(s.ratio - 1) < 0.02, `ratio ${s.ratio}`);
    const k = 420 / 595;
    const sc = await t.ev(() => ({ w: window.__hp.nb.pages[0].strokes[0].width, x: window.__hp.nb.pages[0].strokes[0].pts[0] }));
    check('existing ink is scaled with the page', Math.abs(sc.x - x0 * k) < 0.2 && Math.abs(sc.w - w0 * k) < 0.1, JSON.stringify({ sc, x0, w0 }));
    await t.shot('06b-a5');
    await sleep(1100);
    doc = JSON.parse((await t.saved()).text);
    check('an A5 notebook is saved as v2 with sz=a5', doc.v === 2 && doc.sz === 'a5', JSON.stringify({ v: doc.v, sz: doc.sz }));

    await t.frame.click('.pop.page .seg button:text-is("A6")');
    await sleep(500);
    s = await t.state();
    check('A6 is 298 x 420 points', s.size === 'a6' && s.pageW === 298 && s.pageH === 420, JSON.stringify(s));
    // draw on the small page, then undo the size change twice
    await t.click('button[aria-label="Page style"]'); // close
    const c = await t.toScreen(60, 100);
    const d = await t.toScreen(200, 130);
    await t.mouseStroke(line(c.x, c.y, d.x, d.y, 8));
    check('drawing works on an A6 page', (await t.state()).strokes[0] === 2);
    // pen outside the small page is clamped to it
    const e = await t.toScreen(-40, 500);
    await t.mouseStroke([e, { x: e.x + 5, y: e.y + 5 }]);
    const maxY = await t.ev(() => Math.max(...window.__hp.nb.pages[0].strokes.flatMap((st) => st.pts.filter((_, i) => i % (st.pressure ? 3 : 2) === 1))));
    check('no ink lands below the A6 page', maxY <= 420.01, `maxY ${maxY}`);

    const undo = async () => {
      await t.frame.click('button[aria-label="Undo"]');
      await sleep(250);
    };
    const redo = async () => {
      await t.frame.click('button[aria-label="Redo"]');
      await sleep(250);
    };
    const strokesNow = (await t.state()).strokes[0];
    await undo(); // the A6 drawing(s)
    if (strokesNow > 2) await undo();
    await undo(); // A5 -> A6 undone
    s = await t.state();
    check('the size change can be undone', s.size === 'a5', JSON.stringify(s));
    await undo(); // A4 -> A5 undone
    s = await t.state();
    const back = await t.ev(() => ({ w: window.__hp.nb.pages[0].strokes[0].width, x: window.__hp.nb.pages[0].strokes[0].pts[0] }));
    check('undoing back to A4 restores the original ink', s.size === 'a4' && Math.abs(back.x - x0) < 0.3 && Math.abs(back.w - w0) < 0.1, JSON.stringify({ s: s.size, back, x0, w0 }));
    await redo();
    await redo();
    await sleep(1200);
    check('redo returns to A6', (await t.state()).size === 'a6');

    // reload keeps the size
    await t.page.goto(`${BASE}/host.html`);
    await t.page.waitForSelector('iframe');
    const fr = await (await t.page.$('iframe')).contentFrame();
    await fr.waitForFunction(() => window.__hp && window.__hp.vp.vw > 10);
    const r = await fr.evaluate(() => ({ size: window.__hp.nb.size, w: window.__hp.vp.pageW, h: window.__hp.vp.pageH }));
    check('the paper size survives a reload', r.size === 'a6' && r.w === 298 && r.h === 420, JSON.stringify(r));
    check('no script errors', t.errors.length === 0, JSON.stringify(t.errors));
    await t.close();
  }

  // ------------------------------------------------------------------ 4a3b. taller paper
  {
    const t = await open('taller paper (+50 / +75 / +100 %)', { mobile: false, width: 900, height: 760, dsf: 1 });
    await t.click('button[aria-label="Page style"]');
    await t.frame.click('.pop.page .seg button:text-is("A6")');
    await sleep(400);
    const a = await t.toScreen(60, 100);
    const b = await t.toScreen(200, 120);
    await t.click('button[aria-label="Page style"]'); // close
    await t.mouseStroke(line(a.x, a.y, b.x, b.y, 8));
    const read = () => t.ev(() => ({ x: window.__hp.nb.pages[0].strokes[0].pts[0], w: window.__hp.nb.pages[0].strokes[0].width, n: window.__hp.nb.pages[0].strokes.length }));
    const before = await read();
    await t.click('button[aria-label="Page style"]');
    const labels = await t.frame.evaluate(() => [...document.querySelectorAll('.pop.page .seg')].map((g) => [...g.querySelectorAll('button')].map((x) => x.textContent).join('|')));
    check('there is a "Taller paper" option: Standard, +50%, +75%, +100%', labels.includes('Standard|+50%|+75%|+100%'), JSON.stringify(labels));
    const dims = [];
    for (const [label, expectH] of [['+50%', 630], ['+75%', 735], ['+100%', 840]]) {
      await t.frame.click(`.pop.page .seg button:text-is("${label}")`);
      await sleep(450);
      const s = await t.state();
      dims.push([label, s.pageW, s.pageH, Math.abs(s.ratio - 1) < 0.02]);
      check(`${label}: A6 stays 298 wide and becomes ${expectH} tall, and still fits the screen`, s.pageW === 298 && s.pageH === expectH && Math.abs(s.ratio - 1) < 0.02, JSON.stringify(s));
    }
    const after = await read();
    check('making the paper taller leaves the writing alone', after.x === before.x && after.w === before.w && after.n === 1, JSON.stringify({ before, after }));
    await t.shot('06c-a6-taller');
    await sleep(1100);
    const doc = JSON.parse((await t.saved()).text);
    check('it is saved with ln=100', doc.ln === 100 && doc.sz === 'a6', JSON.stringify({ v: doc.v, sz: doc.sz, ln: doc.ln }));
    // it combines with another size and the writing scales with the size change
    await t.frame.click('.pop.page .seg button:text-is("A5")');
    await sleep(450);
    let s = await t.state();
    check('the taller setting is kept when the paper size changes (A5 + 100% = 420 x 1190)', s.size === 'a5' && s.pageW === 420 && s.pageH === 1190, JSON.stringify(s));
    await t.frame.click('.pop.page .seg button:text-is("A6")');
    await sleep(450);
    // back to standard: writing is not scaled or lost, undo/redo work
    await t.frame.click('.pop.page .seg button:text-is("Standard")');
    await sleep(450);
    s = await t.state();
    check('Standard returns to the normal height', s.pageH === 420, JSON.stringify(s));
    const again = await read();
    check('...with the writing unchanged (within the rounding of the A6 -> A5 -> A6 round trip)', Math.abs(again.x - before.x) < 0.5 && again.n === 1, JSON.stringify(again));
    await t.click('button[aria-label="Undo"]');
    await sleep(350);
    check('undo restores +100%', (await t.state()).pageH === 840);
    await t.click('button[aria-label="Redo"]');
    await sleep(350);
    check('redo returns to standard', (await t.state()).pageH === 420);
    await t.frame.click('.pop.page .seg button:text-is("+75%")');
    await sleep(1100);
    await t.page.goto(`${BASE}/host.html`);
    await t.page.waitForSelector('iframe');
    const fr = await (await t.page.$('iframe')).contentFrame();
    await fr.waitForFunction(() => window.__hp && window.__hp.vp.vw > 10);
    check('the paper length survives a reload', (await fr.evaluate(() => window.__hp.vp.pageH)) === 735);
    // the overview's "add page" box has the page's proportions
    await fr.click('button.page-label');
    const box = await fr.evaluate(() => {
      const r = document.querySelector('.addbox').getBoundingClientRect();
      return r.height / r.width;
    }).catch(() => 0);
    check('the add-page tile matches the paper proportions', Math.abs(box - 735 / 298) < 0.08, String(box));
    check('no script errors', t.errors.length === 0, JSON.stringify(t.errors));
    await t.close();
  }

  // ------------------------------------------------------------------ 4a4. size/format compatibility and preference migration
  {
    const t = await open('format versions and preference migration', { mobile: false, width: 900, height: 760, dsf: 1 });
    const v2 = (extra) => JSON.stringify({ app: 'sn-handwritten-pages', v: 2, sz: 'a6', t: 'lined', sp: 1, pp: 'white', pages: [{ t: 'lined', s: [] }], ...extra });
    await t.page.evaluate((d) => window.mock.setText(d), v2());
    await sleep(250);
    let s = await t.state();
    check('a v2 note with sz=a6 loads as A6', s.unsupported === null && s.size === 'a6', JSON.stringify(s));
    await t.page.evaluate((d) => window.mock.setText(d), v2({ sz: 'a3' }));
    await sleep(250);
    s = await t.state();
    check('an unknown size falls back to A4', s.unsupported === null && s.size === 'a4', JSON.stringify(s));
    await t.page.evaluate((d) => window.mock.setText(d), v2({ v: 99 }));
    await sleep(250);
    s = await t.state();
    check('a note from a newer format is protected, not overwritten', s.unsupported === 'newer', JSON.stringify(s));
    await t.close();

    // old saved preferences (before the pen-only default) are moved to pen-only once
    const old = await open('old preferences are migrated', { prefs: { touch: 'auto', penColor: '#d62b2b' } });
    let o = await old.state();
    check('old "auto" preference becomes pen-only', o.touch === 'scroll', JSON.stringify(o));
    const color = await old.ev(() => window.__hp.prefs.penColor);
    check('...other preferences are kept', color === '#d62b2b', color);
    await old.close();
    const chosen = await open('a deliberate choice is kept', { prefs: { v: 2, touch: 'auto' } });
    o = await chosen.state();
    check('a v2 "auto" preference is respected', o.touch === 'auto', JSON.stringify(o));
    await chosen.close();
  }

  // ------------------------------------------------------------------ 4a5. focus mode: tap for toolbars, fullscreen
  {
    const t = await open('focus mode: single tap shows the toolbars');
    const tapAt = async (x, y) => {
      await t.touch('touchStart', [{ x, y }]);
      await sleep(30);
      await t.touch('touchEnd', []);
    };
    const vis = () =>
      t.frame.evaluate(() => {
        const v = (sel) => {
          const r = document.querySelector(sel).getBoundingClientRect();
          return getComputedStyle(document.querySelector(sel)).visibility !== 'hidden' && r.bottom > 0 && r.top < innerHeight;
        };
        return { top: v('.bar.top'), tray: v('.tray'), presets: v('.bar.presets'), bottom: v('.bar.bottom') };
      });
    const stageH = () => t.frame.evaluate(() => document.querySelector('.stage').clientHeight);
    check('normally both toolbars and the preset row are visible', Object.values(await vis()).every(Boolean));
    const h0 = await stageH();
    const c = await t.toScreen(300, 400);
    await tapAt(c.x, c.y);
    await sleep(120);
    await tapAt(c.x, c.y);
    await sleep(500);
    let s = await t.state();
    const hFocus = await stageH();
    const fs = await t.ev(() => !!document.fullscreenElement);
    console.log(`       browser fullscreen granted in this test host: ${fs}`);
    let v = await vis();
    check('focus mode removes the top toolbar and the bottom bar but keeps the preset row', s.focus && !v.top && !v.bottom && v.presets, JSON.stringify(v));
    check('...so the page area grows (by the two bars)', hFocus > h0 + 80, `${h0} -> ${hFocus}`);

    // a single tap brings both back as an overlay (after the double-tap window)
    await tapAt(c.x, c.y);
    await sleep(150);
    check('toolbars do not appear until the double-tap window has passed', !(await vis()).bottom);
    await sleep(600);
    v = await vis();
    check('a single tap brings up the bottom bar only (not the top toolbar)', !v.top && v.tray && v.presets && v.bottom, JSON.stringify(v));
    const stack = await t.frame.evaluate(() => {
      const p = document.querySelector('.bar.presets').getBoundingClientRect();
      const b = document.querySelector('.bar.bottom').getBoundingClientRect();
      return { presetsBottom: p.bottom, bottomTop: b.top, bottomBottom: b.bottom, vh: innerHeight };
    });
    check('...the preset row moves up and the bottom bar sits under it at the screen edge', stack.presetsBottom <= stack.bottomTop + 1 && Math.abs(stack.bottomBottom - stack.vh) < 2, JSON.stringify(stack));
    check('...as an overlay: the page does not resize or jump', (await stageH()) === hFocus && Math.abs((await t.state()).ratio - 1) < 0.02);
    // the overlay is usable
    await t.frame.click('button[aria-label="Add page"]');
    await sleep(400);
    check('overlay buttons work (add page)', (await t.state()).pages === 2);
    // the colour panel opens clear of the overlaid bottom bar
    await t.frame.click('button[aria-label="Pen"]');
    await sleep(150);
    const geo = await t.frame.evaluate(() => {
      const p = document.querySelector('.pop.ink').getBoundingClientRect();
      const r = document.querySelector('.bar.presets').getBoundingClientRect();
      return { popBottom: p.bottom, presetsTop: r.top };
    });
    check('the colour panel sits above the preset row and bottom bar', geo.popBottom <= geo.presetsTop + 1, JSON.stringify(geo));
    await t.frame.click('button[aria-label="Pen"]');
    // another single tap hides them again
    const c2 = await t.toScreen(300, 400);
    await tapAt(c2.x, c2.y);
    await sleep(700);
    v = await vis();
    check('a second single tap hides the bottom bar again (the preset row stays)', (await t.state()).focus && !v.top && !v.bottom && v.presets, JSON.stringify(v));
    // pen use hides a peeked toolbar by itself
    await tapAt(c2.x, c2.y);
    await sleep(700);
    check('the bottom bar is back', (await vis()).bottom);
    const a = await t.toScreen(100, 250);
    const b = await t.toScreen(300, 280);
    await t.penStroke(line(a.x, a.y, b.x, b.y, 8), Array(8).fill(0.5));
    await sleep(500);
    v = await vis();
    check('starting to write with the pen tucks the toolbars away', !v.bottom && !v.top && v.presets && (await t.state()).strokes[(await t.state()).cur] === 1, JSON.stringify(v));
    // double-tap exits focus: toolbars are in the layout again (after the palm-rejection window that follows pen use)
    await sleep(900);
    await tapAt(c2.x, c2.y);
    await sleep(120);
    await tapAt(c2.x, c2.y);
    await sleep(500);
    s = await t.state();
    v = await vis();
    check('double-tap leaves focus mode and restores the top toolbar and bottom bar', !s.focus && v.top && v.bottom, JSON.stringify({ s: s.focus, v }));
    check('...and browser fullscreen is released', !(await t.ev(() => !!document.fullscreenElement)));
    // leaving browser fullscreen by itself (Esc / swipe) also leaves focus mode
    if (fs) {
      await t.page.keyboard.press('f').catch(() => undefined);
      await t.ev(() => window.__hp.setFocus(true));
      await sleep(300);
      const fs2 = await t.ev(() => !!document.fullscreenElement);
      if (fs2) {
        await t.ev(() => document.exitFullscreen());
        await sleep(300);
        check('leaving fullscreen from the browser also leaves focus mode', (await t.state()).focus === false);
      }
    }
    check('no script errors', t.errors.length === 0, JSON.stringify(t.errors));
    await t.close();
  }

  // ------------------------------------------------------------------ 4a6. preset row
  {
    const t = await open('pen and highlighter presets');
    const info = () =>
      t.frame.evaluate(() => {
        const q = (sel) => document.querySelector(sel);
        const box = (el) => el.getBoundingClientRect();
        const pens = [...document.querySelectorAll('.preset-group.pens .preset:not(.add)')];
        const hls = [...document.querySelectorAll('.preset-group.hls .preset:not(.add)')];
        const mid = box(q('.preset-mid'));
        const row = box(q('.bar.presets'));
        const mids = [...document.querySelectorAll('.preset-mid button')].map((b) => b.getAttribute('aria-label'));
        const penAdd = q('.preset-group.pens .preset.add');
        const hlAdd = q('.preset-group.hls .preset.add');
        return {
          pens: pens.length,
          hls: hls.length,
          midCentre: mid.left + mid.width / 2,
          rowCentre: row.left + row.width / 2,
          penRight: Math.max(...pens.map((b) => box(b).right)),
          hlLeft: Math.min(...hls.map((b) => box(b).left)),
          midLeft: mid.left,
          midRight: mid.right,
          mids,
          penAddDisabled: penAdd.disabled,
          hlAddDisabled: hlAdd.disabled,
          rowH: row.height,
        };
      });
    const prefs = () => t.ev(() => ({ ...window.__hp.prefs }));
    let i = await info();
    check('three pen and three highlighter presets by default', i.pens === 3 && i.hls === 3, JSON.stringify(i));
    check('the eraser sits in the middle of the preset row', i.mids.join() === 'Eraser', i.mids.join());
    check('pens are on the left, highlighters on the right', i.penRight <= i.midLeft + 1 && i.hlLeft >= i.midRight - 1, JSON.stringify(i));
    check('the middle is centred', Math.abs(i.midCentre - i.rowCentre) < 1, `${i.midCentre} vs ${i.rowCentre}`);
    await t.shot('09-presets');
    // bottom bar: pen + highlighter | undo, redo (centred) | add page; no colour dot any more
    const bb = await t.frame.evaluate(() => {
      const bar = document.querySelector('.bar.bottom').getBoundingClientRect();
      const mid = document.querySelector('.bottom-mid').getBoundingClientRect();
      const names = (sel) => [...document.querySelectorAll(sel + ' button')].map((b) => b.getAttribute('aria-label'));
      const add = document.querySelector('button[aria-label="Add page"]').getBoundingClientRect();
      return { barCentre: bar.left + bar.width / 2, midCentre: mid.left + mid.width / 2, left: names('.bottom-left'), mid: names('.bottom-mid'), right: names('.bottom-right'), addRight: add.right, barRight: bar.right, dot: !!document.querySelector('.ink-dot, [aria-label="Colour and size"]') };
    });
    check('bottom bar: Pen, Highlighter | Undo, Redo | Add page', bb.left.join() === 'Pen,Highlighter' && bb.mid.join() === 'Undo,Redo' && bb.right.join() === 'Add page', JSON.stringify(bb));
    check('undo and redo are centred at the bottom', Math.abs(bb.barCentre - bb.midCentre) < 1, JSON.stringify(bb));
    check('add page sits at the bottom right', bb.barRight - bb.addRight < 12, JSON.stringify(bb));
    check('the pen-colour circle is gone', !bb.dot);
    await t.frame.click('button[aria-label="Add page"]');
    await sleep(400);
    check('the bottom Add page button adds a page after this one', (await t.state()).pages === 2 && (await t.state()).cur === 1);

    // add pen presets up to the maximum of six; the middle must stay centred each time
    const centred = [];
    for (let n = 3; n < 6; n++) {
      await t.click('button[aria-label="Add pen preset"]');
      i = await info();
      centred.push(Math.abs(i.midCentre - i.rowCentre) < 1);
      if (n === 3) await t.shot('10-presets-more');
    }
    i = await info();
    check('pen presets can be added one by one', i.pens === 6, JSON.stringify(i));
    await t.ev(() => {
      const a = window.__hp;
      while (a.prefs.penPresets.length < 6) a.addPreset('pen');
      while (a.prefs.hlPresets.length < 6) a.addPreset('highlighter');
    });
    await sleep(150);
    i = await info();
    check('the maximum is six of each', i.pens === 6 && i.hls === 6 && i.penAddDisabled && i.hlAddDisabled, JSON.stringify(i));
    check('the middle stays centred with 6 + 6 presets', Math.abs(i.midCentre - i.rowCentre) < 1, `${i.midCentre} vs ${i.rowCentre}`);
    check('the middle stayed centred while adding', centred.every(Boolean), JSON.stringify(centred));
    await t.shot('11-presets-six');
    // adding beyond six does nothing
    await t.ev(() => window.__hp.ui.closePopovers());
    await t.frame.click('button[aria-label="Pen preset 1"]');
    await t.frame.click('button[aria-label="Pen"]');
    await sleep(150);
    await t.shot('12-pen-colours');
    await t.frame.click('button[aria-label="Pen"]');
    check('a seventh preset is refused', (await t.ev(() => window.__hp.addPreset('pen'))) === false && (await info()).pens === 6);
    await t.close();
  }

  {
    const t = await open('using presets', { mobile: false, width: 900, height: 760, dsf: 1 });
    const prefs = () => t.ev(() => ({ tool: window.__hp.prefs.tool, pc: window.__hp.prefs.penColor, pw: window.__hp.prefs.penWidth, hc: window.__hp.prefs.hlColor, hw: window.__hp.prefs.hlWidth, pi: window.__hp.prefs.penIdx, hi: window.__hp.prefs.hlIdx, np: window.__hp.prefs.penPresets.length, nh: window.__hp.prefs.hlPresets.length }));
    let p = await prefs();
    check('starts on pen preset 1 (black)', p.tool === 'pen' && p.pi === 0 && p.pc === '#1c1c1e', JSON.stringify(p));
    await t.click('button[aria-label="Pen preset 3"]');
    p = await prefs();
    check('tapping a pen preset selects its colour', p.pi === 2 && p.pc === '#d62b2b' && p.tool === 'pen', JSON.stringify(p));
    const a = await t.toScreen(100, 200);
    const b = await t.toScreen(300, 230);
    await t.mouseStroke(line(a.x, a.y, b.x, b.y, 8));
    const col = await t.ev(() => window.__hp.nb.pages[0].strokes[0].color);
    check('ink is drawn in the preset colour', col === '#d62b2b', col);
    await t.click('button[aria-label="Highlighter preset 2"]');
    p = await prefs();
    check('tapping a highlighter preset switches tool and colour', p.tool === 'highlighter' && p.hi === 1 && p.hc === '#a7f3a0', JSON.stringify(p));
    // the Pen tool at the bottom: returns to the pen at its preset, and pressing it again opens the colour/size options
    await t.click('button[aria-label="Pen"]');
    p = await prefs();
    check('the Pen tool returns to the pen (same preset)', p.tool === 'pen' && p.pi === 2, JSON.stringify(p));
    check('...without opening anything yet', !(await t.frame.isVisible('.pop.ink')));
    await t.click('button[aria-label="Pen"]');
    p = await prefs();
    check('pressing the selected Pen tool opens the colour and size options', (await t.frame.isVisible('.pop.ink')) && p.pi === 2, JSON.stringify(p));
    check('...which offer the pen colour grid', (await t.frame.locator('.pop.ink .swatch').count()) === 21);
    await t.click('button[aria-label="Pen"]');
    check('...and pressing it again closes them', !(await t.frame.isVisible('.pop.ink')));
    // presets are plain toggles: tapping the selected one again does nothing
    await t.click('button[aria-label="Pen preset 3"]');
    await t.click('button[aria-label="Pen preset 3"]');
    p = await prefs();
    check('tapping a selected preset again does nothing', p.pi === 2 && p.pc === '#d62b2b' && !(await t.frame.isVisible('.pop.ink')), JSON.stringify(p));
    await t.click('button[aria-label="Highlighter"]');
    await t.click('button[aria-label="Highlighter"]');
    check('the Highlighter tool opens its options the same way', (await t.frame.isVisible('.pop.ink')) && (await prefs()).tool === 'highlighter');
    await t.click('button[aria-label="Highlighter"]');
    // editing the selected preset
    await t.click('button[aria-label="Pen preset 2"]');
    await t.click('button[aria-label="Pen"]');
    check('the selected Pen tool opens the selected preset\'s options', await t.frame.isVisible('.pop.ink'));
    await t.frame.click('.pop.ink .swatch >> nth=4');
    await t.frame.click('.pop.ink .size >> nth=3');
    p = await prefs();
    check('changing colour/size edits the selected preset', p.pc === '#7a3fd1' && p.pw === 3.6, JSON.stringify(p));
    const stored = await t.ev(() => window.__hp.prefs.penPresets.map((x) => x.color + ':' + x.width).join());
    check('...and only that preset', stored === '#1c1c1e:1.4,#7a3fd1:3.6,#d62b2b:1.4', stored);
    // the + button adds and selects, opening the options
    await t.click('button[aria-label="Add pen preset"]');
    p = await prefs();
    check('+ adds a preset and selects it', p.np === 4 && p.pi === 3, JSON.stringify(p));
    check('...and opens its options', await t.frame.isVisible('.pop.ink'));
    await t.frame.click('.pop.ink .row:has-text("Remove this preset")');
    p = await prefs();
    check('a preset can be removed', p.np === 3 && p.pi === 2, JSON.stringify(p));
    // presets are remembered
    await t.page.goto(`${BASE}/host.html`);
    await t.page.waitForSelector('iframe');
    const fr = await (await t.page.$('iframe')).contentFrame();
    await fr.waitForFunction(() => window.__hp && window.__hp.vp.vw > 10);
    const again = await fr.evaluate(() => window.__hp.prefs.penPresets.map((x) => x.color + ':' + x.width).join());
    check('presets are remembered on this device', again === '#1c1c1e:1.4,#7a3fd1:3.6,#d62b2b:1.4', again);
    check('no script errors', t.errors.length === 0, JSON.stringify(t.errors));
    await t.close();
  }

  // ------------------------------------------------------------------ 4a7. preset migration
  {
    const t = await open('presets for existing users', { prefs: { v: 2, touch: 'scroll', penColor: '#e8710a', penWidth: 2.2, hlColor: '#9fe0ff', hlWidth: 18 } });
    const r = await t.ev(() => ({ pens: window.__hp.prefs.penPresets.map((x) => x.color + ':' + x.width), hls: window.__hp.prefs.hlPresets.map((x) => x.color + ':' + x.width), c: window.__hp.prefs.penColor }));
    check('an existing pen colour becomes preset 1 and the stock ones follow', r.pens.length === 3 && r.pens[0] === '#e8710a:2.2' && r.c === '#e8710a', JSON.stringify(r));
    check('...same for the highlighter', r.hls.length === 3 && r.hls[0] === '#9fe0ff:18', JSON.stringify(r));
    await t.close();
    const bad = await open('corrupt presets fall back', { prefs: { v: 2, touch: 'scroll', penPresets: [{ color: 'red; background:url(x)', width: 1 }, 7, null], penIdx: 9 } });
    const rb = await bad.ev(() => ({ n: window.__hp.prefs.penPresets.length, idx: window.__hp.prefs.penIdx }));
    check('invalid saved presets are ignored', rb.n === 3 && rb.idx === 0, JSON.stringify(rb));
    await bad.close();
  }

  // ------------------------------------------------------------------ 4a8. presets sync through the plugin's settings
  {
    const t = await open('presets are synced with the plugin settings', { mobile: false, width: 900, height: 760, dsf: 1, init: () => {
      try {
        if (!localStorage.getItem('mock-component-data')) localStorage.setItem('mock-component-data', JSON.stringify({ somethingElse: { keep: true } }));
      } catch { /* ignore */ }
    } });
    const writes = () => t.page.evaluate(() => window.mock.dataWrites);
    await sleep(800);
    check('opening a notebook writes no settings', (await writes()) === 0);
    await t.click('button[aria-label="Pen preset 2"]');
    await t.click('button[aria-label="Highlighter"]');
    await sleep(900);
    check('switching preset or tool is per device and writes nothing', (await writes()) === 0, String(await writes()));
    await t.click('button[aria-label="Pen"]');
    await t.click('button[aria-label="Pen"]');
    await t.frame.click('.pop.ink .swatch >> nth=18'); // third row, fifth column: lightest purple
    await t.click('button[aria-label="Add highlighter preset"]');
    await sleep(1000);
    const data = await t.page.evaluate(() => window.mock.componentData);
    check('changing presets writes them to the plugin settings (debounced)', (await writes()) >= 1 && (await writes()) <= 2, String(await writes()));
    check('...pen preset 2 holds the new colour', data.presets && data.presets.pen[1].color.toLowerCase() === '#cdb4ee', JSON.stringify(data.presets && data.presets.pen));
    check('...highlighter presets include the added one', data.presets && data.presets.hl.length === 4, JSON.stringify(data.presets && data.presets.hl));
    check('...and other settings stored there are kept', data.somethingElse && data.somethingElse.keep === true, JSON.stringify(data));

    // a "second device": same account data, nothing saved locally
    await t.frame.evaluate(() => localStorage.removeItem('handwritten-pages:prefs:v1'));
    await t.page.goto(`${BASE}/host.html`);
    await t.page.waitForSelector('iframe');
    const fr = await (await t.page.$('iframe')).contentFrame();
    await fr.waitForFunction(() => window.__hp && window.__hp.vp.vw > 10);
    await sleep(300);
    const other = await fr.evaluate(() => ({ pen: window.__hp.prefs.penPresets.map((x) => x.color), hl: window.__hp.prefs.hlPresets.length, idx: window.__hp.prefs.penIdx, pc: window.__hp.prefs.penColor, dots: document.querySelectorAll('.preset-group.pens .preset:not(.add)').length }));
    check('a device with no local settings picks the synced presets up', other.pen[1] === '#cdb4ee' && other.hl === 4 && other.dots === 3, JSON.stringify(other));
    check('...and the active colour follows the selected preset', other.pc === other.pen[other.idx], JSON.stringify(other));
    check('...without writing them back', (await t.page.evaluate(() => window.mock.dataWrites)) === 0);
    await t.close();

    // bad synced data is ignored
    const bad = await open('invalid synced presets are ignored', { mobile: false, width: 900, height: 760, dsf: 1, init: () => {
      try {
        localStorage.setItem('mock-component-data', JSON.stringify({ presets: { v: 1, pen: [{ color: 'javascript:alert(1)', width: 1 }, 'x'], hl: 5 } }));
      } catch { /* ignore */ }
    } });
    const rb = await bad.ev(() => ({ pen: window.__hp.prefs.penPresets.length, hl: window.__hp.prefs.hlPresets.length }));
    check('invalid synced presets fall back to the local ones', rb.pen === 3 && rb.hl === 3, JSON.stringify(rb));
    check('no script errors', bad.errors.length === 0, JSON.stringify(bad.errors));
    await bad.close();
  }

  // ------------------------------------------------------------------ 4a9. swiping on from the last page offers a new one
  {
    const t = await open('swipe past the last page');
    const toastText = () => t.frame.evaluate(() => (document.querySelector('.toast.hidden') ? '' : document.querySelector('.toast')?.textContent || ''));
    await t.click('button[aria-label="Add page after this one"]');
    await sleep(500);
    await t.click('button[aria-label="Previous page"]');
    await sleep(500);
    let s = await t.state();
    check('two pages, on the first', s.pages === 2 && s.cur === 0);
    await t.touchStroke(line(320, 400, 60, 400, 8));
    await sleep(500);
    s = await t.state();
    check('swiping on a middle page just turns it, with no offer', s.cur === 1 && (await toastText()) === '', `${JSON.stringify(s)} / ${await toastText()}`);
    // now on the last page: swipe on
    await t.touchStroke(line(320, 400, 60, 400, 8));
    await sleep(600);
    s = await t.state();
    const txt = await toastText();
    check('swiping on from the last page stays put', s.cur === 1 && s.pages === 2, JSON.stringify(s));
    check('...and offers "Add page"', /last page/i.test(txt) && /Add page/.test(txt), txt);
    await t.shot('13-last-page-offer');
    await t.frame.click('.toast button');
    await sleep(500);
    s = await t.state();
    check('tapping Add page adds one and goes to it', s.pages === 3 && s.cur === 2, JSON.stringify(s));
    check('...and the offer goes away', (await toastText()) === '');
    // the keyboard / next action at the end gives the same offer
    await t.ev(() => window.__hp.nextPage());
    await sleep(300);
    check('"next page" on the last page also offers a new one', /Add page/.test(await toastText()));
    // locked notes can't grow
    await t.page.evaluate(() => window.mock.setLocked(true));
    await sleep(300);
    await t.ev(() => window.__hp.ui.toast('x'));
    await t.ev(() => window.__hp.nextPage());
    await sleep(200);
    check('a locked note gets no offer', !/Add page/.test(await toastText()));
    check('no script errors', t.errors.length === 0, JSON.stringify(t.errors));
    await t.close();
  }

  // ------------------------------------------------------------------ 4a10. palm rejection
  {
    const t = await open('palm rejection');
    await t.click('button[aria-label="Add page after this one"]');
    await sleep(500);
    await t.click('button[aria-label="Previous page"]');
    await sleep(500);
    const swipe = async (r) => {
      await t.touchStroke(line(320, 400, 60, 400, 8), r);
      await sleep(500);
      return t.state();
    };
    const hover = async (x, y) => t.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, pointerType: 'pen' });
    let s = await t.state();
    check('palm rejection is on by default', await t.ev(() => window.__hp.prefs.palm === true));
    // 1. contact size
    s = await swipe(45);
    check('a very large contact patch is ignored (no page turn)', s.cur === 0 && Math.abs(s.ratio - 1) < 0.02, JSON.stringify(s));
    s = await swipe(5);
    check('a normal fingertip still works', s.cur === 1, JSON.stringify(s));
    await t.click('button[aria-label="Previous page"]');
    await sleep(500);
    // 2. stylus hovering close by
    await hover(200, 300);
    await sleep(100);
    s = await swipe();
    check('touches are ignored while the stylus hovers over the screen', s.cur === 0, JSON.stringify(s));
    await sleep(900);
    s = await swipe();
    check('...and work again shortly after it has gone', s.cur === 1, JSON.stringify(s));
    await t.click('button[aria-label="Previous page"]');
    await sleep(500);
    // 3. a palm resting down just after writing
    const a = await t.toScreen(100, 200);
    const b = await t.toScreen(300, 230);
    await t.penStroke(line(a.x, a.y, b.x, b.y, 8), Array(8).fill(0.5));
    s = await swipe();
    check('a palm landing right after a stylus stroke is ignored', s.cur === 0 && s.strokes[0] === 1, JSON.stringify(s));
    await sleep(900);
    // 4. the palm is already on the screen when the pen arrives
    await t.touch('touchStart', [{ x: 250, y: 500, r: 5 }]);
    await t.touch('touchMove', [{ x: 220, y: 500, r: 5 }]);
    await sleep(60);
    const c = await t.toScreen(100, 300);
    const d = await t.toScreen(300, 330);
    await t.penStroke(line(c.x, c.y, d.x, d.y, 8), Array(8).fill(0.5));
    await t.touch('touchMove', [{ x: 120, y: 500, r: 5 }]);
    await t.touch('touchEnd', []);
    await sleep(500);
    s = await t.state();
    check('the stylus wins over a finger or palm that was already scrolling', s.strokes[0] === 2 && s.cur === 0 && Math.abs(s.ratio - 1) < 0.02, JSON.stringify(s));
    await sleep(900);
    // 5. the setting
    await t.click('button[aria-label="More"]');
    check('palm rejection has a switch in the menu', await t.frame.isVisible('.pop.menu input[aria-label="Palm rejection"]'));
    await t.frame.click('.pop.menu input[aria-label="Palm rejection"]');
    check('...which turns it off', (await t.ev(() => window.__hp.prefs.palm)) === false);
    await t.frame.click('.stage', { position: { x: 5, y: 5 }, force: true }).catch(() => {});
    await sleep(200);
    s = await swipe(45);
    check('with it off, a large contact is treated as a finger', s.cur === 1, JSON.stringify(s));
    check('no script errors', t.errors.length === 0, JSON.stringify(t.errors));
    await t.close();
  }

  // ------------------------------------------------------------------ 4a11. two-finger tap = undo, three-finger tap = redo
  {
    const t = await open('two-finger tap undoes, three-finger tap redoes');
    for (let i = 0; i < 3; i++) {
      const a = await t.toScreen(80, 200 + i * 60);
      const b = await t.toScreen(300, 215 + i * 60);
      await t.penStroke(line(a.x, a.y, b.x, b.y, 8), Array(8).fill(0.5));
      await sleep(100);
    }
    await sleep(900); // past the palm-rejection window that follows pen use
    const strokes = async () => (await t.state()).strokes[0];
    check('three strokes drawn', (await strokes()) === 3);
    const F = (n, r = 5) => [{ x: 120, y: 400, id: 1, r }, { x: 200, y: 420, id: 2, r }, { x: 280, y: 400, id: 3, r }].slice(0, n);
    const tapN = async (n, hold = 70) => {
      await t.touch('touchStart', F(n));
      await sleep(hold);
      await t.touch('touchEnd', []);
      await sleep(300);
    };
    await tapN(2);
    check('a two-finger tap undoes the last stroke', (await strokes()) === 2, String(await strokes()));
    await tapN(2);
    check('...and again', (await strokes()) === 1);
    await tapN(3);
    check('a three-finger tap redoes', (await strokes()) === 2, String(await strokes()));
    await tapN(3);
    check('...and again', (await strokes()) === 3);
    await tapN(3);
    check('redo with nothing to redo does nothing', (await strokes()) === 3 && t.errors.length === 0);
    let s = await t.state();
    check('taps do not zoom, scroll or toggle focus', Math.abs(s.ratio - 1) < 0.02 && s.cur === 0 && !s.focus, JSON.stringify(s));
    // two quick two-finger taps are two undos, not a focus-mode double-tap
    await tapN(2, 50);
    await tapN(2, 50);
    s = await t.state();
    check('two two-finger taps in a row undo twice and do not toggle focus', s.strokes[0] === 1 && !s.focus, JSON.stringify(s));
    // a slow press is not a tap
    await tapN(2, 700);
    check('a long two-finger press does nothing', (await strokes()) === 1);
    // a two-finger swipe is not a tap
    await t.twoFinger({ x: 150, y: 500 }, { x: 210, y: 500 }, { x: 150, y: 560 }, { x: 210, y: 560 }, 8);
    check('a two-finger drag does not undo', (await strokes()) === 1);
    // a pinch is not a tap
    await t.twoFinger({ x: 150, y: 500 }, { x: 210, y: 500 }, { x: 100, y: 500 }, { x: 260, y: 500 }, 8, 40);
    check('a pinch does not undo', (await strokes()) === 1);
    // the undo toast
    await t.click('button[aria-label="Redo"]');
    await tapN(2, 60);
    check('a tap shows a brief "Undo" message', await t.frame.evaluate(() => /Undo/.test(document.querySelector('.toast')?.textContent || '')));
    // fingers-draw mode: still no stray ink
    await t.ev(() => window.__hp.setTouchMode('draw'));
    const before = await strokes();
    await tapN(2, 70);
    await tapN(3, 70);
    check('with fingers drawing, the multi-finger taps leave no dots', (await strokes()) === before, `${before} -> ${await strokes()}`);
    // locked note
    await t.page.evaluate(() => window.mock.setLocked(true));
    await sleep(250);
    const n0 = await strokes();
    await tapN(2, 70);
    check('a locked note ignores them', (await strokes()) === n0);
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

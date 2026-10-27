import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode, FORMAT_VERSION } from '../../src/codec.ts';
import { eraseFromStroke, segmentInCircle, simplify, strokeHit } from '../../src/geometry.ts';
import { PAGE_GAP, PAGE_H, PAGE_W, newNotebook, newPage } from '../../src/model.ts';
import type { Notebook, Stroke } from '../../src/model.ts';
import { Viewport } from '../../src/viewport.ts';

function line(x0: number, y0: number, x1: number, y1: number, n = 11): Stroke {
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
  }
  return { tool: 'pen', color: '#1c1c1e', width: 1.4, pressure: false, pts };
}

test('codec round trip keeps strokes (0.1pt precision) and settings', () => {
  const nb: Notebook = newNotebook();
  nb.template = 'grid';
  nb.spacing = 2;
  nb.paper = 'cream';
  nb.pages = [newPage('grid'), newPage('blank')];
  nb.pages[0].strokes.push(line(10, 20, 200.5, 300.3));
  nb.pages[1].strokes.push({
    tool: 'highlighter',
    color: '#fff176',
    width: 12,
    pressure: true,
    pts: [5, 5, 0.2, 7.5, 9.1, 0.55, 20, 30, 1],
  });
  const res = decode(encode(nb));
  assert.equal(res.kind, 'ok');
  if (res.kind !== 'ok') return;
  assert.equal(res.nb.template, 'grid');
  assert.equal(res.nb.spacing, 2);
  assert.equal(res.nb.paper, 'cream');
  assert.equal(res.nb.pages.length, 2);
  assert.equal(res.nb.pages[1].template, 'blank');
  const a = res.nb.pages[0].strokes[0];
  assert.equal(a.pts.length, 22);
  assert.ok(Math.abs(a.pts[20] - 200.5) < 0.051);
  assert.ok(Math.abs(a.pts[21] - 300.3) < 0.051);
  const b = res.nb.pages[1].strokes[0];
  assert.equal(b.tool, 'highlighter');
  assert.equal(b.color, '#fff176');
  assert.equal(b.pressure, true);
  assert.equal(b.width, 12);
  assert.deepEqual(b.pts, [5, 5, 0.2, 7.5, 9.1, 0.55, 20, 30, 1]);
});

test('codec classifies empty / foreign / newer / corrupt text', () => {
  assert.equal(decode('').kind, 'empty');
  assert.equal(decode('   \n').kind, 'empty');
  assert.equal(decode('Just some markdown text').kind, 'foreign');
  assert.equal(decode('{"hello":1}').kind, 'foreign');
  assert.equal(decode(JSON.stringify({ app: 'sn-handwritten-pages', v: FORMAT_VERSION + 1, pages: [] })).kind, 'newer');
  assert.equal(decode(JSON.stringify({ app: 'sn-handwritten-pages', v: 1, pages: 'x' })).kind, 'corrupt');
});

test('codec drops malformed strokes but keeps the rest, and never returns zero pages', () => {
  const text = JSON.stringify({
    app: 'sn-handwritten-pages',
    v: 1,
    pages: [{ t: 'nonsense', s: [[0, 'zzzzzz', 14, 0, 1, 1], [0, '000000', 14, 0, 100, 200, 5, 5], 'bad', [0, '000000', 14, 0, 1]] }],
  });
  const res = decode(text);
  assert.equal(res.kind, 'ok');
  if (res.kind !== 'ok') return;
  assert.equal(res.nb.pages.length, 1);
  assert.equal(res.nb.pages[0].strokes.length, 1);
  assert.equal(res.nb.pages[0].template, 'lined');
  const empty = decode(JSON.stringify({ app: 'sn-handwritten-pages', v: 1, pages: [] }));
  assert.equal(empty.kind === 'ok' && empty.nb.pages.length, 1);
});

test('simplify removes collinear points but keeps corners and pressure changes', () => {
  const straight = line(0, 0, 100, 0, 50).pts;
  assert.equal(simplify(straight, 2, 0.15).length, 4);
  const corner = [0, 0, 50, 0, 100, 0, 100, 50, 100, 100];
  const out = simplify(corner, 2, 0.15);
  assert.deepEqual(out, [0, 0, 100, 0, 100, 100]);
  // pressure goes 0 -> 1 -> 0 along a straight line: the middle sample must survive
  const pr = [0, 0, 0, 50, 0, 1, 100, 0, 0];
  assert.equal(simplify(pr, 3, 0.15, 3).length, 9);
});

test('segmentInCircle', () => {
  assert.equal(segmentInCircle(0, 10, 10, 10, 5, 0, 3), null);
  const iv = segmentInCircle(0, 0, 10, 0, 5, 0, 2) as [number, number];
  assert.ok(Math.abs(iv[0] - 0.3) < 1e-9 && Math.abs(iv[1] - 0.7) < 1e-9);
  const all = segmentInCircle(4, 0, 6, 0, 5, 0, 10) as [number, number];
  assert.deepEqual(all, [0, 1]);
});

test('eraser splits a stroke at the circle boundary and leaves untouched strokes alone', () => {
  const s = line(0, 0, 100, 0, 11);
  assert.equal(eraseFromStroke(s, 50, 50, 5), null);
  const pieces = eraseFromStroke(s, 50, 0, 5) as Stroke[];
  assert.equal(pieces.length, 2);
  const left = pieces[0].pts;
  const right = pieces[1].pts;
  // circle radius 5 + width*0.25 = 5.35 around x=50 -> cut at ~44.65 and ~55.35
  assert.ok(Math.abs(left[left.length - 2] - 44.65) < 0.01, `left end ${left[left.length - 2]}`);
  assert.ok(Math.abs(right[0] - 55.35) < 0.01, `right start ${right[0]}`);
  assert.equal(right[right.length - 2], 100);
  // erasing over the end removes just a tail
  const tail = eraseFromStroke(s, 100, 0, 5) as Stroke[];
  assert.equal(tail.length, 1);
  assert.ok(tail[0].pts[tail[0].pts.length - 2] < 95);
  // erasing everything
  assert.deepEqual(eraseFromStroke(s, 50, 0, 200), []);
  // single dot
  const dot: Stroke = { tool: 'pen', color: '#000000', width: 2, pressure: false, pts: [10, 10] };
  assert.deepEqual(eraseFromStroke(dot, 12, 10, 3), []);
  assert.equal(eraseFromStroke(dot, 30, 10, 3), null);
});

test('eraser keeps pressure values when splitting', () => {
  const s: Stroke = { tool: 'pen', color: '#000000', width: 2, pressure: true, pts: [0, 0, 0, 100, 0, 1] };
  const pieces = eraseFromStroke(s, 50, 0, 5) as Stroke[];
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].pts.length % 3, 0);
  const p = pieces[0].pts[pieces[0].pts.length - 1];
  assert.ok(p > 0.4 && p < 0.5, `pressure ${p}`);
});

test('strokeHit uses stroke width', () => {
  const s = line(0, 0, 100, 0);
  assert.ok(strokeHit(s, 50, 5, 4.5));
  assert.ok(!strokeHit(s, 50, 8, 4.5));
});

function viewport(w: number, h: number, pages: number): Viewport {
  const v = new Viewport();
  v.vw = w;
  v.vh = h;
  v.pages = pages;
  return v;
}

test('viewport fit and page centring', () => {
  const v = viewport(390, 640, 3);
  const fit = v.fit();
  assert.ok(Math.abs(fit - (390 - 20) / PAGE_W) < 1e-9, 'phone portrait fits by width');
  const wide = viewport(1200, 700, 3);
  assert.ok(Math.abs(wide.fit() - (700 - 20) / PAGE_H) < 1e-9, 'landscape tablet fits by height');
  for (const i of [0, 1, 2]) {
    v.view = v.viewFor(i);
    assert.equal(v.currentPage(), i);
    const c = v.clampView(v.view);
    assert.ok(Math.abs(c.tx - v.tx) < 1e-6 && Math.abs(c.ty - v.ty) < 1e-6, `page ${i} centred view survives clamping`);
  }
});

test('viewport centring survives clamping on wide screens (first and last page)', () => {
  const v = viewport(1400, 700, 4);
  for (const i of [0, 3]) {
    const t = v.viewFor(i);
    const c = v.clampView(t);
    assert.ok(Math.abs(c.tx - t.tx) < 1e-6, `page ${i}`);
  }
});

test('zoomAt keeps the point under the cursor fixed', () => {
  const v = viewport(390, 640, 2);
  v.view = v.viewFor(0);
  const before = v.toWorld(200, 300);
  v.zoomAt(200, 300, v.s * 2);
  const after = v.toWorld(200, 300);
  assert.ok(Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6);
  assert.ok(v.s <= v.maxScale());
});

test('clamp stops the strip being dragged off screen', () => {
  const v = viewport(390, 640, 2);
  v.view = v.viewFor(0);
  v.panBy(100000, 100000);
  assert.ok(v.centerX() >= -100 && v.centerY() >= -100);
  v.panBy(-1e7, -1e7);
  assert.ok(v.centerX() <= v.stripWidth() + 100 && v.centerY() <= PAGE_H + 100);
  // zoomed in, the far edge of the last page is reachable
  v.view = v.viewFor(1, v.fit() * 3);
  v.panBy(-1e7, 0);
  const rightEdge = (v.vw - v.tx) / v.s;
  assert.ok(rightEdge >= v.pageX(1) + PAGE_W, `right edge ${rightEdge}`);
});

test('pageAtWorld ignores gaps and areas outside pages', () => {
  const v = viewport(390, 640, 3);
  assert.equal(v.pageAtWorld(10, 10), 0);
  assert.equal(v.pageAtWorld(PAGE_W + PAGE_GAP / 2, 100), -1);
  assert.equal(v.pageAtWorld(PAGE_W + PAGE_GAP + 5, 100), 1);
  assert.equal(v.pageAtWorld(10, PAGE_H + 5), -1);
  assert.equal(v.pageAtWorld(-5, 10), -1);
  assert.equal(v.pageAtWorld(v.pageX(2) + 10, 10), 2);
  assert.equal(v.pageAtWorld(v.pageX(3) + 10, 10), -1);
});

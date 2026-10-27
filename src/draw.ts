// Canvas drawing of paper backgrounds and ink strokes (shared by the main renderer,
// the thumbnail overview and PNG export).

import { PAGE_H, PAGE_W, PAPER_COLOR, bboxOf, spacingPt, strideOf } from './model.ts';
import type { BBox, Notebook, Page, Stroke } from './model.ts';

// Pressure is bucketed into this many width steps so runs of equal width can share one canvas path
// (much faster on dense pages). 16 steps is fine enough that width changes look continuous.
const PRESSURE_LEVELS = 16;

/**
 * Draw the paper pattern for a page. `pxPerPt` is how many device pixels one point covers,
 * used to keep hairlines crisp and to skip patterns that would turn to grey mush when tiny.
 */
export function drawPaper(ctx: CanvasRenderingContext2D, nb: Notebook, page: Page, pxPerPt: number): void {
  const sp = spacingPt(page.template, nb.spacing);
  if (page.template === 'blank' || sp * pxPerPt < 3) return;
  const lw = Math.max(0.5, 0.9 / pxPerPt);
  if (page.template === 'lined') {
    ctx.strokeStyle = 'rgba(70, 105, 160, 0.34)';
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (let y = 64; y <= PAGE_H - 34; y += sp) {
      const yy = Math.round(y * pxPerPt) / pxPerPt;
      ctx.moveTo(0, yy);
      ctx.lineTo(PAGE_W, yy);
    }
    ctx.stroke();
    return;
  }
  const ox = (PAGE_W % sp) / 2;
  const oy = (PAGE_H % sp) / 2;
  if (page.template === 'grid') {
    ctx.strokeStyle = 'rgba(70, 105, 160, 0.26)';
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (let x = ox; x <= PAGE_W; x += sp) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, PAGE_H);
    }
    for (let y = oy; y <= PAGE_H; y += sp) {
      ctx.moveTo(0, y);
      ctx.lineTo(PAGE_W, y);
    }
    ctx.stroke();
    return;
  }
  // dots
  const d = Math.max(1.1, 1.5 / pxPerPt);
  ctx.fillStyle = 'rgba(60, 85, 120, 0.5)';
  ctx.beginPath();
  for (let x = ox; x <= PAGE_W; x += sp) {
    for (let y = oy; y <= PAGE_H; y += sp) ctx.rect(x - d / 2, y - d / 2, d, d);
  }
  ctx.fill();
}

function levelOf(s: Stroke, i: number): number {
  if (!s.pressure) return PRESSURE_LEVELS;
  return Math.max(3, Math.round((0.55 + 0.9 * s.pts[i * 3 + 2]) * PRESSURE_LEVELS));
}

/** Draw one stroke as a smoothed (quadratic midpoint) path; pressure strokes vary in width. */
export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
  const st = strideOf(s);
  const P = s.pts;
  const n = Math.floor(P.length / st);
  if (n === 0) return;
  ctx.strokeStyle = s.color;
  ctx.fillStyle = s.color;
  ctx.lineJoin = 'round';
  ctx.lineCap = s.tool === 'highlighter' ? 'butt' : 'round';
  if (n === 1) {
    const r = (s.width * levelOf(s, 0)) / (2 * PRESSURE_LEVELS);
    ctx.beginPath();
    if (s.tool === 'highlighter') ctx.rect(P[0] - r, P[1] - r, r * 2, r * 2);
    else ctx.arc(P[0], P[1], r, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  let cx = P[0];
  let cy = P[1];
  let level = levelOf(s, 1);
  ctx.lineWidth = (s.width * level) / PRESSURE_LEVELS;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  for (let i = 1; i < n; i++) {
    const l = levelOf(s, i);
    if (l !== level) {
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      level = l;
      ctx.lineWidth = (s.width * level) / PRESSURE_LEVELS;
    }
    if (i === n - 1) {
      ctx.lineTo(P[i * st], P[i * st + 1]);
    } else {
      const mx = (P[i * st] + P[(i + 1) * st]) / 2;
      const my = (P[i * st + 1] + P[(i + 1) * st + 1]) / 2;
      ctx.quadraticCurveTo(P[i * st], P[i * st + 1], mx, my);
      cx = mx;
      cy = my;
    }
  }
  ctx.stroke();
}

function visible(s: Stroke, cull?: BBox): boolean {
  if (!cull) return true;
  const b = bboxOf(s);
  return !(b[2] < cull[0] || b[0] > cull[2] || b[3] < cull[1] || b[1] > cull[3]);
}

/**
 * Draw a page's strokes: highlighters first (multiplied into the paper like a real marker),
 * then pens on top, so ink is never hidden under a highlight.
 */
export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], cull?: BBox): void {
  let marked = false;
  for (const s of strokes) {
    if (s.tool !== 'highlighter' || !visible(s, cull)) continue;
    if (!marked) {
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      marked = true;
    }
    drawStroke(ctx, s);
  }
  if (marked) ctx.restore();
  for (const s of strokes) {
    if (s.tool === 'pen' && visible(s, cull)) drawStroke(ctx, s);
  }
}

/** Render a whole page (paper + ink) at the current transform, origin at the page's top-left. */
export function drawPage(ctx: CanvasRenderingContext2D, nb: Notebook, page: Page, pxPerPt: number, cull?: BBox): void {
  ctx.fillStyle = PAPER_COLOR[nb.paper];
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, PAGE_W, PAGE_H);
  ctx.clip();
  drawPaper(ctx, nb, page, pxPerPt);
  drawStrokes(ctx, page.strokes, cull);
  ctx.restore();
}

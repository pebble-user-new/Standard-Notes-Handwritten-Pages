// Ink geometry: simplification of raw pointer samples and eraser hit-testing / splitting.

import { bboxOf, computeBBox, strideOf } from './model.ts';
import type { Stroke } from './model.ts';

/**
 * Ramer-Douglas-Peucker simplification on a flat point array ([x,y] or [x,y,p]).
 * For pressure strokes the pressure deviation (scaled by stroke width) counts towards the error,
 * so pressure variation along a straight line isn't thrown away.
 */
export function simplify(pts: number[], stride: number, eps: number, width = 1): number[] {
  const n = Math.floor(pts.length / stride);
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const eps2 = eps * eps;
  const stack: number[] = [0, n - 1];
  while (stack.length) {
    const hi = stack.pop() as number;
    const lo = stack.pop() as number;
    if (hi - lo < 2) continue;
    const ax = pts[lo * stride];
    const ay = pts[lo * stride + 1];
    const bx = pts[hi * stride];
    const by = pts[hi * stride + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstErr = eps2;
    for (let i = lo + 1; i < hi; i++) {
      const px = pts[i * stride];
      const py = pts[i * stride + 1];
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - (ax + t * dx);
      const ey = py - (ay + t * dy);
      let err = ex * ex + ey * ey;
      if (stride === 3) {
        const pa = pts[lo * stride + 2];
        const pb = pts[hi * stride + 2];
        const dp = (pts[i * stride + 2] - (pa + (pb - pa) * t)) * width * 0.9;
        err += dp * dp;
      }
      if (err > worstErr) {
        worstErr = err;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push(lo, worst, worst, hi);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    for (let k = 0; k < stride; k++) out.push(pts[i * stride + k]);
  }
  return out;
}

/** Round coordinates to 0.1 pt and pressure to 0.01 so memory matches what gets saved. */
export function quantize(pts: number[], stride: number): void {
  for (let i = 0; i < pts.length; i += stride) {
    pts[i] = Math.round(pts[i] * 10) / 10;
    pts[i + 1] = Math.round(pts[i + 1] * 10) / 10;
    if (stride === 3) pts[i + 2] = Math.round(pts[i + 2] * 100) / 100;
  }
}

/** Parameter interval [t0, t1] (clamped to 0..1) of segment a->b that lies inside the circle, or null. */
export function segmentInCircle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, r: number): [number, number] | null {
  const dx = bx - ax;
  const dy = by - ay;
  const fx = ax - cx;
  const fy = ay - cy;
  const A = dx * dx + dy * dy;
  const C = fx * fx + fy * fy - r * r;
  if (A < 1e-12) return C <= 0 ? [0, 1] : null;
  const B = 2 * (fx * dx + fy * dy);
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const t0 = (-B - sq) / (2 * A);
  const t1 = (-B + sq) / (2 * A);
  if (t1 < 0 || t0 > 1) return null;
  return [Math.max(0, t0), Math.min(1, t1)];
}

export function distToSegment2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = px - (ax + t * dx);
  const ey = py - (ay + t * dy);
  return ex * ex + ey * ey;
}

function makePiece(src: Stroke, pts: number[]): Stroke {
  const s: Stroke = { tool: src.tool, color: src.color, width: src.width, pressure: src.pressure, pts };
  s.bbox = computeBBox(s);
  return s;
}

function overlapsCircle(s: Stroke, cx: number, cy: number, r: number): boolean {
  const b = bboxOf(s);
  return !(cx + r < b[0] || cx - r > b[2] || cy + r < b[1] || cy - r > b[3]);
}

/** Does the eraser circle touch this stroke at all (stroke half-width included)? */
export function strokeHit(s: Stroke, cx: number, cy: number, r: number): boolean {
  if (!overlapsCircle(s, cx, cy, r)) return false;
  const st = strideOf(s);
  const rr = r + s.width * 0.5;
  const rr2 = rr * rr;
  const n = s.pts.length / st;
  if (n === 1) {
    const dx = s.pts[0] - cx;
    const dy = s.pts[1] - cy;
    return dx * dx + dy * dy <= rr2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (distToSegment2(cx, cy, s.pts[i * st], s.pts[i * st + 1], s.pts[(i + 1) * st], s.pts[(i + 1) * st + 1]) <= rr2) return true;
  }
  return false;
}

/**
 * Erase the part of a stroke inside the circle. Returns null when the stroke is untouched,
 * otherwise the remaining pieces (possibly none).
 */
export function eraseFromStroke(s: Stroke, cx: number, cy: number, r: number): Stroke[] | null {
  if (!overlapsCircle(s, cx, cy, r)) return null;
  const st = strideOf(s);
  const rr = r + s.width * 0.25;
  const P = s.pts;
  const n = P.length / st;
  if (n === 1) {
    const dx = P[0] - cx;
    const dy = P[1] - cy;
    return dx * dx + dy * dy <= rr * rr ? [] : null;
  }
  const pieces: Stroke[] = [];
  let cur: number[] | null = null;
  let touched = false;
  const lerpPt = (i: number, t: number): number[] => {
    const o: number[] = [];
    for (let k = 0; k < st; k++) o.push(P[i * st + k] + (P[(i + 1) * st + k] - P[i * st + k]) * t);
    return o;
  };
  const pt = (i: number): number[] => P.slice(i * st, i * st + st);
  const flush = () => {
    if (cur && cur.length >= 2 * st) pieces.push(makePiece(s, cur));
    cur = null;
  };
  for (let i = 0; i < n - 1; i++) {
    const iv = segmentInCircle(P[i * st], P[i * st + 1], P[(i + 1) * st], P[(i + 1) * st + 1], cx, cy, rr);
    if (!iv) {
      if (!cur) cur = pt(i);
      cur.push(...pt(i + 1));
      continue;
    }
    touched = true;
    const [t0, t1] = iv;
    if (t0 > 1e-6) {
      if (!cur) cur = pt(i);
      cur.push(...lerpPt(i, t0));
      flush();
    } else {
      flush();
    }
    if (t1 < 1 - 1e-6) {
      cur = [...lerpPt(i, t1), ...pt(i + 1)];
    }
  }
  flush();
  return touched ? pieces : null;
}

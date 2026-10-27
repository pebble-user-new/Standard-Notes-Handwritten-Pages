// Compact JSON encoding of a notebook into the Standard Notes note text.
//
//   {"app":"sn-handwritten-pages","v":1,"sz":"a5","ln":50,"t":"lined","sp":1,"pp":"white",
//    "pages":[{"t":"lined","s":[[tool,"rrggbb",width*10,hasPressure, ...deltas], ...]}]}
//
// Versions: A4 notebooks are written as v1 (identical to the first release, so an older cached copy of
// the plugin still opens them). Notebooks with another paper size ("sz") or extra page length ("ln", percent) are written as v2, which an
// old copy refuses to open instead of silently showing them as A4 and saving that back.
//
// Points are stored in 1/10 pt, delta-encoded against the previous point (first point is absolute).
// Pressure (when present) is stored in 1/100 steps, also delta-encoded.

import { newNotebook, newPage, LENGTHS, SIZES, TEMPLATES, PAPERS } from './model.ts';
import type { Length, Notebook, Page, PageSize, Paper, Spacing, Stroke, Template } from './model.ts';

export const APP_ID = 'sn-handwritten-pages';
/** newest format this build understands */
export const FORMAT_VERSION = 2;

export type DecodeResult =
  | { kind: 'empty' }
  | { kind: 'ok'; nb: Notebook }
  | { kind: 'foreign' }
  | { kind: 'newer'; version: number }
  | { kind: 'corrupt' };

const COLOR_RE = /^[0-9a-fA-F]{6}$/;

function encodeStroke(s: Stroke): (number | string)[] {
  const out: (number | string)[] = [s.tool === 'pen' ? 0 : 1, s.color.replace('#', ''), Math.round(s.width * 10), s.pressure ? 1 : 0];
  const st = s.pressure ? 3 : 2;
  let px = 0;
  let py = 0;
  let pp = 0;
  for (let i = 0; i < s.pts.length; i += st) {
    const x = Math.round(s.pts[i] * 10);
    const y = Math.round(s.pts[i + 1] * 10);
    out.push(x - px, y - py);
    px = x;
    py = y;
    if (s.pressure) {
      const p = Math.max(0, Math.min(100, Math.round(s.pts[i + 2] * 100)));
      out.push(p - pp);
      pp = p;
    }
  }
  return out;
}

export function encode(nb: Notebook): string {
  const nonA4 = nb.size !== 'a4' || nb.length !== 0;
  return JSON.stringify({
    app: APP_ID,
    v: nonA4 ? 2 : 1,
    ...(nb.size !== 'a4' ? { sz: nb.size } : {}),
    ...(nb.length ? { ln: nb.length } : {}),
    t: nb.template,
    sp: nb.spacing,
    pp: nb.paper,
    pages: nb.pages.map((p) => ({ t: p.template, s: p.strokes.map(encodeStroke) })),
  });
}

function decodeStroke(a: unknown): Stroke | null {
  if (!Array.isArray(a) || a.length < 6) return null;
  const [toolCode, color, w10, hasP] = a;
  if (typeof color !== 'string' || !COLOR_RE.test(color)) return null;
  if (typeof w10 !== 'number' || !Number.isFinite(w10) || w10 <= 0) return null;
  const pressure = hasP === 1;
  const st = pressure ? 3 : 2;
  const body = a.length - 4;
  if (body < st || body % st !== 0) return null;
  const pts: number[] = [];
  let x = 0;
  let y = 0;
  let p = 0;
  for (let i = 4; i < a.length; i += st) {
    const dx = a[i];
    const dy = a[i + 1];
    if (typeof dx !== 'number' || typeof dy !== 'number' || !Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    x += dx;
    y += dy;
    pts.push(x / 10, y / 10);
    if (pressure) {
      const dp = a[i + 2];
      if (typeof dp !== 'number' || !Number.isFinite(dp)) return null;
      p += dp;
      pts.push(Math.max(0, Math.min(100, p)) / 100);
    }
  }
  return { tool: toolCode === 1 ? 'highlighter' : 'pen', color: '#' + color.toLowerCase(), width: w10 / 10, pressure, pts };
}

function asTemplate(v: unknown, fallback: Template): Template {
  return TEMPLATES.includes(v as Template) ? (v as Template) : fallback;
}

export function decode(text: string): DecodeResult {
  if (!text || !text.trim()) return { kind: 'empty' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'foreign' };
  }
  if (!raw || typeof raw !== 'object' || (raw as { app?: unknown }).app !== APP_ID) return { kind: 'foreign' };
  const o = raw as Record<string, unknown>;
  if (typeof o.v !== 'number') return { kind: 'corrupt' };
  if (o.v > FORMAT_VERSION) return { kind: 'newer', version: o.v };
  if (!Array.isArray(o.pages)) return { kind: 'corrupt' };

  const template = asTemplate(o.t, 'lined');
  const nb: Notebook = {
    size: (SIZES.includes(o.sz as PageSize) ? o.sz : 'a4') as PageSize,
    length: (LENGTHS.includes(o.ln as Length) ? o.ln : 0) as Length,
    template,
    spacing: (o.sp === 0 || o.sp === 1 || o.sp === 2 ? o.sp : 1) as Spacing,
    paper: (PAPERS.includes(o.pp as Paper) ? o.pp : 'white') as Paper,
    pages: [],
  };
  for (const rp of o.pages) {
    if (!rp || typeof rp !== 'object') continue;
    const page: Page = newPage(asTemplate((rp as { t?: unknown }).t, template));
    const strokes = (rp as { s?: unknown }).s;
    if (Array.isArray(strokes)) {
      for (const rs of strokes) {
        const s = decodeStroke(rs);
        if (s) page.strokes.push(s);
      }
    }
    nb.pages.push(page);
  }
  if (nb.pages.length === 0) nb.pages.push(newPage(template));
  return { kind: 'ok', nb };
}

export function freshNotebook(): Notebook {
  return newNotebook();
}

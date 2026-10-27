// Per-device preferences (tool, colours, sizes, touch behaviour). Kept in localStorage rather than
// in the note, so switching tools never dirties the note and a tablet's pen settings don't leak to a phone.

import type { Tool } from './model.ts';

export type TouchMode = 'auto' | 'draw' | 'scroll';
export type EraserMode = 'split' | 'stroke';

/** A saved colour + size, shown as a quick-pick dot in the preset row. */
export interface Preset {
  color: string;
  width: number;
}

export const MAX_PRESETS = 6;

export interface Prefs {
  tool: Tool;
  penColor: string;
  penWidth: number;
  hlColor: string;
  hlWidth: number;
  eraserSize: number;
  eraserMode: EraserMode;
  /**
   * scroll ("Pen only", the default): only a stylus or mouse draws, fingers scroll / zoom / turn pages.
   * auto: fingers draw until a stylus has been seen, then they only scroll.
   * draw: fingers always draw.
   */
  touch: TouchMode;
  penSeen: boolean;
  /** quick-pick presets (3 to start with, up to MAX_PRESETS); the selected one mirrors penColor/penWidth etc. */
  penPresets: Preset[];
  hlPresets: Preset[];
  penIdx: number;
  hlIdx: number;
}

/**
 * Pen colours as a grid: one column per hue, rows are the full colour, a lighter shade and a lighter-still shade
 * (black -> greys, red -> light red -> pink, orange -> light orange -> yellow).
 */
export const PEN_SHADES: string[][] = [
  ['#1c1c1e', '#1f4fd8', '#0aa5c9', '#1e8e3e', '#7a3fd1', '#d62b2b', '#e8710a'],
  ['#5c5c60', '#5b83ea', '#52c4de', '#5cb774', '#a47be0', '#e66a6a', '#f2a04d'],
  ['#98989d', '#9db5f3', '#9adcec', '#9bd4aa', '#cdb4ee', '#f4a3b8', '#f6d52b'],
];
/** Flat list, full colours first (new presets take the first colour not used yet). */
export const PEN_COLORS = PEN_SHADES.flat();
export const PEN_WIDTHS = [0.8, 1.4, 2.2, 3.6];
export const HL_COLORS = ['#fff176', '#a7f3a0', '#ffc4e1', '#9fe0ff', '#ffcc80'];
export const HL_WIDTHS = [8, 12, 18];
export const ERASER_SIZES = [4, 9, 18];

export const DEFAULT_PEN_PRESETS: Preset[] = [
  { color: '#1c1c1e', width: PEN_WIDTHS[1] }, // black
  { color: '#1f4fd8', width: PEN_WIDTHS[1] }, // blue
  { color: '#d62b2b', width: PEN_WIDTHS[1] }, // red
];
export const DEFAULT_HL_PRESETS: Preset[] = [
  { color: HL_COLORS[0], width: HL_WIDTHS[1] },
  { color: HL_COLORS[1], width: HL_WIDTHS[1] },
  { color: HL_COLORS[2], width: HL_WIDTHS[1] },
];

const KEY = 'handwritten-pages:prefs:v1';
/**
 * Bumped when a default changes. Preferences saved before the pen-only default (no `v`, or v1) kept
 * the old "auto" value without the person choosing it, so they are moved to the new default once.
 */
const PREFS_VERSION = 2;

export function defaultPrefs(): Prefs {
  return {
    tool: 'pen',
    penColor: PEN_COLORS[0],
    penWidth: PEN_WIDTHS[1],
    hlColor: HL_COLORS[0],
    hlWidth: HL_WIDTHS[1],
    eraserSize: ERASER_SIZES[1],
    eraserMode: 'split',
    touch: 'scroll',
    penSeen: false,
    penPresets: DEFAULT_PEN_PRESETS.map((p) => ({ ...p })),
    hlPresets: DEFAULT_HL_PRESETS.map((p) => ({ ...p })),
    penIdx: 0,
    hlIdx: 0,
  };
}

function cleanPresets(raw: unknown): Preset[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Preset[] = [];
  for (const r of raw) {
    const o = r as Partial<Preset> | null;
    if (o && typeof o.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(o.color) && typeof o.width === 'number' && o.width > 0 && o.width < 100) out.push({ color: o.color, width: o.width });
    if (out.length >= MAX_PRESETS) break;
  }
  return out.length ? out : null;
}

/** Presets for someone who had none yet: their current pen first, then the stock ones. */
function seedPresets(current: Preset, stock: Preset[]): Preset[] {
  return [current, ...stock.filter((p) => p.color !== current.color)].slice(0, 3).map((p) => ({ ...p }));
}

export function loadPrefs(): Prefs {
  const d = defaultPrefs();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const o = JSON.parse(raw) as Partial<Prefs> & { v?: number };
    const migrate = (o.v ?? 1) < PREFS_VERSION;
    const penColor = typeof o.penColor === 'string' ? o.penColor : d.penColor;
    const penWidth = typeof o.penWidth === 'number' ? o.penWidth : d.penWidth;
    const hlColor = typeof o.hlColor === 'string' ? o.hlColor : d.hlColor;
    const hlWidth = typeof o.hlWidth === 'number' ? o.hlWidth : d.hlWidth;
    const penPresets = cleanPresets(o.penPresets) ?? seedPresets({ color: penColor, width: penWidth }, DEFAULT_PEN_PRESETS);
    const hlPresets = cleanPresets(o.hlPresets) ?? seedPresets({ color: hlColor, width: hlWidth }, DEFAULT_HL_PRESETS);
    const idx = (v: unknown, n: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n ? v : 0);
    const penIdx = cleanPresets(o.penPresets) ? idx(o.penIdx, penPresets.length) : 0;
    const hlIdx = cleanPresets(o.hlPresets) ? idx(o.hlIdx, hlPresets.length) : 0;
    return {
      tool: o.tool === 'highlighter' || o.tool === 'eraser' ? o.tool : 'pen',
      // the active colour / size always come from the selected preset
      penColor: penPresets[penIdx].color,
      penWidth: penPresets[penIdx].width,
      hlColor: hlPresets[hlIdx].color,
      hlWidth: hlPresets[hlIdx].width,
      eraserSize: typeof o.eraserSize === 'number' ? o.eraserSize : d.eraserSize,
      eraserMode: o.eraserMode === 'stroke' ? 'stroke' : 'split',
      touch: migrate ? 'scroll' : o.touch === 'draw' || o.touch === 'auto' ? o.touch : 'scroll',
      penSeen: o.penSeen === true,
      penPresets,
      hlPresets,
      penIdx,
      hlIdx,
    };
  } catch {
    return d;
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...p, v: PREFS_VERSION }));
  } catch {
    /* storage may be unavailable inside a sandboxed iframe; preferences just won't persist */
  }
}

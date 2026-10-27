// Per-device preferences (tool, colours, sizes, touch behaviour). Kept in localStorage rather than
// in the note, so switching tools never dirties the note and a tablet's pen settings don't leak to a phone.

import type { Tool } from './model.ts';

export type TouchMode = 'auto' | 'draw' | 'scroll';
export type EraserMode = 'split' | 'stroke';

export interface Prefs {
  tool: Tool;
  penColor: string;
  penWidth: number;
  hlColor: string;
  hlWidth: number;
  eraserSize: number;
  eraserMode: EraserMode;
  /** auto: fingers draw until a stylus has been seen, then fingers only scroll/zoom */
  touch: TouchMode;
  penSeen: boolean;
}

export const PEN_COLORS = ['#1c1c1e', '#1f4fd8', '#d62b2b', '#1e8e3e', '#7a3fd1', '#e8710a'];
export const PEN_WIDTHS = [0.8, 1.4, 2.2, 3.6];
export const HL_COLORS = ['#fff176', '#a7f3a0', '#ffc4e1', '#9fe0ff', '#ffcc80'];
export const HL_WIDTHS = [8, 12, 18];
export const ERASER_SIZES = [4, 9, 18];

const KEY = 'handwritten-pages:prefs:v1';

export function defaultPrefs(): Prefs {
  return {
    tool: 'pen',
    penColor: PEN_COLORS[0],
    penWidth: PEN_WIDTHS[1],
    hlColor: HL_COLORS[0],
    hlWidth: HL_WIDTHS[1],
    eraserSize: ERASER_SIZES[1],
    eraserMode: 'split',
    touch: 'auto',
    penSeen: false,
  };
}

export function loadPrefs(): Prefs {
  const d = defaultPrefs();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const o = JSON.parse(raw) as Partial<Prefs>;
    return {
      tool: o.tool === 'highlighter' || o.tool === 'eraser' ? o.tool : 'pen',
      penColor: typeof o.penColor === 'string' ? o.penColor : d.penColor,
      penWidth: typeof o.penWidth === 'number' ? o.penWidth : d.penWidth,
      hlColor: typeof o.hlColor === 'string' ? o.hlColor : d.hlColor,
      hlWidth: typeof o.hlWidth === 'number' ? o.hlWidth : d.hlWidth,
      eraserSize: typeof o.eraserSize === 'number' ? o.eraserSize : d.eraserSize,
      eraserMode: o.eraserMode === 'stroke' ? 'stroke' : 'split',
      touch: o.touch === 'draw' || o.touch === 'scroll' ? o.touch : 'auto',
      penSeen: o.penSeen === true,
    };
  } catch {
    return d;
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage may be unavailable inside a sandboxed iframe; preferences just won't persist */
  }
}

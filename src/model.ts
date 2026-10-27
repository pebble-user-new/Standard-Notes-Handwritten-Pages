// Data model for a handwritten notebook. All coordinates are in PostScript points
// (1/72 inch) on a portrait page, origin at the page's top-left corner.

/** Gap between pages in the horizontal page strip (world units). */
export const PAGE_GAP = 40;

export type PageSize = 'a4' | 'a5' | 'a6';
/** extra page height in percent (width stays), for differently shaped screens */
export type Length = 0 | 50 | 75 | 100;

export interface PageDims {
  w: number;
  h: number;
  label: string;
  /** physical size in mm, e.g. "105 × 148 mm" */
  mm: string;
}

// ISO A series in points (1 pt = 1/72 in); every size halves the one before it.
const BASE: Record<PageSize, { w: number; h: number; wmm: number; hmm: number }> = {
  a4: { w: 595, h: 842, wmm: 210, hmm: 297 },
  a5: { w: 420, h: 595, wmm: 148, hmm: 210 },
  a6: { w: 298, h: 420, wmm: 105, hmm: 148 },
};
export const SIZES: PageSize[] = ['a4', 'a5', 'a6'];
export const LENGTHS: Length[] = [0, 50, 75, 100];

/** Page size in points for a paper size and extra length: the width never changes, the height grows. */
export function dimsFor(size: PageSize, length: Length): PageDims {
  const b = BASE[size];
  const f = 1 + length / 100;
  return {
    w: b.w,
    h: Math.round(b.h * f),
    label: size.toUpperCase(),
    mm: `${b.wmm} × ${Math.round(b.hmm * f)} mm`,
  };
}

export type Template = 'blank' | 'lined' | 'grid' | 'dots';
export type Paper = 'white' | 'cream' | 'grey';
export type InkTool = 'pen' | 'highlighter';
export type Tool = InkTool | 'eraser';
export type Spacing = 0 | 1 | 2;

export const TEMPLATES: Template[] = ['blank', 'lined', 'grid', 'dots'];
export const TEMPLATE_LABEL: Record<Template, string> = {
  blank: 'Blank',
  lined: 'Lined',
  grid: 'Grid',
  dots: 'Dotted',
};

export const PAPER_COLOR: Record<Paper, string> = {
  white: '#ffffff',
  cream: '#fbf5e4',
  grey: '#eceff1',
};
export const PAPERS: Paper[] = ['white', 'cream', 'grey'];

// narrow / medium / wide, in points
const SPACING: Record<Template, [number, number, number]> = {
  blank: [20, 20, 20],
  lined: [18, 22, 28],
  grid: [11.3, 14.2, 19.8], // 4 mm, 5 mm, 7 mm
  dots: [11.3, 14.2, 19.8],
};

export function spacingPt(template: Template, level: Spacing): number {
  return SPACING[template][level];
}

export type BBox = [minX: number, minY: number, maxX: number, maxY: number];

export interface Stroke {
  tool: InkTool;
  /** '#rrggbb' */
  color: string;
  /** nominal width in points */
  width: number;
  /** true when `pts` holds [x, y, pressure] triples, otherwise [x, y] pairs */
  pressure: boolean;
  pts: number[];
  /** cached bounding box including the stroke width (not persisted) */
  bbox?: BBox;
}

export interface Page {
  template: Template;
  strokes: Stroke[];
}

export interface Notebook {
  /** paper size, the same for every page */
  size: PageSize;
  /** extra page height (percent), the same for every page */
  length: Length;
  /** template used for newly added pages */
  template: Template;
  spacing: Spacing;
  paper: Paper;
  pages: Page[];
}

export function strideOf(s: Stroke): number {
  return s.pressure ? 3 : 2;
}

export function computeBBox(s: Stroke): BBox {
  const st = strideOf(s);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < s.pts.length; i += st) {
    const x = s.pts[i];
    const y = s.pts[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const pad = s.width * (s.pressure ? 0.85 : 0.5) + 1;
  return [minX - pad, minY - pad, maxX + pad, maxY + pad];
}

export function bboxOf(s: Stroke): BBox {
  return (s.bbox ??= computeBBox(s));
}

export function newPage(template: Template): Page {
  return { template, strokes: [] };
}

export function newNotebook(): Notebook {
  return { size: 'a4', length: 0, template: 'lined', spacing: 1, paper: 'white', pages: [newPage('lined')] };
}

export function pageDims(nb: Notebook): PageDims {
  return dimsFor(nb.size, nb.length);
}

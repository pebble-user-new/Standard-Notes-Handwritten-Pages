// The notebook is laid out as a horizontal strip of A4 pages in "world" units (points).
// The viewport maps world -> screen:  screen = world * s + (tx, ty).
// Pure math, no DOM, so it can be unit-tested.

import { PAGE_GAP, dimsFor } from './model.ts';

export interface View {
  s: number;
  tx: number;
  ty: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export class Viewport {
  s = 1;
  tx = 0;
  ty = 0;
  vw = 360;
  vh = 640;
  pages = 1;
  /** page size in points (set from the notebook's paper size) */
  pageW: number = dimsFor('a4', 0).w;
  pageH: number = dimsFor('a4', 0).h;
  /** screen padding around a page when it is "fit" to the screen */
  readonly pad = 10;

  get view(): View {
    return { s: this.s, tx: this.tx, ty: this.ty };
  }

  set view(v: View) {
    this.s = v.s;
    this.tx = v.tx;
    this.ty = v.ty;
  }

  setPageSize(w: number, h: number): void {
    this.pageW = w;
    this.pageH = h;
  }

  /** Scale at which one whole page fits the screen. */
  fit(): number {
    const sx = (this.vw - 2 * this.pad) / this.pageW;
    const sy = (this.vh - 2 * this.pad) / this.pageH;
    return Math.max(0.05, Math.min(sx, sy));
  }

  minScale(): number {
    return this.fit() * 0.3;
  }

  maxScale(): number {
    return Math.max(this.fit() * 8, 5);
  }

  stripWidth(): number {
    return this.pages * this.pageW + (this.pages - 1) * PAGE_GAP;
  }

  pageX(i: number): number {
    return i * (this.pageW + PAGE_GAP);
  }

  toWorld(px: number, py: number): { x: number; y: number } {
    return { x: (px - this.tx) / this.s, y: (py - this.ty) / this.s };
  }

  /** World x of the viewport centre. */
  centerX(): number {
    return (this.vw / 2 - this.tx) / this.s;
  }

  centerY(): number {
    return (this.vh / 2 - this.ty) / this.s;
  }

  /** Index of the page nearest to the viewport centre. */
  currentPage(): number {
    const i = Math.round((this.centerX() - this.pageW / 2) / (this.pageW + PAGE_GAP));
    return clamp(i, 0, this.pages - 1) + 0; // "+ 0" turns -0 into 0
  }

  /** Page index under a world point, or -1 if it is in a gap or outside every page. */
  pageAtWorld(wx: number, wy: number, tolerance = 0): number {
    if (wy < -tolerance || wy > this.pageH + tolerance) return -1;
    const i = Math.round((wx - this.pageW / 2) / (this.pageW + PAGE_GAP)) + 0; // "+ 0" turns -0 into 0
    if (i < 0 || i >= this.pages) return -1;
    const x0 = this.pageX(i);
    if (wx < x0 - tolerance || wx > x0 + this.pageW + tolerance) return -1;
    return i;
  }

  /** View that centres page `i` at scale `s` (default: fit). */
  viewFor(i: number, s = this.fit()): View {
    const cx = this.pageX(i) + this.pageW / 2;
    return { s, tx: this.vw / 2 - cx * s, ty: this.vh / 2 - (this.pageH / 2) * s };
  }

  /** Clamp a view so the strip can't be dragged off screen, allowing a little overscroll. */
  clampView(v: View): View {
    const s = clamp(v.s, this.minScale(), this.maxScale());
    const halfX = this.vw / (2 * s);
    const halfY = this.vh / (2 * s);
    const slack = 36 / s;
    const ax = Math.min(this.pageW / 2, halfX);
    const ay = Math.min(this.pageH / 2, halfY);
    let cx = (this.vw / 2 - v.tx) / v.s;
    let cy = (this.vh / 2 - v.ty) / v.s;
    cx = clamp(cx, ax - slack, this.stripWidth() - ax + slack);
    cy = clamp(cy, ay - slack, this.pageH - ay + slack);
    return { s, tx: this.vw / 2 - cx * s, ty: this.vh / 2 - cy * s };
  }

  clamp(): void {
    this.view = this.clampView(this.view);
  }

  panBy(dx: number, dy: number): void {
    this.tx += dx;
    this.ty += dy;
    this.clamp();
  }

  /** Zoom to scale `s`, keeping the world point under screen (px, py) fixed. */
  zoomAt(px: number, py: number, s: number): void {
    const ns = clamp(s, this.minScale(), this.maxScale());
    const wx = (px - this.tx) / this.s;
    const wy = (py - this.ty) / this.s;
    this.s = ns;
    this.tx = px - wx * ns;
    this.ty = py - wy * ns;
    this.clamp();
  }

  /** Ratio of current scale to the fit scale. */
  ratio(): number {
    return this.s / this.fit();
  }

  /** Is the view close to "one page fits the screen" (paged mode, where swiping turns pages)? */
  isPaged(): boolean {
    const r = this.ratio();
    return r >= 0.8 && r <= 1.06;
  }

  /** Is the view zoomed out enough that several pages show and drawing is disabled? */
  isOverview(): boolean {
    return this.ratio() < 0.8;
  }
}

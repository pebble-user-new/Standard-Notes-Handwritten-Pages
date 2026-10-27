// Application controller: owns the notebook, tools, view and history, and ties the
// renderer, input handling, UI and Standard Notes host together.

import { Camera } from './camera.ts';
import { decode, encode, freshNotebook } from './codec.ts';
import { drawPage } from './draw.ts';
import { eraseFromStroke, quantize, simplify, strokeHit } from './geometry.ts';
import { History } from './history.ts';
import { createHost } from './host.ts';
import type { NoteHost } from './host.ts';
import { Input } from './input.ts';
import { PAGE_H, PAGE_W, PAPER_COLOR, computeBBox, newPage, strideOf } from './model.ts';
import type { Notebook, Page, Paper, Spacing, Stroke, Template, Tool } from './model.ts';
import { loadPrefs, savePrefs } from './prefs.ts';
import type { EraserMode, Prefs, TouchMode } from './prefs.ts';
import { Renderer } from './renderer.ts';
import { UI } from './ui.ts';
import { Viewport } from './viewport.ts';

export interface ActiveStroke {
  pageIndex: number;
  stroke: Stroke;
  lastP: number;
  born: number;
  pointerType: string;
}

export type Unsupported = 'foreign' | 'newer' | 'corrupt' | null;

const SAVE_DELAY = 700;

export class App {
  nb: Notebook = freshNotebook();
  vp = new Viewport();
  history = new History();
  prefs: Prefs = loadPrefs();
  readOnly = false;
  unsupported: Unsupported = null;
  active: ActiveStroke | null = null;
  eraserCursor: { x: number; y: number; r: number } | null = null;

  renderer!: Renderer;
  camera!: Camera;
  ui!: UI;
  input!: Input;
  readonly host: NoteHost = createHost();

  private loaded = false;
  private sized = false;
  private lastText = '';
  private savePending = false;
  private saveTimer = 0;
  private eraseSnap: Map<Page, Stroke[]> | null = null;
  private lastPageShown = -1;

  mount(root: HTMLElement): void {
    this.camera = new Camera(this);
    this.ui = new UI(this);
    const { stage, base, live } = this.ui.build(root);
    this.renderer = new Renderer(this, base, live);
    this.input = new Input(this, stage);
    this.history.onChange = () => this.ui.refresh();

    new ResizeObserver(() => this.onResize(stage.clientWidth, stage.clientHeight)).observe(stage);
    this.onResize(stage.clientWidth, stage.clientHeight);

    const flush = () => this.flushSave();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
    window.addEventListener('blur', flush);

    this.applyTheme();
    this.host.init(() => this.onHostUpdate());
    this.updateBlend();
  }

  // ---------------------------------------------------------------- loading / saving

  private onHostUpdate(): void {
    this.readOnly = this.host.locked;
    const text = this.host.text;
    if (this.loaded && text === this.lastText) {
      this.ui.refresh();
      return;
    }
    // our own unsaved edits win over an incoming change
    if (this.loaded && (this.savePending || this.active || this.input.busy)) return;

    const res = decode(text);
    this.unsupported = null;
    if (res.kind === 'ok') this.nb = res.nb;
    else {
      this.nb = freshNotebook();
      if (res.kind !== 'empty') this.unsupported = res.kind;
    }
    this.lastText = text;
    this.loaded = true;
    this.history.clear();
    this.vp.pages = this.nb.pages.length;
    if (this.sized) {
      this.vp.view = this.vp.viewFor(this.initialPage());
      this.camera.stop();
    }
    this.lastPageShown = -1;
    this.viewChanged();
    this.renderer.invalidate();
    this.ui.refresh();
    this.maybeShowHint();
  }

  /** One-time gesture hint, shown the first time a notebook opens on this device. */
  private maybeShowHint(): void {
    const key = 'handwritten-pages:hint-v1';
    try {
      if (localStorage.getItem(key) || this.unsupported) return;
      localStorage.setItem(key, '1');
    } catch {
      return;
    }
    this.ui.toast('Pinch to zoom · swipe sideways to turn pages');
  }

  /** Open at the last page that has ink, which is usually where the person left off. */
  private initialPage(): number {
    for (let i = this.nb.pages.length - 1; i >= 0; i--) if (this.nb.pages[i].strokes.length) return i;
    return 0;
  }

  private onResize(w: number, h: number): void {
    if (w < 2 || h < 2) return;
    const vp = this.vp;
    const wasFit = !this.sized || Math.abs(vp.s - vp.fit()) / vp.fit() < 0.01;
    const page = vp.currentPage();
    const keepCx = vp.centerX();
    const keepCy = vp.centerY();
    const keepRatio = vp.ratio();
    vp.vw = w;
    vp.vh = h;
    if (!this.sized) {
      this.sized = true;
      vp.view = vp.viewFor(this.loaded ? this.initialPage() : 0);
    } else if (wasFit) {
      vp.view = vp.viewFor(page);
    } else {
      const s = vp.fit() * keepRatio;
      vp.view = vp.clampView({ s, tx: w / 2 - keepCx * s, ty: h / 2 - keepCy * s });
    }
    this.renderer.resize(w, h);
    this.viewChanged();
  }

  private markDirty(): void {
    this.savePending = true;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flushSave(), SAVE_DELAY);
  }

  flushSave(): void {
    window.clearTimeout(this.saveTimer);
    if (!this.savePending) return;
    this.savePending = false;
    const text = encode(this.nb);
    this.lastText = text;
    const n = this.nb.pages.length;
    this.host.write(text, `Handwritten notebook · ${n} page${n === 1 ? '' : 's'}`);
  }

  /** Content changed: redraw, refresh the UI and schedule a save. */
  changed(): void {
    this.renderer.invalidate();
    this.ui.refresh();
    this.markDirty();
  }

  applyTheme(): void {
    this.renderer?.invalidate();
  }

  // ---------------------------------------------------------------- view

  viewChanged(): void {
    this.renderer?.invalidate(true, true);
    const p = this.vp.currentPage();
    if (p !== this.lastPageShown) {
      this.lastPageShown = p;
      this.ui?.refresh();
    }
  }

  curPage(): number {
    return this.vp.currentPage();
  }

  goToPage(i: number): void {
    this.camera.goToPage(i);
  }

  nextPage(): void {
    this.goToPage(this.curPage() + 1);
  }

  prevPage(): void {
    this.goToPage(this.curPage() - 1);
  }

  /** Reset to a whole page filling the screen. */
  fitPage(): void {
    this.camera.animateTo(this.vp.viewFor(this.curPage()), 220);
  }

  // ---------------------------------------------------------------- tools / prefs

  private savePrefs(): void {
    savePrefs(this.prefs);
    this.ui.refresh();
  }

  setTool(t: Tool): void {
    this.prefs.tool = t;
    this.updateBlend();
    this.savePrefs();
  }

  setColor(c: string): void {
    if (this.prefs.tool === 'highlighter') this.prefs.hlColor = c;
    else this.prefs.penColor = c;
    this.savePrefs();
  }

  setWidth(w: number): void {
    if (this.prefs.tool === 'highlighter') this.prefs.hlWidth = w;
    else if (this.prefs.tool === 'eraser') this.prefs.eraserSize = w;
    else this.prefs.penWidth = w;
    this.savePrefs();
  }

  setEraserMode(m: EraserMode): void {
    this.prefs.eraserMode = m;
    this.savePrefs();
  }

  setTouchMode(m: TouchMode): void {
    this.prefs.touch = m;
    this.savePrefs();
  }

  notePenSeen(): void {
    if (this.prefs.penSeen) return;
    this.prefs.penSeen = true;
    this.savePrefs();
  }

  /** Does a pointer of this type draw (as opposed to scrolling / zooming)? */
  pointerDraws(type: string): boolean {
    if (type !== 'touch') return true;
    if (this.prefs.touch === 'draw') return true;
    if (this.prefs.touch === 'scroll') return false;
    return !this.prefs.penSeen;
  }

  /** Whether drawing is currently possible at all. */
  get canEdit(): boolean {
    return !this.readOnly && !this.unsupported;
  }

  private updateBlend(): void {
    // a highlighter is multiplied into the paper once committed; preview it the same way
    this.ui?.setLiveBlend(this.prefs.tool === 'highlighter' ? 'multiply' : 'normal');
  }

  currentWidth(): number {
    const p = this.prefs;
    return p.tool === 'highlighter' ? p.hlWidth : p.tool === 'eraser' ? p.eraserSize : p.penWidth;
  }

  currentColor(): string {
    return this.prefs.tool === 'highlighter' ? this.prefs.hlColor : this.prefs.penColor;
  }

  // ---------------------------------------------------------------- drawing

  beginStroke(pageIndex: number, x: number, y: number, pressure: number | null, pointerType: string): void {
    if (!this.canEdit) return;
    const tool = this.prefs.tool === 'highlighter' ? 'highlighter' : 'pen';
    const stroke: Stroke = {
      tool,
      color: tool === 'highlighter' ? this.prefs.hlColor : this.prefs.penColor,
      width: tool === 'highlighter' ? this.prefs.hlWidth : this.prefs.penWidth,
      pressure: pressure !== null && tool === 'pen',
      pts: [],
    };
    this.active = { pageIndex, stroke, lastP: pressure ?? 0, born: performance.now(), pointerType };
    this.pushPoint(x, y, pressure, true);
  }

  extendStroke(x: number, y: number, pressure: number | null): void {
    this.pushPoint(x, y, pressure, false);
  }

  private pushPoint(x: number, y: number, pressure: number | null, first: boolean): void {
    const a = this.active;
    if (!a) return;
    const s = a.stroke;
    const st = strideOf(s);
    x = Math.max(-30, Math.min(PAGE_W + 30, x));
    y = Math.max(-30, Math.min(PAGE_H + 30, y));
    const n = s.pts.length;
    if (n >= st) {
      const dx = x - s.pts[n - st];
      const dy = y - s.pts[n - st + 1];
      const minD = Math.max(0.1, 0.35 / this.vp.s);
      if (dx * dx + dy * dy < minD * minD) return;
    }
    if (n / st > 40000) return;
    if (s.pressure) {
      const p = first ? (pressure ?? 0.5) : a.lastP * 0.5 + (pressure ?? a.lastP) * 0.5;
      a.lastP = p;
      s.pts.push(x, y, p);
    } else {
      s.pts.push(x, y);
    }
    this.renderer.invalidate(false, true);
  }

  endStroke(): void {
    const a = this.active;
    this.active = null;
    this.renderer.invalidate(false, true);
    if (!a) return;
    const s = a.stroke;
    const st = strideOf(s);
    if (s.pts.length < st) return;
    const pts = simplify(s.pts, st, 0.12, s.width);
    quantize(pts, st);
    s.pts = pts;
    s.bbox = computeBBox(s);
    const page = this.nb.pages[a.pageIndex];
    if (!page) return;
    page.strokes.push(s);
    this.history.push({
      undo: () => {
        const i = page.strokes.lastIndexOf(s);
        if (i >= 0) page.strokes.splice(i, 1);
        this.changed();
      },
      redo: () => {
        page.strokes.push(s);
        this.changed();
      },
    });
    this.changed();
  }

  cancelStroke(): void {
    this.active = null;
    this.renderer.invalidate(false, true);
  }

  // ---------------------------------------------------------------- eraser

  eraseBegin(wx: number, wy: number): void {
    if (!this.canEdit) return;
    this.eraseSnap = new Map();
    this.eraseMove(wx, wy, wx, wy);
  }

  /** Erase along the segment from (fx, fy) to (tx, ty), in world coordinates. */
  eraseMove(fx: number, fy: number, tx: number, ty: number): void {
    if (!this.eraseSnap) return;
    const r = this.prefs.eraserSize;
    const dist = Math.hypot(tx - fx, ty - fy);
    const steps = Math.max(1, Math.ceil(dist / (r * 0.6)));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      this.eraseStep(fx + (tx - fx) * t, fy + (ty - fy) * t, r);
    }
    this.eraserCursor = { x: tx, y: ty, r };
    this.renderer.invalidate(true, true);
  }

  private eraseStep(wx: number, wy: number, r: number): void {
    const snap = this.eraseSnap;
    if (!snap) return;
    if (wy < -r || wy > PAGE_H + r) return;
    const whole = this.prefs.eraserMode === 'stroke';
    for (let i = 0; i < this.nb.pages.length; i++) {
      const px = this.vp.pageX(i);
      if (wx < px - r || wx > px + PAGE_W + r) continue;
      const page = this.nb.pages[i];
      const lx = wx - px;
      let changed = false;
      const next: Stroke[] = [];
      for (const s of page.strokes) {
        if (whole) {
          if (strokeHit(s, lx, wy, r)) changed = true;
          else next.push(s);
        } else {
          const pieces = eraseFromStroke(s, lx, wy, r);
          if (pieces) {
            changed = true;
            next.push(...pieces);
          } else next.push(s);
        }
      }
      if (changed) {
        if (!snap.has(page)) snap.set(page, page.strokes);
        page.strokes = next;
      }
    }
  }

  eraseEnd(): void {
    const snap = this.eraseSnap;
    this.eraseSnap = null;
    this.eraserCursor = null;
    this.renderer.invalidate(true, true);
    if (!snap || snap.size === 0) return;
    const entries = [...snap].map(([page, before]) => ({ page, before, after: page.strokes }));
    this.history.push({
      undo: () => {
        for (const e of entries) e.page.strokes = e.before;
        this.changed();
      },
      redo: () => {
        for (const e of entries) e.page.strokes = e.after;
        this.changed();
      },
    });
    this.changed();
  }

  // ---------------------------------------------------------------- history

  undo(): void {
    if (this.canEdit) this.history.undo();
  }

  redo(): void {
    if (this.canEdit) this.history.redo();
  }

  // ---------------------------------------------------------------- pages

  private applyPages(pages: Page[]): void {
    this.nb.pages = pages;
    this.vp.pages = pages.length;
    this.vp.clamp();
    if (this.vp.isPaged()) this.vp.view = this.vp.viewFor(this.vp.currentPage());
    this.lastPageShown = -1;
    this.viewChanged();
    this.changed();
  }

  private pageListAction(before: Page[], after: Page[]): void {
    this.history.push({ undo: () => this.applyPages(before.slice()), redo: () => this.applyPages(after.slice()) });
  }

  /** Insert a blank page after page `i` and go to it. */
  insertPageAfter(i: number): void {
    if (!this.canEdit) return;
    const before = this.nb.pages.slice();
    const after = before.slice();
    after.splice(i + 1, 0, newPage(this.nb.template));
    this.pageListAction(before, after);
    this.applyPages(after.slice());
    this.goToPage(i + 1);
  }

  duplicatePage(i: number): void {
    if (!this.canEdit) return;
    const src = this.nb.pages[i];
    if (!src) return;
    const before = this.nb.pages.slice();
    const after = before.slice();
    after.splice(i + 1, 0, { template: src.template, strokes: src.strokes.slice() });
    this.pageListAction(before, after);
    this.applyPages(after.slice());
    this.goToPage(i + 1);
    this.ui.toast('Page duplicated');
  }

  deletePage(i: number): void {
    if (!this.canEdit) return;
    const page = this.nb.pages[i];
    if (!page) return;
    if (this.nb.pages.length === 1) {
      if (!page.strokes.length) return;
      const before = page.strokes;
      page.strokes = [];
      this.history.push({
        undo: () => {
          page.strokes = before;
          this.changed();
        },
        redo: () => {
          page.strokes = [];
          this.changed();
        },
      });
      this.changed();
      this.ui.toast('Page cleared', 'Undo', () => this.undo());
      return;
    }
    const before = this.nb.pages.slice();
    const after = before.slice();
    after.splice(i, 1);
    this.pageListAction(before, after);
    this.applyPages(after.slice());
    this.vp.view = this.vp.viewFor(Math.min(i, after.length - 1));
    this.viewChanged();
    this.ui.toast('Page deleted', 'Undo', () => this.undo());
  }

  // ---------------------------------------------------------------- page style

  setTemplate(t: Template, allPages: boolean): void {
    if (!this.canEdit) return;
    const nb = this.nb;
    const targets = allPages ? nb.pages : [nb.pages[this.curPage()]];
    const prev = targets.map((p) => p.template);
    const prevDefault = nb.template;
    const apply = (tpl: Template[], def: Template) => {
      targets.forEach((p, k) => (p.template = tpl[k]));
      nb.template = def;
      this.changed();
    };
    this.history.push({ undo: () => apply(prev, prevDefault), redo: () => apply(targets.map(() => t), t) });
    apply(targets.map(() => t), t);
  }

  setSpacing(level: Spacing): void {
    if (!this.canEdit || level === this.nb.spacing) return;
    const prev = this.nb.spacing;
    const apply = (v: Spacing) => {
      this.nb.spacing = v;
      this.changed();
    };
    this.history.push({ undo: () => apply(prev), redo: () => apply(level) });
    apply(level);
  }

  setPaper(p: Paper): void {
    if (!this.canEdit || p === this.nb.paper) return;
    const prev = this.nb.paper;
    const apply = (v: Paper) => {
      this.nb.paper = v;
      this.changed();
    };
    this.history.push({ undo: () => apply(prev), redo: () => apply(p) });
    apply(p);
  }

  /** Replace an unsupported / foreign note's content with an empty notebook. */
  eraseAndStartNotebook(): void {
    if (this.unsupported === 'newer') return;
    this.nb = freshNotebook();
    this.unsupported = null;
    this.vp.pages = 1;
    this.vp.view = this.vp.viewFor(0);
    this.history.clear();
    this.viewChanged();
    this.changed();
  }

  // ---------------------------------------------------------------- export

  /** Render page `i` to a PNG blob at 2x (about 144 dpi for A4). */
  renderPagePng(i: number, scale = 2): Promise<Blob | null> {
    const page = this.nb.pages[i];
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(PAGE_W * scale);
    canvas.height = Math.round(PAGE_H * scale);
    const ctx = canvas.getContext('2d');
    if (!page || !ctx) return Promise.resolve(null);
    ctx.fillStyle = PAPER_COLOR[this.nb.paper];
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    drawPage(ctx, this.nb, page, scale);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  }

  async exportPagePng(): Promise<void> {
    const i = this.curPage();
    const blob = await this.renderPagePng(i);
    if (!blob) {
      this.ui.toast("Couldn't create the image");
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `notebook-page-${i + 1}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    this.ui.toast(`Page ${i + 1} exported as an image`);
  }
}

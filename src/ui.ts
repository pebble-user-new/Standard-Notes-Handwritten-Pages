// DOM user interface: page navigation bar, tool bar, popovers, page overview and toasts.

import { drawPage } from './draw.ts';
import { ICON, templatePreview } from './icons.ts';
import { PAGE_H, PAGE_W, PAPERS, PAPER_COLOR, TEMPLATES, TEMPLATE_LABEL } from './model.ts';
import type { Spacing } from './model.ts';
import { ERASER_SIZES, HL_COLORS, HL_WIDTHS, PEN_COLORS, PEN_WIDTHS } from './prefs.ts';
import type { TouchMode } from './prefs.ts';
import type { App } from './app.ts';

declare const __VERSION__: string;

type PopKind = 'ink' | 'page' | 'menu';

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  attrs?: Record<string, string>,
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
}

function iconButton(icon: string, label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', `btn ${cls}`.trim(), { type: 'button', 'aria-label': label, title: label });
  b.innerHTML = icon;
  b.addEventListener('click', onClick);
  return b;
}

export class UI {
  private root!: HTMLElement;
  private stageWrap!: HTMLElement;
  private liveCanvas!: HTMLCanvasElement;
  private pop!: HTMLElement;
  private popKind: PopKind | null = null;
  private overview!: HTMLElement;
  private overviewOpen = false;
  private toastEl!: HTMLElement;
  private toastTimer = 0;
  private notice!: HTMLElement;
  private applyAll = false;

  private label!: HTMLButtonElement;
  private prevBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;
  private toolBtns = new Map<string, HTMLButtonElement>();
  private inkBtn!: HTMLButtonElement;
  private inkDot!: HTMLSpanElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private editButtons: HTMLButtonElement[] = [];

  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  build(root: HTMLElement): { stage: HTMLElement; base: HTMLCanvasElement; live: HTMLCanvasElement } {
    this.root = root;
    root.innerHTML = '';
    root.className = 'hp-app';
    const app = this.app;

    // ---- top bar
    this.prevBtn = iconButton(ICON.prev, 'Previous page', () => app.prevPage());
    this.nextBtn = iconButton(ICON.next, 'Next page', () => app.nextPage());
    this.label = h('button', 'page-label', { type: 'button', 'aria-label': 'All pages' });
    this.label.addEventListener('click', () => this.toggleOverview());
    const insert = iconButton(ICON.plus, 'Add page after this one', () => app.insertPageAfter(app.curPage()));
    const overviewBtn = iconButton(ICON.overview, 'All pages', () => this.toggleOverview());
    const styleBtn = iconButton(ICON.pageStyle, 'Page style', () => this.togglePopover('page'));
    const menuBtn = iconButton(ICON.more, 'More', () => this.togglePopover('menu'));
    this.editButtons.push(insert);
    const top = h('header', 'bar top', undefined, this.prevBtn, this.label, this.nextBtn, h('span', 'sp'), insert, overviewBtn, styleBtn, menuBtn);

    // ---- stage
    const base = h('canvas', 'base');
    const live = h('canvas', 'live');
    this.liveCanvas = live;
    const stage = h('div', 'stage', undefined, base, live);
    this.pop = h('div', 'pop hidden');
    this.overview = h('div', 'overview hidden');
    this.toastEl = h('div', 'toast hidden', { role: 'status' });
    this.notice = h('div', 'notice hidden');
    this.stageWrap = h('main', 'stagewrap', undefined, stage, this.pop, this.overview, this.toastEl, this.notice);

    // ---- bottom bar
    const mkTool = (id: 'pen' | 'highlighter' | 'eraser', icon: string, label: string) => {
      const b = iconButton(icon, label, () => {
        if (app.prefs.tool === id) this.togglePopover('ink');
        else {
          app.setTool(id);
          if (this.popKind === 'ink') this.renderPopover();
        }
      });
      b.setAttribute('aria-pressed', 'false');
      this.toolBtns.set(id, b);
      this.editButtons.push(b);
      return b;
    };
    const bottom = h('footer', 'bar bottom');
    bottom.append(mkTool('pen', ICON.pen, 'Pen'), mkTool('highlighter', ICON.highlighter, 'Highlighter'), mkTool('eraser', ICON.eraser, 'Eraser'), h('span', 'sp'));
    this.inkDot = h('span', 'ink-dot');
    this.inkBtn = h('button', 'btn ink-btn', { type: 'button', 'aria-label': 'Colour and size', title: 'Colour and size' }, this.inkDot);
    this.inkBtn.addEventListener('click', () => this.togglePopover('ink'));
    this.undoBtn = iconButton(ICON.undo, 'Undo', () => app.undo());
    this.redoBtn = iconButton(ICON.redo, 'Redo', () => app.redo());
    this.editButtons.push(this.inkBtn, this.undoBtn, this.redoBtn);
    bottom.append(this.inkBtn, this.undoBtn, this.redoBtn);

    root.append(top, this.stageWrap, bottom);
    this.refresh();
    return { stage, base, live };
  }

  setLiveBlend(mode: 'multiply' | 'normal'): void {
    if (this.liveCanvas) this.liveCanvas.style.mixBlendMode = mode;
  }

  // ------------------------------------------------------------------ refresh

  refresh(): void {
    const app = this.app;
    const n = app.nb.pages.length;
    const cur = app.curPage();
    this.label.textContent = `${cur + 1} / ${n}`;
    this.prevBtn.disabled = cur <= 0;
    this.nextBtn.disabled = cur >= n - 1;
    const tool = app.prefs.tool;
    for (const [id, b] of this.toolBtns) b.setAttribute('aria-pressed', String(id === tool));
    this.inkBtn.style.display = '';
    const color = tool === 'eraser' ? '' : app.currentColor();
    this.inkDot.style.background = color || 'transparent';
    this.inkDot.classList.toggle('eraser', tool === 'eraser');
    this.undoBtn.disabled = !app.history.canUndo || !app.canEdit;
    this.redoBtn.disabled = !app.history.canRedo || !app.canEdit;
    for (const b of this.editButtons) {
      if (b === this.undoBtn || b === this.redoBtn) continue;
      b.disabled = !app.canEdit;
    }
    this.root.classList.toggle('locked', app.readOnly);
    this.renderNotice();
    if (this.popKind) this.renderPopover();
    if (this.overviewOpen) this.renderOverview();
  }

  private renderNotice(): void {
    const app = this.app;
    const el = this.notice;
    el.innerHTML = '';
    if (!app.unsupported) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    if (app.unsupported === 'newer') {
      el.append(
        h('h2', undefined, undefined, 'Newer notebook format'),
        h('p', undefined, undefined, 'This note was saved by a newer version of Handwritten Pages. Update the plugin to open it. Nothing has been changed.'),
      );
      return;
    }
    const msg =
      app.unsupported === 'corrupt'
        ? "This note looks like a Handwritten Pages notebook, but its data couldn't be read."
        : "This note isn't a Handwritten Pages notebook, so opening it here could overwrite its text.";
    // two taps instead of window.confirm(), which sandboxed iframes may block
    const btn = h('button', 'primary', { type: 'button' }, 'Erase note and start a notebook');
    let armed = false;
    btn.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        btn.textContent = 'Tap again to erase the note’s text';
        window.setTimeout(() => {
          armed = false;
          btn.textContent = 'Erase note and start a notebook';
        }, 4000);
        return;
      }
      app.eraseAndStartNotebook();
    });
    el.append(h('h2', undefined, undefined, 'Can’t open this note'), h('p', undefined, undefined, msg), h('p', 'muted', undefined, 'Switch the note back to another editor to keep its content.'), btn);
  }

  // ------------------------------------------------------------------ toast

  toast(msg: string, actionLabel?: string, action?: () => void): void {
    const el = this.toastEl;
    el.innerHTML = '';
    el.append(h('span', undefined, undefined, msg));
    if (actionLabel && action) {
      const b = h('button', undefined, { type: 'button' }, actionLabel);
      b.addEventListener('click', () => {
        action();
        el.classList.add('hidden');
      });
      el.append(b);
    }
    el.classList.remove('hidden');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.add('hidden'), actionLabel ? 5000 : 2600);
  }

  // ------------------------------------------------------------------ popovers

  closePopovers(): void {
    this.popKind = null;
    this.pop.classList.add('hidden');
    this.pop.innerHTML = '';
    if (this.overviewOpen) this.toggleOverview(false);
  }

  private togglePopover(kind: PopKind): void {
    if (this.overviewOpen) this.toggleOverview(false);
    if (this.popKind === kind) {
      this.closePopovers();
      return;
    }
    this.popKind = kind;
    this.renderPopover();
  }

  private renderPopover(): void {
    const kind = this.popKind;
    if (!kind) return;
    const pop = this.pop;
    pop.innerHTML = '';
    pop.className = `pop ${kind}`;
    if (kind === 'ink') this.renderInk(pop);
    else if (kind === 'page') this.renderPageStyle(pop);
    else this.renderMenu(pop);
  }

  private seg<T extends string | number>(items: { value: T; label: string }[], current: T, onPick: (v: T) => void): HTMLElement {
    const wrap = h('div', 'seg');
    for (const it of items) {
      const b = h('button', undefined, { type: 'button', 'aria-pressed': String(it.value === current) }, it.label);
      b.addEventListener('click', () => onPick(it.value));
      wrap.append(b);
    }
    return wrap;
  }

  private renderInk(pop: HTMLElement): void {
    const app = this.app;
    const tool = app.prefs.tool;
    if (tool === 'eraser') {
      pop.append(
        h('div', 'pop-title', undefined, 'Eraser'),
        this.seg(
          [
            { value: 'split', label: 'Rub out' },
            { value: 'stroke', label: 'Whole stroke' },
          ],
          app.prefs.eraserMode,
          (v) => app.setEraserMode(v),
        ),
      );
    } else {
      const colors = tool === 'highlighter' ? HL_COLORS : PEN_COLORS;
      const row = h('div', 'swatches');
      for (const c of colors) {
        const b = h('button', 'swatch', { type: 'button', 'aria-label': `Colour ${c}`, 'aria-pressed': String(c === app.currentColor()) });
        b.style.background = c;
        b.addEventListener('click', () => app.setColor(c));
        row.append(b);
      }
      pop.append(h('div', 'pop-title', undefined, tool === 'highlighter' ? 'Highlighter' : 'Pen'), row);
    }
    const sizes = tool === 'highlighter' ? HL_WIDTHS : tool === 'eraser' ? ERASER_SIZES : PEN_WIDTHS;
    const row = h('div', 'sizes');
    for (const w of sizes) {
      const b = h('button', 'size', { type: 'button', 'aria-label': `Size ${w}`, 'aria-pressed': String(w === app.currentWidth()) });
      const mark = h('span', tool === 'eraser' ? 'mark round' : 'mark');
      const px = tool === 'eraser' ? Math.min(30, w * 1.6) : Math.max(2, Math.min(22, w * (tool === 'highlighter' ? 1.2 : 2.4)));
      mark.style.height = `${px}px`;
      if (tool === 'eraser') mark.style.width = `${px}px`;
      else if (tool === 'highlighter') mark.style.background = app.prefs.hlColor;
      b.append(mark);
      b.addEventListener('click', () => app.setWidth(w));
      row.append(b);
    }
    pop.append(row);
  }

  private renderPageStyle(pop: HTMLElement): void {
    const app = this.app;
    const nb = app.nb;
    const cur = nb.pages[app.curPage()];
    pop.append(h('div', 'pop-title', undefined, `Page ${app.curPage() + 1} style`));

    const tiles = h('div', 'tiles');
    for (const t of TEMPLATES) {
      const b = h('button', 'tile', { type: 'button', 'aria-pressed': String(cur?.template === t) });
      b.innerHTML = templatePreview(t);
      b.append(h('span', undefined, undefined, TEMPLATE_LABEL[t]));
      b.addEventListener('click', () => app.setTemplate(t, this.applyAll));
      tiles.append(b);
    }
    pop.append(tiles);

    const allWrap = h('label', 'check');
    const cb = h('input', undefined, { type: 'checkbox' });
    cb.checked = this.applyAll;
    cb.addEventListener('change', () => {
      this.applyAll = cb.checked;
      if (this.applyAll && cur) app.setTemplate(cur.template, true);
    });
    allWrap.append(cb, h('span', undefined, undefined, 'Apply paper style to all pages'));
    pop.append(allWrap);

    pop.append(
      h('div', 'pop-sub', undefined, 'Line spacing'),
      this.seg<Spacing>(
        [
          { value: 0, label: 'Narrow' },
          { value: 1, label: 'Medium' },
          { value: 2, label: 'Wide' },
        ],
        nb.spacing,
        (v) => app.setSpacing(v),
      ),
    );

    const paperRow = h('div', 'swatches');
    for (const p of PAPERS) {
      const b = h('button', 'swatch paper', { type: 'button', 'aria-label': `${p} paper`, 'aria-pressed': String(nb.paper === p) });
      b.style.background = PAPER_COLOR[p];
      b.addEventListener('click', () => app.setPaper(p));
      paperRow.append(b);
    }
    pop.append(h('div', 'pop-sub', undefined, 'Paper'), paperRow);

    const actions = h('div', 'actions');
    const dup = h('button', undefined, { type: 'button' });
    dup.innerHTML = `${ICON.copy}<span>Duplicate page</span>`;
    dup.addEventListener('click', () => {
      this.closePopovers();
      app.duplicatePage(app.curPage());
    });
    const del = h('button', 'danger', { type: 'button' });
    del.innerHTML = `${ICON.trash}<span>${nb.pages.length === 1 ? 'Clear page' : 'Delete page'}</span>`;
    del.addEventListener('click', () => {
      this.closePopovers();
      app.deletePage(app.curPage());
    });
    actions.append(dup, del);
    if (!app.canEdit) for (const b of [dup, del]) b.disabled = true;
    pop.append(actions);
  }

  private renderMenu(pop: HTMLElement): void {
    const app = this.app;
    pop.append(
      h('div', 'pop-title', undefined, 'Touch input'),
      this.seg<TouchMode>(
        [
          { value: 'auto', label: 'Auto' },
          { value: 'draw', label: 'Fingers draw' },
          { value: 'scroll', label: 'Pen only' },
        ],
        app.prefs.touch,
        (v) => app.setTouchMode(v),
      ),
      h(
        'p',
        'muted',
        undefined,
        app.prefs.touch === 'auto'
          ? app.prefs.penSeen
            ? 'A stylus has been used on this device, so fingers scroll and zoom while the pen draws.'
            : 'Fingers draw until a stylus is used, then only the pen draws.'
          : app.prefs.touch === 'draw'
            ? 'One finger draws; two fingers pinch to zoom and swipe to turn pages.'
            : 'Only a pen or mouse draws; one finger scrolls and swipes between pages.',
      ),
    );
    const img = h('button', 'row', { type: 'button' });
    img.innerHTML = `${ICON.image}<span>Save this page as an image</span>`;
    img.addEventListener('click', () => {
      this.closePopovers();
      void app.exportPagePng();
    });
    const fit = h('button', 'row', { type: 'button' });
    fit.innerHTML = `${ICON.overview}<span>Fit page to screen</span>`;
    fit.addEventListener('click', () => {
      this.closePopovers();
      app.fitPage();
    });
    pop.append(fit, img);
    pop.append(
      h('p', 'muted small', undefined, 'Pinch to zoom out and see several pages; tap one to open it. Swipe sideways to turn the page.'),
      h('p', 'muted small', undefined, `Handwritten Pages v${typeof __VERSION__ === 'string' ? __VERSION__ : 'dev'}`),
    );
  }

  // ------------------------------------------------------------------ overview

  private toggleOverview(force?: boolean): void {
    const open = force ?? !this.overviewOpen;
    if (open === this.overviewOpen) return;
    this.overviewOpen = open;
    if (open) {
      this.popKind = null;
      this.pop.classList.add('hidden');
      this.overview.classList.remove('hidden');
      this.renderOverview();
    } else {
      this.overview.classList.add('hidden');
      this.overview.innerHTML = '';
    }
  }

  private renderOverview(): void {
    const app = this.app;
    const grid = h('div', 'grid');
    const thumbs: { canvas: HTMLCanvasElement; index: number }[] = [];
    const cur = app.curPage();
    app.nb.pages.forEach((_, i) => {
      const canvas = h('canvas');
      const tile = h('button', 'thumb', { type: 'button', 'aria-label': `Page ${i + 1}`, 'aria-pressed': String(i === cur) }, canvas, h('span', undefined, undefined, String(i + 1)));
      tile.addEventListener('click', () => {
        this.toggleOverview(false);
        app.goToPage(i);
      });
      grid.append(tile);
      thumbs.push({ canvas, index: i });
    });
    const add = h('button', 'thumb add', { type: 'button', 'aria-label': 'Add page at the end' });
    add.innerHTML = `<div class="addbox">${ICON.plus}</div><span>Add page</span>`;
    add.disabled = !app.canEdit;
    add.addEventListener('click', () => {
      this.toggleOverview(false);
      app.insertPageAfter(app.nb.pages.length - 1);
    });
    grid.append(add);
    const scroller = h('div', 'overview-scroll', undefined, grid);
    this.overview.innerHTML = '';
    this.overview.append(scroller);

    // draw thumbnails a few per frame so a long notebook opens instantly
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = 110;
    let k = 0;
    const work = () => {
      if (!this.overviewOpen || !this.overview.contains(scroller)) return;
      for (let n = 0; n < 4 && k < thumbs.length; n++, k++) {
        const { canvas, index } = thumbs[k];
        const w = Math.round(cssW * dpr);
        canvas.width = w;
        canvas.height = Math.round((w * PAGE_H) / PAGE_W);
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        const sc = w / PAGE_W;
        ctx.scale(sc, sc);
        drawPage(ctx, app.nb, app.nb.pages[index], sc);
      }
      if (k < thumbs.length) requestAnimationFrame(work);
    };
    requestAnimationFrame(work);
    const curTile = grid.children[cur] as HTMLElement | undefined;
    curTile?.scrollIntoView({ block: 'center' });
  }
}

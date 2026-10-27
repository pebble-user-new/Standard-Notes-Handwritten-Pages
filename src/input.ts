// Pointer handling. One pointer draws (pen, mouse, or a finger when touch-drawing is on);
// two touches pinch/pan; a single finger pans when it isn't drawing. Swipes at "fit" zoom turn pages.

import { PAGE_GAP } from './model.ts';
import type { App } from './app.ts';

type Mode = 'idle' | 'draw' | 'erase' | 'pan' | 'gesture';

interface Ptr {
  id: number;
  type: string;
  x: number;
  y: number;
  startX: number;
  startY: number;
  startT: number;
  ignored: boolean;
  /** a resting palm: never counts for anything, not even multi-finger taps */
  palm?: boolean;
}

interface Sample {
  t: number;
  x: number;
  y: number;
}

/** A second finger landing within this time of the first cancels a finger stroke and starts a pinch. */
const PINCH_GRACE_MS = 350;
const TAP_MOVE_PX = 8;
const TAP_MS = 300;
/** two quick finger taps this close in time and place toggle focus mode */
const DOUBLE_TAP_MS = 380;
const DOUBLE_TAP_PX = 48;
/** touches this soon after the stylus was last near the screen are treated as the resting palm */
const PEN_NEAR_MS = 700;
/** a touch whose contact patch is at least this big (CSS px, about 10 mm) is a palm, not a finger */
const PALM_CONTACT_PX = 64;
/** a two- / three-finger tap: all fingers down and up within this time, barely moving */
const MULTI_TAP_MS = 400;
const MULTI_TAP_MOVE_PX = 14;

export class Input {
  private ptrs = new Map<number, Ptr>();
  private mode: Mode = 'idle';
  private mainId = -1;
  private strokeStart = 0;
  private lastErase = { x: 0, y: 0 };
  private samples: Sample[] = [];
  private gest = { d: 1, s: 1, wx: 0, wy: 0 };
  private startPage = 0;
  private spaceDown = false;
  private wheelAccum = 0;
  private lastTap = { t: 0, x: 0, y: 0 };
  private wheelCooldown = 0;
  private lastPenT = -1e9;
  /** the current run of touches: when it began, the most fingers down together, how far any moved */
  private multi = { t: 0, n: 0, moved: 0 };

  private app: App;
  private el: HTMLElement;

  constructor(app: App, el: HTMLElement) {
    this.app = app;
    this.el = el;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e, false));
    el.addEventListener('pointercancel', (e) => this.up(e, true));
    el.addEventListener('lostpointercapture', (e) => {
      if (this.ptrs.has(e.pointerId) && !e.buttons) this.up(e, true);
    });
    el.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.key(e, true));
    window.addEventListener('keyup', (e) => this.key(e, false));
  }

  /** True while a stroke, erase or gesture is in progress. */
  get busy(): boolean {
    return this.mode !== 'idle';
  }

  private local(e: PointerEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ------------------------------------------------------------------ pointer events

  /** Is this touch a resting palm (or a knuckle) rather than a finger? */
  private isPalm(e: PointerEvent): boolean {
    if (e.pointerType !== 'touch' || !this.app.prefs.palm) return false;
    if (Math.max(e.width, e.height) >= PALM_CONTACT_PX) return true;
    const penDown = [...this.ptrs.values()].some((q) => q.type === 'pen');
    return penDown || performance.now() - this.lastPenT < PEN_NEAR_MS;
  }

  private down(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button > 2) return;
    if (e.pointerType === 'pen') this.lastPenT = performance.now();
    const app = this.app;
    if (this.isPalm(e)) {
      // swallow it: it never draws, pans, pinches or counts as a tap, and stays ignored until it lifts
      try {
        this.el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      e.preventDefault();
      const { x, y } = this.local(e);
      this.ptrs.set(e.pointerId, { id: e.pointerId, type: 'touch', x, y, startX: x, startY: y, startT: performance.now(), ignored: true, palm: true });
      return;
    }
    app.camera.stop();
    app.ui.closePopovers();
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    e.preventDefault();
    const { x, y } = this.local(e);
    const p: Ptr = { id: e.pointerId, type: e.pointerType, x, y, startX: x, startY: y, startT: performance.now(), ignored: false };
    if (e.pointerType === 'pen') app.notePenSeen();
    this.ptrs.set(p.id, p);
    if (p.type === 'touch') {
      const n = this.activeTouches();
      if (n <= 1) this.multi = { t: performance.now(), n: 1, moved: 0 };
      else this.multi.n = Math.max(this.multi.n, n);
    }

    switch (this.mode) {
      case 'idle':
        this.begin(e, p);
        break;
      case 'draw': {
        const main = this.ptrs.get(this.mainId);
        if (p.type === 'pen' && main && main.type === 'touch') {
          // a stylus arrived while a finger/palm was drawing: the pen wins
          app.cancelStroke();
          main.ignored = true;
          this.mode = 'idle';
          this.begin(e, p);
        } else if (p.type === 'touch' && main && main.type === 'touch' && performance.now() - this.strokeStart < PINCH_GRACE_MS) {
          // second finger right after the first: it was a pinch, not a stroke
          app.cancelStroke();
          main.startT = 0;
          this.mode = 'idle';
          this.startPage = app.curPage();
          this.startGesture();
        } else {
          p.ignored = true;
        }
        break;
      }
      case 'pan':
      case 'gesture':
        if (p.type === 'pen' && app.prefs.palm) {
          // the stylus came down while fingers were scrolling: they were a palm, so the pen wins
          for (const q of this.ptrs.values()) if (q.type === 'touch') q.ignored = true;
          app.camera.release(0, 0, this.startPage);
          this.mode = 'idle';
          this.begin(e, p);
        } else if (p.type === 'touch' && this.mode === 'pan') this.startGesture();
        else p.ignored = true;
        break;
      default:
        p.ignored = true;
    }
  }

  private begin(e: PointerEvent, p: Ptr): void {
    const app = this.app;
    const vp = app.vp;
    this.startPage = app.curPage();
    const mousePan = p.type === 'mouse' && (e.button === 1 || e.button === 2 || this.spaceDown);
    const erasing = app.prefs.tool === 'eraser' || (p.type === 'pen' && (e.buttons & 32) !== 0);
    const canDraw = app.canEdit && !mousePan && !vp.isOverview() && app.pointerDraws(p.type);
    const w = vp.toWorld(p.x, p.y);
    const pageIndex = vp.pageAtWorld(w.x, w.y);
    this.samples = [{ t: performance.now(), x: p.x, y: p.y }];
    this.mainId = p.id;

    if (canDraw && erasing) {
      this.mode = 'erase';
      this.lastErase = w;
      app.eraseBegin(w.x, w.y);
    } else if (canDraw && pageIndex >= 0) {
      this.mode = 'draw';
      this.strokeStart = performance.now();
      const pressure = p.type === 'pen' && e.pressure > 0 ? e.pressure : null;
      app.beginStroke(pageIndex, w.x - vp.pageX(pageIndex), w.y, pressure, p.type);
    } else {
      this.mode = 'pan';
    }
  }

  private move(e: PointerEvent): void {
    if (e.pointerType === 'pen') this.lastPenT = performance.now();
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    const app = this.app;
    const vp = app.vp;
    const prevX = p.x;
    const prevY = p.y;
    const { x, y } = this.local(e);
    p.x = x;
    p.y = y;
    if (p.type === 'touch' && !p.palm) this.multi.moved = Math.max(this.multi.moved, Math.hypot(x - p.startX, y - p.startY));
    if (p.ignored) return;

    switch (this.mode) {
      case 'draw': {
        if (p.id !== this.mainId || !app.active) return;
        const pageX = vp.pageX(app.active.pageIndex);
        const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
        const list = evs.length ? evs : [e];
        const r = this.el.getBoundingClientRect();
        for (const ev of list) {
          const w = vp.toWorld(ev.clientX - r.left, ev.clientY - r.top);
          const pressure = p.type === 'pen' && ev.pressure > 0 ? ev.pressure : null;
          app.extendStroke(w.x - pageX, w.y, pressure);
        }
        break;
      }
      case 'erase': {
        if (p.id !== this.mainId) return;
        const w = vp.toWorld(x, y);
        app.eraseMove(this.lastErase.x, this.lastErase.y, w.x, w.y);
        this.lastErase = w;
        break;
      }
      case 'pan': {
        if (p.id !== this.mainId) return;
        vp.panBy(x - prevX, y - prevY);
        this.sample(x, y);
        app.viewChanged();
        break;
      }
      case 'gesture':
        this.applyGesture();
        break;
      default:
    }
  }

  private up(e: PointerEvent, cancelled: boolean): void {
    if (e.pointerType === 'pen') this.lastPenT = performance.now();
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    this.ptrs.delete(e.pointerId);
    const app = this.app;
    if (p.type === 'touch' && !p.palm && !cancelled && this.activeTouches() === 0) this.multiTap();
    if (p.ignored) return;

    switch (this.mode) {
      case 'draw':
        if (p.id === this.mainId) {
          if (cancelled && p.type === 'touch') {
            app.cancelStroke();
          } else if (!cancelled && this.isFingerTap(p) && this.multi.n < 2) {
            // a quick finger tap isn't ink (so a double-tap can't leave dots); two of them toggle focus mode
            app.cancelStroke();
            this.fingerTap(p.x, p.y);
          } else {
            app.endStroke();
          }
          this.finishSingle();
        }
        break;
      case 'erase':
        if (p.id === this.mainId) {
          app.eraseEnd();
          this.finishSingle();
        }
        break;
      case 'pan':
        if (p.id === this.mainId) {
          const tap = !cancelled && p.type !== 'pen' && this.multi.n < 2 && Math.hypot(p.x - p.startX, p.y - p.startY) < TAP_MOVE_PX && performance.now() - p.startT < TAP_MS;
          if (tap && app.vp.isOverview()) {
            this.tapOverview(p.x, p.y);
          } else {
            if (tap && p.type === 'touch') this.fingerTap(p.x, p.y);
            const v = this.velocity();
            app.camera.release(v.x, v.y, this.startPage);
          }
          this.finishSingle();
        }
        break;
      case 'gesture': {
        const rest = [...this.ptrs.values()].filter((q) => !q.ignored && q.type === 'touch');
        if (rest.length >= 2) {
          this.startGesture();
        } else if (rest.length === 1) {
          this.mode = 'pan';
          this.mainId = rest[0].id;
          this.samples = [{ t: performance.now(), x: rest[0].x, y: rest[0].y }];
        } else {
          const v = this.velocity();
          app.camera.release(v.x, v.y, this.startPage);
          this.finishSingle();
        }
        break;
      }
      default:
    }
  }

  /** Back to idle; any pointers still down (a palm, say) are ignored until they lift. */
  private finishSingle(): void {
    this.mode = 'idle';
    this.mainId = -1;
    for (const q of this.ptrs.values()) q.ignored = true;
  }

  private activeTouches(): number {
    let n = 0;
    for (const q of this.ptrs.values()) if (q.type === 'touch' && !q.palm) n++;
    return n;
  }

  /** All fingers just lifted: a quick, still two-finger tap is undo, three fingers is redo. */
  private multiTap(): void {
    const m = this.multi;
    const quick = performance.now() - m.t < MULTI_TAP_MS && m.moved < MULTI_TAP_MOVE_PX;
    const n = m.n;
    this.multi = { t: 0, n: 0, moved: 0 };
    if (!quick || n < 2 || !this.app.canEdit) return;
    window.clearTimeout(this.tapTimer);
    this.lastTap = { t: 0, x: 0, y: 0 };
    if (n === 2) this.app.undoTap();
    else this.app.redoTap();
  }

  private isFingerTap(p: Ptr): boolean {
    return p.type === 'touch' && Math.hypot(p.x - p.startX, p.y - p.startY) < TAP_MOVE_PX && performance.now() - p.startT < TAP_MS;
  }

  private tapTimer = 0;

  /**
   * A finger tap: two quick ones toggle focus mode. In focus mode a single tap shows / hides the
   * toolbars; that waits out the double-tap window so the second tap of a double-tap can never land
   * on a toolbar button that the first tap just revealed.
   */
  private fingerTap(x: number, y: number): void {
    window.clearTimeout(this.tapTimer);
    if (this.registerTap(x, y)) {
      this.app.toggleFocus();
    } else if (this.app.focus) {
      this.tapTimer = window.setTimeout(() => this.app.togglePeek(), DOUBLE_TAP_MS);
    }
  }

  /** Records a finger tap; true when it completes a double-tap. */
  private registerTap(x: number, y: number): boolean {
    const now = performance.now();
    const t = this.lastTap;
    if (now - t.t < DOUBLE_TAP_MS && Math.hypot(x - t.x, y - t.y) < DOUBLE_TAP_PX) {
      this.lastTap = { t: 0, x: 0, y: 0 };
      return true;
    }
    this.lastTap = { t: now, x, y };
    return false;
  }

  private tapOverview(px: number, py: number): void {
    const vp = this.app.vp;
    const w = vp.toWorld(px, py);
    const i = vp.pageAtWorld(w.x, w.y, PAGE_GAP / 2);
    if (i >= 0) this.app.goToPage(i);
    else this.app.camera.release(0, 0, this.startPage);
  }

  // ------------------------------------------------------------------ gestures

  private touches(): Ptr[] {
    return [...this.ptrs.values()].filter((q) => !q.ignored && q.type === 'touch').slice(0, 2);
  }

  private startGesture(): void {
    const t = this.touches();
    if (t.length < 2) return;
    const vp = this.app.vp;
    const cx = (t[0].x + t[1].x) / 2;
    const cy = (t[0].y + t[1].y) / 2;
    const w = vp.toWorld(cx, cy);
    this.gest = { d: Math.max(1, Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y)), s: vp.s, wx: w.x, wy: w.y };
    this.mode = 'gesture';
    this.samples = [{ t: performance.now(), x: cx, y: cy }];
  }

  private applyGesture(): void {
    const t = this.touches();
    if (t.length < 2) return;
    const vp = this.app.vp;
    const cx = (t[0].x + t[1].x) / 2;
    const cy = (t[0].y + t[1].y) / 2;
    const d = Math.max(1, Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y));
    const s = Math.max(vp.minScale(), Math.min(vp.maxScale(), this.gest.s * (d / this.gest.d)));
    // keep the world point that started under the fingers' midpoint under them now
    vp.view = vp.clampView({ s, tx: cx - this.gest.wx * s, ty: cy - this.gest.wy * s });
    this.sample(cx, cy);
    this.app.viewChanged();
  }

  private sample(x: number, y: number): void {
    const now = performance.now();
    this.samples.push({ t: now, x, y });
    while (this.samples.length > 2 && now - this.samples[0].t > 100) this.samples.shift();
  }

  /** Fling velocity in px/ms over the last ~100 ms. */
  private velocity(): { x: number; y: number } {
    const s = this.samples;
    if (s.length < 2) return { x: 0, y: 0 };
    const a = s[0];
    const b = s[s.length - 1];
    const dt = b.t - a.t;
    if (dt < 1 || performance.now() - b.t > 80) return { x: 0, y: 0 };
    return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
  }

  // ------------------------------------------------------------------ wheel / trackpad

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const app = this.app;
    const vp = app.vp;
    app.camera.stop();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vp.vh : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    const r = this.el.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      // pinch on a trackpad (ctrl+wheel) or ctrl+scroll: zoom about the pointer
      vp.zoomAt(e.clientX - r.left, e.clientY - r.top, vp.s * Math.exp(-dy * 0.01));
      app.viewChanged();
      this.settleSoon();
      return;
    }
    const horizontal = e.shiftKey ? dy : Math.abs(dx) > Math.abs(dy) * 1.2 ? dx : 0;
    if (vp.isPaged() && horizontal) {
      // at fit zoom a horizontal swipe turns the page
      const now = performance.now();
      if (now < this.wheelCooldown) return;
      this.wheelAccum += horizontal;
      if (Math.abs(this.wheelAccum) > 60) {
        app.goToPage(app.curPage() + (this.wheelAccum > 0 ? 1 : -1));
        this.wheelAccum = 0;
        this.wheelCooldown = now + 450;
      }
      return;
    }
    this.wheelAccum = 0;
    if (e.shiftKey) vp.panBy(-dy, 0);
    else vp.panBy(-dx, -dy);
    app.viewChanged();
    this.settleSoon();
  }

  private settleTimer = 0;

  /** After a burst of wheel zooming, snap back to a whole page if we ended near "fit". */
  private settleSoon(): void {
    window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      const vp = this.app.vp;
      if (vp.isPaged() && this.mode === 'idle') this.app.camera.animateTo(vp.viewFor(vp.currentPage()), 180);
    }, 220);
  }

  // ------------------------------------------------------------------ keyboard

  private key(e: KeyboardEvent, down: boolean): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === ' ') {
      // hold Space to pan with the mouse; don't let it "click" a focused toolbar button
      if (t && t.tagName === 'BUTTON') t.blur();
      e.preventDefault();
      this.spaceDown = down;
      return;
    }
    if (!down) return;
    const app = this.app;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) app.redo();
      else app.undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      app.redo();
    } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      app.nextPage();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      app.prevPage();
    } else if (!mod && e.key === '0') {
      app.fitPage();
    } else if (!mod && e.key.toLowerCase() === 'f') {
      app.toggleFocus();
    } else if (e.key === 'Escape' && app.focus) {
      app.setFocus(false);
    } else if (!mod && e.key.toLowerCase() === 'p') {
      app.setTool('pen');
    } else if (!mod && e.key.toLowerCase() === 'h') {
      app.setTool('highlighter');
    } else if (!mod && e.key.toLowerCase() === 'e') {
      app.setTool('eraser');
    }
  }
}

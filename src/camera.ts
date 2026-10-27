// View animation: eased moves between views, momentum after a pan, and the "release" logic
// that snaps to a page / turns the page when a swipe ends at fit zoom.

import { PAGE_GAP } from './model.ts';
import type { View } from './viewport.ts';
import type { App } from './app.ts';

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/** px/ms fling speed that counts as a deliberate page-turning flick */
const FLICK_SPEED = 0.35;
/** fraction of the screen width a drag must cover to turn the page without a flick */
const TURN_FRACTION = 0.2;

export class Camera {
  private raf = 0;
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  get busy(): boolean {
    return this.raf !== 0;
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  animateTo(target: View, ms = 240): void {
    this.stop();
    const vp = this.app.vp;
    const goal = vp.clampView(target);
    const from = vp.view;
    if (Math.abs(goal.s - from.s) < 1e-6 && Math.abs(goal.tx - from.tx) < 0.5 && Math.abs(goal.ty - from.ty) < 0.5) {
      vp.view = goal;
      this.app.viewChanged();
      return;
    }
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      const e = easeOutCubic(t);
      vp.view = {
        s: from.s + (goal.s - from.s) * e,
        tx: from.tx + (goal.tx - from.tx) * e,
        ty: from.ty + (goal.ty - from.ty) * e,
      };
      this.app.viewChanged();
      this.raf = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this.raf = requestAnimationFrame(step);
  }

  /** Momentum scrolling after a pan (velocities in px/ms). */
  fling(vx: number, vy: number): void {
    this.stop();
    if (Math.hypot(vx, vy) < 0.05) return;
    const vp = this.app.vp;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(48, now - last);
      last = now;
      const decay = Math.pow(0.003, dt / 1000);
      vx *= decay;
      vy *= decay;
      const before = vp.view;
      vp.panBy(vx * dt, vy * dt);
      this.app.viewChanged();
      const moved = Math.abs(vp.tx - before.tx) + Math.abs(vp.ty - before.ty);
      if (Math.hypot(vx, vy) > 0.02 && moved > 0.05) {
        this.raf = requestAnimationFrame(step);
      } else {
        this.raf = 0;
        this.snapZoomed(0);
      }
    };
    this.raf = requestAnimationFrame(step);
  }

  /**
   * When zoomed in and scrolled sideways past a page edge, two pages can be on screen with a gap between.
   * Settle on one of them (the one with more showing, or the flick direction), aligned to its edge.
   * Returns true if an animation was started.
   */
  private snapZoomed(vx: number): boolean {
    const vp = this.app.vp;
    if (vp.ratio() <= 1.06) return false;
    const s = vp.s;
    const x0 = -vp.tx / s;
    const x1 = (vp.vw - vp.tx) / s;
    // find a page boundary that is currently inside the viewport (a gap, or an edge showing)
    for (let i = 0; i < vp.pages - 1; i++) {
      const rightEdge = vp.pageX(i) + vp.pageW;
      const nextLeft = vp.pageX(i + 1);
      if (x0 < rightEdge && x1 > nextLeft) {
        const showingPrev = (rightEdge - x0) * s;
        const showingNext = (x1 - nextLeft) * s;
        const goNext = vx < -FLICK_SPEED ? true : vx > FLICK_SPEED ? false : showingNext > showingPrev;
        const edge = 8;
        const tx = goNext ? edge - nextLeft * s : vp.vw - edge - rightEdge * s;
        this.animateTo({ s, tx, ty: vp.ty }, 240);
        return true;
      }
    }
    return false;
  }

  /** Called when a pan / pinch ends. `startPage` is the page that was showing when it began. */
  release(vx: number, vy: number, startPage: number): void {
    const vp = this.app.vp;
    if (vp.isPaged()) {
      let target = vp.currentPage();
      const offset = (vp.centerX() - (vp.pageX(startPage) + vp.pageW / 2)) * vp.s; // screen px the page was dragged
      if (target === startPage) {
        if (vx < -FLICK_SPEED || offset > TURN_FRACTION * vp.vw) target = startPage + 1;
        else if (vx > FLICK_SPEED || offset < -TURN_FRACTION * vp.vw) target = startPage - 1;
      }
      // swiping on from the last page: it stays put, but offer a new one
      if (target > vp.pages - 1) this.app.offerNewPage();
      target = Math.max(0, Math.min(vp.pages - 1, target));
      this.animateTo(vp.viewFor(target), 260);
      return;
    }
    if (this.snapZoomed(vx)) return;
    this.fling(vx, vy);
  }

  /** Go to page `i`. When zoomed in, keep the zoom and start at the top of that page. */
  goToPage(i: number): void {
    const vp = this.app.vp;
    const target = Math.max(0, Math.min(vp.pages - 1, i));
    if (vp.ratio() > 1.06) {
      const cur = vp.currentPage();
      const shift = (target - cur) * (vp.pageW + PAGE_GAP) * vp.s;
      this.animateTo({ s: vp.s, tx: vp.tx - shift, ty: 24 }, 260);
    } else {
      this.animateTo(vp.viewFor(target), 260);
    }
  }
}

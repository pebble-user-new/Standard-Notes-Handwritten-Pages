// Two stacked canvases: `base` holds the pages (paper + committed ink) and is redrawn when the
// view or content changes; `live` holds only the stroke being drawn and the eraser cursor, so
// drawing latency doesn't depend on how much is already on the page.

import { drawPaper, drawStroke, drawStrokes } from './draw.ts';
import { PAGE_H, PAGE_W, PAPER_COLOR } from './model.ts';
import type { App } from './app.ts';

export class Renderer {
  private base: CanvasRenderingContext2D;
  private live: CanvasRenderingContext2D;
  private dpr = 1;
  private raf = 0;
  private baseDirty = true;
  private liveDirty = true;
  /** last frame timings, exposed for tests / perf checks */
  lastBaseMs = 0;

  private app: App;
  private baseCanvas: HTMLCanvasElement;
  private liveCanvas: HTMLCanvasElement;

  constructor(app: App, baseCanvas: HTMLCanvasElement, liveCanvas: HTMLCanvasElement) {
    this.app = app;
    this.baseCanvas = baseCanvas;
    this.liveCanvas = liveCanvas;
    this.base = baseCanvas.getContext('2d', { alpha: true }) as CanvasRenderingContext2D;
    this.live = liveCanvas.getContext('2d', { alpha: true }) as CanvasRenderingContext2D;
  }

  resize(w: number, h: number): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    for (const c of [this.baseCanvas, this.liveCanvas]) {
      c.width = Math.max(1, Math.round(w * this.dpr));
      c.height = Math.max(1, Math.round(h * this.dpr));
    }
    this.invalidate();
  }

  invalidate(base = true, live = true): void {
    this.baseDirty ||= base;
    this.liveDirty ||= live;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }

  /** Draw synchronously (used by tests and screenshots to avoid waiting on rAF). */
  flush(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.frame();
  }

  private frame(): void {
    this.raf = 0;
    if (this.baseDirty) {
      const t0 = performance.now();
      this.drawBase();
      this.lastBaseMs = performance.now() - t0;
      this.baseDirty = false;
    }
    if (this.liveDirty) {
      this.drawLive();
      this.liveDirty = false;
    }
  }

  private drawBase(): void {
    const { vp, nb } = this.app;
    const ctx = this.base;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.baseCanvas.width, this.baseCanvas.height);
    const k = vp.s * dpr;
    const x0 = -vp.tx / vp.s;
    const x1 = (vp.vw - vp.tx) / vp.s;
    const y0 = -vp.ty / vp.s;
    const y1 = (vp.vh - vp.ty) / vp.s;
    const showNumbers = vp.ratio() < 0.9;
    for (let i = 0; i < nb.pages.length; i++) {
      const px = vp.pageX(i);
      if (px + PAGE_W < x0 || px > x1) continue;
      const page = nb.pages[i];
      ctx.setTransform(k, 0, 0, k, vp.tx * dpr, vp.ty * dpr);
      ctx.save();
      ctx.translate(px, 0);
      // paper with a soft shadow (shadow sizes are in device pixels, unaffected by the transform)
      ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
      ctx.shadowBlur = 10 * dpr;
      ctx.shadowOffsetY = 2 * dpr;
      ctx.fillStyle = PAPER_COLOR[nb.paper];
      ctx.fillRect(0, 0, PAGE_W, PAGE_H);
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.beginPath();
      ctx.rect(0, 0, PAGE_W, PAGE_H);
      ctx.clip();
      drawPaper(ctx, nb, page, k);
      drawStrokes(ctx, page.strokes, [x0 - px, y0, x1 - px, y1]);
      ctx.restore();
      if (showNumbers) {
        ctx.save();
        ctx.translate(px, 0);
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--sn-stylekit-foreground-color').trim() || '#444';
        ctx.globalAlpha = 0.75;
        // constant on-screen size (about 14 css px) regardless of zoom
        ctx.font = `600 ${14 / vp.s}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(String(i + 1), PAGE_W / 2, PAGE_H + 24 / vp.s);
        ctx.restore();
      }
    }
  }

  private drawLive(): void {
    const { vp, active, eraserCursor } = this.app;
    const ctx = this.live;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
    const k = vp.s * dpr;
    if (active) {
      ctx.setTransform(k, 0, 0, k, vp.tx * dpr, vp.ty * dpr);
      ctx.save();
      ctx.translate(vp.pageX(active.pageIndex), 0);
      ctx.beginPath();
      ctx.rect(0, 0, PAGE_W, PAGE_H);
      ctx.clip();
      drawStroke(ctx, active.stroke);
      ctx.restore();
    }
    if (eraserCursor) {
      ctx.setTransform(k, 0, 0, k, vp.tx * dpr, vp.ty * dpr);
      ctx.beginPath();
      ctx.arc(eraserCursor.x, eraserCursor.y, eraserCursor.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.fill();
      ctx.lineWidth = 1.2 / vp.s;
      ctx.strokeStyle = 'rgba(60, 60, 60, 0.75)';
      ctx.stroke();
    }
  }
}

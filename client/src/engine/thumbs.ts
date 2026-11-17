import { objBounds } from '../../../shared/geometry';
import type { BBox, Page } from '../../../shared/types';
import { drawBackground, drawObject, type RenderEnv } from './render';

// Page thumbnails for the sidebar. They are drawn off the main path: only in idle time,
// a while after the last edit to a page, in small time slices (so drawing never stutters),
// never while a pen is down, and cached per page until the page changes again.

export const THUMB_W = 172;
export const THUMB_H = 104;
/** quiet time after an edit before a page's thumbnail is redrawn */
const DEBOUNCE_MS = 700;
/** longest slice of work per turn, even when the browser offers a longer idle period */
const SLICE_MS = 5;
const PAD = 24;

interface Job {
  pageId: string;
  ver: number;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  ids: string[];
  i: number;
  tapes: string[];
  dark: boolean;
}

type IdleDeadline = { timeRemaining(): number };
const ric: (cb: (d: IdleDeadline) => void) => number = typeof window !== 'undefined' && 'requestIdleCallback' in window
  ? (cb) => (window as unknown as { requestIdleCallback(cb: (d: IdleDeadline) => void, o?: object): number }).requestIdleCallback(cb)
  : (cb) => window.setTimeout(() => { const t = performance.now(); cb({ timeRemaining: () => Math.max(0, SLICE_MS - (performance.now() - t)) }); }, 50);

/**
 * Canvas drawing is recorded and only rasterised when the pixels are needed. Reading one pixel
 * makes that happen now, inside the idle slice, instead of when the sidebar copies the thumbnail.
 */
function flush(ctx: CanvasRenderingContext2D) { ctx.getImageData(0, 0, 1, 1); }

export interface ThumbHost {
  pages(): Page[];
  env(): RenderEnv;
  /** true while a pointer gesture (a stroke, an erase…) is in progress: thumbnails wait */
  busy(): boolean;
  changed(pageId: string): void;
}

export class Thumbnails {
  private done = new Map<string, { ver: number; canvas: HTMLCanvasElement; dark: boolean }>();
  private ver = new Map<string, number>();
  private dueAt = new Map<string, number>();
  private job: Job | null = null;
  private scheduled = false;
  private timer = 0;
  private stopped = false;
  /** only while the sidebar is showing */
  private enabled = false;
  /** total time spent drawing thumbnails, for measurements */
  workMs = 0;
  private dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);

  constructor(private host: ThumbHost) {}

  /** The latest finished thumbnail for a page (it may be a little behind the page). */
  get(pageId: string): HTMLCanvasElement | null { return this.done.get(pageId)?.canvas ?? null; }

  /** A page's content changed: redraw its thumbnail once things are quiet. */
  touch(pageId: string, now = performance.now()) {
    this.ver.set(pageId, (this.ver.get(pageId) ?? 0) + 1);
    this.dueAt.set(pageId, now + DEBOUNCE_MS);
    this.kick(DEBOUNCE_MS);
  }

  /** Everything changed (snapshot, theme): redraw all, soon. */
  touchAll() {
    for (const p of this.host.pages()) { this.ver.set(p.id, (this.ver.get(p.id) ?? 0) + 1); this.dueAt.set(p.id, 0); }
    this.job = null;
    this.kick(50);
  }

  stop() { this.stopped = true; window.clearTimeout(this.timer); }

  /** The sidebar is shown (true) or hidden (false). Hidden: no work at all. */
  setEnabled(on: boolean) {
    this.enabled = on;
    if (on) this.kick(50); else window.clearTimeout(this.timer);
  }

  /** Something every thumbnail depends on changed (the theme): redraw them in idle time. */
  refresh() { this.kick(50); }

  private kick(delay: number) {
    if (this.stopped || !this.enabled) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.schedule(), delay);
  }

  private schedule() {
    if (this.scheduled || this.stopped || !this.enabled) return;
    this.scheduled = true;
    ric((d) => { this.scheduled = false; this.work(d); });
  }

  /** The next page whose thumbnail is out of date and quiet long enough. */
  private next(now: number): Page | null {
    const dark = this.host.env().dark;
    let wait = Infinity;
    for (const p of this.host.pages()) {
      const want = this.ver.get(p.id) ?? 0;
      const have = this.done.get(p.id);
      if (have && have.ver === want && have.dark === dark) continue;
      const due = this.dueAt.get(p.id) ?? 0;
      if (due <= now) return p;
      wait = Math.min(wait, due - now);
    }
    if (wait < Infinity) this.kick(wait + 10);
    return null;
  }

  private work(idle: IdleDeadline) {
    if (this.stopped || !this.enabled) return;
    if (this.host.busy()) { this.kick(300); return; }
    const t0 = performance.now();
    // a short slice even when the browser offers a long idle period: a pen can come down at any moment
    const d: IdleDeadline = { timeRemaining: () => Math.min(idle.timeRemaining(), SLICE_MS - (performance.now() - t0)) };
    try {
      while (d.timeRemaining() > 1) {
        if (!this.job) {
          const p = this.next(performance.now());
          if (!p) break;
          this.job = this.begin(p);
        }
        if (this.step(this.job, d)) this.job = null;
      }
    } catch (err) {
      console.error('[thumbs]', err);
      this.job = null;
    }
    this.workMs += performance.now() - t0;
    // more to do: continue in the next idle period
    if (this.job || this.next(performance.now())) this.schedule();
  }

  private begin(page: Page): Job {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(THUMB_W * this.dpr);
    canvas.height = Math.round(THUMB_H * this.dpr);
    // a plain (CPU) canvas, so the drawing really happens inside each slice and not later, all at once
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const env = this.host.env();
    // fit the page's content (with a little room), never larger than 1:1
    let b: BBox | null = null;
    for (const id of page.order) {
      const o = page.objects[id];
      if (!o) continue;
      const ob = objBounds(o);
      b = b ? [Math.min(b[0], ob[0]), Math.min(b[1], ob[1]), Math.max(b[2], ob[2]), Math.max(b[3], ob[3])] : ob;
    }
    const view: BBox = b ? [b[0] - PAD, b[1] - PAD, b[2] + PAD, b[3] + PAD] : [0, 0, THUMB_W * 4, THUMB_H * 4];
    const k = Math.min(1, THUMB_W / (view[2] - view[0]), THUMB_H / (view[3] - view[1]));
    const cx = (view[0] + view[2]) / 2, cy = (view[1] + view[3]) / 2;
    const cam = { x: cx - THUMB_W / 2 / k, y: cy - THUMB_H / 2 / k, zoom: k };
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    drawBackground(ctx, page.background, cam, THUMB_W, THUMB_H, env.dark);
    ctx.setTransform(this.dpr * k, 0, 0, this.dpr * k, -cam.x * k * this.dpr, -cam.y * k * this.dpr);
    const tapes: string[] = [];
    const ids: string[] = [];
    for (const id of page.order) {
      const o = page.objects[id];
      if (o?.type === 'tape' && !o.revealed) tapes.push(id); else if (o) ids.push(id);
    }
    return { pageId: page.id, ver: this.ver.get(page.id) ?? 0, canvas, ctx, ids: [...ids, ...tapes], i: 0, tapes, dark: env.dark };
  }

  /** Draws objects until the time slice is used up; true when the thumbnail is finished. */
  private step(job: Job, d: IdleDeadline): boolean {
    const page = this.host.pages().find((p) => p.id === job.pageId);
    if (!page) return true;
    // the page changed while drawing: start again later with the new content
    if ((this.ver.get(job.pageId) ?? 0) !== job.ver) return true;
    const env = this.host.env();
    while (job.i < job.ids.length) {
      for (let n = 0; n < 12 && job.i < job.ids.length; n++, job.i++) {
        const o = page.objects[job.ids[job.i]];
        if (o) drawObject(job.ctx, o, env);
      }
      if (d.timeRemaining() <= 1) { flush(job.ctx); return false; }
    }
    flush(job.ctx);
    this.done.set(job.pageId, { ver: job.ver, canvas: job.canvas, dark: job.dark });
    this.host.changed(job.pageId);
    return true;
  }
}

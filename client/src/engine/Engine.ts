import { nanoid } from 'nanoid';
import {
  bboxIntersects, frameCorners, frameOf, matApply, objBounds, setTextMeasurer, translateObject, unionBounds,
  LINE_H, type Frame, type Mat,
} from '../../../shared/geometry';
import { placeImage } from '../../../shared/imageSize';
import { applyOp, applyPageOp, applyWithInverse, findPage, newNotebook, notebookIsEmpty, type ApplyHooks } from '../../../shared/ops';
import { protractorAngle } from '../../../shared/ruler';
import type {
  Background, BBox, BoardObject, Camera, ImageObj, Notebook, Op, Page, PageOp, PresenceUser, RulerState, StrokeStyle,
} from '../../../shared/types';
import { getCachedNotebook, putCachedNotebook } from './idb';
import { ImageCache, prepareImage, uploadImage } from './images';
import { drawCursor, drawLaser, drawRuler, LASER_MS, type LaserPoint } from './overlay';
import { carryPath, drawBackground, drawLiveStroke, drawObject, drawTape, FONT, type RenderEnv } from './render';
import { saveSettings, type PenFav, type Settings, type Store, type ToolId, type UIState } from './store';
import { Sync, type PendingItem } from './sync';
import { Input } from './tools';

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type OpBody = DistOmit<Op, 'opId' | 'pageId'>;
interface UndoEntry { ops: OpBody[] }
interface UndoStack { undo: UndoEntry[]; redo: UndoEntry[] }

interface RemoteStroke { sid: string; pageId: string; style: StrokeStyle; points: number[]; t: number; ended: boolean }
interface ReplayItem { id: string; start: number; dur: number }
interface ReplayState { items: Map<string, ReplayItem>; t: number; total: number; playing: boolean; speed: number; last: number }

export interface EngineOptions { notebookId: string; userId: string; name: string; passcode: string }

const MIN_ZOOM = 0.1, MAX_ZOOM = 8;
const UNDO_LIMIT = 500;
/** how far (CSS px) a pan may slide the cached ink bitmap before the exposed strips are painted */
const SCROLL_STEP = 96;
/** how far (world units) an object's rendering may reach outside its geometric bounds */
const PAINT_SPILL = 64;
const HANDLE_DIRS: [number, number][] = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
const strip = (ops: Op[]): OpBody[] => ops.map(({ opId: _o, pageId: _p, ...rest }) => rest as OpBody);

export class Engine {
  nb: Notebook;
  pageId: string;
  cam: Camera = { x: -40, y: -40, zoom: 1 };
  vw = 1; vh = 1; dpr = 1;
  images: ImageCache;
  sync: Sync;
  input: Input;
  env: RenderEnv;

  sel = new Set<string>();
  /** objects temporarily lifted off the committed layer and drawn on the live layer through `xform` */
  preview: { ids: Set<string>; m: Mat } | null = null;
  editingId: string | null = null;
  placeholders = new Map<string, { obj: ImageObj; pageId: string; drawable: CanvasImageSource }>();
  remoteStrokes = new Map<string, RemoteStroke>();
  cursors = new Map<string, { x: number; y: number; tool: string; pageId: string; t: number }>();
  lasers = new Map<string, { pts: LaserPoint[]; mode: 'trail' | 'dot'; pageId: string }>();
  rulers = new Map<string, RulerState & { pageId: string }>();
  erasers = new Map<string, { x: number; y: number; r: number; pageId: string; t: number }>();
  replay: ReplayState | null = null;
  clipboard: { token: string; objs: BoardObject[]; pastes: number } | null = null;

  private bg: HTMLCanvasElement; private main: HTMLCanvasElement; live: HTMLCanvasElement;
  private bgCtx: CanvasRenderingContext2D; private mainCtx: CanvasRenderingContext2D; private liveCtx: CanvasRenderingContext2D;
  private cams = new Map<string, Camera>();
  private undoStacks = new Map<string, UndoStack>();
  private dirtyBg = true; private dirtyMain = true; private dirtyLive = true;
  private raf = 0;
  private mainCam: Camera = { x: 0, y: 0, zoom: 1 };
  private lastFullMs = 0; private lastFullAt = 0; private camMovedAt = 0;
  /** overscan (CSS px) around the viewport on the committed layer, so panning can reuse the bitmap */
  private margin = 0;
  /** world-space region of the committed layer that must be repainted (cheaper than a full redraw) */
  private dirtyRect: BBox | null = null;
  /** real cost of the last two full redraws (frame time, not just script time: canvas raster is deferred) */
  private costSamples: [number, number] = [0, 0];
  private probeAt = 0;
  private camSeq = 0; private seenSeq = 0; private stillFrames = 0;
  private lastScrollAt = 0;
  private mainCss = '';
  private cacheTimer = 0; private cachePaused = false;
  private rulerDirty = false; private viewportSentAt = 0; private viewportDirty = true;
  private ro: ResizeObserver;
  private dprQuery: MediaQueryList | null = null;
  private destroyed = false;
  private hooks: ApplyHooks = { moved: carryPath };
  private toastId = 1;
  private textKey = 0;

  constructor(private container: HTMLElement, public ui: Store<UIState>, public opts: EngineOptions) {
    this.nb = newNotebook(opts.notebookId, 'loading');
    this.pageId = this.nb.pages[0].id;
    const mk = (cls: string) => {
      const c = document.createElement('canvas');
      c.className = `layer ${cls}`;
      container.appendChild(c);
      return c;
    };
    this.bg = mk('layer-bg'); this.main = mk('layer-main'); this.live = mk('layer-live');
    this.bgCtx = this.bg.getContext('2d', { alpha: false })!;
    this.mainCtx = this.main.getContext('2d')!;
    this.liveCtx = this.live.getContext('2d', { desynchronized: true })!;
    this.main.style.transformOrigin = '0 0';

    const measure = document.createElement('canvas').getContext('2d')!;
    setTextMeasurer((text, fontSize) => {
      measure.font = `${fontSize}px ${FONT}`;
      const lines = text.split('\n');
      let w = 0;
      for (const l of lines) w = Math.max(w, measure.measureText(l).width);
      return { w: Math.max(w, fontSize * 0.5), h: lines.length * fontSize * LINE_H };
    });

    this.images = new ImageCache(() => { this.dirtyMain = true; this.requestFrame(); });
    this.env = {
      dark: ui.get().settings.dark,
      getImage: (src) => (src.startsWith('local:') ? this.placeholders.get(src.slice(6))?.drawable ?? null : this.images.get(src)),
      imageState: (src) => this.images.state(src),
    };

    this.input = new Input(this);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.watchDpr();
    this.resize();

    this.sync = new Sync({
      onSnapshot: (nb, info) => this.onSnapshot(nb, info),
      onRemoteOps: (ops) => this.onRemoteOps(ops),
      onRemotePageOp: (op) => this.onRemotePageOp(op),
      onPresence: (users) => this.onPresence(users),
      onJoined: (me) => ui.set((s) => ({ me: { ...s.me, ...me } })),
      onStatus: () => ui.set({ conn: this.sync.conn, saving: this.sync.saving }),
      onFatal: (reason) => ui.set({ fatal: reason }),
      onLive: (ev, data) => this.onLive(ev, data),
    }, { notebookId: opts.notebookId, userId: opts.userId, name: opts.name, passcode: opts.passcode, color: localStorage.getItem('mathboard.color') ?? undefined });
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.cacheTimer);
    this.flushCache();
    this.ro.disconnect();
    this.dprQuery?.removeEventListener('change', this.onDpr);
    this.input.destroy();
    this.sync.close();
    this.bg.remove(); this.main.remove(); this.live.remove();
  }

  // ---------- basics ----------
  get page(): Page { return findPage(this.nb, this.pageId) ?? this.nb.pages[0]; }
  get settings(): Settings { return this.ui.get().settings; }
  get me() { return this.ui.get().me; }
  get activeFav(): PenFav { const s = this.settings; return s.favs[s.activeFav] ?? s.favs[0]; }

  setSettings(patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)) {
    const cur = this.settings;
    const next = { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) };
    this.ui.set({ settings: next });
    saveSettings(next);
    if (next.dark !== this.env.dark) {
      this.env.dark = next.dark;
      this.invalidate();
    }
    this.dirtyLive = true;
    this.requestFrame();
  }

  toast(msg: string, kind: 'info' | 'error' = 'info') {
    const id = this.toastId++;
    this.ui.set((s) => ({ toasts: [...s.toasts, { id, msg, kind }] }));
    window.setTimeout(() => this.ui.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 3200);
  }

  toScreen = (x: number, y: number): [number, number] => [(x - this.cam.x) * this.cam.zoom, (y - this.cam.y) * this.cam.zoom];
  toWorld = (sx: number, sy: number): [number, number] => [sx / this.cam.zoom + this.cam.x, sy / this.cam.zoom + this.cam.y];
  viewBox(): BBox { return [this.cam.x, this.cam.y, this.cam.x + this.vw / this.cam.zoom, this.cam.y + this.vh / this.cam.zoom]; }

  invalidate() { this.dirtyBg = this.dirtyMain = this.dirtyLive = true; this.requestFrame(); }
  invalidateMain() { this.dirtyMain = true; this.requestFrame(); }
  /** Repaint only a region of the committed layer (world coordinates). */
  invalidateRect(b: BBox | null) {
    if (!b) return;
    const d = this.dirtyRect;
    this.dirtyRect = d ? [Math.min(d[0], b[0]), Math.min(d[1], b[1]), Math.max(d[2], b[2]), Math.max(d[3], b[3])] : [b[0], b[1], b[2], b[3]];
    this.requestFrame();
  }
  invalidateLive() { this.dirtyLive = true; this.requestFrame(); }

  // ---------- sizing ----------
  private onDpr = () => { this.watchDpr(); this.resize(); };
  private watchDpr() {
    this.dprQuery?.removeEventListener('change', this.onDpr);
    this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.dprQuery.addEventListener('change', this.onDpr);
  }

  resize() {
    const r = this.container.getBoundingClientRect();
    this.vw = Math.max(1, Math.round(r.width));
    this.vh = Math.max(1, Math.round(r.height));
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    for (const c of [this.bg, this.live]) {
      c.width = Math.round(this.vw * this.dpr);
      c.height = Math.round(this.vh * this.dpr);
      c.style.width = `${this.vw}px`;
      c.style.height = `${this.vh}px`;
    }
    // the committed layer is larger than the viewport (kept under ~14 MP for tablets)
    let m = 256;
    while (m > 0 && (this.vw + 2 * m) * (this.vh + 2 * m) * this.dpr * this.dpr > 14e6) m -= 64;
    this.margin = Math.max(0, m);
    this.main.width = Math.round((this.vw + 2 * this.margin) * this.dpr);
    this.main.height = Math.round((this.vh + 2 * this.margin) * this.dpr);
    this.main.style.width = `${this.vw + 2 * this.margin}px`;
    this.main.style.height = `${this.vh + 2 * this.margin}px`;
    this.main.style.left = this.main.style.top = `${-this.margin}px`;
    const k = this.cam.zoom * this.dpr;
    this.cam = { x: Math.round(this.cam.x * k) / k, y: Math.round(this.cam.y * k) / k, zoom: this.cam.zoom };
    this.viewportDirty = true;
    this.updateSelUI();
    this.invalidate();
  }

  // ---------- camera ----------
  setCamera(cam: Camera, fromFollow = false) {
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom));
    // The camera sits on whole device pixels, so a pan moves the cached ink bitmap by exact
    // pixels: it stays crisp and stays aligned with the live layer without being repainted.
    const k = zoom * this.dpr;
    const x = Math.round(cam.x * k) / k, y = Math.round(cam.y * k) / k;
    if (zoom === this.cam.zoom && x === this.cam.x && y === this.cam.y) return;
    this.cam = { x, y, zoom };
    this.camSeq++;
    this.cams.set(this.pageId, this.cam);
    this.camMovedAt = performance.now();
    this.dirtyBg = this.dirtyLive = true;
    this.viewportDirty = true;
    if (!fromFollow && this.ui.get().following) this.ui.set({ following: null });
    this.ui.set({ zoom });
    this.updateSelUI();
    this.requestFrame();
  }
  panBy(dxScreen: number, dyScreen: number) {
    this.setCamera({ x: this.cam.x - dxScreen / this.cam.zoom, y: this.cam.y - dyScreen / this.cam.zoom, zoom: this.cam.zoom });
  }
  zoomAt(sx: number, sy: number, factor: number) {
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.cam.zoom * factor));
    const [wx, wy] = this.toWorld(sx, sy);
    this.setCamera({ x: wx - sx / zoom, y: wy - sy / zoom, zoom });
  }
  zoomStep(dir: 1 | -1) {
    const steps = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
    const z = this.cam.zoom;
    const next = dir > 0 ? steps.find((s) => s > z + 1e-6) ?? MAX_ZOOM : [...steps].reverse().find((s) => s < z - 1e-6) ?? MIN_ZOOM;
    this.zoomAt(this.vw / 2, this.vh / 2, next / z);
  }
  resetZoom() { this.zoomAt(this.vw / 2, this.vh / 2, 1 / this.cam.zoom); }
  fitContent() {
    const b = unionBounds(Object.values(this.page.objects));
    if (!b) { this.setCamera({ x: -40, y: -40, zoom: 1 }); return; }
    this.fitRect(b, 48);
  }
  private fitRect(b: BBox, pad: number, maxZoom = 2) {
    const w = Math.max(1, b[2] - b[0]), h = Math.max(1, b[3] - b[1]);
    const zoom = Math.max(MIN_ZOOM, Math.min(maxZoom, (this.vw - pad * 2) / w, (this.vh - pad * 2) / h));
    this.setCamera({ x: (b[0] + b[2]) / 2 - this.vw / zoom / 2, y: (b[1] + b[3]) / 2 - this.vh / zoom / 2, zoom }, true);
  }

  // ---------- frame loop ----------
  requestFrame() {
    if (!this.raf && !this.destroyed) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    let again = false;
    try {
      if (this.probeAt) {
        // how long did the frame containing the last full redraw really take?
        const dt = now - this.probeAt;
        this.probeAt = 0;
        if (dt < 1500 && !document.hidden) this.costSamples = [this.costSamples[1], dt > 28 ? dt : this.lastFullMs];
      }
      again = this.input.frame(now) || again;
      if (this.replay?.playing) {
        const r = this.replay;
        r.t = Math.min(r.total, r.t + ((now - r.last) / 1000) * r.speed);
        r.last = now;
        if (r.t >= r.total) r.playing = false;
        this.ui.set({ replay: { t: r.t, total: r.total, playing: r.playing, speed: r.speed } });
        this.dirtyMain = true;
        again = true;
      }
      if (this.rulerDirty) {
        this.rulerDirty = false;
        this.sync.emit('ruler', { pageId: this.pageId, ...this.ui.get().ruler });
      }
      if (this.viewportDirty && now - this.viewportSentAt > 90) {
        this.viewportDirty = false;
        this.viewportSentAt = now;
        this.sync.emit('viewport', { pageId: this.pageId, camera: this.cam, vw: this.vw, vh: this.vh }, true);
      } else if (this.viewportDirty) again = true;

      if (this.dirtyBg) { this.dirtyBg = false; this.renderBg(); }

      // ---- committed layer: repaint as little as possible ----
      if (this.camSeq !== this.seenSeq) { this.seenSeq = this.camSeq; this.stillFrames = 0; } else this.stillFrames++;
      const idle = this.stillFrames >= 2 && now - this.camMovedAt > 110;
      const cost = Math.min(this.costSamples[0], this.costSamples[1]);
      if (this.dirtyMain) this.renderMain(now);
      else if (this.cam.zoom !== this.mainCam.zoom) {
        // light pages repaint every frame; heavy ones show the scaled bitmap and repaint on a
        // throttle proportional to what a repaint costs, and crisply once the motion stops
        if (cost <= 12 || idle || now - this.lastFullAt > Math.max(280, cost * 8)) this.renderMain(now);
        else again = true;
      } else if (this.cam.x !== this.mainCam.x || this.cam.y !== this.mainCam.y) {
        // a pan slides the bitmap (free); only the strips it exposes are painted, a slice at a time
        const dx = Math.abs(this.mainCam.x - this.cam.x) * this.cam.zoom, dy = Math.abs(this.mainCam.y - this.cam.y) * this.cam.zoom;
        const share = Math.min(1, dx / (this.vw + 2 * this.margin) + dy / (this.vh + 2 * this.margin));
        if (idle || ((Math.max(dx, dy) >= SCROLL_STEP || !this.cacheCovers()) && now - this.lastScrollAt > cost * share * 3)) this.scrollMain(now);
        else again = true;
      }
      if (this.dirtyRect && !this.dirtyMain) {
        if (this.cam.zoom === this.mainCam.zoom) {
          const b = this.dirtyRect;
          this.dirtyRect = null;
          this.renderRect(b, now);
        } else again = true; // painted by the next full repaint
      }
      this.placeMain();
      if (this.probeAt) again = true;
      if (this.dirtyLive) { this.dirtyLive = false; again = this.renderLive(now) || again; }
    } catch (err) {
      console.error('[engine] frame error', err);
    }
    if (again) this.requestFrame();
  };

  private renderBg() {
    const ctx = this.bgCtx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    drawBackground(ctx, this.page.background, this.cam, this.vw, this.vh, this.env.dark);
  }

  private worldTransform(ctx: CanvasRenderingContext2D) {
    const k = this.dpr * this.cam.zoom;
    ctx.setTransform(k, 0, 0, k, -this.cam.x * k, -this.cam.y * k);
  }

  /** Camera transform for the committed layer, which is `margin` larger than the viewport on every side. */
  private mainTransform(ctx: CanvasRenderingContext2D) {
    const c = this.mainCam, k = this.dpr * c.zoom, m = this.margin * this.dpr;
    ctx.setTransform(k, 0, 0, k, -c.x * k + m, -c.y * k + m);
  }

  /** Shows the committed bitmap where the current camera wants it (it was painted at `mainCam`). */
  private placeMain() {
    const c = this.mainCam, s = this.cam.zoom / c.zoom, m = this.margin;
    let css = '';
    if (s !== 1 || this.cam.x !== c.x || this.cam.y !== c.y) {
      let tx = (c.x - this.cam.x) * this.cam.zoom + m * (1 - s), ty = (c.y - this.cam.y) * this.cam.zoom + m * (1 - s);
      if (s === 1) { tx = Math.round(tx * this.dpr) / this.dpr; ty = Math.round(ty * this.dpr) / this.dpr; }
      css = `translate(${tx}px, ${ty}px) scale(${s})`;
    }
    if (css !== this.mainCss) { this.mainCss = css; this.main.style.transform = css; }
  }

  /** World rectangle the committed layer covers when painted at `cam`. */
  private mainView(cam: Camera = this.mainCam): BBox {
    const m = this.margin / cam.zoom;
    return [cam.x - m, cam.y - m, cam.x + this.vw / cam.zoom + m, cam.y + this.vh / cam.zoom + m];
  }

  /** true while the cached bitmap still shows the whole viewport at the current zoom */
  private cacheCovers(): boolean {
    if (this.cam.zoom !== this.mainCam.zoom) return false;
    const c = this.mainView(), v = this.viewBox();
    return v[0] >= c[0] && v[1] >= c[1] && v[2] <= c[2] && v[3] <= c[3];
  }

  private isHidden(id: string): boolean {
    return id === this.editingId || !!this.preview?.ids.has(id);
  }

  private renderMain(now: number) {
    const t0 = performance.now();
    const ctx = this.mainCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.main.width, this.main.height);
    this.mainCam = { ...this.cam };
    this.mainTransform(ctx);
    this.drawContent(ctx, this.mainView());
    this.dirtyMain = false;
    this.dirtyRect = null;
    this.lastFullMs = performance.now() - t0;
    this.lastFullAt = now;
    this.probeAt = now;
  }

  /** Repaints one world-space region of the committed layer. */
  private renderRect(b: BBox, now: number) {
    const c = this.mainCam, k = this.dpr * c.zoom, m = this.margin * this.dpr;
    const ox = -c.x * k + m, oy = -c.y * k + m;
    const pad = 3;
    const x0 = Math.max(0, Math.floor(b[0] * k + ox) - pad), y0 = Math.max(0, Math.floor(b[1] * k + oy) - pad);
    const x1 = Math.min(this.main.width, Math.ceil(b[2] * k + ox) + pad), y1 = Math.min(this.main.height, Math.ceil(b[3] * k + oy) + pad);
    if (x1 <= x0 || y1 <= y0) return; // entirely off the cached area
    if ((x1 - x0) * (y1 - y0) > this.main.width * this.main.height * 0.45) { this.renderMain(now); return; }
    this.paintDevice(x0, y0, x1, y1);
  }

  /** Clears and repaints a rectangle given in whole device pixels of the committed canvas (so no seams appear). */
  private paintDevice(x0: number, y0: number, x1: number, y1: number) {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(this.main.width, x1); y1 = Math.min(this.main.height, y1);
    if (x1 <= x0 || y1 <= y0) return;
    const c = this.mainCam, k = this.dpr * c.zoom, m = this.margin * this.dpr;
    const ox = -c.x * k + m, oy = -c.y * k + m;
    const ctx = this.mainCtx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    this.mainTransform(ctx);
    this.drawContent(ctx, [(x0 - ox) / k, (y0 - oy) / k, (x1 - ox) / k, (y1 - oy) / k]);
    ctx.restore();
  }

  /** After a pan: shifts the cached bitmap to the new camera and paints only the strips that came into range. */
  private scrollMain(now: number) {
    const k = this.dpr * this.cam.zoom, W = this.main.width, H = this.main.height;
    const dx = Math.round((this.mainCam.x - this.cam.x) * k), dy = Math.round((this.mainCam.y - this.cam.y) * k);
    this.lastScrollAt = now;
    if (Math.abs(dx) > W * 0.55 || Math.abs(dy) > H * 0.55) { this.renderMain(now); return; } // little left to reuse
    const ctx = this.mainCtx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(this.main, dx, dy);
    ctx.restore();
    this.mainCam = { ...this.cam };
    if (dx > 0) this.paintDevice(0, 0, dx, H); else if (dx < 0) this.paintDevice(W + dx, 0, W, H);
    if (dy > 0) this.paintDevice(0, 0, W, dy); else if (dy < 0) this.paintDevice(0, H + dy, W, H);
  }

  /** Draws the page's committed objects that intersect `view`, in z-order. */
  private drawContent(ctx: CanvasRenderingContext2D, area: BBox) {
    // cull against a slightly larger box: ink is wider than its point bounds under pressure, and
    // axes draw arrows and labels outside their box
    const view: BBox = [area[0] - PAINT_SPILL, area[1] - PAINT_SPILL, area[2] + PAINT_SPILL, area[3] + PAINT_SPILL];
    const page = this.page;
    const tapes: BoardObject[] = [];
    const rp = this.replay;
    for (const id of page.order) {
      const o = page.objects[id];
      if (!o || this.isHidden(id)) continue;
      if (!bboxIntersects(objBounds(o), view)) continue;
      if (o.type === 'tape' && !o.revealed) { tapes.push(o); continue; }
      if (rp) {
        const item = rp.items.get(id);
        if (item) {
          const f = (rp.t - item.start) / item.dur;
          if (f <= 0) continue;
          if (f < 1) {
            if (o.type === 'stroke') {
              const n = Math.max(1, Math.ceil((o.points.length / 3) * f));
              drawLiveStroke(ctx, { ...o, stab: o.stab ?? undefined, sim: !!o.sim }, o.points.slice(0, n * 3), this.env);
            } else { ctx.globalAlpha = f; drawObject(ctx, o, this.env); ctx.globalAlpha = 1; }
            continue;
          }
        }
      }
      drawObject(ctx, o, this.env);
    }
    // covering tape always sits above ink, whatever was written later
    for (const t of tapes) drawObject(ctx, t, this.env);
    for (const p of this.placeholders.values()) if (p.pageId === this.pageId) drawObject(ctx, p.obj, this.env);
  }

  /** Draws a just-added top-most object without repainting the whole layer. */
  private appendToMain(o: BoardObject) {
    const ctx = this.mainCtx;
    this.mainTransform(ctx);
    drawObject(ctx, o, this.env);
  }

  /** Painted extent of an object: its bounds plus whatever its rendering can spill over them. */
  private paintBounds(o: BoardObject): BBox {
    const b = objBounds(o);
    const p = o.type === 'stroke' ? Math.min(PAINT_SPILL, o.size + 2) : o.type === 'axes' ? 48 : 4;
    return [b[0] - p, b[1] - p, b[2] + p, b[3] + p];
  }

  /**
   * Union of the painted bounds of everything `ops` refer to on the current page, as the
   * notebook stands now. Called before AND after applying, so both old and new spots repaint.
   * Returns 'all' when a full redraw is simpler.
   */
  private touched(ops: Op[], acc: BBox | 'all' | null = null): BBox | 'all' | null {
    if (acc === 'all') return acc;
    const page = this.page;
    let n = 0;
    for (const op of ops) {
      if (op.pageId !== this.pageId) continue;
      const ids = op.kind === 'add' ? [op.obj.id] : op.kind === 'move' ? op.ids : [op.id];
      if ((n += ids.length) > 1500) return 'all';
      for (const id of ids) {
        const o = page.objects[id];
        if (!o) continue;
        if (o.type === 'tape') return 'all'; // revealing / moving tape changes what is drawn above everything
        const b = this.paintBounds(o);
        acc = acc ? [Math.min(acc[0], b[0]), Math.min(acc[1], b[1]), Math.max(acc[2], b[2]), Math.max(acc[3], b[3])] : b;
      }
    }
    return acc;
  }

  private renderLive(now: number): boolean {
    let again = false;
    const ctx = this.liveCtx;
    const z = this.cam.zoom;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    this.worldTransform(ctx);
    const page = this.page;

    if (this.preview) {
      ctx.save();
      ctx.transform(...this.preview.m);
      for (const id of page.order) {
        if (!this.preview.ids.has(id)) continue;
        const o = page.objects[id];
        if (o) drawObject(ctx, o, this.env);
      }
      ctx.restore();
    }

    for (const [id, rs] of this.remoteStrokes) {
      if (now - rs.t > 5000 || (rs.ended && now - rs.t > 1500)) { this.remoteStrokes.delete(id); continue; }
      if (rs.pageId === this.pageId) drawLiveStroke(ctx, rs.style, rs.points, this.env);
      again = true;
    }

    this.input.draw(ctx);

    // rulers: remote ones tinted in their owner's colour, mine on top
    const users = this.ui.get().users;
    for (const [sid, r] of this.rulers) {
      if (!r.visible || r.pageId !== this.pageId) continue;
      drawRuler(ctx, r, z, this.env.dark, users.find((u) => u.sid === sid)?.color ?? '#888', null);
    }
    const mine = this.ui.get().ruler;
    if (mine.visible) {
      const h = this.input.hoverWorld;
      drawRuler(ctx, mine, z, this.env.dark, null, mine.kind === 'protractor' && h ? protractorAngle(mine, h[0], h[1]) : null);
    }

    // ---- screen-space overlays ----
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawSelection(ctx);

    for (const [sid, e] of this.erasers) {
      if (now - e.t > 400) { this.erasers.delete(sid); continue; }
      if (e.pageId !== this.pageId) continue;
      const [x, y] = this.toScreen(e.x, e.y);
      ctx.beginPath();
      ctx.arc(x, y, e.r * z, 0, Math.PI * 2);
      ctx.strokeStyle = users.find((u) => u.sid === sid)?.color ?? '#888';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      again = true;
    }
    for (const [sid, l] of this.lasers) {
      while (l.pts.length > 1 && now - l.pts[0].t > LASER_MS) l.pts.shift();
      const last = l.pts[l.pts.length - 1];
      if (!last || now - last.t > LASER_MS) { this.lasers.delete(sid); continue; }
      again = true;
      if (l.pageId !== this.pageId) continue;
      const color = sid === 'me' ? this.me.color : users.find((u) => u.sid === sid)?.color ?? '#e03131';
      drawLaser(ctx, l.pts, color, now, l.mode, this.toScreen);
    }
    for (const [sid, c] of this.cursors) {
      const age = now - c.t;
      if (age > 3600) { this.cursors.delete(sid); continue; }
      again = true;
      if (c.pageId !== this.pageId) continue;
      const u = users.find((x) => x.sid === sid);
      if (!u) continue;
      const [x, y] = this.toScreen(c.x, c.y);
      drawCursor(ctx, x, y, u.name, u.color, c.tool, age < 3000 ? 1 : 1 - (age - 3000) / 600);
    }
    this.input.drawCursor(ctx);
    return again;
  }

  // ---------- selection geometry ----------
  selObjects(): BoardObject[] {
    const page = this.page;
    const out: BoardObject[] = [];
    for (const id of page.order) if (this.sel.has(id) && page.objects[id]) out.push(page.objects[id]);
    return out;
  }

  /** World-space selection frame: oriented for a single box-like object, otherwise axis-aligned. */
  selFrame(): Frame | null {
    const objs = this.selObjects();
    if (!objs.length) return null;
    const pad = 5 / this.cam.zoom;
    if (objs.length === 1) {
      const f = frameOf(objs[0]);
      if (f) {
        const extra = objs[0].type === 'shape' ? objs[0].size / 2 : 0;
        return { ...f, w: f.w + (pad + extra) * 2, h: f.h + (pad + extra) * 2 };
      }
    }
    const b = unionBounds(objs)!;
    return { cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, w: b[2] - b[0] + pad * 2, h: b[3] - b[1] + pad * 2, rot: 0 };
  }

  /** Handle positions (world) for a frame: 8 resize handles then the rotate handle. */
  handles(f: Frame): { x: number; y: number; hx: number; hy: number; rotate: boolean }[] {
    const c = Math.cos(f.rot), s = Math.sin(f.rot);
    const at = (lx: number, ly: number): [number, number] => [f.cx + lx * c - ly * s, f.cy + lx * s + ly * c];
    const out = HANDLE_DIRS.map(([hx, hy]) => {
      const [x, y] = at((hx * f.w) / 2, (hy * f.h) / 2);
      return { x, y, hx, hy, rotate: false };
    });
    const [rx, ry] = at(0, -f.h / 2 - 30 / this.cam.zoom);
    out.push({ x: rx, y: ry, hx: 0, hy: -1, rotate: true });
    return out;
  }

  selLocked(): boolean { const o = this.selObjects(); return o.length > 0 && o.every((x) => x.locked); }

  private drawSelection(ctx: CanvasRenderingContext2D) {
    let f = this.selFrame();
    if (!f) return;
    const m = this.preview && this.input.transformingSelection ? this.preview.m : null;
    const corners = frameCorners(f).reduce<number[]>((acc, v, i, arr) => {
      if (i % 2 === 0) {
        const [wx, wy] = m ? matApply(m, v, arr[i + 1]) : [v, arr[i + 1]];
        acc.push(...this.toScreen(wx, wy));
      }
      return acc;
    }, []);
    const locked = this.selLocked();
    ctx.save();
    ctx.strokeStyle = locked ? '#868e96' : '#1971c2';
    ctx.lineWidth = 1.25;
    ctx.setLineDash(locked ? [5, 4] : []);
    ctx.beginPath();
    ctx.moveTo(corners[0], corners[1]);
    for (let i = 2; i < 8; i += 2) ctx.lineTo(corners[i], corners[i + 1]);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    if (!locked && !m) {
      const hs = this.handles(f);
      const top = hs[1], rot = hs[8];
      const [tx, ty] = this.toScreen(top.x, top.y), [rx, ry] = this.toScreen(rot.x, rot.y);
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(rx, ry); ctx.stroke();
      ctx.fillStyle = '#ffffff';
      for (const h of hs) {
        const [x, y] = this.toScreen(h.x, h.y);
        ctx.beginPath();
        if (h.rotate) ctx.arc(x, y, 6.5, 0, Math.PI * 2);
        else if (h.hx && h.hy) ctx.rect(x - 5, y - 5, 10, 10);
        else ctx.roundRect(x - 4, y - 4, 8, 8, 4);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
    f = null;
  }

  setSelection(ids: Iterable<string>) {
    this.sel = new Set(ids);
    this.selChanged();
  }

  selChanged() {
    const page = this.page;
    for (const id of this.sel) if (!page.objects[id]) this.sel.delete(id);
    if (this.ui.get().graphInteract && !(this.sel.size === 1 && this.selObjects()[0]?.type === 'graph')) this.ui.set({ graphInteract: false });
    this.updateSelUI();
    this.invalidateLive();
  }

  updateSelUI() {
    const objs = this.selObjects();
    if (!objs.length) { if (this.ui.get().sel) this.ui.set({ sel: null }); return; }
    const f = this.selFrame()!;
    const c = frameCorners(f);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < 8; i += 2) {
      const [sx, sy] = this.toScreen(c[i], c[i + 1]);
      minX = Math.min(minX, sx); maxX = Math.max(maxX, sx); minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
    }
    this.ui.set({
      sel: {
        ids: objs.map((o) => o.id),
        rect: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
        allLocked: objs.every((o) => o.locked),
        anyLocked: objs.some((o) => o.locked),
        hasColor: objs.some((o) => o.type === 'stroke' || o.type === 'shape' || o.type === 'text' || o.type === 'tape'),
        hasSize: objs.some((o) => o.type === 'stroke' || o.type === 'shape'),
        single: objs.length === 1 ? objs[0] : null,
      },
    });
  }

  setPreview(ids: Set<string> | null, m?: Mat) {
    const had = this.preview;
    if (!ids) {
      this.preview = null;
      if (had) { this.invalidateIds(had.ids); this.invalidateLive(); }
      return;
    }
    const same = had && had.ids === ids;
    this.preview = { ids, m: m ?? [1, 0, 0, 1, 0, 0] };
    if (!same) { if (had) this.invalidateIds(had.ids); this.invalidateIds(ids); }
    this.invalidateLive();
  }

  /** Repaints where the given objects are (used when they are lifted to / dropped from the live layer). */
  private invalidateIds(ids: Set<string>) {
    if (ids.size > 1500) { this.invalidateMain(); return; }
    const page = this.page;
    let acc: BBox | null = null;
    for (const id of ids) {
      const o = page.objects[id];
      if (!o) continue;
      if (o.type === 'tape') { this.invalidateMain(); return; }
      const b = this.paintBounds(o);
      acc = acc ? [Math.min(acc[0], b[0]), Math.min(acc[1], b[1]), Math.max(acc[2], b[2]), Math.max(acc[3], b[3])] : b;
    }
    this.invalidateRect(acc);
  }

  // ---------- ops & undo ----------
  private stack(pageId = this.pageId): UndoStack {
    let s = this.undoStacks.get(pageId);
    if (!s) { s = { undo: [], redo: [] }; this.undoStacks.set(pageId, s); }
    return s;
  }

  private stamp(bodies: OpBody[], pageId: string): Op[] {
    return bodies.map((b) => ({ ...b, opId: nanoid(10), pageId }) as Op);
  }

  /** Applies my ops optimistically, sends them, and (by default) records an undo step. */
  commit(bodies: OpBody[], opts: { undo?: boolean; pageId?: string } = {}): OpBody[] {
    if (!bodies.length) return [];
    const pageId = opts.pageId ?? this.pageId;
    const ops = this.stamp(bodies, pageId);
    const before = this.touched(ops);
    const inv = strip(applyWithInverse(this.nb, ops, this.hooks));
    if (opts.undo !== false && inv.length) this.pushUndo(inv, pageId);
    this.sync.sendOps(ops);
    this.afterOps(ops, false, before);
    return inv;
  }

  /** Records an undo step: `ops` are what must run to undo. */
  pushUndo(ops: OpBody[], pageId = this.pageId) {
    if (!ops.length) return;
    const s = this.stack(pageId);
    s.undo.push({ ops });
    if (s.undo.length > UNDO_LIMIT) s.undo.shift();
    s.redo = [];
    this.updateUndoUI();
  }

  private runHistory(from: UndoEntry[], to: UndoEntry[]) {
    this.input.cancelGesture();
    const entry = from.pop();
    if (!entry) return;
    const ops = this.stamp(entry.ops, this.pageId);
    const before = this.touched(ops);
    const inv = strip(applyWithInverse(this.nb, ops, this.hooks));
    if (inv.length) to.push({ ops: inv });
    this.sync.sendOps(ops);
    this.afterOps(ops, false, before);
    this.updateUndoUI();
  }
  undo() { const s = this.stack(); this.runHistory(s.undo, s.redo); }
  redo() { const s = this.stack(); this.runHistory(s.redo, s.undo); }

  private updateUndoUI() {
    const s = this.stack();
    this.ui.set({ canUndo: s.undo.length > 0, canRedo: s.redo.length > 0 });
  }

  private hasCoveringTape(): boolean {
    const page = this.page;
    for (const id of page.order) { const o = page.objects[id]; if (o?.type === 'tape' && !o.revealed) return true; }
    return false;
  }

  /** Bookkeeping after any ops were applied to the notebook (mine or remote). */
  private afterOps(ops: Op[], remote: boolean, before: BBox | 'all' | null) {
    const page = this.page;
    let needFull = false;
    let touchedCurrent = false;
    // the cached bitmap can take a new top-most object directly, even while it is slid by a pan
    const clean = !this.dirtyMain && !this.dirtyRect && !this.replay && this.cam.zoom === this.mainCam.zoom;
    for (const op of ops) {
      if (op.kind === 'add' && remote) {
        const rs = this.remoteStrokes.get(op.obj.id);
        if (rs) { this.remoteStrokes.delete(op.obj.id); this.dirtyLive = true; }
      }
      if (op.pageId !== this.pageId) continue;
      touchedCurrent = true;
      if (!needFull && clean && op.kind === 'add' && page.order[page.order.length - 1] === op.obj.id && !this.isHidden(op.obj.id) && !this.hasCoveringTape()) {
        const o = page.objects[op.obj.id];
        if (o && bboxIntersects(this.paintBounds(o), this.mainView())) this.appendToMain(o);
      } else needFull = true;
    }
    if (needFull) {
      // repaint just the old and new spots of what changed; fall back to everything when that is simpler
      const region = this.replay ? 'all' : this.touched(ops, before);
      if (region === 'all') this.dirtyMain = true;
      else this.invalidateRect(region);
    }
    if (touchedCurrent) {
      if (this.sel.size) this.selChanged();
      this.dirtyLive = true;
    }
    this.syncPagesUI();
    this.scheduleCache();
    this.requestFrame();
  }

  private onRemoteOps(ops: Op[]) {
    const touched = new Set<string>();
    const before = this.touched(ops);
    for (const op of ops) {
      applyOp(this.nb, op, this.hooks);
      if (op.kind === 'update' || op.kind === 'delete') touched.add(op.id);
      else if (op.kind === 'add') touched.add(op.obj.id);
    }
    // last-writer-wins by server order: my still-unacknowledged updates will be ordered after these
    if (touched.size) {
      for (const it of this.sync.pending) {
        if (it.type !== 'ops') continue;
        for (const mine of it.ops) if (mine.kind === 'update' && touched.has(mine.id)) applyOp(this.nb, mine, this.hooks);
      }
    }
    this.afterOps(ops, true, before);
  }

  private onRemotePageOp(op: PageOp) {
    applyPageOp(this.nb, op);
    this.afterPageChange();
  }

  private afterPageChange() {
    if (!findPage(this.nb, this.pageId)) {
      this.pageId = this.nb.pages[0].id;
      this.enterPage();
    }
    this.syncPagesUI();
    this.scheduleCache();
    this.invalidate();
  }

  private pagesKey = '';
  private syncPagesUI() {
    const key = this.nb.pages.map((p) => `${p.id}|${p.title}|${p.background}|${p.order.length}`).join('~') + '#' + this.pageId;
    if (key === this.pagesKey) return;
    this.pagesKey = key;
    this.ui.set({
      pages: this.nb.pages.map((p) => ({ id: p.id, title: p.title, background: p.background, count: p.order.length })),
      pageId: this.pageId,
    });
  }

  // ---------- snapshots, caching, restore ----------
  private onSnapshot(nb: Notebook, info: { first: boolean; pending: PendingItem[]; restoredBy?: string }) {
    this.input.cancelGesture();
    this.nb = nb;
    for (const it of info.pending) {
      if (it.type === 'ops') for (const op of it.ops) applyOp(this.nb, op, this.hooks);
      else applyPageOp(this.nb, it.op);
    }
    if (info.first) {
      const last = localStorage.getItem(`mathboard.page.${nb.id}`);
      this.pageId = last && findPage(nb, last) ? last : nb.pages[0].id;
    } else if (!findPage(nb, this.pageId)) this.pageId = nb.pages[0].id;
    this.remoteStrokes.clear();
    this.enterPage();
    this.pagesKey = '';
    this.syncPagesUI();
    this.selChanged();
    this.updateUndoUI();
    this.invalidate();
    this.ui.set({ ready: true });
    if (info.restoredBy !== undefined) {
      this.ui.set({ restore: null });
      this.cachePaused = false;
      this.toast(info.restoredBy ? `Board restored by ${info.restoredBy}` : 'Board restored');
      this.scheduleCache();
      return;
    }
    void this.checkRestore(nb, info.pending.length > 0);
  }

  /** Server-restart safety: offer this device's copy when the server's is empty or older. */
  private async checkRestore(server: Notebook, hasPending: boolean) {
    const cached = await getCachedNotebook(server.id);
    if (this.nb !== server || this.destroyed) return;
    if (!cached || notebookIsEmpty(cached) || hasPending) { this.scheduleCache(); return; }
    const empty = notebookIsEmpty(server);
    if (empty || cached.updatedAt > server.updatedAt) {
      this.cachePaused = true; // keep the device copy intact until the user decides
      this.ui.set({ restore: { reason: empty ? 'empty' : 'older' } });
    } else this.scheduleCache();
  }

  async restoreFromDevice(): Promise<void> {
    const cached = await getCachedNotebook(this.nb.id);
    if (!cached) { this.declineRestore(); return; }
    try {
      await this.uploadNotebook(cached, async (src) => this.images.blob(src));
    } catch (err) {
      this.toast(`Restore failed: ${(err as Error).message}`, 'error');
    }
  }

  declineRestore() {
    this.cachePaused = false;
    this.ui.set({ restore: null });
    this.scheduleCache();
  }

  /**
   * Replaces the server's notebook with `nb` (device restore and JSON import).
   * Images missing on the server are re-uploaded from `getBlob` and re-linked.
   */
  async uploadNotebook(nb: Notebook, getBlob: (src: string) => Promise<Blob | null>): Promise<void> {
    const copy: Notebook = JSON.parse(JSON.stringify(nb));
    copy.id = this.nb.id;
    const remap = new Map<string, string>();
    for (const p of copy.pages) {
      for (const id of Object.keys(p.objects)) {
        const o = p.objects[id];
        if (o.type !== 'image') continue;
        if (!remap.has(o.src)) {
          let url = o.src;
          let present = false;
          if (o.src.startsWith(`/uploads/${copy.id}/`)) {
            try { present = (await fetch(o.src, { method: 'HEAD' })).ok; } catch { present = false; }
          }
          if (!present) {
            const blob = await getBlob(o.src);
            if (blob) {
              url = await uploadImage(copy.id, blob, this.opts.passcode);
              void this.images.blob(url);
            }
          }
          remap.set(o.src, url);
        }
        p.objects[id] = { ...o, src: remap.get(o.src)! };
      }
      // anything still pointing outside this notebook's uploads cannot be stored
      for (const id of Object.keys(p.objects)) {
        const o = p.objects[id];
        if (o.type === 'image' && !/^\/uploads\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.(png|jpg|gif|webp)$/.test(o.src)) {
          delete p.objects[id];
          p.order = p.order.filter((x) => x !== id);
        }
      }
    }
    const ok = await this.sync.restore(copy);
    if (!ok) throw new Error('the server did not accept the notebook');
  }

  private scheduleCache() {
    if (this.cachePaused || this.cacheTimer) return;
    this.cacheTimer = window.setTimeout(() => { this.cacheTimer = 0; this.flushCache(); }, 1500);
  }
  private flushCache() {
    if (this.cachePaused || !this.ui.get().ready) return;
    this.nb.updatedAt = Math.max(this.nb.updatedAt, this.sync.latestT);
    void putCachedNotebook(this.nb);
  }

  // ---------- presence & transient events ----------
  private onPresence(users: PresenceUser[]) {
    this.ui.set({ users });
    const alive = new Set(users.map((u) => u.sid));
    for (const m of [this.cursors, this.rulers, this.lasers, this.erasers] as Map<string, unknown>[]) {
      for (const sid of m.keys()) if (sid !== 'me' && !alive.has(sid)) m.delete(sid);
    }
    const f = this.ui.get().following;
    if (f && !alive.has(f)) this.ui.set({ following: null });
    const me = users.find((u) => u.sid === this.me.sid);
    if (me) localStorage.setItem('mathboard.color', me.color);
    this.invalidateLive();
  }

  private onLive(ev: string, d: any) {
    const now = performance.now();
    switch (ev) {
      case 'live:start':
        this.remoteStrokes.set(d.strokeId, { sid: d.sid, pageId: d.pageId, style: d.style, points: [], t: now, ended: false });
        break;
      case 'live:points': {
        const rs = this.remoteStrokes.get(d.strokeId);
        if (!rs) return;
        if (d.reset) rs.points = d.points; else for (const v of d.points) rs.points.push(v);
        rs.t = now;
        break;
      }
      case 'live:end': {
        const rs = this.remoteStrokes.get(d.strokeId);
        if (rs) { rs.ended = true; rs.t = now; }
        break;
      }
      case 'live:erase':
        if (d.active) this.erasers.set(d.sid, { x: d.x, y: d.y, r: d.r, pageId: d.pageId, t: now }); else this.erasers.delete(d.sid);
        break;
      case 'cursor':
        this.cursors.set(d.sid, { x: d.x, y: d.y, tool: d.tool, pageId: d.pageId, t: now });
        break;
      case 'laser': {
        let l = this.lasers.get(d.sid);
        if (!l) { l = { pts: [], mode: d.mode ?? 'trail', pageId: d.pageId }; this.lasers.set(d.sid, l); }
        l.mode = d.mode ?? 'trail'; l.pageId = d.pageId;
        if (l.mode === 'dot') l.pts = [];
        for (let i = 0; i + 1 < d.points.length; i += 2) l.pts.push({ x: d.points[i], y: d.points[i + 1], t: now });
        break;
      }
      case 'ruler':
        this.rulers.set(d.sid, { visible: d.visible, kind: d.kind, x: d.x, y: d.y, angle: d.angle, pageId: d.pageId });
        break;
      case 'viewport':
        if (this.ui.get().following === d.sid) this.applyFollow(d);
        return;
      case 'leave':
        this.cursors.delete(d.sid); this.rulers.delete(d.sid); this.lasers.delete(d.sid); this.erasers.delete(d.sid);
        for (const [id, rs] of this.remoteStrokes) if (rs.sid === d.sid) this.remoteStrokes.delete(id);
        break;
    }
    this.invalidateLive();
  }

  private applyFollow(d: { pageId: string; camera: Camera; vw: number; vh: number }) {
    if (d.pageId !== this.pageId && findPage(this.nb, d.pageId)) this.gotoPage(d.pageId, true);
    const w = d.vw / d.camera.zoom, h = d.vh / d.camera.zoom;
    this.fitRect([d.camera.x, d.camera.y, d.camera.x + w, d.camera.y + h], 0, MAX_ZOOM);
  }

  follow(sid: string | null) {
    if (sid && sid === this.me.sid) return;
    this.ui.set({ following: sid });
    if (sid) {
      const u = this.ui.get().users.find((x) => x.sid === sid);
      if (u?.pageId && u.pageId !== this.pageId && findPage(this.nb, u.pageId)) this.gotoPage(u.pageId, true);
      this.toast(`Following ${u?.name ?? 'collaborator'} — pan, draw or click to stop`);
    }
  }
  stopFollow() { if (this.ui.get().following) this.ui.set({ following: null }); }

  laserPoint(x: number, y: number, mode: 'trail' | 'dot') {
    let l = this.lasers.get('me');
    if (!l) { l = { pts: [], mode, pageId: this.pageId }; this.lasers.set('me', l); }
    l.mode = mode; l.pageId = this.pageId;
    if (mode === 'dot') l.pts = [];
    l.pts.push({ x, y, t: performance.now() });
    this.invalidateLive();
  }

  setRuler(patch: Partial<RulerState>) {
    this.ui.set((s) => ({ ruler: { ...s.ruler, ...patch } }));
    this.rulerDirty = true;
    this.invalidateLive();
  }

  toggleRuler(kind?: 'ruler' | 'protractor') {
    const r = this.ui.get().ruler;
    const k = kind ?? this.settings.rulerKind;
    if (r.visible && (!kind || kind === r.kind)) { this.setRuler({ visible: false }); return; }
    if (kind) this.setSettings({ rulerKind: kind });
    const [cx, cy] = this.toWorld(this.vw / 2, this.vh / 2);
    const inView = r.x > this.cam.x && r.x < this.cam.x + this.vw / this.cam.zoom && r.y > this.cam.y && r.y < this.cam.y + this.vh / this.cam.zoom;
    this.setRuler({ visible: true, kind: k, ...(inView && (r.x || r.y) ? {} : { x: Math.round(cx), y: Math.round(cy) }) });
  }

  // ---------- tools ----------
  setTool(tool: ToolId) {
    const s = this.ui.get();
    this.input.cancelGesture();
    if (s.textEdit) this.commitText(s.textEdit.text);
    if (tool !== 'select' && this.sel.size) this.setSelection([]);
    this.ui.set({ tool, popover: null });
    this.invalidateLive();
  }

  selectFav(i: number) {
    if (i < 0 || i >= this.settings.favs.length) return;
    this.setSettings({ activeFav: i });
    this.setTool('pen');
  }

  /** Style used by pen-like tools right now. */
  currentStyle(tool: 'pen' | 'highlighter', sim: boolean): StrokeStyle {
    if (tool === 'highlighter') {
      const h = this.settings.hl;
      return { pen: 'highlighter', color: h.color, size: h.size, opacity: 0.4, stab: 30, sim };
    }
    const f = this.activeFav;
    return { pen: f.pen, color: f.color, size: f.size, opacity: f.pen === 'highlighter' ? 0.4 : 1, stab: f.stab, sim };
  }

  nudgeThickness(dir: 1 | -1) {
    const s = this.ui.get();
    const step = (v: number) => Math.max(0.5, Math.min(60, Math.round((v + dir * Math.max(0.5, v * 0.15)) * 2) / 2));
    if (s.tool === 'highlighter') this.setSettings((st) => ({ hl: { ...st.hl, size: step(st.hl.size) } }));
    else this.setSettings((st) => ({ favs: st.favs.map((f, i) => (i === st.activeFav ? { ...f, size: step(f.size) } : f)) }));
  }

  // ---------- selection actions ----------
  private clone(objs: BoardObject[], dx: number, dy: number): BoardObject[] {
    return objs.map((o) => ({ ...translateObject(o, dx, dy), id: nanoid(12), authorId: this.me.userId, createdAt: Date.now(), locked: null }) as BoardObject);
  }

  deleteSelection() {
    const ids = [...this.sel];
    if (!ids.length) return;
    this.setSelection([]);
    this.commit(ids.map((id) => ({ kind: 'delete', id })));
  }

  duplicateSelection() {
    const objs = this.selObjects();
    if (!objs.length) return;
    const d = 24 / this.cam.zoom;
    const copies = this.clone(objs, d, d);
    this.commit(copies.map((obj) => ({ kind: 'add', obj })));
    this.setSelection(copies.map((c) => c.id));
  }

  /** Copies the selection to the in-app clipboard; returns the marker to place on the system clipboard. */
  copySelection(): string | null {
    const objs = this.selObjects();
    if (!objs.length) return null;
    const token = nanoid(8);
    this.clipboard = { token, objs: JSON.parse(JSON.stringify(objs)), pastes: 0 };
    return `mathboard-clip:${token}`;
  }

  pasteClipboard() {
    const c = this.clipboard;
    if (!c || !c.objs.length) return;
    c.pastes++;
    const b = unionBounds(c.objs)!;
    let dx = (24 * c.pastes) / this.cam.zoom, dy = dx;
    const v = this.viewBox();
    // if the original spot is off-screen (or another page), paste in the middle of the view
    if (b[2] + dx < v[0] || b[0] + dx > v[2] || b[3] + dy < v[1] || b[1] + dy > v[3]) {
      dx = (v[0] + v[2]) / 2 - (b[0] + b[2]) / 2;
      dy = (v[1] + v[3]) / 2 - (b[1] + b[3]) / 2;
    }
    const copies = this.clone(c.objs, dx, dy);
    if (this.ui.get().tool !== 'select') this.setTool('select');
    this.commit(copies.map((obj) => ({ kind: 'add', obj })));
    this.setSelection(copies.map((x) => x.id));
  }

  reorderSelection(to: 'front' | 'back') {
    const page = this.page;
    const ids = page.order.filter((id) => this.sel.has(id));
    if (!ids.length) return;
    const ops: OpBody[] = to === 'front'
      ? ids.map((id) => ({ kind: 'reorder', id, index: page.order.length - 1 }))
      : [...ids].reverse().map((id) => ({ kind: 'reorder', id, index: 0 }));
    this.commit(ops);
  }

  patchSelection(make: (o: BoardObject) => Record<string, unknown> | null) {
    const ops: OpBody[] = [];
    for (const o of this.selObjects()) {
      const patch = make(o);
      if (patch) ops.push({ kind: 'update', id: o.id, patch });
    }
    this.commit(ops);
  }
  recolorSelection(color: string) {
    this.patchSelection((o) => (o.type === 'stroke' || o.type === 'shape' || o.type === 'text' || o.type === 'tape' ? { color } : null));
  }
  resizeSelectionStroke(size: number) {
    this.patchSelection((o) => (o.type === 'stroke' || o.type === 'shape' ? { size } : null));
  }
  toggleLockSelection() {
    const lock = !this.selLocked();
    this.patchSelection(() => ({ locked: lock ? true : null }));
  }
  selectAll() {
    const page = this.page;
    this.setTool('select');
    this.setSelection(page.order.filter((id) => !page.objects[id]?.locked));
  }

  clearPage() {
    this.setSelection([]);
    this.commit(this.page.order.map((id) => ({ kind: 'delete', id })));
  }
  clearMyInk() {
    const page = this.page;
    this.setSelection([]);
    const mine = page.order.filter((id) => {
      const o = page.objects[id];
      return o && (o.type === 'stroke' || o.type === 'shape') && o.authorId === this.me.userId && !o.locked;
    });
    this.commit(mine.map((id) => ({ kind: 'delete', id })));
  }

  // ---------- text ----------
  beginText(at: { x: number; y: number } | BoardObject) {
    const cur = this.ui.get().textEdit;
    if (cur) this.commitText(cur.text);
    if ('type' in at) {
      if (at.type !== 'text' || at.locked) return;
      this.editingId = at.id;
      this.setSelection([]);
      this.ui.set({ textEdit: { key: ++this.textKey, id: at.id, x: at.x, y: at.y, text: at.text, fontSize: at.fontSize, color: at.color, rotation: at.rotation || 0 } });
      this.invalidateMain();
    } else {
      const t = this.settings.text;
      this.ui.set({ textEdit: { key: ++this.textKey, id: null, x: at.x, y: at.y, text: '', fontSize: t.fontSize, color: t.color, rotation: 0 } });
    }
  }

  commitText(text: string) {
    const te = this.ui.get().textEdit;
    if (!te) return;
    this.ui.set({ textEdit: null });
    this.editingId = null;
    const clean = text.replace(/\s+$/g, '');
    if (te.id) {
      const cur = this.page.objects[te.id];
      if (cur && cur.type === 'text') {
        if (!clean) this.commit([{ kind: 'delete', id: te.id }]);
        else if (clean !== cur.text) this.commit([{ kind: 'update', id: te.id, patch: { text: clean } }]);
      }
    } else if (clean) {
      this.commit([{ kind: 'add', obj: { id: nanoid(12), type: 'text', authorId: this.me.userId, createdAt: Date.now(), text: clean, x: te.x, y: te.y, fontSize: te.fontSize, color: te.color } }]);
    }
    this.invalidateMain();
  }

  insertTextAtCenter(text: string) {
    const [cx, cy] = this.toWorld(this.vw / 2, this.vh / 2);
    const t = this.settings.text;
    const id = nanoid(12);
    const trimmed = text.replace(/\r/g, '').slice(0, 5000);
    this.commit([{ kind: 'add', obj: { id, type: 'text', authorId: this.me.userId, createdAt: Date.now(), text: trimmed, x: Math.round(cx - 150), y: Math.round(cy - 20), fontSize: t.fontSize, color: t.color } }]);
    this.setTool('select');
    this.setSelection([id]);
  }

  // ---------- images ----------
  /** Shows the image immediately from the local decode, uploads it, then commits the synced object. */
  async insertImage(file: Blob, opts: { locked?: boolean; pageId?: string; rect?: { x: number; y: number; w: number; h: number }; quiet?: boolean } = {}): Promise<string | null> {
    const pageId = opts.pageId ?? this.pageId;
    const id = nanoid(12);
    try {
      const prep = await prepareImage(file);
      const v = this.viewBox();
      const rect = opts.rect ?? placeImage(prep.w, prep.h, { x: v[0], y: v[1], w: v[2] - v[0], h: v[3] - v[1] });
      const obj: ImageObj = {
        id, type: 'image', authorId: this.me.userId, createdAt: Date.now(), src: `local:${id}`,
        x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h), naturalW: prep.w, naturalH: prep.h,
      };
      this.placeholders.set(id, { obj, pageId, drawable: prep.drawable });
      this.invalidateMain();
      const url = await uploadImage(this.nb.id, prep.blob, this.opts.passcode);
      this.images.seed(url, prep.drawable, prep.blob);
      this.placeholders.delete(id);
      const locked = opts.locked ?? this.settings.autoLockImages;
      if (!findPage(this.nb, pageId)) { this.invalidateMain(); return null; }
      this.commit([{ kind: 'add', obj: { ...obj, src: url, ...(locked ? { locked: true } : {}) } }], { pageId });
      this.invalidateMain();
      return id;
    } catch (err) {
      this.placeholders.delete(id);
      this.invalidateMain();
      if (!opts.quiet) this.toast(`Could not add image: ${(err as Error).message}`, 'error');
      return null;
    }
  }

  // ---------- pages ----------
  private enterPage() {
    this.cam = this.cams.get(this.pageId) ?? { x: -40, y: -40, zoom: 1 };
    this.sel.clear();
    this.preview = null;
    this.editingId = null;
    this.ui.set({ pageId: this.pageId, zoom: this.cam.zoom, sel: null, textEdit: null, graphInteract: false });
    try { localStorage.setItem(`mathboard.page.${this.nb.id}`, this.pageId); } catch { /* ignore */ }
    this.sync?.emit('page', { pageId: this.pageId });
    this.rulerDirty = true;
    this.viewportDirty = true;
    this.dirtyRect = null;
    this.costSamples = [0, 0];
    this.updateUndoUI();
  }

  gotoPage(id: string, fromFollow = false) {
    if (id === this.pageId || !findPage(this.nb, id)) return;
    const te = this.ui.get().textEdit;
    if (te) this.commitText(te.text);
    this.input.cancelGesture();
    if (this.replay) this.stopReplay();
    if (!fromFollow) this.stopFollow();
    this.pageId = id;
    this.enterPage();
    this.syncPagesUI();
    this.invalidate();
  }

  stepPage(dir: 1 | -1) {
    const i = this.nb.pages.findIndex((p) => p.id === this.pageId);
    const next = this.nb.pages[i + dir];
    if (next) this.gotoPage(next.id);
  }

  private pageOp(op: DistOmit<PageOp, 'opId'>) {
    const full = { ...op, opId: nanoid(10) } as PageOp;
    if (!applyPageOp(this.nb, full)) return false;
    this.sync.sendPageOp(full);
    this.afterPageChange();
    return true;
  }

  addPage(title?: string, goto = true): string {
    const id = nanoid(10);
    const index = this.nb.pages.findIndex((p) => p.id === this.pageId) + 1;
    this.pageOp({ kind: 'add', page: { id, title: title ?? `Page ${this.nb.pages.length + 1}`, background: this.page.background }, index: goto ? index : this.nb.pages.length });
    if (goto) this.gotoPage(id);
    return id;
  }
  renamePage(pageId: string, title: string) {
    const t = title.trim().slice(0, 120);
    if (t) this.pageOp({ kind: 'rename', pageId, title: t });
  }
  duplicatePage(pageId: string) {
    const src = findPage(this.nb, pageId);
    if (!src) return;
    const newId = nanoid(10);
    if (this.pageOp({ kind: 'duplicate', pageId, newId, title: `${src.title} (copy)`.slice(0, 120), seed: nanoid(8) })) this.gotoPage(newId);
  }
  deletePage(pageId: string) {
    if (this.nb.pages.length <= 1) { this.toast('A notebook needs at least one page'); return; }
    this.undoStacks.delete(pageId);
    this.pageOp({ kind: 'delete', pageId });
  }
  reorderPage(pageId: string, index: number) { this.pageOp({ kind: 'reorder', pageId, index }); }
  setBackground(background: Background) { this.pageOp({ kind: 'setBackground', pageId: this.pageId, background }); }

  // ---------- ink replay (view only) ----------
  startReplay() {
    this.input.cancelGesture();
    this.setSelection([]);
    const page = this.page;
    const ink = page.order
      .map((id, i) => ({ o: page.objects[id], i }))
      .filter((x) => x.o && (x.o.type === 'stroke' || x.o.type === 'shape'))
      .sort((a, b) => a.o.createdAt - b.o.createdAt || a.i - b.i);
    if (!ink.length) { this.toast('Nothing to replay on this page yet'); return; }
    const items = new Map<string, ReplayItem>();
    let t = 0.2;
    for (const { o } of ink) {
      const dur = o.type === 'stroke' ? Math.max(0.12, Math.min(3, o.points.length / 3 / 110)) : 0.35;
      items.set(o.id, { id: o.id, start: t, dur });
      t += dur + 0.1;
    }
    this.replay = { items, t: 0, total: t + 0.2, playing: true, speed: 1, last: performance.now() };
    this.ui.set({ replay: { t: 0, total: this.replay.total, playing: true, speed: 1 }, popover: null });
    this.invalidate();
  }
  replayControl(p: { playing?: boolean; t?: number; speed?: number }) {
    const r = this.replay;
    if (!r) return;
    if (p.t !== undefined) r.t = Math.max(0, Math.min(r.total, p.t));
    if (p.speed !== undefined) r.speed = p.speed;
    if (p.playing !== undefined) {
      r.playing = p.playing;
      if (r.playing && r.t >= r.total) r.t = 0;
    }
    r.last = performance.now();
    this.ui.set({ replay: { t: r.t, total: r.total, playing: r.playing, speed: r.speed } });
    this.invalidateMain();
  }
  stopReplay() {
    this.replay = null;
    this.ui.set({ replay: null });
    this.invalidate();
  }

  /** Draws one object with a matrix (used by tools for previews). */
  drawTapePreview(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
    drawTape(ctx, { id: '', type: 'tape', authorId: '', createdAt: 0, x, y, w, h, color, revealed: false });
  }
}

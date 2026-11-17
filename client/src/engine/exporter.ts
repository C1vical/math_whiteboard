import type { jsPDF as JsPdf } from 'jspdf';
import { backgroundMarks, layoutSheets, outlineCubics, type Paper, type Sheet } from '../../../shared/exportLayout';
import { arrowHead, bboxIntersects, frameCorners, frameOf } from '../../../shared/geometry';
import { pencilAlpha, strokeOutline } from '../../../shared/ink';
import { DEFAULT_TITLE, type BBox, type BoardObject, type Notebook, type Page, type Shape, type Stroke } from '../../../shared/types';
import type { Engine } from './Engine';
import { loadGraph } from './graphLoader';
import { drawObject, paintBounds, resolveColor, type RenderEnv } from './render';

export interface ExportOptions {
  /** PDF only: the current page or every page of the notebook */
  scope: 'page' | 'notebook';
  /** PDF only */
  paper: Paper;
  /** 'cover': every tape hides what is under it. 'reveal': tape is left out (an answer-key copy). */
  tape: 'cover' | 'reveal';
  /** plain white, or the page's own grid / lines / dots */
  background: 'white' | 'page';
}

export const DEFAULT_EXPORT: ExportOptions = { scope: 'notebook', paper: 'fit', tape: 'cover', background: 'white' };

const PAD = 40;
type Drawable = ImageBitmap | HTMLImageElement;

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'mathboard';

/** File-name stem: the notebook's name, or its code while it is still unnamed. */
const notebookName = (nb: Notebook) => (nb.title && nb.title !== DEFAULT_TITLE ? nb.title : `MathBoard ${nb.id}`);

async function loadImages(e: Engine, pages: Page[]): Promise<Map<string, Drawable>> {
  // graphs are drawn by code that is loaded on first use
  if (pages.some((p) => p.order.some((id) => p.objects[id]?.type === 'graph'))) await loadGraph();
  const out = new Map<string, Drawable>();
  const srcs = new Set<string>();
  for (const p of pages) for (const id of p.order) { const o = p.objects[id]; if (o?.type === 'image') srcs.add(o.src); }
  await Promise.all([...srcs].map(async (src) => {
    const blob = await e.images.blob(src);
    if (!blob) return;
    try {
      out.set(src, await createImageBitmap(blob));
    } catch {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      await new Promise<void>((res) => { img.onload = () => res(); img.onerror = () => res(); img.src = url; });
      if (img.naturalWidth) out.set(src, img);
    }
  }));
  return out;
}

const exportEnv = (images: Map<string, Drawable>): RenderEnv => ({ dark: false, getImage: (src) => images.get(src) ?? null, imageState: () => 'error' });

/** What goes on paper, bottom to top: covering tape always ends up above the ink it hides. */
function exportObjects(page: Page, tape: ExportOptions['tape']): BoardObject[] {
  const objs: BoardObject[] = [], tapes: BoardObject[] = [];
  for (const id of page.order) {
    const o = page.objects[id];
    if (!o) continue;
    if (o.type === 'tape') { if (tape === 'cover') tapes.push({ ...o, revealed: false }); continue; }
    objs.push(o);
  }
  return [...objs, ...tapes];
}

function unionOf(boxes: BBox[]): BBox | null {
  if (!boxes.length) return null;
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const x of boxes) { a = Math.min(a, x[0]); b = Math.min(b, x[1]); c = Math.max(c, x[2]); d = Math.max(d, x[3]); }
  return [a, b, c, d];
}

function drawMarks(ctx: CanvasRenderingContext2D, page: Page, b: BBox) {
  const m = backgroundMarks(page.background, b);
  ctx.save();
  for (const [lines, color] of [[m.minor, 'rgba(40,70,120,0.13)'], [m.major, 'rgba(40,70,120,0.26)']] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const l of lines) { ctx.moveTo(l[0], l[1]); ctx.lineTo(l[2], l[3]); }
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(40,70,120,0.36)';
  for (const d of m.dots) ctx.fillRect(d[0] - 0.9, d[1] - 0.9, 1.8, 1.8);
  ctx.restore();
}

/** Renders a page's content bounds (+ padding) on white, in light-mode colours. */
function renderPage(page: Page, images: Map<string, Drawable>, maxSide: number, opts: Pick<ExportOptions, 'tape' | 'background'>): HTMLCanvasElement | null {
  const objs = exportObjects(page, opts.tape);
  const b = unionOf(objs.map(paintBounds));
  if (!b) return null;
  const view: BBox = [b[0] - PAD, b[1] - PAD, b[2] + PAD, b[3] + PAD];
  const w = view[2] - view[0], h = view[3] - view[1];
  const scale = Math.min(2, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, -view[0] * scale, -view[1] * scale);
  if (opts.background === 'page') drawMarks(ctx, page, view);
  const env = exportEnv(images);
  for (const o of objs) drawObject(ctx, o, env);
  return canvas;
}

export async function exportPagePng(e: Engine, opts: Pick<ExportOptions, 'tape' | 'background'> = DEFAULT_EXPORT): Promise<void> {
  const page = e.page;
  const canvas = renderPage(page, await loadImages(e, [page]), 8000, opts);
  if (!canvas) { e.toast('This page is empty — nothing to export'); return; }
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) { e.toast('Could not create the PNG', 'error'); return; }
  download(blob, `${safeName(`${notebookName(e.nb)} - ${page.title}`)}.png`);
}

// ---------- PDF ----------

const colorProbe = () => {
  const ctx = document.createElement('canvas').getContext('2d')!;
  const cache = new Map<string, [number, number, number]>();
  return (css: string): [number, number, number] => {
    let c = cache.get(css);
    if (!c) {
      ctx.fillStyle = '#000000';
      ctx.fillStyle = css; // an unknown colour leaves black
      const s = String(ctx.fillStyle);
      const hex = /^#([0-9a-f]{6})$/i.exec(s);
      const fn = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
      c = hex ? [parseInt(hex[1].slice(0, 2), 16), parseInt(hex[1].slice(2, 4), 16), parseInt(hex[1].slice(4, 6), 16)]
        : fn ? [Number(fn[1]), Number(fn[2]), Number(fn[3])] : [0, 0, 0];
      cache.set(css, c);
    }
    return c;
  };
};

interface Pen {
  doc: JsPdf;
  X(x: number): number;
  Y(y: number): number;
  S: number;
  rgb(css: string): [number, number, number];
  alpha(a: number): void;
}

/** Relative segments for jsPDF's `lines()` from absolute points / cubic segments. */
function relPath(start: [number, number], segs: number[][], p: Pen): { x0: number; y0: number; rel: number[][] } {
  let px = p.X(start[0]), py = p.Y(start[1]);
  const x0 = px, y0 = py;
  const rel: number[][] = [];
  for (const g of segs) {
    if (g.length === 2) {
      const x = p.X(g[0]), y = p.Y(g[1]);
      rel.push([x - px, y - py]);
      px = x; py = y;
    } else {
      const ex = p.X(g[4]), ey = p.Y(g[5]);
      rel.push([p.X(g[0]) - px, p.Y(g[1]) - py, p.X(g[2]) - px, p.Y(g[3]) - py, ex - px, ey - py]);
      px = ex; py = ey;
    }
  }
  return { x0, y0, rel };
}

/** Ink as a filled vector outline: the same shape the canvas draws, sharp at any zoom. */
function pdfStroke(p: Pen, s: Stroke) {
  const outline = strokeOutline(s, s.points);
  if (!outline.length) return;
  p.doc.setFillColor(...p.rgb(resolveColor(s.color, false)));
  p.alpha(s.pen === 'pencil' ? pencilAlpha(s, s.points) : s.opacity);
  const c = outlineCubics(outline);
  if (!c) p.doc.circle(p.X(outline[0][0]), p.Y(outline[0][1]), Math.max(0.5, s.size / 2) * p.S, 'F');
  else {
    const { x0, y0, rel } = relPath(c.start, c.segs, p);
    p.doc.lines(rel, x0, y0, [1, 1], 'F', true);
  }
  p.alpha(1);
}

function pdfShape(p: Pen, sh: Shape) {
  const { doc } = p;
  const pts = sh.points;
  doc.setDrawColor(...p.rgb(resolveColor(sh.color, false)));
  doc.setLineWidth(sh.size * p.S);
  doc.setLineCap('round');
  doc.setLineJoin('round');
  const dash = sh.dashed ? [Math.max(6, sh.size * 3) * p.S, Math.max(5, sh.size * 2.6) * p.S] : [];
  doc.setLineDashPattern(dash, 0);
  let start: [number, number];
  let segs: number[][];
  let closed = true;
  const f = frameOf(sh);
  if (f && sh.kind === 'rect') {
    const c = frameCorners(f);
    start = [c[0], c[1]];
    segs = [[c[2], c[3]], [c[4], c[5]], [c[6], c[7]]];
  } else if (f) {
    // an ellipse as four cubic arcs, rotated with its frame
    const k = 0.5522847498, rx = f.w / 2, ry = f.h / 2, cs = Math.cos(f.rot), sn = Math.sin(f.rot);
    const at = (lx: number, ly: number): [number, number] => [f.cx + lx * cs - ly * sn, f.cy + lx * sn + ly * cs];
    const arc = (c1: [number, number], c2: [number, number], e: [number, number]) => [...at(...c1), ...at(...c2), ...at(...e)];
    start = at(rx, 0);
    segs = [
      arc([rx, k * ry], [k * rx, ry], [0, ry]), arc([-k * rx, ry], [-rx, k * ry], [-rx, 0]),
      arc([-rx, -k * ry], [-k * rx, -ry], [0, -ry]), arc([k * rx, -ry], [rx, -k * ry], [rx, 0]),
    ];
  } else if (sh.kind === 'triangle' || sh.kind === 'polygon') {
    start = [pts[0], pts[1]];
    segs = [];
    for (let i = 2; i + 1 < pts.length; i += 2) segs.push([pts[i], pts[i + 1]]);
  } else {
    closed = false;
    start = [pts[0], pts[1]];
    segs = [[pts[2], pts[3]]];
  }
  const { x0, y0, rel } = relPath(start, segs, p);
  if (closed && sh.fill) {
    doc.setFillColor(...p.rgb(resolveColor(sh.fill, false)));
    p.alpha(sh.fillOpacity ?? 0.25);
    doc.lines(rel, x0, y0, [1, 1], 'F', true);
    p.alpha(1);
  }
  doc.lines(rel, x0, y0, [1, 1], 'S', closed);
  if (sh.kind === 'arrow' || sh.kind === 'doubleArrow') {
    doc.setLineDashPattern([], 0);
    const heads = [arrowHead(pts[2], pts[3], pts[0], pts[1], sh.size)];
    if (sh.kind === 'doubleArrow') heads.push(arrowHead(pts[0], pts[1], pts[2], pts[3], sh.size));
    for (const h of heads) {
      const r = relPath([h[0], h[1]], [[h[2], h[3]], [h[4], h[5]]], p);
      doc.lines(r.rel, r.x0, r.y0, [1, 1], 'S', false);
    }
  }
  doc.setLineDashPattern([], 0);
}

interface Raster { data: string; format: 'JPEG' | 'PNG'; b: BBox }

function isOpaque(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return false;
  return true;
}

/**
 * Images, text, graphs, axes and tape are placed as pictures of their own, at 300 dpi or
 * better for the paper (an image never above its own resolution), so z-order with the vector
 * ink is kept exactly.
 */
function rasterize(o: BoardObject, pxPerUnit: number, env: RenderEnv): Raster | null {
  const b = paintBounds(o);
  const w = b[2] - b[0], h = b[3] - b[1];
  if (!(w > 0) || !(h > 0)) return null;
  let k = pxPerUnit;
  if (o.type === 'image' && o.w > 0) k = Math.min(k, Math.max(1, (o.naturalW * (o.crop?.w ?? 1)) / o.w));
  k = Math.min(k, 4096 / Math.max(w, h), Math.sqrt(12e6 / (w * h)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.setTransform(canvas.width / w, 0, 0, canvas.height / h, (-b[0] * canvas.width) / w, (-b[1] * canvas.height) / h);
  drawObject(ctx, o, env);
  // photographs and screenshots without transparency go in as JPEG (small, embedded as is)
  if (o.type === 'image' && isOpaque(ctx, canvas.width, canvas.height)) return { data: canvas.toDataURL('image/jpeg', 0.92), format: 'JPEG', b };
  return { data: canvas.toDataURL('image/png'), format: 'PNG', b };
}

function drawSheet(doc: JsPdf, sheet: Sheet, page: Page, objs: BoardObject[], boxes: BBox[], opts: ExportOptions, env: RenderEnv, rasters: Map<string, Raster | null>, pen: Omit<Pen, 'X' | 'Y' | 'S'>) {
  const S = sheet.scale;
  const p: Pen = { ...pen, S, X: (x) => sheet.ox + (x - sheet.src[0]) * S, Y: (y) => sheet.oy + (y - sheet.src[1]) * S };
  const sw = (sheet.src[2] - sheet.src[0]) * S, sh = (sheet.src[3] - sheet.src[1]) * S;
  doc.saveGraphicsState();
  if (sheet.clip) {
    doc.rect(sheet.ox, sheet.oy, sw, sh, null);
    doc.clip();
    doc.discardPath();
  }
  if (opts.background === 'page') {
    const m = backgroundMarks(page.background, sheet.src);
    doc.setLineCap('butt');
    doc.setLineDashPattern([], 0);
    for (const [lines, color, width] of [[m.minor, [229, 233, 240], 0.5], [m.major, [201, 209, 222], 0.6]] as const) {
      if (!lines.length) continue;
      doc.setDrawColor(color[0], color[1], color[2]);
      doc.setLineWidth(width);
      for (const l of lines) doc.line(p.X(l[0]), p.Y(l[1]), p.X(l[2]), p.Y(l[3]));
    }
    if (m.dots.length) {
      doc.setFillColor(178, 189, 207);
      for (const d of m.dots) doc.circle(p.X(d[0]), p.Y(d[1]), Math.max(0.5, 0.9 * S), 'F');
    }
  }
  objs.forEach((o, i) => {
    if (!bboxIntersects(boxes[i], sheet.src)) return;
    try {
      if (o.type === 'stroke') pdfStroke(p, o);
      else if (o.type === 'shape') pdfShape(p, o);
      else {
        if (!rasters.has(o.id)) rasters.set(o.id, rasterize(o, (S * 300) / 72, env));
        const r = rasters.get(o.id);
        if (r) doc.addImage(r.data, r.format, p.X(r.b[0]), p.Y(r.b[1]), (r.b[2] - r.b[0]) * S, (r.b[3] - r.b[1]) * S, `${page.id}-${o.id}`, 'FAST');
      }
    } catch (err) {
      console.error('[export] object skipped', o.id, err);
    }
  });
  doc.restoreGraphicsState();
}

/**
 * PDF export. Strokes and shapes are vector paths, so ink stays sharp however far the
 * reader zooms in; everything else is embedded at print resolution.
 */
export async function exportPdf(e: Engine, opts: ExportOptions = DEFAULT_EXPORT): Promise<{ pages: number; sheets: number }> {
  const mod = await import('jspdf');
  const { jsPDF } = mod;
  const pages = opts.scope === 'page' ? [e.page] : e.nb.pages;
  const env = exportEnv(await loadImages(e, pages));
  const rgb = colorProbe();
  let doc: JsPdf | null = null;
  let sheetCount = 0;
  const GState = (mod as unknown as { GState: new (o: { opacity: number }) => unknown }).GState;
  for (const page of pages) {
    const objs = exportObjects(page, opts.tape);
    const boxes = objs.map(paintBounds);
    const sheets = layoutSheets(unionOf(boxes), boxes, opts.paper);
    const rasters = new Map<string, Raster | null>();
    for (const sheet of sheets) {
      const orientation = sheet.w > sheet.h ? 'landscape' : 'portrait';
      if (!doc) doc = new jsPDF({ unit: 'pt', format: [sheet.w, sheet.h], orientation, compress: true });
      else doc.addPage([sheet.w, sheet.h], orientation);
      const d = doc;
      let cur = 1;
      const alpha = (a: number) => {
        const v = Math.max(0, Math.min(1, Math.round(a * 100) / 100));
        if (v === cur) return;
        cur = v;
        d.setGState(new GState({ opacity: v }) as never);
      };
      drawSheet(d, sheet, page, objs, boxes, opts, env, rasters, { doc: d, rgb, alpha });
      sheetCount++;
      await new Promise((r) => setTimeout(r, 0)); // keep the page responsive between sheets
    }
  }
  if (!doc) return { pages: 0, sheets: 0 };
  const stem = opts.scope === 'page' ? `${notebookName(e.nb)} - ${e.page.title}` : notebookName(e.nb);
  download(doc.output('blob'), `${safeName(stem)}${opts.tape === 'reveal' ? ' (answer key)' : ''}.pdf`);
  return { pages: pages.length, sheets: sheetCount };
}

interface BackupFile { format: 'mathboard'; version: 1; exportedAt: string; notebook: Notebook; images: Record<string, string> }

const toDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** Full backup: the notebook plus every image it uses, embedded as data URLs. */
export async function exportNotebookJson(e: Engine): Promise<void> {
  const images: Record<string, string> = {};
  let missing = 0;
  for (const p of e.nb.pages) {
    for (const id of p.order) {
      const o = p.objects[id];
      if (o?.type !== 'image' || images[o.src]) continue;
      const blob = await e.images.blob(o.src);
      if (blob) images[o.src] = await toDataUrl(blob); else missing++;
    }
  }
  const file: BackupFile = { format: 'mathboard', version: 1, exportedAt: new Date().toISOString(), notebook: e.nb, images };
  download(new Blob([JSON.stringify(file)], { type: 'application/json' }), `${safeName(`${notebookName(e.nb)} backup ${new Date().toISOString().slice(0, 10)}`)}.json`);
  if (missing) e.toast(`${missing} image(s) could not be read and were left out of the backup`, 'error');
}

/** Restores a backup file into the current notebook (replacing its contents for everyone). */
export async function importNotebookJson(e: Engine, file: File): Promise<void> {
  let data: BackupFile;
  try {
    data = JSON.parse(await file.text()) as BackupFile;
  } catch {
    throw new Error('That file is not valid JSON');
  }
  if (!data || data.format !== 'mathboard' || !data.notebook || !Array.isArray(data.notebook.pages) || !data.notebook.pages.length) {
    throw new Error('That file is not a MathBoard backup');
  }
  const blobs = new Map<string, Blob>();
  for (const [src, url] of Object.entries(data.images ?? {})) {
    if (typeof url === 'string' && url.startsWith('data:image/')) blobs.set(src, await (await fetch(url)).blob());
  }
  await e.uploadNotebook(data.notebook, async (src) => blobs.get(src) ?? null);
}

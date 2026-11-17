import { z } from 'zod';
import { patched } from './ops';
import { CLIP_MAX_CHARS, CLIP_PREFIX, DEFAULT_TITLE, type BoardObject, type Notebook, type Page } from './types';

// Validation rules for everything that is stored: board objects, pages and notebooks.
// Shared so the server (incoming messages, files on disk) and the client (pasting board
// objects from the system clipboard) apply exactly the same rules.

export const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const num = z.number().finite().min(-1e9).max(1e9);
export const pos = z.number().finite().min(0).max(1e7);
export const color = z.string().min(1).max(32);
export const points = z.array(num).max(120000);
export const background = z.enum(['blank', 'grid', 'graph', 'lined', 'dots']);
export const penType = z.enum(['ballpoint', 'fountain', 'pencil', 'marker', 'highlighter']);
export const shapeKind = z.enum(['line', 'arrow', 'doubleArrow', 'rect', 'ellipse', 'triangle', 'polygon']);
export const title = z.string().max(200);

const base = {
  id,
  authorId: z.string().max(64),
  createdAt: z.number().finite(),
  locked: z.boolean().nullish(),
  rotation: num.nullish(),
};
const box = { x: num, y: num, w: pos, h: pos };
const range = { xMin: num, xMax: num, yMin: num, yMax: num };

export const graphExpr = z.object({ id: z.string().max(32), text: z.string().max(300), color, visible: z.boolean() });
const slidePlay = z.object({ t0: z.number().finite().min(0).max(1e14), v0: num, dir: z.union([z.literal(1), z.literal(-1)]) });
export const graphSlider = z.object({ name: z.string().min(1).max(8), min: num, max: num, step: num, value: num, play: slidePlay.nullish() });
export const axisLabel = z.string().max(24);
export const angleMode = z.enum(['rad', 'deg']);

const frac = z.number().finite().min(0).max(1);
/** crop rectangle as fractions of the source image; must stay inside it and keep some area */
export const crop = z.object({ x: frac, y: frac, w: frac.min(0.001), h: frac.min(0.001) })
  .refine((c) => c.x + c.w <= 1.000001 && c.y + c.h <= 1.000001, 'crop outside the image');

const stroke = z.object({
  ...base, type: z.literal('stroke'), pen: penType, color, size: pos.max(600), opacity: z.number().min(0).max(1),
  points, bbox: z.tuple([num, num, num, num]), stab: z.number().min(0).max(100).nullish(), sim: z.boolean().nullish(),
});
const shape = z.object({
  ...base, type: z.literal('shape'), kind: shapeKind, points: z.array(num).min(4).max(400), color, size: pos.max(600),
  dashed: z.boolean().nullish(), fill: color.nullish(), fillOpacity: z.number().min(0).max(1).nullish(),
});
const axes = z.object({
  ...base, type: z.literal('axes'), ...box, ...range, xStep: num, yStep: num,
  showNumbers: z.boolean(), mode: z.enum(['xy', 'numberLine']),
  grid: z.boolean().nullish(), xLabel: axisLabel.nullish(), yLabel: axisLabel.nullish(), piTicks: z.boolean().nullish(),
});
const image = z.object({
  ...base, type: z.literal('image'), src: z.string().regex(/^\/uploads\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\.(png|jpg|gif|webp)$/),
  ...box, naturalW: pos, naturalH: pos, crop: crop.nullish(),
});
const text = z.object({ ...base, type: z.literal('text'), text: z.string().max(20000), x: num, y: num, fontSize: pos.max(2000), color });
const graph = z.object({
  ...base, type: z.literal('graph'), ...box, ...range, showGrid: z.boolean(), showNumbers: z.boolean(),
  expressions: z.array(graphExpr).max(40), sliders: z.array(graphSlider).max(26).nullish(),
  angle: angleMode.nullish(), piTicks: z.boolean().nullish(),
});
const tape = z.object({ ...base, type: z.literal('tape'), ...box, color, revealed: z.boolean() });

export const boardObject = z.discriminatedUnion('type', [stroke, shape, axes, image, text, graph, tape]);

const FIELDS: Record<string, Record<string, unknown>> = {
  stroke: stroke.shape, shape: shape.shape, axes: axes.shape, image: image.shape, text: text.shape, graph: graph.shape, tape: tape.shape,
};

/**
 * Is `patch` a legal update of `cur`? It may only touch fields of the object's own type, and the
 * object it produces must satisfy the same rules as a newly added one. (A patch like
 * `points: []` on a shape passes the generic patch schema but would leave an object that
 * cannot be loaded again.)
 */
export function validUpdate(cur: BoardObject, patch: Record<string, unknown>): boolean {
  const fields = FIELDS[cur.type];
  if (!fields) return false;
  for (const k of Object.keys(patch)) if (!Object.prototype.hasOwnProperty.call(fields, k)) return false;
  const next = patched(cur, patch);
  // A stroke's points were checked when it was added. Unless the patch replaces them, they are
  // left out here: re-checking every number of every stroke on a recolour would stall the server.
  const probe = next.type === 'stroke' && !('points' in patch) ? { ...next, points: [] } : next;
  return boardObject.safeParse(probe).success;
}

export const page = z.object({
  id, title, background,
  objects: z.record(boardObject),
  order: z.array(id).max(200000),
});
export const notebook = z.object({
  id, title, pages: z.array(page).min(1).max(500), updatedAt: z.number().finite(),
});

/** Board objects on the system clipboard (copy / paste across tabs and boards). */
export const clipboardPayload = z.object({
  v: z.literal(1),
  token: z.string().max(40),
  board: id,
  objs: z.array(boardObject).min(1).max(20000),
});

export interface ClipboardPayload { v: 1; token: string; board: string; objs: BoardObject[] }

/** Reads board objects from clipboard text; null when it is not ours, too large or not valid. */
export function parseClipboard(text: string): ClipboardPayload | null {
  if (!text.startsWith(CLIP_PREFIX) || text.length > CLIP_MAX_CHARS + CLIP_PREFIX.length) return null;
  let raw: unknown;
  try { raw = JSON.parse(text.slice(CLIP_PREFIX.length)); } catch { return null; }
  const parsed = clipboardPayload.safeParse(raw);
  return parsed.success ? (parsed.data as ClipboardPayload) : null;
}

// ---------- salvage: keep everything that is still valid ----------

/** Drops dangling ids so `order` and `objects` always agree. */
export function sanitizePage(p: Page): Page {
  const seen = new Set<string>();
  p.order = p.order.filter((oid) => p.objects[oid] && !seen.has(oid) && !!seen.add(oid));
  for (const oid of Object.keys(p.objects)) {
    if (!seen.has(oid)) p.order.push(oid);
    if (p.objects[oid].id !== oid) p.objects[oid] = { ...p.objects[oid], id: oid };
  }
  return p;
}
export function sanitize(nb: Notebook): Notebook {
  for (const p of nb.pages) sanitizePage(p);
  return nb;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validates one stored page. Anything invalid is dropped on its own (one bad object never
 * costs the page); `dropped` says what was lost. Returns null only when the page has no usable id.
 */
export function salvagePage(raw: unknown, index: number): { page: Page | null; dropped: string[] } {
  const whole = page.safeParse(raw);
  if (whole.success) return { page: sanitizePage(whole.data as Page), dropped: [] };
  const dropped: string[] = [];
  if (!isObj(raw) || !id.safeParse(raw.id).success) return { page: null, dropped: [`page #${index + 1}: no valid id`] };
  const pid = raw.id as string;
  const out: Page = { id: pid, title: `Page ${index + 1}`, background: 'blank', objects: {}, order: [] };
  if (typeof raw.title === 'string') out.title = raw.title.slice(0, 200);
  else dropped.push(`page ${pid}: title`);
  const bg = background.safeParse(raw.background);
  if (bg.success) out.background = bg.data;
  else dropped.push(`page ${pid}: background`);
  if (isObj(raw.objects)) {
    for (const key of Object.keys(raw.objects)) {
      const parsed = id.safeParse(key).success ? boardObject.safeParse(raw.objects[key]) : null;
      if (parsed?.success) out.objects[key] = parsed.data as BoardObject;
      else dropped.push(`page ${pid}: object ${key.slice(0, 64)}`);
    }
  } else dropped.push(`page ${pid}: objects`);
  if (Array.isArray(raw.order)) out.order = raw.order.filter((v): v is string => typeof v === 'string').slice(0, 200000);
  else dropped.push(`page ${pid}: order`);
  return { page: sanitizePage(out), dropped };
}

export interface Salvaged {
  /** null when nothing usable was found */
  nb: Notebook | null;
  dropped: string[];
  /** ids of the pages that lost something (for keeping copies of the right files) */
  damagedPages: string[];
}

/** Validates a stored notebook page by page and object by object, keeping all that is valid. */
export function salvageNotebook(raw: unknown): Salvaged {
  const whole = notebook.safeParse(raw);
  if (whole.success) return { nb: sanitize(whole.data as Notebook), dropped: [], damagedPages: [] };
  if (!isObj(raw) || !Array.isArray(raw.pages)) return { nb: null, dropped: ['the file is not a notebook'], damagedPages: [] };
  const dropped: string[] = [];
  const damagedPages: string[] = [];
  const nb: Notebook = {
    id: typeof raw.id === 'string' ? raw.id : '',
    title: DEFAULT_TITLE,
    pages: [],
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
  };
  if (typeof raw.title === 'string') nb.title = raw.title.slice(0, 200);
  else dropped.push('notebook title');
  const ids = new Set<string>();
  raw.pages.slice(0, 500).forEach((p, i) => {
    const r = salvagePage(p, i);
    dropped.push(...r.dropped);
    if (!r.page) return;
    if (ids.has(r.page.id)) { dropped.push(`page ${r.page.id}: duplicate id`); return; }
    ids.add(r.page.id);
    if (r.dropped.length) damagedPages.push(r.page.id);
    nb.pages.push(r.page);
  });
  if (raw.pages.length > 500) dropped.push(`${raw.pages.length - 500} pages beyond the limit of 500`);
  if (!nb.pages.length) return { nb: null, dropped: dropped.length ? dropped : ['the notebook has no pages'], damagedPages };
  return { nb, dropped, damagedPages };
}

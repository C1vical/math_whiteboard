import type { Background, BBox } from './types';

// Page layout for PDF export: how a board page (an infinite canvas) is placed on sheets of paper.

export type Paper = 'fit' | 'letter' | 'a4';

/** Sheet sizes in PDF points (1/72 inch), portrait. */
export const PAPER_SIZE: Record<Exclude<Paper, 'fit'>, { w: number; h: number }> = {
  letter: { w: 612, h: 792 },
  a4: { w: 595.28, h: 841.89 },
};
export const MARGIN_PT = 36; // half an inch
/** padding around the content, in world units */
const FIT_PAD = 40;
const PAPER_PAD = 8;
/** Content is never enlarged beyond this many points per world unit (2x its on-screen size at 100%). */
const MAX_SCALE = 1.5;
/** Below this scale handwriting gets hard to read, so tall content is split across sheets instead. */
const MIN_READABLE = 0.5;
const MAX_SHEETS = 200;
/** PDF pages may be at most 200 inches on a side */
const MAX_PT = 14400;

export interface Sheet {
  /** sheet size in points */
  w: number;
  h: number;
  /** points per world unit */
  scale: number;
  /** world rectangle shown on this sheet */
  src: BBox;
  /** where the top-left corner of `src` lands on the sheet, in points */
  ox: number;
  oy: number;
  /** content outside `src` must be clipped away (a page split across sheets) */
  clip: boolean;
}

/**
 * Where to cut: the lowest y in [lo, hi] that does not run through any of `boxes`
 * (so a line of handwriting is not sliced in half). Falls back to `hi`.
 */
export function breakBelow(boxes: BBox[], lo: number, hi: number): number {
  const near = boxes.filter((b) => b[3] > lo && b[1] < hi);
  const cuts = (y: number) => near.some((b) => b[1] < y - 1e-6 && b[3] > y + 1e-6);
  if (!cuts(hi)) return hi;
  const candidates = new Set<number>();
  for (const b of near) {
    if (b[1] > lo && b[1] <= hi) candidates.add(b[1]);
    if (b[3] > lo && b[3] <= hi) candidates.add(b[3]);
  }
  for (const y of [...candidates].sort((a, b) => b - a)) if (!cuts(y)) return y;
  return hi;
}

/**
 * Lays a page's content out on sheets.
 * - 'fit': one sheet sized to the content (plus padding), one point per world unit.
 * - 'letter' / 'a4': the content is fitted inside the margins, landscape when that shows it
 *   larger. Content much taller than one sheet is split across portrait sheets at a readable
 *   size rather than shrunk; cuts avoid running through objects where they can.
 * `bounds` is null for an empty page (one blank sheet).
 */
export function layoutSheets(bounds: BBox | null, boxes: BBox[], paper: Paper): Sheet[] {
  if (paper === 'fit') {
    if (!bounds) return [{ w: 842, h: 595, scale: 1, src: [0, 0, 842, 595], ox: 0, oy: 0, clip: false }];
    const src: BBox = [bounds[0] - FIT_PAD, bounds[1] - FIT_PAD, bounds[2] + FIT_PAD, bounds[3] + FIT_PAD];
    const cw = src[2] - src[0], ch = src[3] - src[1];
    const scale = Math.min(1, MAX_PT / Math.max(cw, ch));
    const w = Math.max(72, cw * scale), h = Math.max(72, ch * scale);
    return [{ w, h, scale, src, ox: (w - cw * scale) / 2, oy: (h - ch * scale) / 2, clip: false }];
  }
  const size = PAPER_SIZE[paper];
  if (!bounds) return [{ w: size.w, h: size.h, scale: 1, src: [0, 0, size.w - 2 * MARGIN_PT, size.h - 2 * MARGIN_PT], ox: MARGIN_PT, oy: MARGIN_PT, clip: false }];
  const src: BBox = [bounds[0] - PAPER_PAD, bounds[1] - PAPER_PAD, bounds[2] + PAPER_PAD, bounds[3] + PAPER_PAD];
  const cw = Math.max(1, src[2] - src[0]), ch = Math.max(1, src[3] - src[1]);
  const fit = (w: number, h: number) => Math.min(MAX_SCALE, (w - 2 * MARGIN_PT) / cw, (h - 2 * MARGIN_PT) / ch);
  const portrait = fit(size.w, size.h), landscape = fit(size.h, size.w);
  const one = (w: number, h: number, scale: number): Sheet => ({
    w, h, scale, src, ox: (w - cw * scale) / 2, oy: Math.max(MARGIN_PT, Math.min((h - ch * scale) / 2, MARGIN_PT + (h - 2 * MARGIN_PT - ch * scale) * 0.25)), clip: false,
  });

  // across the width of a portrait sheet, how big would it be and how many sheets tall?
  const pw = size.w - 2 * MARGIN_PT, ph = size.h - 2 * MARGIN_PT;
  const wide = Math.min(MAX_SCALE, pw / cw);
  const best = Math.max(portrait, landscape);
  const tall = ch * wide > ph * 1.25; // clearly more than one sheet at that size
  if (!tall || best >= MIN_READABLE || wide <= best * 1.15) {
    return [landscape > portrait * 1.02 ? one(size.h, size.w, landscape) : one(size.w, size.h, portrait)];
  }

  const sheets: Sheet[] = [];
  const perSheet = ph / wide; // world units of height per sheet
  let y0 = src[1];
  while (y0 < src[3] - 1e-6 && sheets.length < MAX_SHEETS) {
    let y1 = y0 + perSheet;
    if (y1 >= src[3] - perSheet * 0.02) y1 = src[3]; // do not leave a sliver for a last sheet
    else y1 = Math.max(y0 + perSheet * 0.5, breakBelow(boxes, y0 + perSheet * 0.7, y1));
    sheets.push({ w: size.w, h: size.h, scale: wide, src: [src[0], y0, src[2], y1], ox: (size.w - cw * wide) / 2, oy: MARGIN_PT, clip: true });
    y0 = y1;
  }
  return sheets;
}

export interface BackgroundMarks {
  /** x1, y1, x2, y2 */
  minor: number[][];
  major: number[][];
  /** x, y */
  dots: number[][];
}

/** The page pattern (grid, graph paper, lines, dots) over a world rectangle, as plain geometry. */
export function backgroundMarks(bg: Background, b: BBox, maxMarks = 6000): BackgroundMarks {
  const out: BackgroundMarks = { minor: [], major: [], dots: [] };
  if (bg === 'blank') return out;
  const span = Math.max(b[2] - b[0], b[3] - b[1]);
  const thin = (step: number) => { let s = step; while (span / s > maxMarks / 4) s *= 5; return s; };
  const lines = (step: number, into: number[][], vertical: boolean, horizontal: boolean) => {
    const s = thin(step);
    if (vertical) for (let x = Math.ceil(b[0] / s) * s; x <= b[2]; x += s) into.push([x, b[1], x, b[3]]);
    if (horizontal) for (let y = Math.ceil(b[1] / s) * s; y <= b[3]; y += s) into.push([b[0], y, b[2], y]);
  };
  if (bg === 'grid') lines(40, out.minor, true, true);
  else if (bg === 'graph') {
    lines(20, out.minor, true, true);
    lines(100, out.major, true, true);
  } else if (bg === 'lined') lines(40, out.major, false, true);
  else if (bg === 'dots') {
    let s = 40;
    while (((b[2] - b[0]) / s) * ((b[3] - b[1]) / s) > maxMarks) s *= 2;
    for (let x = Math.ceil(b[0] / s) * s; x <= b[2]; x += s) for (let y = Math.ceil(b[1] / s) * s; y <= b[3]; y += s) out.dots.push([x, y]);
  }
  return out;
}

/** Cubic Bezier control points equivalent to a quadratic from p0 through control c to p1. */
export function quadToCubic(p0x: number, p0y: number, cx: number, cy: number, p1x: number, p1y: number): [number, number, number, number, number, number] {
  return [p0x + (2 / 3) * (cx - p0x), p0y + (2 / 3) * (cy - p0y), p1x + (2 / 3) * (cx - p1x), p1y + (2 / 3) * (cy - p1y), p1x, p1y];
}

/**
 * The smooth closed outline the canvas renderer draws through a perfect-freehand polygon,
 * as a start point and absolute cubic segments (c1x, c1y, c2x, c2y, x, y).
 * Returns null for degenerate outlines (drawn as a dot).
 */
export function outlineCubics(pts: number[][]): { start: [number, number]; segs: number[][] } | null {
  const n = pts.length;
  if (n < 3) return null;
  let px = (pts[0][0] + pts[1][0]) / 2, py = (pts[0][1] + pts[1][1]) / 2;
  const start: [number, number] = [px, py];
  const segs: number[][] = [];
  for (let i = 1; i <= n; i++) {
    const a = pts[i % n], b = pts[(i + 1) % n];
    const ex = (a[0] + b[0]) / 2, ey = (a[1] + b[1]) / 2;
    segs.push(quadToCubic(px, py, a[0], a[1], ex, ey));
    px = ex; py = ey;
  }
  return { start, segs };
}

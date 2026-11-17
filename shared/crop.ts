import type { Crop, ImageObj } from './types';

// Non-destructive image cropping. An image object's x, y, w, h (and rotation) describe the visible
// frame; `crop` says which part of the source image is shown, as fractions of it. The file is never
// changed, so a crop can always be widened again or reset.

export const FULL: Crop = { x: 0, y: 0, w: 1, h: 1 };
/** smallest crop, as a fraction of the source on either side */
export const MIN_CROP = 0.02;

export const cropOf = (o: Pick<ImageObj, 'crop'>): Crop => o.crop ?? FULL;

/** The whole (uncropped) source image as a frame in world space, with the object's rotation. */
export function fullFrame(o: ImageObj): { cx: number; cy: number; w: number; h: number; rot: number } {
  const c = cropOf(o);
  const fw = o.w / c.w, fh = o.h / c.h;
  const rot = o.rotation || 0;
  // centre of the full image, relative to the visible frame's centre, in the object's own axes
  const lx = (0.5 - (c.x + c.w / 2)) * fw, ly = (0.5 - (c.y + c.h / 2)) * fh;
  const cs = Math.cos(rot), sn = Math.sin(rot);
  return { cx: o.x + o.w / 2 + lx * cs - ly * sn, cy: o.y + o.h / 2 + lx * sn + ly * cs, w: fw, h: fh, rot };
}

/** Keeps a crop inside the source image and above the minimum size. */
export function clampCrop(c: Crop): Crop {
  const w = Math.max(MIN_CROP, Math.min(1, c.w)), h = Math.max(MIN_CROP, Math.min(1, c.h));
  const x = Math.max(0, Math.min(1 - w, c.x)), y = Math.max(0, Math.min(1 - h, c.y));
  return { x, y, w, h };
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

/**
 * The update that shows `next` (a crop of the source, in fractions) at the image's current scale
 * and rotation. The parts that stay visible do not move. `null` resets to the whole image.
 */
export function cropPatch(o: ImageObj, next: Crop | null): Record<string, unknown> {
  const f = fullFrame(o);
  const c = next ? clampCrop(next) : FULL;
  const full = c.x <= 1e-6 && c.y <= 1e-6 && c.w >= 1 - 1e-6 && c.h >= 1 - 1e-6;
  const w = c.w * f.w, h = c.h * f.h;
  const lx = (c.x + c.w / 2 - 0.5) * f.w, ly = (c.y + c.h / 2 - 0.5) * f.h;
  const cs = Math.cos(f.rot), sn = Math.sin(f.rot);
  const cx = f.cx + lx * cs - ly * sn, cy = f.cy + lx * sn + ly * cs;
  return {
    x: r1(cx - w / 2), y: r1(cy - h / 2), w: r1(w), h: r1(h),
    crop: full ? null : { x: r5(c.x), y: r5(c.y), w: r5(c.w), h: r5(c.h) },
  };
}

/** World point → position in the source image, as fractions (may lie outside 0..1). */
export function toImageFraction(o: ImageObj, wx: number, wy: number): [number, number] {
  const f = fullFrame(o);
  const cs = Math.cos(-f.rot), sn = Math.sin(-f.rot);
  const dx = wx - f.cx, dy = wy - f.cy;
  return [(dx * cs - dy * sn) / f.w + 0.5, (dx * sn + dy * cs) / f.h + 0.5];
}

/** Source-image fraction → world point. */
export function fromImageFraction(o: ImageObj, u: number, v: number): [number, number] {
  const f = fullFrame(o);
  const lx = (u - 0.5) * f.w, ly = (v - 0.5) * f.h;
  const cs = Math.cos(f.rot), sn = Math.sin(f.rot);
  return [f.cx + lx * cs - ly * sn, f.cy + lx * sn + ly * cs];
}

/**
 * Drags one edge or corner of a crop (hx, hy in -1 / 0 / 1, like the selection handles) to the
 * point (u, v) given in source fractions; (0, 0) moves the whole crop by (du, dv).
 */
export function dragCrop(start: Crop, hx: number, hy: number, u: number, v: number, du = 0, dv = 0): Crop {
  if (!hx && !hy) return clampCrop({ ...start, x: start.x + du, y: start.y + dv });
  let x0 = start.x, x1 = start.x + start.w, y0 = start.y, y1 = start.y + start.h;
  if (hx < 0) x0 = Math.max(0, Math.min(x1 - MIN_CROP, u));
  if (hx > 0) x1 = Math.min(1, Math.max(x0 + MIN_CROP, u));
  if (hy < 0) y0 = Math.max(0, Math.min(y1 - MIN_CROP, v));
  if (hy > 0) y1 = Math.min(1, Math.max(y0 + MIN_CROP, v));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

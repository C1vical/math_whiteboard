import type { BBox, BoardObject, Page, Shape, Stroke } from './types';

// ---------- matrices: x' = a x + c y + e ; y' = b x + d y + f ----------
export type Mat = [number, number, number, number, number, number];
export const IDENT: Mat = [1, 0, 0, 1, 0, 0];

/** Returns the matrix that applies `first`, then `second`. */
export function matMul(second: Mat, first: Mat): Mat {
  const [a1, b1, c1, d1, e1, f1] = second;
  const [a2, b2, c2, d2, e2, f2] = first;
  return [
    a1 * a2 + c1 * b2, b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2, b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1,
  ];
}
export const matTranslate = (dx: number, dy: number): Mat => [1, 0, 0, 1, dx, dy];
export function matRotateAbout(ang: number, cx: number, cy: number): Mat {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
}
export function matScaleAbout(sx: number, sy: number, cx: number, cy: number): Mat {
  return [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy];
}
export function matApply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
export const isTranslation = (m: Mat) =>
  Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[3] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9;

const r1 = (v: number) => Math.round(v * 10) / 10;

// ---------- text measuring (client installs a real canvas measurer) ----------
export const LINE_H = 1.3;
type Measurer = (text: string, fontSize: number) => { w: number; h: number };
let measurer: Measurer = (text, fontSize) => {
  const lines = text.split('\n');
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 1);
  return { w: longest * fontSize * 0.55, h: lines.length * fontSize * LINE_H };
};
export function setTextMeasurer(fn: Measurer) { measurer = fn; }
export function textSize(t: { text: string; fontSize: number }) { return measurer(t.text, t.fontSize); }

// ---------- frames & bounds ----------
export interface Frame { cx: number; cy: number; w: number; h: number; rot: number }

/** Oriented frame for box-like objects; null for strokes and vertex shapes. */
export function frameOf(o: BoardObject): Frame | null {
  const rot = o.rotation || 0;
  switch (o.type) {
    case 'image': case 'axes': case 'graph': case 'tape':
      return { cx: o.x + o.w / 2, cy: o.y + o.h / 2, w: o.w, h: o.h, rot };
    case 'text': {
      const s = textSize(o);
      return { cx: o.x + s.w / 2, cy: o.y + s.h / 2, w: s.w, h: s.h, rot };
    }
    case 'shape':
      if (o.kind === 'rect' || o.kind === 'ellipse') {
        const [x1, y1, x2, y2] = o.points;
        return { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, w: Math.abs(x2 - x1), h: Math.abs(y2 - y1), rot };
      }
      return null;
    default:
      return null;
  }
}

export function frameCorners(f: Frame): number[] {
  const c = Math.cos(f.rot), s = Math.sin(f.rot), hw = f.w / 2, hh = f.h / 2;
  const out: number[] = [];
  for (const [lx, ly] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]) {
    out.push(f.cx + lx * c - ly * s, f.cy + lx * s + ly * c);
  }
  return out;
}

export function strokeBBox(points: number[]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 3) {
    const x = points[i], y = points[i + 1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return [0, 0, 0, 0];
  return [minX, minY, maxX, maxY];
}

function xyBBox(pts: number[]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    if (pts[i] < minX) minX = pts[i]; if (pts[i] > maxX) maxX = pts[i];
    if (pts[i + 1] < minY) minY = pts[i + 1]; if (pts[i + 1] > maxY) maxY = pts[i + 1];
  }
  if (minX === Infinity) return [0, 0, 0, 0];
  return [minX, minY, maxX, maxY];
}

const boundsCache = new WeakMap<object, BBox>();

/** Axis-aligned bounds including stroke width and rotation. */
export function objBounds(o: BoardObject): BBox {
  const hit = boundsCache.get(o);
  if (hit) return hit;
  let b: BBox;
  if (o.type === 'stroke') {
    const p = o.size / 2 + 1;
    const bb = o.bbox && o.bbox.length === 4 ? o.bbox : strokeBBox(o.points);
    b = [bb[0] - p, bb[1] - p, bb[2] + p, bb[3] + p];
  } else {
    const f = frameOf(o);
    if (f) {
      const bb = xyBBox(frameCorners(f));
      const p = o.type === 'shape' ? o.size / 2 + 1 : 0;
      b = [bb[0] - p, bb[1] - p, bb[2] + p, bb[3] + p];
    } else {
      const sh = o as Shape;
      const bb = xyBBox(sh.points);
      const p = sh.size / 2 + 1 + (sh.kind === 'arrow' || sh.kind === 'doubleArrow' ? arrowLen(sh.size) : 0);
      b = [bb[0] - p, bb[1] - p, bb[2] + p, bb[3] + p];
    }
  }
  boundsCache.set(o, b);
  return b;
}

export function unionBounds(objs: BoardObject[]): BBox | null {
  if (!objs.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of objs) {
    const b = objBounds(o);
    if (b[0] < minX) minX = b[0]; if (b[1] < minY) minY = b[1];
    if (b[2] > maxX) maxX = b[2]; if (b[3] > maxY) maxY = b[3];
  }
  return [minX, minY, maxX, maxY];
}

export const bboxIntersects = (a: BBox, b: BBox) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

// ---------- translate / transform ----------
export function translateObject<T extends BoardObject>(o: T, dx: number, dy: number): T {
  if (o.type === 'stroke') {
    const pts = new Array<number>(o.points.length);
    for (let i = 0; i < o.points.length; i += 3) {
      pts[i] = r1(o.points[i] + dx); pts[i + 1] = r1(o.points[i + 1] + dy); pts[i + 2] = o.points[i + 2];
    }
    return { ...o, points: pts, bbox: strokeBBox(pts) };
  }
  if (o.type === 'shape') {
    const pts = o.points.map((v, i) => r1(v + (i % 2 === 0 ? dx : dy)));
    return { ...o, points: pts };
  }
  return { ...o, x: (o as { x: number }).x + dx, y: (o as { y: number }).y + dy };
}

/** Patch that applies affine matrix `m` to the object. Exact for similarity transforms. */
export function transformObject(o: BoardObject, m: Mat): Record<string, unknown> {
  const det = Math.abs(m[0] * m[3] - m[1] * m[2]);
  const s = Math.sqrt(det) || 1;
  if (o.type === 'stroke') {
    const pts = new Array<number>(o.points.length);
    for (let i = 0; i < o.points.length; i += 3) {
      const [x, y] = matApply(m, o.points[i], o.points[i + 1]);
      pts[i] = r1(x); pts[i + 1] = r1(y); pts[i + 2] = o.points[i + 2];
    }
    return { points: pts, size: Math.max(0.3, Math.round(o.size * s * 100) / 100) };
  }
  const f = frameOf(o);
  if (!f) {
    const sh = o as Shape;
    const pts: number[] = [];
    for (let i = 0; i + 1 < sh.points.length; i += 2) {
      const [x, y] = matApply(m, sh.points[i], sh.points[i + 1]);
      pts.push(r1(x), r1(y));
    }
    return { points: pts, size: Math.max(0.3, Math.round(sh.size * s * 100) / 100) };
  }
  const [cx, cy] = matApply(m, f.cx, f.cy);
  const c = Math.cos(f.rot), sn = Math.sin(f.rot);
  const ux = m[0] * c + m[2] * sn, uy = m[1] * c + m[3] * sn;
  const vx = -m[0] * sn + m[2] * c, vy = -m[1] * sn + m[3] * c;
  const ku = Math.hypot(ux, uy), kv = Math.hypot(vx, vy);
  let rot = Math.atan2(uy, ux);
  if (Math.abs(rot) < 1e-4) rot = 0;
  const rotation = rot === 0 ? null : Math.round(rot * 1e4) / 1e4;
  if (o.type === 'text') {
    const fontSize = Math.max(6, Math.round(o.fontSize * kv * 10) / 10);
    const k = fontSize / o.fontSize;
    return { x: r1(cx - (f.w * k) / 2), y: r1(cy - (f.h * k) / 2), fontSize, rotation };
  }
  const w = Math.max(2, f.w * ku), h = Math.max(2, f.h * kv);
  if (o.type === 'shape') {
    return {
      points: [r1(cx - w / 2), r1(cy - h / 2), r1(cx + w / 2), r1(cy + h / 2)],
      size: Math.max(0.3, Math.round(o.size * s * 100) / 100), rotation,
    };
  }
  return { x: r1(cx - w / 2), y: r1(cy - h / 2), w: r1(w), h: r1(h), rotation };
}

// ---------- distances ----------
export function distPointSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function segsIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function distSegSeg(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  if (segsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    distPointSeg(ax, ay, cx, cy, dx, dy), distPointSeg(bx, by, cx, cy, dx, dy),
    distPointSeg(cx, cy, ax, ay, bx, by), distPointSeg(dx, dy, ax, ay, bx, by),
  );
}

export function pointInPolygon(x: number, y: number, poly: number[]): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1], xj = poly[j * 2], yj = poly[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------- shape outlines ----------
export const arrowLen = (size: number) => Math.max(12, size * 4.5);

/** Arrow head polyline [x1,y1, tipX,tipY, x2,y2] for a line from (fx,fy) to the tip. */
export function arrowHead(tx: number, ty: number, fx: number, fy: number, size: number): number[] {
  const ang = Math.atan2(ty - fy, tx - fx);
  const len = arrowLen(size), spread = 0.45;
  return [
    tx - len * Math.cos(ang - spread), ty - len * Math.sin(ang - spread),
    tx, ty,
    tx - len * Math.cos(ang + spread), ty - len * Math.sin(ang + spread),
  ];
}

export function shapeOutline(sh: Shape): number[][] {
  const p = sh.points;
  switch (sh.kind) {
    case 'line': return [p.slice(0, 4)];
    case 'arrow': return [p.slice(0, 4), arrowHead(p[2], p[3], p[0], p[1], sh.size)];
    case 'doubleArrow':
      return [p.slice(0, 4), arrowHead(p[2], p[3], p[0], p[1], sh.size), arrowHead(p[0], p[1], p[2], p[3], sh.size)];
    case 'rect': {
      const c = frameCorners(frameOf(sh)!);
      return [[...c, c[0], c[1]]];
    }
    case 'ellipse': {
      const f = frameOf(sh)!;
      const out: number[] = [];
      const c = Math.cos(f.rot), s = Math.sin(f.rot);
      for (let i = 0; i <= 64; i++) {
        const t = (i / 64) * Math.PI * 2;
        const lx = (f.w / 2) * Math.cos(t), ly = (f.h / 2) * Math.sin(t);
        out.push(f.cx + lx * c - ly * s, f.cy + lx * s + ly * c);
      }
      return [out];
    }
    default:
      return [[...p, p[0], p[1]]];
  }
}

const polyCache = new WeakMap<object, number[][]>();

/** Ink geometry as xy polylines (strokes and shapes only). */
export function inkPolylines(o: Stroke | Shape): number[][] {
  const hit = polyCache.get(o);
  if (hit) return hit;
  let out: number[][];
  if (o.type === 'stroke') {
    const xy: number[] = [];
    for (let i = 0; i + 1 < o.points.length; i += 3) xy.push(o.points[i], o.points[i + 1]);
    out = [xy];
  } else out = shapeOutline(o);
  polyCache.set(o, out);
  return out;
}

function polyDistToSeg(poly: number[], ax: number, ay: number, bx: number, by: number, limit: number): boolean {
  if (poly.length === 2) return distPointSeg(poly[0], poly[1], ax, ay, bx, by) <= limit;
  for (let i = 0; i + 3 < poly.length; i += 2) {
    if (distSegSeg(poly[i], poly[i + 1], poly[i + 2], poly[i + 3], ax, ay, bx, by) <= limit) return true;
  }
  return false;
}

const isClosedShape = (o: Shape) => o.kind === 'rect' || o.kind === 'ellipse' || o.kind === 'triangle' || o.kind === 'polygon';

/** Does the swept eraser segment (radius r) touch this stroke/shape? */
export function segHitsInk(o: Stroke | Shape, ax: number, ay: number, bx: number, by: number, r: number): boolean {
  const b = objBounds(o);
  if (Math.max(ax, bx) + r < b[0] || Math.min(ax, bx) - r > b[2] || Math.max(ay, by) + r < b[1] || Math.min(ay, by) - r > b[3]) return false;
  const limit = r + o.size / 2;
  for (const poly of inkPolylines(o)) if (polyDistToSeg(poly, ax, ay, bx, by, limit)) return true;
  if (o.type === 'shape' && o.fill && isClosedShape(o)) return pointInPolygon(bx, by, inkPolylines(o)[0]);
  return false;
}

export function pointInFrame(f: Frame, x: number, y: number, pad = 0): boolean {
  const c = Math.cos(-f.rot), s = Math.sin(-f.rot);
  const dx = x - f.cx, dy = y - f.cy;
  const lx = dx * c - dy * s, ly = dx * s + dy * c;
  return Math.abs(lx) <= f.w / 2 + pad && Math.abs(ly) <= f.h / 2 + pad;
}

/** Point hit-test with tolerance r (world units). */
export function hitObject(o: BoardObject, x: number, y: number, r: number): boolean {
  const b = objBounds(o);
  if (x < b[0] - r || x > b[2] + r || y < b[1] - r || y > b[3] + r) return false;
  if (o.type === 'stroke') return segHitsInk(o, x, y, x, y, r);
  if (o.type === 'shape') {
    if (segHitsInk(o, x, y, x, y, r)) return true;
    return !!o.fill && isClosedShape(o) && pointInPolygon(x, y, inkPolylines(o)[0]);
  }
  return pointInFrame(frameOf(o)!, x, y, r);
}

function samplePoints(o: BoardObject): number[] {
  if (o.type === 'stroke' || o.type === 'shape') return inkPolylines(o).flat();
  const f = frameOf(o)!;
  return [...frameCorners(f), f.cx, f.cy];
}

/** Lasso containment: at least 70% of the object's sample points are inside. */
export function objInLasso(o: BoardObject, poly: number[]): boolean {
  const pts = samplePoints(o);
  const n = pts.length / 2;
  if (!n) return false;
  let inside = 0;
  for (let i = 0; i < n; i++) if (pointInPolygon(pts[i * 2], pts[i * 2 + 1], poly)) inside++;
  return inside / n >= 0.7;
}

export function objInRect(o: BoardObject, r: BBox): boolean {
  const b = objBounds(o);
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  const mostly = b[0] >= r[0] - 2 && b[2] <= r[2] + 2 && b[1] >= r[1] - 2 && b[3] <= r[3] + 2;
  return mostly && cx >= r[0] && cx <= r[2] && cy >= r[1] && cy <= r[3];
}

const isInk = (o: BoardObject) => (o.type === 'stroke' && o.pen !== 'highlighter') || o.type === 'shape' || o.type === 'text';
const isOpaque = (o: BoardObject) => o.type === 'image' || o.type === 'graph' || o.type === 'axes' || o.type === 'tape';

/**
 * Z-index at which a new highlighter stroke must be inserted so it sits beneath
 * all ink it overlaps (but above any image/graph under that ink).
 */
export function highlighterIndex(page: Page, bbox: BBox): number {
  let idx = page.order.length;
  for (let i = page.order.length - 1; i >= 0; i--) {
    const o = page.objects[page.order[i]];
    if (!o) continue;
    if (!bboxIntersects(objBounds(o), bbox)) continue;
    if (isOpaque(o)) break;
    if (isInk(o)) idx = i;
  }
  return idx;
}

/** Convert a shape to plain ballpoint-like stroke point lists (used by the partial eraser). */
export function shapeToStrokePoints(sh: Shape): number[][] {
  return shapeOutline(sh).map((poly) => {
    const out: number[] = [];
    for (let i = 0; i + 1 < poly.length; i += 2) {
      if (i > 0) {
        // densify long segments so partial erasing has points to work with
        const ax = poly[i - 2], ay = poly[i - 1], bx = poly[i], by = poly[i + 1];
        const n = Math.floor(Math.hypot(bx - ax, by - ay) / 12);
        for (let k = 1; k < n; k++) out.push(r1(ax + ((bx - ax) * k) / n), r1(ay + ((by - ay) * k) / n), 0.5);
      }
      out.push(r1(poly[i]), r1(poly[i + 1]), 0.5);
    }
    return out;
  });
}

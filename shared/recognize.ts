import { distPointSeg } from './geometry';
import type { ShapeKind } from './types';

export interface Recognized {
  kind: ShapeKind;
  points: number[];
  rotation?: number;
}

export interface RecognizeOpts {
  /** Screen pixels per world unit (camera zoom) — size thresholds are in screen pixels. */
  scale: number;
  /** 'auto' = ink-to-shape on pen-up (very conservative); 'hold' = draw-and-hold (explicit intent). */
  mode: 'auto' | 'hold';
}

const r1 = (v: number) => Math.round(v * 10) / 10;

function toXY(pts: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1];
    const n = out.length;
    if (n && Math.abs(out[n - 2] - x) < 1e-6 && Math.abs(out[n - 1] - y) < 1e-6) continue;
    out.push(x, y);
  }
  return out;
}

function pathLen(xy: number[]): number {
  let l = 0;
  for (let i = 2; i < xy.length; i += 2) l += Math.hypot(xy[i] - xy[i - 2], xy[i + 1] - xy[i - 1]);
  return l;
}

function resample(xy: number[], n: number): number[] {
  const total = pathLen(xy);
  if (total === 0) return xy.slice(0, 2);
  const step = total / (n - 1);
  const out = [xy[0], xy[1]];
  let acc = 0, px = xy[0], py = xy[1];
  for (let i = 2; i < xy.length; i += 2) {
    let d = Math.hypot(xy[i] - px, xy[i + 1] - py);
    while (acc + d >= step && d > 0) {
      const t = (step - acc) / d;
      px += (xy[i] - px) * t; py += (xy[i + 1] - py) * t;
      out.push(px, py);
      d = Math.hypot(xy[i] - px, xy[i + 1] - py);
      acc = 0;
    }
    acc += d; px = xy[i]; py = xy[i + 1];
  }
  while (out.length < n * 2) out.push(xy[xy.length - 2], xy[xy.length - 1]);
  return out.slice(0, n * 2);
}

/** Light moving-average smoothing (removes sensor jitter, keeps the endpoints). */
function smooth(xy: number[], radius = 2): number[] {
  const n = xy.length / 2;
  const out = xy.slice();
  for (let i = 1; i < n - 1; i++) {
    const r = Math.min(radius, i, n - 1 - i);
    let sx = 0, sy = 0;
    for (let k = i - r; k <= i + r; k++) { sx += xy[k * 2]; sy += xy[k * 2 + 1]; }
    out[i * 2] = sx / (2 * r + 1); out[i * 2 + 1] = sy / (2 * r + 1);
  }
  return out;
}

function bounds(xy: number[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < xy.length; i += 2) {
    minX = Math.min(minX, xy[i]); maxX = Math.max(maxX, xy[i]);
    minY = Math.min(minY, xy[i + 1]); maxY = Math.max(maxY, xy[i + 1]);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY, diag: Math.hypot(maxX - minX, maxY - minY) };
}

function maxDeviation(xy: number[], from: number, to: number): number {
  const ax = xy[from * 2], ay = xy[from * 2 + 1], bx = xy[to * 2], by = xy[to * 2 + 1];
  let m = 0;
  for (let i = from + 1; i < to; i++) m = Math.max(m, distPointSeg(xy[i * 2], xy[i * 2 + 1], ax, ay, bx, by));
  return m;
}

function principalAngle(xy: number[]): { cx: number; cy: number; ang: number } {
  const n = xy.length / 2;
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += xy[i * 2]; cy += xy[i * 2 + 1]; }
  cx /= n; cy /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xy[i * 2] - cx, dy = xy[i * 2 + 1] - cy;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  return { cx, cy, ang: 0.5 * Math.atan2(2 * sxy, sxx - syy) };
}

// ---------- open shapes ----------
function tryLine(xy: number[], len: number, o: RecognizeOpts): Recognized | null {
  const n = xy.length / 2;
  const chord = Math.hypot(xy[n * 2 - 2] - xy[0], xy[n * 2 - 1] - xy[1]);
  if (chord <= 0) return null;
  const auto = o.mode === 'auto';
  if (auto && chord * o.scale < 120) return null;
  if (!auto && chord * o.scale < 12) return null;
  if (maxDeviation(xy, 0, n - 1) / chord > (auto ? 0.035 : 0.1)) return null;
  if (len / chord > (auto ? 1.06 : 1.2)) return null;
  return { kind: 'line', points: [r1(xy[0]), r1(xy[1]), r1(xy[n * 2 - 2]), r1(xy[n * 2 - 1])] };
}

function tryArrow(xy: number[], o: RecognizeOpts): Recognized | null {
  const n = xy.length / 2;
  const sx = xy[0], sy = xy[1];
  let tip = 0, far = 0;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(xy[i * 2] - sx, xy[i * 2 + 1] - sy);
    if (d > far) { far = d; tip = i; }
  }
  if (tip < 4 || tip >= n - 3) return null;
  const tx = xy[tip * 2], ty = xy[tip * 2 + 1];
  const shaft = far;
  const auto = o.mode === 'auto';
  if (shaft * o.scale < (auto ? 100 : 30)) return null;
  if (maxDeviation(xy, 0, tip) / shaft > (auto ? 0.04 : 0.08)) return null;
  const ux = (tx - sx) / shaft, uy = (ty - sy) / shaft;
  let headLen = 0, left = 0, right = 0, back = 0;
  for (let i = tip + 1; i < n; i++) {
    const px = xy[i * 2], py = xy[i * 2 + 1];
    headLen += Math.hypot(px - xy[i * 2 - 2], py - xy[i * 2 - 1]);
    if (Math.hypot(px - tx, py - ty) > shaft * 0.45) return null; // head must stay near the tip
    const side = (px - sx) * -uy + (py - sy) * ux;
    left = Math.max(left, side); right = Math.max(right, -side);
    back = Math.max(back, (tx - px) * ux + (ty - py) * uy);
  }
  if (headLen < shaft * 0.12 || headLen > shaft * 1.2) return null;
  if (back < shaft * 0.05) return null;
  // needs a visible barb on at least one side, and both sides for auto mode
  const need = shaft * 0.035;
  if (auto ? left < need || right < need : Math.max(left, right) < need) return null;
  return { kind: 'arrow', points: [r1(sx), r1(sy), r1(tx), r1(ty)] };
}

// ---------- closed shapes ----------
function tryEllipse(xy: number[], o: RecognizeOpts): { shape: Recognized; err: number } | null {
  const n = xy.length / 2;
  const { ang } = principalAngle(xy);
  const c = Math.cos(-ang), s = Math.sin(-ang);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  const loc: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = xy[i * 2] * c - xy[i * 2 + 1] * s, v = xy[i * 2] * s + xy[i * 2 + 1] * c;
    loc.push(u, v);
    minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }
  const a = (maxU - minU) / 2, b = (maxV - minV) / 2;
  if (a <= 0 || b <= 0) return null;
  const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
  let sq = 0, wind = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const du = (loc[i * 2] - cu) / a, dv = (loc[i * 2 + 1] - cv) / b;
    sq += (Math.hypot(du, dv) - 1) ** 2;
    const th = Math.atan2(dv, du);
    if (i > 0) {
      let d = th - prev;
      if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
      wind += d;
    }
    prev = th;
  }
  const rms = Math.sqrt(sq / n);
  const auto = o.mode === 'auto';
  if (rms > (auto ? 0.075 : 0.14)) return null;
  const turns = Math.abs(wind) / (2 * Math.PI);
  if (turns < (auto ? 0.88 : 0.8) || turns > (auto ? 1.2 : 1.35)) return null;
  // back to world: centre and orientation
  const cc = Math.cos(ang), ss = Math.sin(ang);
  const cx = cu * cc - cv * ss, cy = cu * ss + cv * cc;
  let w = a * 2, h = b * 2, rot = ang;
  if (Math.abs(w - h) / Math.max(w, h) < 0.14) { w = h = (w + h) / 2; rot = 0; }
  const deg = (rot * 180) / Math.PI;
  const near = Math.round(deg / 90) * 90;
  if (Math.abs(deg - near) < 12) {
    if (Math.abs(near) % 180 === 90) [w, h] = [h, w];
    rot = 0;
  }
  w = r1(w); h = r1(h);
  const ex = r1(cx - w / 2), ey = r1(cy - h / 2);
  const shape: Recognized = { kind: 'ellipse', points: [ex, ey, r1(ex + w), r1(ey + h)] };
  if (rot) shape.rotation = Math.round(rot * 1e4) / 1e4;
  return { shape, err: rms * 0.35 };
}

function rdp(xy: number[], from: number, to: number, eps: number, keep: boolean[]) {
  if (to <= from + 1) return;
  const ax = xy[from * 2], ay = xy[from * 2 + 1], bx = xy[to * 2], by = xy[to * 2 + 1];
  let idx = -1, max = 0;
  for (let i = from + 1; i < to; i++) {
    const d = distPointSeg(xy[i * 2], xy[i * 2 + 1], ax, ay, bx, by);
    if (d > max) { max = d; idx = i; }
  }
  if (max > eps && idx >= 0) {
    keep[idx] = true;
    rdp(xy, from, idx, eps, keep);
    rdp(xy, idx, to, eps, keep);
  }
}

const interiorAngle = (v: number[][], i: number) => {
  const n = v.length;
  const p = v[(i + n - 1) % n], q = v[i], r = v[(i + 1) % n];
  const a1 = Math.atan2(p[1] - q[1], p[0] - q[0]), a2 = Math.atan2(r[1] - q[1], r[0] - q[0]);
  let d = Math.abs(a1 - a2);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return (d * 180) / Math.PI;
};

function tryPolygon(xy: number[], diag: number, o: RecognizeOpts): { shape: Recognized; err: number } | null {
  const auto = o.mode === 'auto';
  const n = xy.length / 2;
  // start the loop at the point farthest from the centroid (almost certainly a corner)
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += xy[i * 2]; cy += xy[i * 2 + 1]; }
  cx /= n; cy /= n;
  let start = 0, far = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(xy[i * 2] - cx, xy[i * 2 + 1] - cy);
    if (d > far) { far = d; start = i; }
  }
  const loop: number[] = [];
  for (let i = 0; i <= n; i++) { const j = (start + i) % n; loop.push(xy[j * 2], xy[j * 2 + 1]); }
  const keep: boolean[] = new Array(n + 1).fill(false);
  // split the loop at its far point so RDP has a non-degenerate chord
  let mid = 0, md = 0;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(loop[i * 2] - loop[0], loop[i * 2 + 1] - loop[1]);
    if (d > md) { md = d; mid = i; }
  }
  keep[0] = keep[mid] = true;
  const eps = diag * 0.045;
  rdp(loop, 0, mid, eps, keep);
  rdp(loop, mid, n, eps, keep);
  let verts: number[][] = [];
  for (let i = 0; i < n; i++) if (keep[i]) verts.push([loop[i * 2], loop[i * 2 + 1]]);

  // merge vertices that are very close, drop nearly-straight ones
  let changed = true;
  while (changed && verts.length > 3) {
    changed = false;
    for (let i = 0; i < verts.length; i++) {
      const j = (i + 1) % verts.length;
      if (Math.hypot(verts[i][0] - verts[j][0], verts[i][1] - verts[j][1]) < diag * 0.12) {
        verts[i] = [(verts[i][0] + verts[j][0]) / 2, (verts[i][1] + verts[j][1]) / 2];
        verts.splice(j, 1);
        changed = true;
        break;
      }
    }
    if (changed) continue;
    for (let i = 0; i < verts.length; i++) {
      if (interiorAngle(verts, i) > 152) { verts.splice(i, 1); changed = true; break; }
    }
  }
  const k = verts.length;
  if (k < 3 || k > 6) return null;

  let sum = 0, max = 0;
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (let j = 0; j < k; j++) {
      const a = verts[j], b = verts[(j + 1) % k];
      best = Math.min(best, distPointSeg(xy[i * 2], xy[i * 2 + 1], a[0], a[1], b[0], b[1]));
    }
    sum += best; max = Math.max(max, best);
  }
  const mean = sum / n / diag;
  if (mean > (auto ? 0.022 : 0.04) || max / diag > (auto ? 0.085 : 0.14)) return null;

  const angles = verts.map((_, i) => interiorAngle(verts, i));
  if (k === 4 && angles.every((a) => Math.abs(a - 90) < 18)) {
    const e = (i: number) => [verts[(i + 1) % 4][0] - verts[i][0], verts[(i + 1) % 4][1] - verts[i][1]];
    const e0 = e(0), e1 = e(1), e2 = e(2), e3 = e(3);
    let w = (Math.hypot(e0[0], e0[1]) + Math.hypot(e2[0], e2[1])) / 2;
    let h = (Math.hypot(e1[0], e1[1]) + Math.hypot(e3[0], e3[1])) / 2;
    let rot = Math.atan2(e0[1] - e2[1], e0[0] - e2[0]);
    let deg = (rot * 180) / Math.PI;
    // normalise to (-45, 45]
    while (deg > 45) { deg -= 90; [w, h] = [h, w]; }
    while (deg <= -45) { deg += 90; [w, h] = [h, w]; }
    if (Math.abs(deg) < 9) deg = 0;
    if (Math.abs(w - h) / Math.max(w, h) < 0.12) w = h = (w + h) / 2;
    const mx = (verts[0][0] + verts[1][0] + verts[2][0] + verts[3][0]) / 4;
    const my = (verts[0][1] + verts[1][1] + verts[2][1] + verts[3][1]) / 4;
    w = r1(w); h = r1(h);
    const rx = r1(mx - w / 2), ry = r1(my - h / 2);
    const shape: Recognized = { kind: 'rect', points: [rx, ry, r1(rx + w), r1(ry + h)] };
    if (deg) shape.rotation = Math.round(((deg * Math.PI) / 180) * 1e4) / 1e4;
    return { shape, err: mean };
  }
  if (k >= 5 && auto) {
    // only near-regular pentagons/hexagons: rejects letters like "D" whose arc fakes extra corners
    const sides = verts.map((v, i) => Math.hypot(verts[(i + 1) % k][0] - v[0], verts[(i + 1) % k][1] - v[1]));
    if (Math.max(...angles) > 140 || Math.max(...sides) / Math.min(...sides) > 2.2) return null;
  }
  return { shape: { kind: k === 3 ? 'triangle' : 'polygon', points: verts.flatMap((v) => [r1(v[0]), r1(v[1])]) }, err: mean };
}

/**
 * Recognises a single hand-drawn stroke as a clean shape. Deliberately conservative:
 * returns null whenever unsure, so ordinary handwriting is never converted.
 */
export function recognizeShape(pts: number[], o: RecognizeOpts): Recognized | null {
  const raw = toXY(pts);
  if (raw.length < 6) return null;
  if (pathLen(raw) <= 0) return null;
  const rs = resample(raw, 96);
  const xy = smooth(rs); // de-jittered copy for the straightness / length tests
  const len = pathLen(xy);
  const b = bounds(xy);
  if (b.diag <= 0) return null;
  const n = xy.length / 2;
  const gap = Math.hypot(xy[n * 2 - 2] - xy[0], xy[n * 2 - 1] - xy[1]);
  const auto = o.mode === 'auto';
  const closed = gap <= b.diag * 0.22 && len >= b.diag * 1.9;

  if (!closed) return tryLine(xy, len, o) ?? tryArrow(xy, o);

  const big = Math.max(b.w, b.h) * o.scale, small = Math.min(b.w, b.h) * o.scale;
  if (!auto && big < 24) return null;
  // corners are located on the unsmoothed points so they are not rounded off
  const poly = !auto || (big >= 80 && small >= 36) ? tryPolygon(rs, b.diag, o) : null;
  const ell = !auto || (big >= 90 && small >= 64) ? tryEllipse(xy, o) : null;
  if (poly && ell) return poly.err <= ell.err ? poly.shape : ell.shape;
  return (poly ?? ell)?.shape ?? null;
}

/** Fast back-and-forth zigzag (used by scribble-to-erase). */
export function isScribble(pts: number[], scale: number): boolean {
  const raw = toXY(pts);
  if (raw.length < 24) return false;
  const len = pathLen(raw);
  const b = bounds(raw);
  if (b.diag * scale < 28 || len < b.diag * 3) return false;
  const xy = resample(raw, 128);
  const { ang } = principalAngle(xy);
  const c = Math.cos(ang), s = Math.sin(ang);
  const proj: number[] = [];
  for (let i = 0; i < xy.length; i += 2) proj.push(xy[i] * c + xy[i + 1] * s);
  const extent = Math.max(...proj) - Math.min(...proj);
  if (extent <= 0) return false;
  const swing = extent * 0.3;
  let reversals = 0, dir = 0, anchor = proj[0];
  for (const p of proj) {
    if (dir >= 0 && p < anchor - swing) { if (dir > 0) reversals++; dir = -1; anchor = p; }
    else if (dir <= 0 && p > anchor + swing) { if (dir < 0) reversals++; dir = 1; anchor = p; }
    else if ((dir > 0 && p > anchor) || (dir < 0 && p < anchor) || dir === 0) anchor = dir === 0 ? anchor : p;
  }
  return reversals >= 4;
}

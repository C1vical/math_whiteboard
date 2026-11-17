import type { RulerState } from './types';

export const RULER_LEN = 1500;
export const RULER_W = 100;
export const PROT_R = 280;
export const PROT_BASE = 34; // strip below the protractor's base line
export const CM = 37.8; // world units per centimetre at 100%

const rad = (d: number) => (d * Math.PI) / 180;

export type Snap =
  | { type: 'edge'; ax: number; ay: number; bx: number; by: number }
  | { type: 'ray'; cx: number; cy: number; base: number }
  | { type: 'arc'; cx: number; cy: number; r: number };

/** World → ruler-local coordinates (u along the length, v across). */
export function toLocal(r: RulerState, px: number, py: number): [number, number] {
  const a = rad(r.angle), c = Math.cos(a), s = Math.sin(a);
  const dx = px - r.x, dy = py - r.y;
  return [dx * c + dy * s, -dx * s + dy * c];
}

export function toWorld(r: RulerState, u: number, v: number): [number, number] {
  const a = rad(r.angle), c = Math.cos(a), s = Math.sin(a);
  return [r.x + u * c - v * s, r.y + u * s + v * c];
}

export function rulerContains(r: RulerState, px: number, py: number): boolean {
  const [u, v] = toLocal(r, px, py);
  if (r.kind === 'ruler') return Math.abs(u) <= RULER_LEN / 2 && Math.abs(v) <= RULER_W / 2;
  return (v <= 0 && Math.hypot(u, v) <= PROT_R) || (v > 0 && v <= PROT_BASE && Math.abs(u) <= PROT_R);
}

export function knobPos(r: RulerState): [number, number] {
  return r.kind === 'ruler' ? toWorld(r, RULER_LEN / 2 - 50, 0) : toWorld(r, 0, -PROT_R * 0.45);
}

/** Which ruler feature (if any) a stroke starting at (px,py) should snap to. */
export function findSnap(r: RulerState, px: number, py: number, tol: number): Snap | null {
  if (!r.visible) return null;
  const [u, v] = toLocal(r, px, py);
  if (r.kind === 'ruler') {
    if (Math.abs(u) > RULER_LEN / 2 + tol) return null;
    for (const ev of [-RULER_W / 2, RULER_W / 2]) {
      if (Math.abs(v - ev) <= tol) {
        const [ax, ay] = toWorld(r, -RULER_LEN / 2, ev);
        const [bx, by] = toWorld(r, RULER_LEN / 2, ev);
        return { type: 'edge', ax, ay, bx, by };
      }
    }
    return null;
  }
  const d = Math.hypot(u, v);
  if (d <= tol * 1.2) return { type: 'ray', cx: r.x, cy: r.y, base: rad(r.angle) };
  if (Math.abs(d - PROT_R) <= tol && v <= tol) return { type: 'arc', cx: r.x, cy: r.y, r: PROT_R };
  if (Math.abs(v - PROT_BASE) <= tol && Math.abs(u) <= PROT_R + tol) {
    const [ax, ay] = toWorld(r, -PROT_R, PROT_BASE);
    const [bx, by] = toWorld(r, PROT_R, PROT_BASE);
    return { type: 'edge', ax, ay, bx, by };
  }
  return null;
}

/** Projects the pen position onto the snapped feature. */
export function snapPoint(s: Snap, px: number, py: number): [number, number] {
  if (s.type === 'edge') {
    const dx = s.bx - s.ax, dy = s.by - s.ay;
    const l2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((px - s.ax) * dx + (py - s.ay) * dy) / l2));
    return [s.ax + t * dx, s.ay + t * dy];
  }
  if (s.type === 'arc') {
    const d = Math.hypot(px - s.cx, py - s.cy) || 1;
    return [s.cx + ((px - s.cx) / d) * s.r, s.cy + ((py - s.cy) / d) * s.r];
  }
  // ray: whole-degree angle measured from the protractor's base line
  const d = Math.hypot(px - s.cx, py - s.cy);
  const rel = Math.atan2(py - s.cy, px - s.cx) - s.base;
  const snapped = rad(Math.round((rel * 180) / Math.PI)) + s.base;
  return [s.cx + d * Math.cos(snapped), s.cy + d * Math.sin(snapped)];
}

/** Angle (degrees, 0..180 measured counter-clockwise from the base) of a point on a protractor. */
export function protractorAngle(r: RulerState, px: number, py: number): number {
  const [u, v] = toLocal(r, px, py);
  let deg = (Math.atan2(-v, u) * 180) / Math.PI;
  if (deg < 0) deg += 360;
  return deg;
}

export function normDeg(d: number): number {
  d %= 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

const TARGETS = [0, 15, 30, 45, 60, 90];

/** Ruler rotation snapping: magnetic at 0/15/30/45/60/90 (+ mirrors); Shift = 5° steps. */
export function snapAngle(deg: number, fiveStep: boolean, tol = 2.5): number {
  deg = normDeg(deg);
  if (fiveStep) return normDeg(Math.round(deg / 5) * 5);
  const sign = deg < 0 ? -1 : 1;
  const a = Math.abs(deg); // 0..180
  const folded = a > 90 ? 180 - a : a; // 0..90
  for (const t of TARGETS) {
    if (Math.abs(folded - t) <= tol) return normDeg(sign * (a > 90 ? 180 - t : t));
  }
  return deg;
}

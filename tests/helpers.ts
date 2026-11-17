import { strokeBBox } from '../shared/geometry';
import type { Shape, Stroke } from '../shared/types';

/** Deterministic PRNG so "hand-drawn" fixtures are stable. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Densifies a polyline of [x,y] vertices into pen points (x,y,p) with jitter. */
export function draw(vertices: number[][], jitter = 0, seed = 1, spacing = 3): number[] {
  const r = rng(seed);
  const out: number[] = [];
  for (let i = 0; i < vertices.length - 1; i++) {
    const [ax, ay] = vertices[i], [bx, by] = vertices[i + 1];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / spacing));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      // rounded to 0.1 like real captured input
      out.push(
        Math.round((ax + ((bx - ax) * k) / n + (r() - 0.5) * 2 * jitter) * 10) / 10,
        Math.round((ay + ((by - ay) * k) / n + (r() - 0.5) * 2 * jitter) * 10) / 10,
        0.5,
      );
    }
  }
  return out;
}

/** Points along an ellipse arc (degrees), as [x,y] vertices. */
export function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number, steps = 48): number[][] {
  const out: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
}

export function mkStroke(id: string, points: number[], extra: Partial<Stroke> = {}): Stroke {
  return {
    id, type: 'stroke', authorId: 'u1', createdAt: 1, pen: 'ballpoint', color: 'ink', size: 3, opacity: 1,
    points, bbox: strokeBBox(points), ...extra,
  };
}

export function mkShape(id: string, kind: Shape['kind'], points: number[], extra: Partial<Shape> = {}): Shape {
  return { id, type: 'shape', authorId: 'u1', createdAt: 1, kind, points, color: 'ink', size: 3, ...extra };
}

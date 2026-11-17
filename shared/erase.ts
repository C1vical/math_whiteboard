import { distPointSeg, distSegSeg } from './geometry';

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Partial eraser: removes the part of a stroke covered by the capsule swept from
 * (ax,ay) to (bx,by) with radius r. Returns the surviving pieces (possibly none),
 * or null when the stroke was not touched.
 */
export function eraseStroke(points: number[], ax: number, ay: number, bx: number, by: number, r: number): number[][] | null {
  const n = Math.floor(points.length / 3);
  if (n === 0) return null;
  const inside = (x: number, y: number) => distPointSeg(x, y, ax, ay, bx, by) <= r;
  if (n === 1) return inside(points[0], points[1]) ? [] : null;

  const lerp = (i: number, t: number): [number, number, number] => {
    const a = i * 3, b = a + 3;
    return [
      points[a] + (points[b] - points[a]) * t,
      points[a + 1] + (points[b + 1] - points[a + 1]) * t,
      points[a + 2] + (points[b + 2] - points[a + 2]) * t,
    ];
  };
  // boundary between an outside parameter and an inside parameter on segment i
  const boundary = (i: number, tOut: number, tIn: number): [number, number, number] => {
    for (let k = 0; k < 14; k++) {
      const tm = (tOut + tIn) / 2;
      const p = lerp(i, tm);
      if (inside(p[0], p[1])) tIn = tm; else tOut = tm;
    }
    const p = lerp(i, tOut);
    return [r1(p[0]), r1(p[1]), Math.round(p[2] * 100) / 100];
  };

  const runs: number[][] = [];
  let run: number[] | null = null;
  let touched = false;
  let prevIn = inside(points[0], points[1]);
  if (prevIn) touched = true; else run = [points[0], points[1], points[2]];

  for (let i = 0; i < n - 1; i++) {
    const x1 = points[i * 3], y1 = points[i * 3 + 1];
    const x2 = points[i * 3 + 3], y2 = points[i * 3 + 4], p2 = points[i * 3 + 5];
    const curIn = inside(x2, y2);
    if (!prevIn && !curIn) {
      let tc = -1;
      if (distSegSeg(x1, y1, x2, y2, ax, ay, bx, by) <= r) {
        const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
        if (l2 > 0) {
          const cands = [((ax - x1) * dx + (ay - y1) * dy) / l2, ((bx - x1) * dx + (by - y1) * dy) / l2];
          // crossing point of the two segments, if any
          const ex = bx - ax, ey = by - ay, den = dx * ey - dy * ex;
          if (Math.abs(den) > 1e-12) cands.push(((ax - x1) * ey - (ay - y1) * ex) / den);
          let best = Infinity;
          for (const c of cands) {
            const t = Math.max(0, Math.min(1, c));
            const d = distPointSeg(x1 + dx * t, y1 + dy * t, ax, ay, bx, by);
            if (d < best) { best = d; tc = t; }
          }
          if (best > r) tc = -1;
        }
      }
      if (tc >= 0) {
        touched = true;
        run!.push(...boundary(i, 0, tc));
        runs.push(run!);
        run = [...boundary(i, 1, tc), x2, y2, p2];
      } else run!.push(x2, y2, p2);
    } else if (!prevIn && curIn) {
      touched = true;
      run!.push(...boundary(i, 0, 1));
      runs.push(run!);
      run = null;
    } else if (prevIn && !curIn) {
      run = [...boundary(i, 1, 0), x2, y2, p2];
    }
    prevIn = curIn;
  }
  if (run) runs.push(run);
  if (!touched) return null;

  return runs.filter((p) => {
    if (p.length < 6) return false;
    let len = 0;
    for (let i = 3; i < p.length; i += 3) len += Math.hypot(p[i] - p[i - 3], p[i + 1] - p[i - 2]);
    return len >= 0.5;
  });
}

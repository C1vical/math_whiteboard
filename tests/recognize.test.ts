import { describe, expect, it } from 'vitest';
import { isScribble, recognizeShape } from '../shared/recognize';
import { arc, draw } from './helpers';

const auto = { scale: 1, mode: 'auto' as const };
const hold = { scale: 1, mode: 'hold' as const };

describe('shape recognizer — clean shapes convert', () => {
  it('line', () => {
    for (const seed of [1, 2, 3]) {
      const r = recognizeShape(draw([[10, 10], [310, 60]], 1.2, seed), auto)!;
      expect(r.kind).toBe('line');
      expect(r.points[0]).toBeCloseTo(10, -1);
      expect(r.points[2]).toBeCloseTo(310, -1);
    }
  });

  it('triangle', () => {
    for (const seed of [1, 2, 3]) {
      const r = recognizeShape(draw([[100, 0], [220, 200], [-20, 200], [100, 0]], 1.5, seed), auto)!;
      expect(r.kind).toBe('triangle');
      expect(r.points.length).toBe(6);
    }
  });

  it('rectangle, axis-aligned when drawn roughly straight', () => {
    for (const seed of [1, 2, 3]) {
      const r = recognizeShape(draw([[0, 0], [240, 4], [238, 140], [-3, 137], [0, 0]], 1.5, seed), auto)!;
      expect(r.kind).toBe('rect');
      expect(r.rotation).toBeUndefined();
      expect(Math.abs(r.points[2] - r.points[0])).toBeCloseTo(240, -1);
      expect(Math.abs(r.points[3] - r.points[1])).toBeCloseTo(137, -1);
    }
  });

  it('square snaps to equal sides', () => {
    const r = recognizeShape(draw([[0, 0], [150, 0], [150, 158], [0, 155], [0, 0]], 1, 4), auto)!;
    expect(r.kind).toBe('rect');
    expect(Math.abs(r.points[2] - r.points[0])).toBeCloseTo(Math.abs(r.points[3] - r.points[1]), 5);
  });

  it('circle and ellipse', () => {
    for (const seed of [1, 2, 3]) {
      const c = recognizeShape(draw(arc(200, 200, 90, 90, -80, 290), 1.5, seed), auto)!;
      expect(c.kind).toBe('ellipse');
      expect(Math.abs(c.points[2] - c.points[0])).toBeCloseTo(Math.abs(c.points[3] - c.points[1]), 5); // true circle
      expect((c.points[0] + c.points[2]) / 2).toBeCloseTo(200, -1);
    }
    const e = recognizeShape(draw(arc(0, 0, 160, 80, 0, 365), 1.5, 9), auto)!;
    expect(e.kind).toBe('ellipse');
    expect(Math.abs(e.points[2] - e.points[0])).toBeGreaterThan(Math.abs(e.points[3] - e.points[1]) * 1.6);
  });

  it('arrow: a line with a hand-drawn head', () => {
    const r = recognizeShape(draw([[0, 0], [250, 0], [215, -25], [250, 0], [215, 25]], 1, 5), auto)!;
    expect(r.kind).toBe('arrow');
    expect(r.points[2]).toBeCloseTo(250, -1);
  });

  it('pentagon is a polygon', () => {
    const v = [0, 1, 2, 3, 4, 5].map((i) => [100 * Math.cos((i * 72 - 90) * Math.PI / 180), 100 * Math.sin((i * 72 - 90) * Math.PI / 180)]);
    const r = recognizeShape(draw(v, 1, 6), auto)!;
    expect(r.kind).toBe('polygon');
    expect(r.points.length).toBe(10);
  });

  it('thresholds follow the zoom level (screen size, not world size)', () => {
    const smallWorld = draw([[0, 0], [60, 1], [60, 35], [0, 34], [0, 0]], 0.3, 1, 1);
    expect(recognizeShape(smallWorld, auto)).toBeNull();
    expect(recognizeShape(smallWorld, { scale: 4, mode: 'auto' })?.kind).toBe('rect');
  });
});

describe('shape recognizer — handwriting is left alone', () => {
  const expectInk = (name: string, pts: number[]) => {
    const r = recognizeShape(pts, auto);
    expect(r, `${name} became ${r?.kind}`).toBeNull();
  };

  it('"0" (several sizes and slants)', () => {
    for (const [rx, ry] of [[9, 16], [12, 20], [14, 24], [18, 30]]) {
      for (const seed of [1, 2, 3]) expectInk('0', draw(arc(50, 50, rx, ry, -100, 280), 0.6, seed, 2));
    }
  });

  it('"o"', () => {
    for (const r of [7, 10, 14, 18]) expectInk('o', draw(arc(50, 50, r, r * 0.95, -90, 290), 0.5, r, 2));
  });

  it('"D" — even written large', () => {
    for (const h of [36, 60, 110, 160]) {
      const d = [[0, 0], [0, h], ...arc(0, h / 2, h * 0.55, h / 2, 90, -90, 24)];
      for (const seed of [1, 2]) expectInk('D', draw(d, h / 80, seed, 2));
    }
  });

  it('"+" (two strokes, or one continuous stroke)', () => {
    expectInk('+ bar', draw([[0, 15], [30, 15]], 0.5, 1, 2));
    expectInk('+ stem', draw([[15, 0], [15, 30]], 0.5, 2, 2));
    expectInk('+ single', draw([[15, 0], [15, 30], [15, 15], [0, 15], [30, 15]], 0.5, 3, 2));
  });

  it('"="', () => {
    expectInk('= top', draw([[0, 0], [32, 1]], 0.5, 1, 2));
    expectInk('= bottom', draw([[0, 10], [33, 10]], 0.5, 2, 2));
  });

  it('"7", "1", "L", "V", "Z", "N", "M"', () => {
    expectInk('7', draw([[0, 0], [26, 0], [8, 44]], 0.6, 1, 2));
    expectInk('7 big', draw([[0, 0], [90, 0], [30, 150]], 1, 1, 2));
    expectInk('1', draw([[0, 10], [9, 0], [9, 42]], 0.5, 2, 2));
    expectInk('L', draw([[0, 0], [0, 150], [90, 150]], 1, 3, 2));
    expectInk('V', draw([[0, 0], [60, 150], [120, 0]], 1, 4, 2));
    expectInk('Z', draw([[0, 0], [100, 0], [0, 130], [100, 130]], 1, 5, 2));
    expectInk('N', draw([[0, 130], [0, 0], [90, 130], [90, 0]], 1, 6, 2));
    expectInk('M', draw([[0, 130], [0, 0], [60, 80], [120, 0], [120, 130]], 1, 7, 2));
  });

  it('a short fraction bar is never anything but (at most) a straight line', () => {
    for (const w of [30, 45, 60, 80, 110]) {
      for (const seed of [1, 2, 3]) {
        const r = recognizeShape(draw([[0, 0], [w, 1]], 0.8, seed, 2), auto);
        expect(r === null || r.kind === 'line').toBe(true);
        if (w < 100) expect(r).toBeNull();
      }
    }
    // a long but wobbly bar is not "nearly straight" → stays ink
    const wobbly = draw([[0, 0], [50, 9], [100, -7], [150, 8], [200, 0]], 0.5, 1, 2);
    expect(recognizeShape(wobbly, auto)).toBeNull();
  });

  it('curves, checkmarks, "S", "C", "U", "6", "8" and integral signs', () => {
    expectInk('C', draw(arc(0, 0, 80, 100, 50, 310), 1, 1, 2));
    expectInk('U', draw([[0, 0], ...arc(60, 100, 60, 60, 180, 0), [120, 0]], 1, 2, 2));
    expectInk('S', draw([...arc(0, 0, 50, 45, -30, -270), ...arc(0, 90, 50, 45, -90, 90).slice(1), ...arc(0, 90, 50, 45, 90, 200).slice(1)], 1, 3, 2));
    expectInk('check', draw([[0, 60], [35, 100], [130, 0]], 1, 4, 2));
    expectInk('6', draw([[60, 0], [20, 60], ...arc(50, 110, 40, 40, 180, -170)], 1, 5, 2));
    expectInk('8', draw([...arc(0, 0, 40, 40, 90, 450), ...arc(0, 90, 45, 50, -90, 270).slice(1)], 1, 6, 2));
    expectInk('parabola', draw(Array.from({ length: 41 }, (_, i) => [i * 6, ((i - 20) * (i - 20)) / 2.5]), 0.8, 7, 2));
    expectInk('sqrt sign', draw([[0, 60], [15, 55], [35, 110], [70, 0], [220, 0]], 1, 8, 2));
  });
});

describe('draw-and-hold is more permissive (explicit intent)', () => {
  it('recognises small shapes that auto mode refuses', () => {
    const small = draw(arc(0, 0, 20, 20, 0, 360), 0.4, 1, 2);
    expect(recognizeShape(small, auto)).toBeNull();
    expect(recognizeShape(small, hold)?.kind).toBe('ellipse');
    expect(recognizeShape(draw([[0, 0], [50, 2]], 0.5, 1, 2), hold)?.kind).toBe('line');
  });
});

describe('scribble detection', () => {
  it('detects a fast zigzag but not ordinary writing or shading strokes', () => {
    const zig: number[][] = [];
    for (let i = 0; i < 8; i++) zig.push([i % 2 ? 80 : 0, i * 5]);
    expect(isScribble(draw(zig, 0.8, 1, 2), 1)).toBe(true);
    expect(isScribble(draw([[0, 0], [100, 0]], 0.5, 1, 2), 1)).toBe(false);
    expect(isScribble(draw(arc(0, 0, 40, 40, 0, 360), 0.5, 1, 2), 1)).toBe(false);
    expect(isScribble(draw([[0, 0], [60, 60], [120, 0]], 0.5, 1, 2), 1)).toBe(false);
    expect(isScribble(draw([[0, 0], [40, 0], [0, 6], [40, 6]], 0.5, 1, 2), 1)).toBe(false); // "Z"-like, 2 reversals
  });
});

import { describe, expect, it } from 'vitest';
import {
  compileGraph, contourImplicit, findPOIs, findRoots, findTurningPoints, fitYRange, formatCoord, formatTick, nearestCurvePoint, niceStep, preprocess,
  sampleFunction, sliderDirAt, sliderValueAt, SLIDER_SWEEP_MS, splitRestriction,
} from '../shared/graph';
import { formatPi, piStep } from '../shared/ticks';

const one = (text: string, sliders: Record<string, number> = {}) => compileGraph([{ id: 'e', text }], sliders).items[0];
const fn = (text: string, sliders: Record<string, number> = {}) => {
  const it = one(text, sliders);
  if (it.kind !== 'fn') throw new Error(`${text} → ${it.kind}: ${it.error}`);
  return it.fn!;
};

/** true if any drawn segment spans x = at */
const crosses = (paths: number[][], at: number) =>
  paths.some((p) => {
    for (let i = 2; i < p.length; i += 2) if ((p[i - 2] - at) * (p[i] - at) < 0) return true;
    return false;
  });

describe('graph parser', () => {
  it('implicit multiplication and powers', () => {
    expect(fn('y = 2x^2 - 3x + 1')(3)).toBeCloseTo(10);
    expect(fn('2x^2')(3)).toBeCloseTo(18);
    expect(fn('y = 3(x+1)')(2)).toBeCloseTo(9);
    expect(fn('y = 2pi')(0)).toBeCloseTo(2 * Math.PI);
    expect(fn('y = x(x+1)')(3)).toBeCloseTo(12);
    expect(fn('y = (x+1)(x-1)')(3)).toBeCloseTo(8);
    expect(fn('y = -x^2')(3)).toBeCloseTo(-9);
    expect(fn('y = 2^x')(3)).toBeCloseTo(8);
    expect(fn('y=e^x')(1)).toBeCloseTo(Math.E);
    expect(fn('y = 1/2x')(4)).toBeCloseTo(2);
  });

  it('functions, ln/log and absolute value bars', () => {
    expect(fn('y = sin(x)')(Math.PI / 2)).toBeCloseTo(1);
    expect(fn('y = ln(x)')(Math.E)).toBeCloseTo(1);
    expect(fn('y = log(x)')(1000)).toBeCloseTo(3);
    expect(fn('y=|x|')(-4)).toBeCloseTo(4);
    expect(fn('y = |x - 2| + 1')(-1)).toBeCloseTo(4);
    expect(fn('y = 2|x|')(-3)).toBeCloseTo(6);
    expect(fn('y = ||x| - 3|')(1)).toBeCloseTo(2);
    expect(fn('y = sqrt(x-2)')(6)).toBeCloseTo(2);
    expect(fn('y = sqrt(x-2)')(1)).toBeNaN();
    expect(fn('y = ln(x)')(-1)).toBeNaN();
    expect(fn('y = tan(x)')(Math.PI / 4)).toBeCloseTo(1);
    expect(preprocess('y = |x|')).toBe('y = abs(x)');
  });

  it('f(x) definitions can be reused, in any order', () => {
    const g = compileGraph([
      { id: 'a', text: 'y = f(x-1) + 2' },
      { id: 'b', text: 'f(x) = x^2' },
      { id: 'c', text: 'g(t) = 2t + 1' },
      { id: 'd', text: 'y = g(f(x))' },
    ]);
    expect(g.items.map((i) => i.kind)).toEqual(['fn', 'fn', 'fn', 'fn']);
    expect(g.items[0].fn!(4)).toBeCloseTo(11);
    expect(g.items[1].fn!(3)).toBeCloseTo(9);
    expect(g.items[3].fn!(3)).toBeCloseTo(19);
    expect(g.params).toEqual([]);
  });

  it('vertical lines and points', () => {
    expect(one('x = 3')).toMatchObject({ kind: 'vline', value: 3, rel: '=' });
    expect(one('x = 2pi').value).toBeCloseTo(2 * Math.PI);
    expect(one('(2, 3)')).toMatchObject({ kind: 'point', point: [2, 3] });
    expect(one('(-1.5, sqrt(4))')).toMatchObject({ kind: 'point', point: [-1.5, 2] });
    // (x+1)(x-1) is a function, not a point
    expect(one('(x+1)(x-1)').kind).toBe('fn');
  });

  it('inequalities', () => {
    expect(one('y > 2x + 1')).toMatchObject({ kind: 'fn', rel: '>' });
    expect(one('y <= x^2')).toMatchObject({ kind: 'fn', rel: '<=' });
    expect(one('y ≥ x')).toMatchObject({ kind: 'fn', rel: '>=' });
    expect(one('x^2 < y')).toMatchObject({ kind: 'fn', rel: '>' });
    expect(one('x < 2')).toMatchObject({ kind: 'vline', rel: '<', value: 2 });
    expect(one('y > 2x + 1').fn!(1)).toBeCloseTo(3);
  });

  it('auto sliders for unknown single letters', () => {
    const g = compileGraph([{ id: 'a', text: 'y = a x^2 + b' }, { id: 'b', text: '(a, b)' }], { a: 2, b: -1 });
    expect(g.params).toEqual(['a', 'b']);
    expect(g.items[0].fn!(3)).toBeCloseTo(17);
    expect(g.items[1].point).toEqual([2, -1]);
    // default value when the slider does not exist yet
    expect(compileGraph([{ id: 'a', text: 'y = k x' }]).items[0].fn!(5)).toBeCloseTo(5);
    // constants are not sliders
    expect(compileGraph([{ id: 'a', text: 'y = e^x + pi' }]).params).toEqual([]);
  });

  it('invalid input never throws and reports an error', () => {
    const bad = ['y = ', 'y = 2 +* 3', 'y = foo(x)', 'y = xy', '((', 'y = y + 1', 'x = x', 'a = b = c', 'y = 1 = 2',
      'y = [1,2,3]', 'y = "hi"', 'import("fs")', 'y = x; 5', 'q + r = 5', '(1,2,3)', 'y = sqrt(', '|', 'f(x) =', 'y = cos'];
    for (const text of bad) {
      let item;
      expect(() => { item = one(text); }).not.toThrow();
      expect(item!.kind, text).toBe('error');
      expect(typeof item!.error).toBe('string');
    }
    expect(one('').kind).toBe('empty');
    expect(one('   ').kind).toBe('empty');
    // evaluation problems give NaN rather than exceptions
    expect(fn('y = 1/x')(0)).not.toBeNaN(); // ±Infinity
    expect(Number.isFinite(fn('y = 1/x')(0))).toBe(false);
    expect(fn('f(x) = f(x) + 1')(1)).toBeNaN(); // runaway recursion is cut off
  });
});

describe('graph sampler', () => {
  it('samples a parabola as one continuous path', () => {
    const p = sampleFunction(fn('y = x^2'), -10, 10, -10, 10);
    expect(p.length).toBe(1);
    expect(p[0][0]).toBe(-10);
    expect(p[0][p[0].length - 2]).toBe(10);
  });

  it('never connects across the tan(x) asymptotes', () => {
    const p = sampleFunction(fn('y = tan(x)'), -10, 10, -10, 10);
    for (let k = -3; k <= 2; k++) expect(crosses(p, Math.PI / 2 + k * Math.PI)).toBe(false);
    expect(p.length).toBe(7);
    // each branch still runs off the top and bottom of the window
    for (const branch of p.slice(1, -1)) {
      const ys = branch.filter((_, i) => i % 2 === 1);
      expect(Math.min(...ys)).toBeLessThan(-10);
      expect(Math.max(...ys)).toBeGreaterThan(10);
    }
  });

  it('never connects across the 1/x asymptote', () => {
    for (const [a, b] of [[-10, 10], [-3, 7], [-0.5, 0.5], [-100, 100]]) {
      const p = sampleFunction(fn('y = 1/x'), a, b, -10, 10);
      expect(crosses(p, 0)).toBe(false);
      expect(p.length).toBe(2);
    }
  });

  it('sqrt(x) and ln(x) simply stop where undefined', () => {
    const s = sampleFunction(fn('y = sqrt(x)'), -10, 10, -10, 10);
    expect(s.length).toBe(1);
    expect(s[0][0]).toBeGreaterThanOrEqual(0);
    expect(s[0][0]).toBeLessThan(1e-4); // reaches the domain edge
    expect(s[0][1]).toBeLessThan(0.01);
    const s2 = sampleFunction(fn('y = sqrt(x-2)'), -10, 10, -10, 10);
    expect(s2[0][0]).toBeCloseTo(2, 3);
    const l = sampleFunction(fn('y = ln(x)'), -10, 10, -10, 10);
    expect(l.length).toBe(1);
    expect(l[0][0]).toBeGreaterThan(0);
    const both = sampleFunction(fn('y = sqrt(4 - x^2)'), -10, 10, -10, 10);
    expect(both.length).toBe(1);
    expect(both[0][0]).toBeCloseTo(-2, 3);
    expect(both[0][both[0].length - 2]).toBeCloseTo(2, 3);
  });

  it('breaks at jump discontinuities but not at steep continuous parts', () => {
    expect(sampleFunction(fn('y = floor(x)'), -3.5, 3.5, -5, 5).length).toBe(8); // 7 jumps → 8 steps
    expect(sampleFunction(fn('y = x^3'), -10, 10, -10, 10).length).toBe(1);
    expect(sampleFunction(fn('y = 50x'), -10, 10, -10, 10).length).toBe(1);
    expect(sampleFunction(fn('y = |x|'), -10, 10, -10, 10).length).toBe(1);
    expect(sampleFunction(fn('y = sin(x)'), -10, 10, -2, 2).length).toBe(1);
  });

  it('refines fast oscillations and handles empty / degenerate windows', () => {
    const coarse = sampleFunction(fn('y = sin(20x)'), -10, 10, -2, 2, 100);
    expect(coarse.length).toBe(1);
    expect(coarse[0].length / 2).toBeGreaterThan(400);
    expect(sampleFunction(fn('y = sqrt(x)'), -10, -1, -10, 10)).toEqual([]);
    expect(sampleFunction(fn('y = x'), 5, 5, -1, 1)).toEqual([]);
    expect(sampleFunction(() => { return NaN; }, -1, 1, -1, 1)).toEqual([]);
  });

  it('nice ticks, labels and zoom-to-fit', () => {
    expect(niceStep(20, 10)).toBe(2);
    expect(niceStep(1, 10)).toBeCloseTo(0.1);
    expect(niceStep(7000, 7)).toBe(1000);
    expect(formatTick(0.30000000000000004, 0.1)).toBe('0.3');
    expect(formatTick(-2, 1)).toBe('-2');
    expect(formatTick(1e-17, 0.5)).toBe('0');
    const g = compileGraph([{ id: 'a', text: 'y = x^2' }, { id: 'b', text: 'y = 1000' }]);
    const r = fitYRange(g, new Set(['a']), -2, 2)!;
    expect(r[0]).toBeLessThan(0);
    expect(r[1]).toBeGreaterThan(4);
    expect(r[1]).toBeLessThan(6);
    expect(fitYRange(g, new Set(), -2, 2)).toBeNull();
  });
});

// ---------- graph upgrades (final round) ----------

const deg = (text: string) => {
  const it = compileGraph([{ id: 'e', text }], {}, { angle: 'deg' }).items[0];
  if (it.kind !== 'fn') throw new Error(`${text} → ${it.kind}: ${it.error}`);
  return it.fn!;
};

describe('degrees or radians', () => {
  it('trig functions take degrees, inverse trig answers in degrees', () => {
    expect(deg('y = sin(x)')(90)).toBeCloseTo(1);
    expect(deg('y = sin(x)')(180)).toBe(0);
    expect(deg('y = cos(x)')(60)).toBeCloseTo(0.5);
    expect(deg('y = tan(x)')(45)).toBeCloseTo(1);
    expect(deg('y = asin(x)')(1)).toBeCloseTo(90);
    expect(deg('y = arctan(x)')(1)).toBeCloseTo(45);
    expect(deg('y = sec(x)')(60)).toBeCloseTo(2);
    // user functions see the same mode, and radians stay the default
    const g = compileGraph([{ id: 'a', text: 'f(x) = sin(x)' }, { id: 'b', text: 'y = 2f(x)' }], {}, { angle: 'deg' });
    expect(g.items[1].fn!(30)).toBeCloseTo(1);
    expect(fn('y = sin(x)')(Math.PI / 2)).toBeCloseTo(1);
    expect(deg('y = x^2')(3)).toBe(9); // non-trig functions are unaffected
    // tan(90°) is an asymptote: no connecting line
    expect(crosses(sampleFunction(deg('y = tan(x)'), -360, 360, -10, 10), 90)).toBe(false);
  });
});

describe('domain restrictions', () => {
  it('y = x^2 {x > 0} and y = 2x + 1 {-1 <= x <= 3}', () => {
    const f = fn('y = x^2 {x > 0}');
    expect(f(2)).toBe(4);
    expect(f(-2)).toBeNaN();
    const p = sampleFunction(f, -10, 10, -10, 10);
    expect(p.length).toBe(1);
    expect(p[0][0]).toBeGreaterThan(0);
    expect(p[0][0]).toBeLessThan(1e-3);
    const g = fn('y = 2x + 1 {-1 <= x <= 3}');
    expect(g(-1)).toBe(-1);
    expect(g(3)).toBe(7);
    expect(g(3.01)).toBeNaN();
    const q = sampleFunction(g, -10, 10, -10, 10);
    expect(q.length).toBe(1);
    expect(q[0][0]).toBeCloseTo(-1, 4);
    expect(q[0][q[0].length - 2]).toBeCloseTo(3, 4);
  });

  it('several conditions, y conditions, sliders in bounds, and the other kinds', () => {
    expect(fn('y = x {x > 0, x < 2}')(1)).toBe(1);
    expect(fn('y = x {x > 0, x < 2}')(3)).toBeNaN();
    expect(fn('y = x^2 - 4 {y < 0}')(1)).toBe(-3);
    expect(fn('y = x^2 - 4 {y < 0}')(3)).toBeNaN();
    const s = compileGraph([{ id: 'e', text: 'y = x {x < k}' }], { k: 2 });
    expect(s.params).toEqual(['k']);
    expect(s.items[0].fn!(1.5)).toBe(1.5);
    expect(s.items[0].fn!(2.5)).toBeNaN();
    expect(one('x = 3 {0 < y < 5}')).toMatchObject({ kind: 'vline', value: 3 });
    expect(one('x = 3 {0 < y < 5}').mask!(3, 6)).toBe(false);
    expect(one('y >= x {x > 0}').fn!(-1)).toBeNaN(); // shading only where allowed
    expect(splitRestriction('y = x {x > 1}')).toEqual({ body: 'y = x', cond: 'x > 1' });
    expect(splitRestriction('y = x')).toEqual({ body: 'y = x', cond: null });
  });

  it('bad restrictions are reported, never thrown', () => {
    for (const text of ['y = x {', 'y = x {}', 'y = x {x}', 'y = x {x >}', 'y = x {x > 0} {x < 1}', 'y = x {foo(x) > 1}', 'y = {x > 0} x', 'f(x) = x {x > 0}']) {
      let item;
      expect(() => { item = one(text); }, text).not.toThrow();
      expect(item!.kind, text).toBe('error');
    }
  });
});

describe('implicit relations', () => {
  const imp = (text: string) => {
    const it = one(text);
    if (it.kind !== 'implicit') throw new Error(`${text} → ${it.kind}: ${it.error}`);
    return it.F!;
  };
  const near = (paths: number[][], test: (x: number, y: number) => boolean) => paths.every((p) => {
    for (let i = 0; i < p.length; i += 2) if (!test(p[i], p[i + 1])) return false;
    return true;
  });

  it('x^2 + y^2 = 25 is a circle of radius 5', () => {
    const paths = contourImplicit(imp('x^2 + y^2 = 25'), -10, 10, -10, 10, 160, 160);
    expect(paths.length).toBe(1); // one closed loop, no stray pieces
    const p = paths[0];
    expect(Math.hypot(p[0] - p[p.length - 2], p[1] - p[p.length - 1])).toBeLessThan(1e-9); // closed
    expect(near(paths, (x, y) => Math.abs(Math.hypot(x, y) - 5) < 0.02)).toBe(true);
    expect(p.length / 2).toBeGreaterThan(100);
  });

  it('x^2/9 + y^2/4 = 1 is an ellipse; other implicit curves and sliders work', () => {
    const paths = contourImplicit(imp('x^2/9 + y^2/4 = 1'), -10, 10, -10, 10, 160, 160);
    expect(paths.length).toBe(1);
    expect(near(paths, (x, y) => Math.abs((x * x) / 9 + (y * y) / 4 - 1) < 0.02)).toBe(true);
    const xs = paths[0].filter((_, i) => i % 2 === 0);
    expect(Math.max(...xs)).toBeCloseTo(3, 1);
    const hyper = contourImplicit(imp('x y = 1'), -5, 5, -5, 5, 120, 120);
    expect(hyper.length).toBe(2); // two branches
    expect(near(hyper, (x, y) => Math.abs(x * y - 1) < 0.05)).toBe(true);
    const g = compileGraph([{ id: 'e', text: 'x^2 + y^2 = r^2' }], { r: 3 });
    expect(g.params).toEqual(['r']);
    expect(near(contourImplicit(g.items[0].F!, -5, 5, -5, 5), (x, y) => Math.abs(Math.hypot(x, y) - 3) < 0.03)).toBe(true);
  });

  it('no stray segments across poles', () => {
    // 1/x = y has a pole along x = 0: F changes sign there for every y, but that is not a crossing
    const paths = contourImplicit(imp('1/x = y + 0'), -5, 5, -5, 5, 100, 100);
    expect(paths.length).toBeGreaterThan(0);
    expect(near(paths, (x, y) => Math.abs(x * y - 1) < 0.1)).toBe(true);
    const tanPaths = contourImplicit(imp('y - tan(x) = 0'), -5, 5, -5, 5, 100, 100);
    for (const pole of [-1.5, -0.5, 0.5, 1.5].map((k) => k * Math.PI)) expect(crosses(tanPaths, pole), `x = ${pole}`).toBe(false);
    expect(near(tanPaths, (x, y) => Math.abs(y - Math.tan(x)) < 0.2)).toBe(true);
  });

  it('a restriction clips the curve; bad input never crashes', () => {
    const half = contourImplicit(imp('x^2 + y^2 = 25 {y > 0}'), -10, 10, -10, 10);
    expect(half.length).toBeGreaterThan(0);
    expect(near(half, (_x, y) => y > -0.2)).toBe(true);
    for (const text of ['x^2 + y^2 = ', 'x^2 + y^2 < 25', '2 = 3', 'q + r = 5', 'x^2 + y^2 = foo(', 'x y = sqrt(']) {
      let item;
      expect(() => { item = one(text); }, text).not.toThrow();
      expect(item!.kind, text).toBe('error');
    }
    expect(compileGraph([{ id: 'e', text: 'q + r = 5' }]).params).toEqual([]); // no stray sliders
    expect(contourImplicit(() => NaN, -1, 1, -1, 1)).toEqual([]);
    expect(contourImplicit(() => { throw new Error('boom'); }, -1, 1, -1, 1)).toEqual([]);
    expect(contourImplicit(imp('x^2 + y^2 = 25'), 1, 1, -1, 1)).toEqual([]);
  });
});

describe('points of interest', () => {
  const pois = (texts: string[], win = [-10, 10, -10, 10]) => {
    const c = compileGraph(texts.map((text, i) => ({ id: String(i), text })));
    return findPOIs(c, new Set(texts.map((_, i) => String(i))), win[0], win[1], win[2], win[3]);
  };
  const has = (ps: { x: number; y: number; kind: string }[], x: number, y: number, kind?: string) =>
    ps.some((p) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6 && (!kind || p.kind === kind));

  it('x-intercepts, y-intercept and turning points', () => {
    const ps = pois(['y = x^2 - 4']);
    expect(has(ps, -2, 0, 'xint') && has(ps, 2, 0, 'xint')).toBe(true);
    expect(has(ps, 0, -4)).toBe(true); // the y-intercept, which is also the minimum
    expect(ps.length).toBe(3);
    // a double root (touching the axis) is still an x-intercept
    expect(has(pois(['y = (x - 3)^2']), 3, 0, 'xint')).toBe(true);
    const c = pois(['y = x^3 - 3x']);
    expect(has(c, -1, 2, 'turn') && has(c, 1, -2, 'turn')).toBe(true);
    expect(has(c, Math.sqrt(3), 0, 'xint') && has(c, 0, 0)).toBe(true);
  });

  it('intersections between visible curves, including vertical lines and implicit curves', () => {
    expect(has(pois(['y = x', 'y = 4 - x']), 2, 2, 'cross')).toBe(true);
    expect(has(pois(['y = x^2', 'x = 2']), 2, 4, 'cross')).toBe(true);
    const circ = pois(['x^2 + y^2 = 25', 'y = x']);
    expect(has(circ, 5 / Math.SQRT2, 5 / Math.SQRT2, 'cross') && has(circ, -5 / Math.SQRT2, -5 / Math.SQRT2, 'cross')).toBe(true);
    expect(has(circ, 5, 0, 'xint') && has(circ, 0, 5, 'yint')).toBe(true);
    // hidden curves are left out
    const c = compileGraph([{ id: 'a', text: 'y = x' }, { id: 'b', text: 'y = 4 - x' }]);
    expect(findPOIs(c, new Set(['a']), -10, 10, -10, 10).some((p) => p.kind === 'cross')).toBe(false);
  });

  it('asymptotes and jumps are not roots or turning points', () => {
    expect(pois(['y = 1/x']).length).toBe(0);
    expect(findRoots((x) => Math.tan(x), -3, 3).map((r) => Math.round(r * 1e6) / 1e6)).toEqual([0]);
    expect(findTurningPoints((x) => Math.floor(x), -3.5, 3.5)).toEqual([]);
    expect(findTurningPoints(() => 5, -3, 3)).toEqual([]);
    expect(pois(['y = sin(20x)']).length).toBeLessThanOrEqual(80); // capped
    expect(pois([])).toEqual([]);
  });

  it('tapping near a curve finds the point on it', () => {
    const c = compileGraph([{ id: 'a', text: 'y = x^2' }, { id: 'b', text: 'x = -3' }, { id: 'c', text: '(4, -2)' }]);
    const vis = new Set(['a', 'b', 'c']);
    const p = nearestCurvePoint(c, vis, 2.05, 4.3, 0.4, 0.4)!;
    expect(p.id).toBe('a');
    expect(p.y).toBeCloseTo(p.x * p.x, 6);
    expect(Math.hypot(p.x - 2.05, p.y - 4.3)).toBeLessThan(0.3);
    expect(nearestCurvePoint(c, vis, -3.1, 7, 0.3, 0.3)).toMatchObject({ x: -3, y: 7, id: 'b' });
    expect(nearestCurvePoint(c, vis, 4.1, -2.1, 0.3, 0.3)).toMatchObject({ x: 4, y: -2, id: 'c' });
    expect(nearestCurvePoint(c, vis, 8, -8, 0.3, 0.3)).toBeNull();
    const imp = compileGraph([{ id: 'i', text: 'x^2 + y^2 = 25' }]);
    const paths = new Map([['i', contourImplicit(imp.items[0].F!, -10, 10, -10, 10)]]);
    const q = nearestCurvePoint(imp, new Set(['i']), 0.1, 5.2, 0.4, 0.4, paths)!;
    expect(Math.hypot(q.x, q.y)).toBeCloseTo(5, 1);
    expect(formatCoord(1.41421)).toBe('1.414');
    expect(formatCoord(-0.0001)).toBe('0');
    expect(formatCoord(-2.5)).toBe('−2.5');
  });
});

describe('π tick labels', () => {
  it('steps are simple fractions or multiples of π', () => {
    expect(piStep(4 * Math.PI, 8)).toBeCloseTo(Math.PI / 2);
    expect(piStep(2 * Math.PI, 8)).toBeCloseTo(Math.PI / 4);
    expect(piStep(40 * Math.PI, 8)).toBeCloseTo(5 * Math.PI);
    expect(piStep(1, 10)).toBeCloseTo(Math.PI / 12);
  });
  it('labels read the way a teacher writes them', () => {
    const s = Math.PI / 2;
    expect([0, 1, 2, 3, 4, -1, -2, -3].map((k) => formatPi(k * s, s))).toEqual(['0', 'π/2', 'π', '3π/2', '2π', '−π/2', '−π', '−3π/2']);
    const t = Math.PI / 6;
    expect([1, 2, 3, 4, 5].map((k) => formatPi(k * t, t))).toEqual(['π/6', 'π/3', 'π/2', '2π/3', '5π/6']);
    expect(formatPi(10 * Math.PI, 5 * Math.PI)).toBe('10π');
  });
});

describe('slider play', () => {
  const sl = { min: 0, max: 10, step: 0.1, value: 2 };
  it('bounces between min and max as a function of the shared clock', () => {
    const play = { t0: 1000, v0: 2, dir: 1 as const };
    expect(sliderValueAt({ ...sl }, 5000)).toBe(2); // not playing
    expect(sliderValueAt({ ...sl, play }, 1000)).toBeCloseTo(2);
    expect(sliderValueAt({ ...sl, play }, 1000 + SLIDER_SWEEP_MS * 0.4)).toBeCloseTo(6);
    expect(sliderValueAt({ ...sl, play }, 1000 + SLIDER_SWEEP_MS * 0.8)).toBeCloseTo(10);
    expect(sliderValueAt({ ...sl, play }, 1000 + SLIDER_SWEEP_MS * 1.0)).toBeCloseTo(8); // on its way back
    expect(sliderDirAt({ ...sl, play }, 1000 + SLIDER_SWEEP_MS * 1.0)).toBe(-1);
    expect(sliderValueAt({ ...sl, play }, 1000 + SLIDER_SWEEP_MS * 2.8)).toBeCloseTo(10);
    const down = { t0: 0, v0: 2, dir: -1 as const };
    expect(sliderValueAt({ ...sl, play: down }, SLIDER_SWEEP_MS * 0.3)).toBeCloseTo(1);
    for (let t = 0; t < 30000; t += 137) {
      const v = sliderValueAt({ ...sl, play }, t);
      expect(v >= 0 && v <= 10).toBe(true);
    }
    expect(sliderValueAt({ min: 5, max: 5, step: 1, value: 5, play }, 9999)).toBe(5);
  });
});

import { describe, expect, it } from 'vitest';
import { compileGraph, fitYRange, formatTick, niceStep, preprocess, sampleFunction } from '../shared/graph';

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

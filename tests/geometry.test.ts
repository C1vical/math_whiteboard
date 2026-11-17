import { describe, expect, it } from 'vitest';
import { eraseStroke } from '../shared/erase';
import {
  highlighterIndex, hitObject, matRotateAbout, matScaleAbout, objBounds, objInLasso, segHitsInk, transformObject,
} from '../shared/geometry';
import { downscaleSize, placeImage } from '../shared/imageSize';
import { applyOp, newNotebook } from '../shared/ops';
import { findSnap, RULER_LEN, RULER_W, snapAngle, snapPoint, toWorld } from '../shared/ruler';
import type { ImageObj, RulerState } from '../shared/types';
import { draw, mkShape, mkStroke } from './helpers';

const len = (p: number[]) => {
  let l = 0;
  for (let i = 3; i < p.length; i += 3) l += Math.hypot(p[i] - p[i - 3], p[i + 1] - p[i - 2]);
  return l;
};

describe('partial eraser stroke splitting', () => {
  const line = draw([[0, 0], [100, 0]], 0, 1, 5);

  it('returns null when the eraser misses', () => {
    expect(eraseStroke(line, 50, 30, 50, 40, 8)).toBeNull();
  });

  it('splits a stroke in two with cut points on the eraser boundary', () => {
    const pieces = eraseStroke(line, 50, 0, 50, 0, 10)!;
    expect(pieces.length).toBe(2);
    const [a, b] = pieces;
    expect(a[0]).toBe(0);
    expect(a[a.length - 3]).toBeCloseTo(40, 0);
    expect(b[0]).toBeCloseTo(60, 0);
    expect(b[b.length - 3]).toBe(100);
    expect(len(a) + len(b)).toBeCloseTo(80, 0);
  });

  it('trims an end without creating an extra piece', () => {
    const pieces = eraseStroke(line, 0, 0, 0, 0, 10)!;
    expect(pieces.length).toBe(1);
    expect(pieces[0][0]).toBeCloseTo(10, 0);
  });

  it('removes the stroke entirely when fully covered', () => {
    expect(eraseStroke(line, 0, 0, 100, 0, 5)).toEqual([]);
    expect(eraseStroke([5, 5, 0.5], 5, 5, 5, 5, 3)).toEqual([]);
    expect(eraseStroke([5, 5, 0.5], 50, 50, 50, 50, 3)).toBeNull();
  });

  it('cuts a segment that crosses the eraser between two sample points', () => {
    const sparse = [0, 0, 0.5, 100, 0, 0.5]; // both ends far outside
    const pieces = eraseStroke(sparse, 50, -20, 50, 20, 4)!;
    expect(pieces.length).toBe(2);
    expect(pieces[0][pieces[0].length - 3]).toBeCloseTo(46, 0);
    expect(pieces[1][0]).toBeCloseTo(54, 0);
  });

  it('interpolates pressure at the cut', () => {
    const p = [0, 0, 0, 100, 0, 1];
    const pieces = eraseStroke(p, 50, 0, 50, 0, 10)!;
    expect(pieces[0][pieces[0].length - 1]).toBeCloseTo(0.4, 1);
    expect(pieces[1][2]).toBeCloseTo(0.6, 1);
  });

  it('a sweep across a zigzag yields several pieces', () => {
    const zig = draw([[0, 0], [20, 60], [40, 0], [60, 60], [80, 0]], 0, 1, 4);
    const pieces = eraseStroke(zig, -10, 30, 90, 30, 3)!;
    expect(pieces.length).toBe(5);
  });
});

describe('ruler edge-snap math', () => {
  const ruler: RulerState = { visible: true, kind: 'ruler', x: 500, y: 300, angle: 0 };

  it('snaps strokes that start near either long edge', () => {
    const top = findSnap(ruler, 400, 300 - RULER_W / 2 - 6, 10)!;
    expect(top.type).toBe('edge');
    const bottom = findSnap(ruler, 400, 300 + RULER_W / 2 + 4, 10)!;
    expect(bottom.type).toBe('edge');
    expect(findSnap(ruler, 400, 300, 10)).toBeNull(); // middle of the ruler
    expect(findSnap(ruler, 400, 300 - RULER_W / 2 - 30, 10)).toBeNull(); // too far
    expect(findSnap({ ...ruler, visible: false }, 400, 300 - RULER_W / 2, 10)).toBeNull();
  });

  it('projects wobbly input onto a perfectly straight edge', () => {
    const snap = findSnap(ruler, 400, 300 - RULER_W / 2 - 6, 10)!;
    for (const [x, y] of [[410, 240], [455.5, 262], [600, 251]]) {
      const [sx, sy] = snapPoint(snap, x, y);
      expect(sx).toBeCloseTo(x, 6);
      expect(sy).toBeCloseTo(300 - RULER_W / 2, 6);
    }
  });

  it('works for a rotated ruler and clamps to its ends', () => {
    const r: RulerState = { ...ruler, angle: 30 };
    const [ex, ey] = toWorld(r, 100, -RULER_W / 2);
    const snap = findSnap(r, ex + 2, ey - 3, 10)!;
    expect(snap.type).toBe('edge');
    const pts = [[ex + 40, ey + 10], [ex + 90, ey + 70], [ex + 160, ey + 60]].map(([x, y]) => snapPoint(snap, x, y));
    // collinear, and along the 30° direction
    for (const [x, y] of pts) {
      const ang = (Math.atan2(y - ey, x - ex) * 180) / Math.PI;
      expect(ang).toBeCloseTo(30, 4);
    }
    const [fx, fy] = snapPoint(snap, 1e6, 1e6);
    const [endX, endY] = toWorld(r, RULER_LEN / 2, -RULER_W / 2);
    expect(fx).toBeCloseTo(endX, 4);
    expect(fy).toBeCloseTo(endY, 4);
  });

  it('protractor: centre ray snaps to whole degrees, edge snaps to the arc', () => {
    const p: RulerState = { visible: true, kind: 'protractor', x: 0, y: 0, angle: 0 };
    const ray = findSnap(p, 3, -2, 10)!;
    expect(ray.type).toBe('ray');
    const [rx, ry] = snapPoint(ray, 100, -57); // ~29.68° above the base
    expect((Math.atan2(-ry, rx) * 180) / Math.PI).toBeCloseTo(30, 6);
    expect(Math.hypot(rx, ry)).toBeCloseTo(Math.hypot(100, 57), 6);
    const arcSnap = findSnap(p, 0, -283, 10)!;
    expect(arcSnap.type).toBe('arc');
    const [ax, ay] = snapPoint(arcSnap, 150, -200);
    expect(Math.hypot(ax, ay)).toBeCloseTo(280, 6);
  });

  it('rotation snapping', () => {
    expect(snapAngle(1.4, false)).toBe(0);
    expect(snapAngle(43.2, false)).toBe(45);
    expect(snapAngle(-61, false)).toBe(-60);
    expect(snapAngle(91.5, false)).toBe(90);
    expect(snapAngle(136, false)).toBe(135);
    expect(snapAngle(37.4, false)).toBe(37.4);
    expect(snapAngle(37.4, true)).toBe(35);
    expect(snapAngle(363, true)).toBe(5);
  });
});

describe('image sizing', () => {
  it('leaves small images alone', () => {
    expect(downscaleSize(800, 600)).toEqual({ w: 800, h: 600, scaled: false });
    expect(downscaleSize(2400, 2400)).toEqual({ w: 2400, h: 2400, scaled: false });
  });
  it('scales the longest side down to 2400 keeping aspect ratio', () => {
    expect(downscaleSize(4800, 2400)).toEqual({ w: 2400, h: 1200, scaled: true });
    expect(downscaleSize(3000, 6000)).toEqual({ w: 1200, h: 2400, scaled: true });
    const odd = downscaleSize(2401, 7);
    expect(odd.w).toBe(2400);
    expect(odd.h).toBeGreaterThanOrEqual(1);
  });
  it('places images centred at ~60% of the viewport width', () => {
    const p = placeImage(1000, 500, { x: 100, y: 50, w: 1000, h: 800 });
    expect(p.w).toBeCloseTo(600);
    expect(p.h).toBeCloseTo(300);
    expect(p.x + p.w / 2).toBeCloseTo(600);
    expect(p.y + p.h / 2).toBeCloseTo(450);
    const tall = placeImage(500, 2000, { x: 0, y: 0, w: 1000, h: 800 });
    expect(tall.h).toBeCloseTo(640); // capped to 80% of the height
    expect(tall.w / tall.h).toBeCloseTo(0.25);
  });
});

describe('hit testing, lasso and transforms', () => {
  const s = mkStroke('a', draw([[0, 0], [100, 0]], 0, 1, 5), { size: 4 });
  const img: ImageObj = { id: 'i', type: 'image', authorId: 'u', createdAt: 1, src: '/uploads/n/a.png', x: 0, y: 0, w: 200, h: 100, naturalW: 200, naturalH: 100 };

  it('hits strokes within tolerance only', () => {
    expect(hitObject(s, 50, 3, 2)).toBe(true);
    expect(hitObject(s, 50, 12, 2)).toBe(false);
    expect(segHitsInk(s, 50, -20, 50, 20, 1)).toBe(true);
    expect(segHitsInk(s, 150, -20, 150, 20, 1)).toBe(false);
  });

  it('hits unfilled shapes on the outline and filled shapes inside', () => {
    const rect = mkShape('r', 'rect', [0, 0, 100, 60]);
    expect(hitObject(rect, 50, 30, 3)).toBe(false);
    expect(hitObject(rect, 50, 1, 3)).toBe(true);
    expect(hitObject({ ...rect, fill: '#f00' }, 50, 30, 3)).toBe(true);
  });

  it('respects rotation for boxes', () => {
    const rot = { ...img, rotation: Math.PI / 2 };
    expect(hitObject(img, 190, 50, 0)).toBe(true);
    expect(hitObject(rot, 190, 50, 0)).toBe(false);
    expect(hitObject(rot, 100, -40, 0)).toBe(true);
    const b = objBounds(rot);
    expect(b[0]).toBeCloseTo(50); expect(b[1]).toBeCloseTo(-50); expect(b[2]).toBeCloseTo(150); expect(b[3]).toBeCloseTo(150);
  });

  it('lasso needs most of the object inside', () => {
    const big = [-10, -10, 110, -10, 110, 10, -10, 10];
    const half = [-10, -10, 40, -10, 40, 10, -10, 10];
    expect(objInLasso(s, big)).toBe(true);
    expect(objInLasso(s, half)).toBe(false);
  });

  it('scales and rotates objects', () => {
    const scaled = transformObject(s, matScaleAbout(2, 2, 0, 0));
    expect((scaled.points as number[]).slice(-3)).toEqual([200, 0, 0.5]);
    expect(scaled.size).toBe(8);
    const p = transformObject(img, matRotateAbout(Math.PI / 2, 100, 50));
    expect(p).toMatchObject({ x: 0, y: 0, w: 200, h: 100 });
    expect(p.rotation as number).toBeCloseTo(Math.PI / 2, 3);
    const moved = transformObject(img, matScaleAbout(0.5, 0.5, 0, 0));
    expect(moved).toMatchObject({ x: 0, y: 0, w: 100, h: 50, rotation: null });
  });

  it('places highlighter beneath the ink it overlaps but above the image under that ink', () => {
    const nb = newNotebook('n', 'p');
    const add = (obj: unknown, index?: number) => applyOp(nb, { opId: 'x', pageId: 'p', kind: 'add', obj: obj as ImageObj, index });
    add(img);
    add(mkStroke('w1', draw([[10, 20], [90, 20]])));
    add(mkStroke('w2', draw([[10, 40], [90, 40]])));
    add(mkStroke('far', draw([[1000, 1000], [1100, 1000]])));
    expect(highlighterIndex(nb.pages[0], [0, 10, 100, 50])).toBe(1); // above the image, below w1
    expect(highlighterIndex(nb.pages[0], [2000, 2000, 2100, 2100])).toBe(4); // nothing there → top
  });
});

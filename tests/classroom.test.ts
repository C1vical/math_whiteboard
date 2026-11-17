// Part C pure logic: reset, countdown timer, crop maths, touch taps.
import { describe, expect, it } from 'vitest';
import { clampCrop, cropPatch, dragCrop, fromImageFraction, fullFrame, MIN_CROP, toImageFraction } from '../shared/crop';
import { inkToClear, tapeToCover } from '../shared/reset';
import { formatTimer, parseTimerInput, timerFinished, timerReduce, timerRemaining, timerRunning } from '../shared/timer';
import { MultiTapDetector, TAP_MAX_MS } from '../shared/touchTap';
import type { ImageObj, Page, TimerState } from '../shared/types';
import { mkShape, mkStroke } from './helpers';

describe('C3 — reset for the next class', () => {
  it('clears strokes and shapes that are not locked, keeps everything else; covers revealed tape', () => {
    const page: Page = {
      id: 'p', title: 'P', background: 'grid', order: ['s', 'locked', 'sh', 'img', 'tx', 'tp1', 'tp2', 'gr'],
      objects: {
        s: mkStroke('s', [0, 0, 0.5]),
        locked: mkStroke('locked', [0, 0, 0.5], { locked: true }),
        sh: mkShape('sh', 'rect', [0, 0, 5, 5]),
        img: { id: 'img', type: 'image', authorId: 'u', createdAt: 1, src: '/uploads/a/b.png', x: 0, y: 0, w: 1, h: 1, naturalW: 1, naturalH: 1 },
        tx: { id: 'tx', type: 'text', authorId: 'u', createdAt: 1, text: 'hi', x: 0, y: 0, fontSize: 20, color: 'ink' },
        tp1: { id: 'tp1', type: 'tape', authorId: 'u', createdAt: 1, x: 0, y: 0, w: 5, h: 5, color: '#f00', revealed: true },
        tp2: { id: 'tp2', type: 'tape', authorId: 'u', createdAt: 1, x: 0, y: 0, w: 5, h: 5, color: '#f00', revealed: false },
        gr: { id: 'gr', type: 'graph', authorId: 'u', createdAt: 1, x: 0, y: 0, w: 5, h: 5, xMin: -1, xMax: 1, yMin: -1, yMax: 1, showGrid: true, showNumbers: true, expressions: [] },
      },
    };
    expect(inkToClear(page)).toEqual(['s', 'sh']);
    expect(tapeToCover(page)).toEqual(['tp1']);
  });
});

describe('C4 — shared countdown timer', () => {
  it('presets, start, pause, reset, dismiss and move', () => {
    let t: TimerState | null | undefined = timerReduce(null, { action: 'show', durationMs: 5 * 60000 }, 0);
    expect(t).toMatchObject({ x: 0, y: 0, endsAt: null, remainingMs: 300000 }); // top left, not running yet
    expect(t).toMatchObject({ durationMs: 300000, remainingMs: 300000, endsAt: null });
    expect(timerReduce(null, { action: 'start' }, 0)).toBeUndefined(); // nothing to start
    t = timerReduce(t!, { action: 'start' }, 1000);
    expect(t!.endsAt).toBe(301000);
    expect(timerRunning(t!, 2000)).toBe(true);
    expect(timerRemaining(t!, 61000)).toBe(240000); // a late joiner computes the same
    expect(timerReduce(t!, { action: 'start' }, 2000)).toBeUndefined(); // already running
    t = timerReduce(t!, { action: 'pause' }, 61000);
    expect(t).toMatchObject({ remainingMs: 240000, endsAt: null });
    expect(timerRemaining(t!, 999999)).toBe(240000); // paused: time stands still
    t = timerReduce(t!, { action: 'start' }, 100000);
    expect(timerRemaining(t!, 340000)).toBe(0);
    expect(timerFinished(t!, 340000)).toBe(true);
    // starting a finished timer runs it again from the full duration
    expect(timerReduce(t!, { action: 'start' }, 400000)!.endsAt).toBe(700000);
    t = timerReduce(t!, { action: 'reset' }, 400000);
    expect(t).toMatchObject({ remainingMs: 300000, endsAt: null });
    t = timerReduce(t!, { action: 'move', x: 2, y: -1 }, 0);
    expect([t!.x, t!.y]).toEqual([1, 0]);
    expect(timerReduce(t!, { action: 'show', durationMs: 60000 }, 0)).toMatchObject({ x: 1, y: 0, durationMs: 60000 }); // keeps its place
    expect(timerReduce(t!, { action: 'dismiss' }, 0)).toBeNull();
    expect(timerReduce(null, { action: 'dismiss' }, 0)).toBeUndefined();
  });

  it('reads a custom time typed by a teacher', () => {
    expect(parseTimerInput('5')).toBe(300000);
    expect(parseTimerInput(' 2:30 ')).toBe(150000);
    expect(parseTimerInput('1:05:00')).toBe(3900000);
    expect(parseTimerInput('90s')).toBe(90000);
    expect(parseTimerInput('1.5')).toBe(90000);
    expect(parseTimerInput('3 min')).toBe(180000);
    for (const bad of ['', 'abc', '2:75', '0', '0:00', '25h', '-1', '1:2:3:4']) expect(parseTimerInput(bad)).toBeNull();
  });

  it('formats like a kitchen timer', () => {
    expect(formatTimer(300000)).toBe('5:00');
    expect(formatTimer(61001)).toBe('1:02');
    expect(formatTimer(999)).toBe('0:01');
    expect(formatTimer(0)).toBe('0:00');
    expect(formatTimer(3600000 + 65000)).toBe('1:01:05');
  });
});

describe('C7 — crop maths', () => {
  const img = (extra: Partial<ImageObj> = {}): ImageObj => ({
    id: 'i', type: 'image', authorId: 'u', createdAt: 1, src: '/uploads/a/b.png', x: 100, y: 50, w: 400, h: 200, naturalW: 800, naturalH: 400, ...extra,
  });

  it('a crop keeps the visible part where it was, at the same scale', () => {
    const o = img();
    const p = cropPatch(o, { x: 0.25, y: 0.5, w: 0.5, h: 0.5 });
    expect(p).toMatchObject({ x: 200, y: 150, w: 200, h: 100, crop: { x: 0.25, y: 0.5, w: 0.5, h: 0.5 } });
    // widening again (or resetting) gives the original frame back
    const cropped = { ...o, ...p } as ImageObj;
    expect(fullFrame(cropped)).toMatchObject({ cx: 300, cy: 150, w: 400, h: 200 });
    expect(cropPatch(cropped, null)).toMatchObject({ x: 100, y: 50, w: 400, h: 200, crop: null });
    expect(cropPatch(cropped, { x: 0, y: 0, w: 1, h: 1 })).toMatchObject({ crop: null });
  });

  it('works for rotated images too', () => {
    const o = img({ rotation: Math.PI / 2 });
    const p = cropPatch(o, { x: 0, y: 0, w: 0.5, h: 1 }) as { x: number; y: number; w: number; h: number };
    // the left half of the picture; rotated 90°, it ends up above the centre
    expect(p.w).toBeCloseTo(200);
    expect(p.h).toBeCloseTo(200);
    expect(p.x + p.w / 2).toBeCloseTo(300, 0);
    expect(p.y + p.h / 2).toBeCloseTo(50, 0);
    // fraction ↔ world round trip
    const c = { ...o, ...p } as ImageObj;
    const [wx, wy] = fromImageFraction(c, 0.3, 0.7);
    const [u, v] = toImageFraction(c, wx, wy);
    expect(u).toBeCloseTo(0.3);
    expect(v).toBeCloseTo(0.7);
  });

  it('dragging edges and corners stays inside the image and above a minimum size', () => {
    const start = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
    const left = dragCrop(start, -1, 0, 0.5, 0);
    expect(left.x).toBeCloseTo(0.5);
    expect(left.w).toBeCloseTo(0.3);
    expect(left.y).toBe(0.2);
    expect(dragCrop(start, 1, 1, 2, 2)).toEqual({ x: 0.2, y: 0.2, w: 0.8, h: 0.8 });
    expect(dragCrop(start, -1, -1, 0.95, 0.95).w).toBeCloseTo(MIN_CROP);
    const moved = dragCrop(start, 0, 0, 0, 0, 0.5, -0.5); // moved, then kept inside
    expect(moved.x).toBeCloseTo(0.4);
    expect(moved.y).toBe(0);
    expect(clampCrop({ x: -1, y: 2, w: 3, h: 0 })).toEqual({ x: 0, y: 1 - MIN_CROP, w: 1, h: MIN_CROP });
  });
});

describe('C8 — touch undo / redo taps', () => {
  it('two-finger tap undoes, three-finger tap redoes', () => {
    const d = new MultiTapDetector();
    d.start(1, 100, 100, 0); d.start(2, 200, 100, 40);
    expect(d.end(1, 120)).toBeNull();
    expect(d.end(2, 130)).toBe('undo');
    d.start(1, 100, 100, 1000); d.start(2, 200, 100, 1010); d.start(3, 300, 100, 1030);
    d.end(2, 1100); d.end(1, 1110);
    expect(d.end(3, 1120)).toBe('redo');
  });

  it('never during a pinch or a pan, a slow press, a late finger, or pen input', () => {
    const d = new MultiTapDetector();
    // pinch: fingers move apart
    d.start(1, 100, 100, 0); d.start(2, 200, 100, 10);
    d.move(1, 80, 100); d.move(2, 230, 100);
    d.end(1, 100);
    expect(d.end(2, 110)).toBeNull();
    // two-finger pan
    d.start(1, 100, 100, 500); d.start(2, 200, 100, 510);
    d.move(1, 100, 130); d.move(2, 200, 130);
    d.end(1, 600);
    expect(d.end(2, 610)).toBeNull();
    // held too long
    d.start(1, 100, 100, 1000); d.start(2, 200, 100, 1010);
    d.end(1, 1000 + TAP_MAX_MS + 50);
    expect(d.end(2, 1000 + TAP_MAX_MS + 60)).toBeNull();
    // the second finger joins much later (one finger was panning)
    d.start(1, 100, 100, 2000); d.start(2, 200, 100, 2300);
    d.end(1, 2320);
    expect(d.end(2, 2330)).toBeNull();
    // one finger is not a gesture
    d.start(1, 100, 100, 3000);
    expect(d.end(1, 3050)).toBeNull();
    // spoiled by pen input / a cancelled touch
    d.start(1, 100, 100, 4000); d.start(2, 200, 100, 4010); d.spoil();
    d.end(1, 4050);
    expect(d.end(2, 4060)).toBeNull();
    d.start(1, 100, 100, 5000); d.start(2, 200, 100, 5010); d.cancel(1);
    expect(d.end(2, 5060)).toBeNull();
    // a tiny wobble is still a tap
    d.start(1, 100, 100, 6000); d.start(2, 200, 100, 6010); d.move(1, 104, 103);
    d.end(1, 6100);
    expect(d.end(2, 6110)).toBe('undo');
  });
});

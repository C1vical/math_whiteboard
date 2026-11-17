import { describe, expect, it } from 'vitest';
import { eraseStroke } from '../shared/erase';
import { applyOp, applyPageOp, applyWithInverse, newNotebook } from '../shared/ops';
import { recognizeShape } from '../shared/recognize';
import { spaceOp } from '../shared/space';
import type { Notebook, Op, Stroke } from '../shared/types';
import { draw, mkShape, mkStroke } from './helpers';

const P = 'p1';
const fresh = (): Notebook => newNotebook('nb', P);
const op = (o: Record<string, unknown>): Op => ({ opId: Math.random().toString(36).slice(2), pageId: P, ...o }) as Op;
const snap = (nb: Notebook) => JSON.parse(JSON.stringify(nb.pages));

describe('op reducer', () => {
  it('adds objects in z-order and at an explicit index', () => {
    const nb = fresh();
    applyOp(nb, op({ kind: 'add', obj: mkStroke('a', [0, 0, 0.5, 10, 0, 0.5]) }));
    applyOp(nb, op({ kind: 'add', obj: mkStroke('b', [0, 5, 0.5, 10, 5, 0.5]) }));
    applyOp(nb, op({ kind: 'add', obj: mkStroke('c', [0, 9, 0.5]), index: 0 }));
    expect(nb.pages[0].order).toEqual(['c', 'a', 'b']);
    expect(Object.keys(nb.pages[0].objects).sort()).toEqual(['a', 'b', 'c']);
  });

  it('recomputes the stroke bbox on add and update', () => {
    const nb = fresh();
    applyOp(nb, op({ kind: 'add', obj: { ...mkStroke('a', [1, 2, 0.5, 11, 22, 0.5]), bbox: [9, 9, 9, 9] } }));
    expect((nb.pages[0].objects.a as Stroke).bbox).toEqual([1, 2, 11, 22]);
    applyOp(nb, op({ kind: 'update', id: 'a', patch: { points: [5, 5, 0.5, 6, 8, 0.5] } }));
    expect((nb.pages[0].objects.a as Stroke).bbox).toEqual([5, 5, 6, 8]);
  });

  it('updates with a shallow patch and protects identity fields', () => {
    const nb = fresh();
    applyOp(nb, op({ kind: 'add', obj: mkStroke('a', [0, 0, 0.5]) }));
    expect(applyOp(nb, op({ kind: 'update', id: 'a', patch: { color: '#f00', id: 'zzz', type: 'image' } }))).toBe(true);
    const a = nb.pages[0].objects.a as Stroke;
    expect(a.color).toBe('#f00');
    expect(a.id).toBe('a');
    expect(a.type).toBe('stroke');
    expect(applyOp(nb, op({ kind: 'update', id: 'missing', patch: { color: '#0f0' } }))).toBe(false);
  });

  it('deletes and reorders', () => {
    const nb = fresh();
    for (const id of ['a', 'b', 'c']) applyOp(nb, op({ kind: 'add', obj: mkStroke(id, [0, 0, 0.5]) }));
    applyOp(nb, op({ kind: 'reorder', id: 'a', index: 2 }));
    expect(nb.pages[0].order).toEqual(['b', 'c', 'a']);
    applyOp(nb, op({ kind: 'reorder', id: 'a', index: 0 }));
    expect(nb.pages[0].order).toEqual(['a', 'b', 'c']);
    applyOp(nb, op({ kind: 'delete', id: 'b' }));
    expect(nb.pages[0].order).toEqual(['a', 'c']);
    expect(nb.pages[0].objects.b).toBeUndefined();
    expect(applyOp(nb, op({ kind: 'delete', id: 'b' }))).toBe(false);
  });

  it('moves strokes, shapes and boxes', () => {
    const nb = fresh();
    applyOp(nb, op({ kind: 'add', obj: mkStroke('a', [0, 0, 0.5, 10, 10, 0.7]) }));
    applyOp(nb, op({ kind: 'add', obj: mkShape('s', 'line', [0, 0, 5, 5]) }));
    applyOp(nb, op({ kind: 'add', obj: { id: 't', type: 'tape', authorId: 'u', createdAt: 1, x: 1, y: 2, w: 3, h: 4, color: '#f00', revealed: false } }));
    applyOp(nb, op({ kind: 'move', ids: ['a', 's', 't', 'nope'], dx: 5, dy: -2 }));
    const o = nb.pages[0].objects;
    expect((o.a as Stroke).points).toEqual([5, -2, 0.5, 15, 8, 0.7]);
    expect((o.a as Stroke).bbox).toEqual([5, -2, 15, 8]);
    expect((o.s as { points: number[] }).points).toEqual([5, -2, 10, 3]);
    expect(o.t).toMatchObject({ x: 6, y: 0 });
  });

  it('ignores ops for unknown pages', () => {
    const nb = fresh();
    expect(applyOp(nb, { opId: 'x', pageId: 'ghost', kind: 'delete', id: 'a' })).toBe(false);
  });

  it('handles page ops', () => {
    const nb = fresh();
    applyOp(nb, op({ kind: 'add', obj: mkStroke('a', [0, 0, 0.5]) }));
    applyPageOp(nb, { opId: '1', kind: 'add', page: { id: 'p2', title: 'Two', background: 'dots' }, index: 1 });
    applyPageOp(nb, { opId: '2', kind: 'rename', pageId: 'p2', title: 'Second' });
    applyPageOp(nb, { opId: '3', kind: 'setBackground', pageId: 'p2', background: 'lined' });
    applyPageOp(nb, { opId: '4', kind: 'duplicate', pageId: P, newId: 'p3', title: 'Copy', seed: 'seed' });
    expect(nb.pages.map((p) => p.id)).toEqual([P, 'p3', 'p2']);
    expect(nb.pages[2]).toMatchObject({ title: 'Second', background: 'lined' });
    expect(nb.pages[1].order).toEqual(['seed0']);
    expect(nb.pages[1].objects.seed0.id).toBe('seed0');
    applyPageOp(nb, { opId: '5', kind: 'reorder', pageId: 'p2', index: 0 });
    expect(nb.pages.map((p) => p.id)).toEqual(['p2', P, 'p3']);
    applyPageOp(nb, { opId: '6', kind: 'delete', pageId: 'p3' });
    applyPageOp(nb, { opId: '7', kind: 'delete', pageId: 'p2' });
    expect(applyPageOp(nb, { opId: '8', kind: 'delete', pageId: P })).toBe(false); // never delete the last page
    expect(nb.pages.length).toBe(1);
  });
});

describe('undo / redo via inverse ops', () => {
  /** applies ops, then checks undo restores the exact prior state and redo re-creates the result */
  const roundTrip = (nb: Notebook, ops: Op[]) => {
    const before = snap(nb);
    const undo = applyWithInverse(nb, ops);
    const after = snap(nb);
    expect(after).not.toEqual(before);
    const redo = applyWithInverse(nb, undo);
    expect(snap(nb)).toEqual(before);
    applyWithInverse(nb, redo);
    expect(snap(nb)).toEqual(after);
    applyWithInverse(nb, undo);
    expect(snap(nb)).toEqual(before);
  };

  const seeded = () => {
    const nb = fresh();
    applyOp(nb, op({ kind: 'add', obj: mkStroke('a', draw([[0, 0], [100, 0]])) }));
    applyOp(nb, op({ kind: 'add', obj: mkStroke('b', draw([[0, 50], [100, 50]])) }));
    applyOp(nb, op({ kind: 'add', obj: mkStroke('c', draw([[0, 200], [100, 200]])) }));
    return nb;
  };

  it('draw, delete, update, reorder, move', () => {
    roundTrip(seeded(), [op({ kind: 'add', obj: mkStroke('n', [1, 1, 0.5]) })]);
    roundTrip(seeded(), [op({ kind: 'delete', id: 'a' })]); // restores z-position too
    roundTrip(seeded(), [op({ kind: 'update', id: 'b', patch: { color: '#00f', size: 9, locked: true } })]);
    roundTrip(seeded(), [op({ kind: 'reorder', id: 'a', index: 2 })]);
    roundTrip(seeded(), [op({ kind: 'move', ids: ['a', 'c'], dx: 12.5, dy: -40 })]);
  });

  it('clear page (many deletes) restores order', () => {
    const nb = seeded();
    roundTrip(nb, nb.pages[0].order.map((id) => op({ kind: 'delete', id })));
    expect(nb.pages[0].order).toEqual(['a', 'b', 'c']);
  });

  it('partial erase: original replaced by pieces at the same z-index', () => {
    const nb = seeded();
    const orig = nb.pages[0].objects.b as Stroke;
    const pieces = eraseStroke(orig.points, 50, 40, 50, 60, 8)!;
    expect(pieces.length).toBe(2);
    const idx = nb.pages[0].order.indexOf('b');
    const ops: Op[] = [
      op({ kind: 'delete', id: 'b' }),
      ...pieces.map((pts, i) => op({ kind: 'add', obj: mkStroke(`b${i}`, pts), index: idx + i })),
    ];
    const before = snap(nb);
    const undo = applyWithInverse(nb, ops);
    expect(nb.pages[0].order).toEqual(['a', 'b0', 'b1', 'c']);
    applyWithInverse(nb, undo);
    expect(snap(nb)).toEqual(before);
    roundTrip(nb, ops);
  });

  it('shape conversion: one undo restores the original ink, a second removes it', () => {
    const nb = fresh();
    const ink = draw([[0, 0], [200, 0], [200, 120], [0, 120], [0, 0]], 1.2, 7);
    const rec = recognizeShape(ink, { scale: 1, mode: 'auto' })!;
    expect(rec.kind).toBe('rect');
    // what the engine does on pen-up: the clean shape takes the stroke id, the ink keeps a new id
    const shape = mkShape('s1', rec.kind, rec.points);
    const inkStroke = mkStroke('ink1', ink);
    const undoAdd = applyWithInverse(nb, [op({ kind: 'add', obj: inkStroke })]);
    const undoConvert = applyWithInverse(nb, [op({ kind: 'delete', id: 'ink1' }), op({ kind: 'add', obj: shape })]);
    expect(nb.pages[0].order).toEqual(['s1']);
    const redoConvert = applyWithInverse(nb, undoConvert); // Ctrl+Z #1
    expect(nb.pages[0].order).toEqual(['ink1']);
    expect((nb.pages[0].objects.ink1 as Stroke).points).toEqual(ink);
    applyWithInverse(nb, undoAdd); // Ctrl+Z #2
    expect(nb.pages[0].order).toEqual([]);
    applyWithInverse(nb, [op({ kind: 'add', obj: inkStroke })]);
    applyWithInverse(nb, redoConvert); // redo
    expect(nb.pages[0].order).toEqual(['s1']);
  });

  it('insert space pushes everything below the line and undoes exactly', () => {
    const nb = seeded();
    const before = snap(nb);
    const sp = spaceOp(nb.pages[0], 'y', 40, 75)!;
    expect(sp.kind === 'move' && sp.ids).toEqual(['b', 'c']);
    const undo = applyWithInverse(nb, [sp]);
    expect((nb.pages[0].objects.a as Stroke).bbox[1]).toBe(0);
    expect((nb.pages[0].objects.b as Stroke).bbox[1]).toBe(125);
    expect((nb.pages[0].objects.c as Stroke).bbox[1]).toBe(275);
    applyWithInverse(nb, undo);
    expect(snap(nb)).toEqual(before);
    // remove space (negative) and the vertical variant
    roundTrip(nb, [spaceOp(nb.pages[0], 'y', 100, -60)!]);
    roundTrip(nb, [spaceOp(nb.pages[0], 'x', -5, 30)!]);
    expect(spaceOp(nb.pages[0], 'y', 9999, 50)).toBeNull();
  });

  it('undo of an op on an object someone else deleted is a harmless no-op', () => {
    const nb = seeded();
    const undo = applyWithInverse(nb, [op({ kind: 'update', id: 'a', patch: { color: '#123456' } })]);
    applyOp(nb, op({ kind: 'delete', id: 'a' })); // remote user deletes it
    expect(() => applyWithInverse(nb, undo)).not.toThrow();
    expect(nb.pages[0].objects.a).toBeUndefined();
  });
});

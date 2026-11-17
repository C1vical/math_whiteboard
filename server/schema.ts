import { z } from 'zod';
import {
  angleMode, axisLabel, background, boardObject, color, crop, graphExpr, graphSlider, id, notebook, num, page, penType, points, pos, shapeKind, title,
} from '../shared/schema';
import { MAX_TIMER_MS } from '../shared/types';

// Every incoming socket message is validated against these schemas; anything that
// fails is dropped without touching state. The rules for stored objects, pages and
// notebooks live in shared/schema.ts (the client uses them too, when pasting).

export { boardObject, notebook, page };

// update patches: only known fields, each type-checked. The server additionally checks that the
// fields belong to the object's type and that the merged object is still valid (see app.ts).
const patch = z.object({
  locked: z.boolean().nullable(), rotation: num.nullable(),
  pen: penType, color, size: pos.max(600), opacity: z.number().min(0).max(1), points,
  stab: z.number().min(0).max(100).nullable(), sim: z.boolean().nullable(),
  kind: shapeKind, dashed: z.boolean().nullable(), fill: color.nullable(), fillOpacity: z.number().min(0).max(1).nullable(),
  x: num, y: num, w: pos, h: pos, xMin: num, xMax: num, yMin: num, yMax: num, xStep: num, yStep: num,
  showNumbers: z.boolean(), showGrid: z.boolean(), mode: z.enum(['xy', 'numberLine']),
  text: z.string().max(20000), fontSize: pos.max(2000),
  expressions: z.array(graphExpr).max(40), sliders: z.array(graphSlider).max(26).nullable(),
  revealed: z.boolean(),
  grid: z.boolean().nullable(), xLabel: axisLabel.nullable(), yLabel: axisLabel.nullable(), piTicks: z.boolean().nullable(),
  angle: angleMode.nullable(), crop: crop.nullable(),
}).partial().strict();

const opBase = { opId: z.string().min(1).max(40), pageId: id };
export const op = z.discriminatedUnion('kind', [
  z.object({ ...opBase, kind: z.literal('add'), obj: boardObject, index: z.number().int().min(0).optional() }),
  z.object({ ...opBase, kind: z.literal('update'), id, patch }),
  z.object({ ...opBase, kind: z.literal('delete'), id }),
  z.object({ ...opBase, kind: z.literal('reorder'), id, index: z.number().int().min(0) }),
  z.object({ ...opBase, kind: z.literal('move'), ids: z.array(id).max(60000), dx: num, dy: num }),
]);
export const opsMsg = z.object({ ops: z.array(op).min(1).max(6000) });

const pOp = { opId: z.string().min(1).max(40) };
export const pageOp = z.discriminatedUnion('kind', [
  z.object({ ...pOp, kind: z.literal('add'), page: z.object({ id, title, background }), index: z.number().int().min(0) }),
  z.object({ ...pOp, kind: z.literal('rename'), pageId: id, title }),
  z.object({ ...pOp, kind: z.literal('duplicate'), pageId: id, newId: id, title, seed: z.string().regex(/^[A-Za-z0-9_-]{4,24}$/) }),
  z.object({ ...pOp, kind: z.literal('delete'), pageId: id }),
  z.object({ ...pOp, kind: z.literal('reorder'), pageId: id, index: z.number().int().min(0) }),
  z.object({ ...pOp, kind: z.literal('setBackground'), pageId: id, background }),
  z.object({ ...pOp, kind: z.literal('restorePage'), page, index: z.number().int().min(0) }),
  z.object({ ...pOp, kind: z.literal('notebookTitle'), title: z.string().min(1).max(120) }),
]);
export const pageOpMsg = z.object({ op: pageOp });

const userName = z.string().min(1).max(40);
export const joinMsg = z.object({
  notebookId: id,
  userId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  name: userName,
  color: color.optional(),
  passcode: z.string().max(200).optional(),
  pending: z.array(z.string().max(40)).max(20000).optional(),
});
export const renameMsg = z.object({ name: userName });

const style = z.object({
  pen: penType, color, size: pos.max(600), opacity: z.number().min(0).max(1),
  stab: z.number().min(0).max(100), sim: z.boolean(),
});
const camera = z.object({ x: num, y: num, zoom: z.number().min(0.01).max(100) });
export const liveStart = z.object({ strokeId: id, pageId: id, style });
export const livePoints = z.object({ strokeId: id, points: z.array(num).max(30000), reset: z.boolean().optional() });
export const liveEnd = z.object({ strokeId: id });
export const liveErase = z.object({ pageId: id, x: num, y: num, r: pos, active: z.boolean() });
export const cursorMsg = z.object({ pageId: id, x: num, y: num, tool: z.string().max(20) });
export const laserMsg = z.object({ pageId: id, points: z.array(num).max(2000), mode: z.enum(['trail', 'dot']).optional() });
export const rulerMsg = z.object({
  pageId: id, visible: z.boolean(), x: num, y: num, angle: num, kind: z.enum(['ruler', 'protractor']),
});
export const viewportMsg = z.object({ pageId: id, camera, vw: pos, vh: pos });
/** "bring everyone here": one-shot, relayed to the other editors */
export const summonMsg = z.object({ pageId: id, camera, vw: pos.min(1), vh: pos.min(1) });
export const pageMsg = z.object({ pageId: id });

const frac = z.number().finite().min(0).max(1);
export const timerMsg = z.discriminatedUnion('action', [
  z.object({ action: z.literal('show'), durationMs: z.number().int().min(1000).max(MAX_TIMER_MS) }),
  z.object({ action: z.literal('start') }),
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('reset') }),
  z.object({ action: z.literal('dismiss') }),
  z.object({ action: z.literal('move'), x: frac, y: frac }),
]);

export const restoreMsg = z.object({ notebook });
/** asks for a server-side backup of the notebook as it is now (before a notebook-wide change) */
export const backupMsg = z.object({}).strict();

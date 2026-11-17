import { z } from 'zod';

// Every incoming socket message is validated against these schemas; anything that
// fails is dropped without touching state.

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const num = z.number().finite().min(-1e9).max(1e9);
const pos = z.number().finite().min(0).max(1e7);
const color = z.string().min(1).max(32);
const points = z.array(num).max(120000);
const background = z.enum(['blank', 'grid', 'graph', 'lined', 'dots']);
const penType = z.enum(['ballpoint', 'fountain', 'pencil', 'marker', 'highlighter']);
const shapeKind = z.enum(['line', 'arrow', 'doubleArrow', 'rect', 'ellipse', 'triangle', 'polygon']);

const base = {
  id,
  authorId: z.string().max(64),
  createdAt: z.number().finite(),
  locked: z.boolean().nullish(),
  rotation: num.nullish(),
};
const box = { x: num, y: num, w: pos, h: pos };
const range = { xMin: num, xMax: num, yMin: num, yMax: num };

const graphExpr = z.object({ id: z.string().max(32), text: z.string().max(300), color, visible: z.boolean() });
const graphSlider = z.object({ name: z.string().min(1).max(8), min: num, max: num, step: num, value: num });

const stroke = z.object({
  ...base, type: z.literal('stroke'), pen: penType, color, size: pos.max(600), opacity: z.number().min(0).max(1),
  points, bbox: z.tuple([num, num, num, num]), stab: z.number().min(0).max(100).nullish(), sim: z.boolean().nullish(),
});
const shape = z.object({
  ...base, type: z.literal('shape'), kind: shapeKind, points: z.array(num).min(4).max(400), color, size: pos.max(600),
  dashed: z.boolean().nullish(), fill: color.nullish(), fillOpacity: z.number().min(0).max(1).nullish(),
});
const axes = z.object({
  ...base, type: z.literal('axes'), ...box, ...range, xStep: num, yStep: num,
  showNumbers: z.boolean(), mode: z.enum(['xy', 'numberLine']),
});
const image = z.object({
  ...base, type: z.literal('image'), src: z.string().regex(/^\/uploads\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\.(png|jpg|gif|webp)$/),
  ...box, naturalW: pos, naturalH: pos,
});
const text = z.object({ ...base, type: z.literal('text'), text: z.string().max(20000), x: num, y: num, fontSize: pos.max(2000), color });
const graph = z.object({
  ...base, type: z.literal('graph'), ...box, ...range, showGrid: z.boolean(), showNumbers: z.boolean(),
  expressions: z.array(graphExpr).max(40), sliders: z.array(graphSlider).max(26).nullish(),
});
const tape = z.object({ ...base, type: z.literal('tape'), ...box, color, revealed: z.boolean() });

export const boardObject = z.discriminatedUnion('type', [stroke, shape, axes, image, text, graph, tape]);

// update patches: only known fields, each type-checked
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

const title = z.string().max(200);
const pOp = { opId: z.string().min(1).max(40) };
export const pageOp = z.discriminatedUnion('kind', [
  z.object({ ...pOp, kind: z.literal('add'), page: z.object({ id, title, background }), index: z.number().int().min(0) }),
  z.object({ ...pOp, kind: z.literal('rename'), pageId: id, title }),
  z.object({ ...pOp, kind: z.literal('duplicate'), pageId: id, newId: id, title, seed: z.string().regex(/^[A-Za-z0-9_-]{4,24}$/) }),
  z.object({ ...pOp, kind: z.literal('delete'), pageId: id }),
  z.object({ ...pOp, kind: z.literal('reorder'), pageId: id, index: z.number().int().min(0) }),
  z.object({ ...pOp, kind: z.literal('setBackground'), pageId: id, background }),
]);
export const pageOpMsg = z.object({ op: pageOp });

export const joinMsg = z.object({
  notebookId: id,
  userId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  name: z.string().min(1).max(40),
  color: color.optional(),
  passcode: z.string().max(200).optional(),
  pending: z.array(z.string().max(40)).max(20000).optional(),
});

const style = z.object({
  pen: penType, color, size: pos.max(600), opacity: z.number().min(0).max(1),
  stab: z.number().min(0).max(100), sim: z.boolean(),
});
export const liveStart = z.object({ strokeId: id, pageId: id, style });
export const livePoints = z.object({ strokeId: id, points: z.array(num).max(30000), reset: z.boolean().optional() });
export const liveEnd = z.object({ strokeId: id });
export const liveErase = z.object({ pageId: id, x: num, y: num, r: pos, active: z.boolean() });
export const cursorMsg = z.object({ pageId: id, x: num, y: num, tool: z.string().max(20) });
export const laserMsg = z.object({ pageId: id, points: z.array(num).max(2000), mode: z.enum(['trail', 'dot']).optional() });
export const rulerMsg = z.object({
  pageId: id, visible: z.boolean(), x: num, y: num, angle: num, kind: z.enum(['ruler', 'protractor']),
});
export const viewportMsg = z.object({
  pageId: id, camera: z.object({ x: num, y: num, zoom: z.number().min(0.01).max(100) }), vw: pos, vh: pos,
});
export const pageMsg = z.object({ pageId: id });

const page = z.object({
  id, title, background,
  objects: z.record(boardObject),
  order: z.array(id).max(200000),
});
export const notebook = z.object({
  id, title, pages: z.array(page).min(1).max(500), updatedAt: z.number().finite(),
});
export const restoreMsg = z.object({ notebook });

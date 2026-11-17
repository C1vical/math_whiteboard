// Data model + socket protocol types shared by client, server and tests.

export type PenType = 'ballpoint' | 'fountain' | 'pencil' | 'marker' | 'highlighter';
export type Background = 'blank' | 'grid' | 'graph' | 'lined' | 'dots';
export type ShapeKind = 'line' | 'arrow' | 'doubleArrow' | 'rect' | 'ellipse' | 'triangle' | 'polygon';
export type BBox = [number, number, number, number]; // minX, minY, maxX, maxY

export interface Base {
  id: string;
  authorId: string;
  createdAt: number;
  locked?: boolean | null;
  rotation?: number | null; // radians, about the object's centre
}

export interface Stroke extends Base {
  type: 'stroke';
  pen: PenType;
  color: string;
  size: number;
  opacity: number;
  points: number[]; // x,y,pressure flat
  bbox: BBox;
  stab?: number | null; // stabilization 0..100
  sim?: boolean | null; // simulate pressure (mouse / touch)
}

export interface Shape extends Base {
  type: 'shape';
  kind: ShapeKind;
  points: number[]; // rect/ellipse: bounds x1,y1,x2,y2 ; others: vertices x,y flat
  color: string;
  size: number;
  dashed?: boolean | null;
  fill?: string | null;
  fillOpacity?: number | null;
}

export interface Axes extends Base {
  type: 'axes';
  x: number; y: number; w: number; h: number;
  xMin: number; xMax: number; yMin: number; yMax: number;
  xStep: number; yStep: number;
  showNumbers: boolean;
  mode: 'xy' | 'numberLine';
  /** light grid lines inside the axes box */
  grid?: boolean | null;
  /** axis labels; default "x" and "y" */
  xLabel?: string | null;
  yLabel?: string | null;
  /** label the x axis in multiples of π */
  piTicks?: boolean | null;
}

/** Non-destructive crop: the part of the source image that is shown, as fractions (0..1) of it. */
export interface Crop { x: number; y: number; w: number; h: number }

export interface ImageObj extends Base {
  type: 'image';
  src: string;
  x: number; y: number; w: number; h: number;
  naturalW: number; naturalH: number;
  /** x, y, w, h describe the visible (cropped) frame; the original file is never changed */
  crop?: Crop | null;
}

export interface TextObj extends Base {
  type: 'text';
  text: string;
  x: number; y: number;
  fontSize: number;
  color: string;
}

export interface GraphExpr { id: string; text: string; color: string; visible: boolean }
export interface GraphSlider { name: string; min: number; max: number; step: number; value: number }

export interface Graph extends Base {
  type: 'graph';
  x: number; y: number; w: number; h: number;
  xMin: number; xMax: number; yMin: number; yMax: number;
  showGrid: boolean; showNumbers: boolean;
  expressions: GraphExpr[];
  sliders?: GraphSlider[] | null;
  /** trig functions work in radians (default) or degrees */
  angle?: 'rad' | 'deg' | null;
  /** label the x axis in multiples of π */
  piTicks?: boolean | null;
}

export interface Tape extends Base {
  type: 'tape';
  x: number; y: number; w: number; h: number;
  color: string;
  revealed: boolean;
}

export type BoardObject = Stroke | Shape | Axes | ImageObj | TextObj | Graph | Tape;
export type BoxObject = Axes | ImageObj | Graph | Tape;

export interface Page {
  id: string;
  title: string;
  background: Background;
  objects: Record<string, BoardObject>;
  order: string[]; // z-order, bottom → top
}

export interface Notebook {
  id: string;
  title: string;
  pages: Page[];
  updatedAt: number;
}

// ---------- ops ----------

export type Op = { opId: string; pageId: string } & (
  | { kind: 'add'; obj: BoardObject; index?: number }
  | { kind: 'update'; id: string; patch: Record<string, unknown> }
  | { kind: 'delete'; id: string }
  | { kind: 'reorder'; id: string; index: number }
  | { kind: 'move'; ids: string[]; dx: number; dy: number }
);

export type PageOp = { opId: string } & (
  | { kind: 'add'; page: { id: string; title: string; background: Background }; index: number }
  | { kind: 'rename'; pageId: string; title: string }
  | { kind: 'duplicate'; pageId: string; newId: string; title: string; seed: string }
  | { kind: 'delete'; pageId: string }
  | { kind: 'reorder'; pageId: string; index: number }
  | { kind: 'setBackground'; pageId: string; background: Background }
  /** puts a deleted page back, with its content, at its old position (undo of 'delete') */
  | { kind: 'restorePage'; page: Page; index: number }
  | { kind: 'notebookTitle'; title: string }
);

// ---------- protocol ----------

export interface StrokeStyle {
  pen: PenType;
  color: string;
  size: number;
  opacity: number;
  stab: number;
  sim: boolean;
}

export interface Camera { x: number; y: number; zoom: number }

export interface RulerState {
  visible: boolean;
  kind: 'ruler' | 'protractor';
  x: number; y: number;
  angle: number; // degrees
}

export interface PresenceUser {
  sid: string;
  userId: string;
  name: string;
  color: string;
  pageId: string | null;
}

export interface JoinPayload {
  notebookId: string;
  userId: string;
  name: string;
  color?: string;
  passcode?: string;
  pending?: string[]; // opIds I still hold unacknowledged
}

/**
 * Shared countdown timer. Lives on the server per notebook and is never saved to disk.
 * Running when `endsAt` is set (server clock, ms); otherwise paused at `remainingMs`.
 */
export interface TimerState {
  durationMs: number;
  remainingMs: number;
  endsAt: number | null;
  /** position of the widget as fractions of the board area */
  x: number;
  y: number;
}

export type TimerAction =
  | { action: 'show'; durationMs: number }
  | { action: 'start' }
  | { action: 'pause' }
  | { action: 'reset' }
  | { action: 'dismiss' }
  | { action: 'move'; x: number; y: number };

/** "Bring everyone here": relayed once to the other editors. */
export interface SummonMsg { pageId: string; camera: Camera; vw: number; vh: number }

export interface JoinAck {
  ok: boolean;
  error?: string;
  notebook?: Notebook;
  seq?: number;
  color?: string;
  sid?: string;
  seen?: string[]; // which of `pending` the server already applied
  users?: PresenceUser[];
  timer?: TimerState | null;
  /** server clock at the time of the reply, to correct for clock differences */
  now?: number;
}

export const USER_COLORS = [
  '#e03131', '#1971c2', '#2f9e44', '#f08c00', '#9c36b5', '#0c8599',
  '#d6336c', '#5f3dc4', '#66a80f', '#e8590c', '#1098ad', '#846358',
];

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const INK = 'ink';
export const DEFAULT_TITLE = 'Untitled notebook';
export const MAX_TIMER_MS = 24 * 60 * 60 * 1000;

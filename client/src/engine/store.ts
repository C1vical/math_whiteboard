import { useSyncExternalStore } from 'react';
import type { Background, BoardObject, Crop, PenType, PresenceUser, RulerState, TimerState } from '../../../shared/types';

export type ToolId = 'pen' | 'highlighter' | 'eraser' | 'select' | 'shape' | 'laser' | 'space' | 'text' | 'graph' | 'axes' | 'tape';
export type ShapeTool = 'line' | 'arrow' | 'doubleArrow' | 'rect' | 'ellipse' | 'triangle' | 'rightTriangle';

export interface PenFav { id: string; pen: PenType; color: string; size: number; stab: number }

export interface Settings {
  favs: PenFav[];
  activeFav: number;
  hl: { color: string; size: number; straight: boolean };
  eraser: { mode: 'stroke' | 'partial'; size: number; hlOnly: boolean };
  shape: { kind: ShapeTool; dashed: boolean; fill: string | null; fillOpacity: number; snap: boolean };
  select: { mode: 'lasso' | 'rect' };
  laser: { mode: 'trail' | 'dot' };
  space: { axis: 'y' | 'x' };
  text: { fontSize: number; color: string };
  axes: { mode: 'xy' | 'numberLine' };
  tape: { color: string };
  rulerKind: 'ruler' | 'protractor';
  inkToShape: boolean;
  scribbleErase: boolean;
  drawWithFinger: boolean;
  autoLockImages: boolean;
  dark: boolean;
  sidebar: boolean;
  recentColors: string[];
}

export const PEN_COLORS = [
  'ink', '#868e96', '#e03131', '#f76707', '#f59f00', '#f8d800', '#2f9e44', '#12b886',
  '#1098ad', '#1971c2', '#4263eb', '#7048e8', '#ae3ec9', '#d6336c', '#8d5524', '#ffffff',
];
export const HL_COLORS = ['#ffe033', '#7bed6f', '#ff8fc7', '#74c0fc', '#ffa94d'];
export const TAPE_COLORS = ['#f6c453', '#ff8fa3', '#8ecae6', '#b7e4a0', '#cdb4ff'];
export const SIZE_PRESETS: Record<PenType, number[]> = {
  ballpoint: [1.5, 2.5, 3.5, 5, 8],
  fountain: [2.5, 4, 6, 9, 13],
  pencil: [2, 3, 4.5, 7, 10],
  marker: [5, 8, 12, 18, 26],
  highlighter: [10, 16, 22, 30, 42],
};
export const ERASER_SIZES = [8, 16, 30]; // radius, screen px

export const defaultSettings = (): Settings => ({
  favs: [
    { id: 'f1', pen: 'ballpoint', color: 'ink', size: 2.5, stab: 30 },
    { id: 'f2', pen: 'ballpoint', color: '#1971c2', size: 2.5, stab: 30 },
    { id: 'f3', pen: 'ballpoint', color: '#e03131', size: 2.5, stab: 30 },
    { id: 'f4', pen: 'ballpoint', color: '#2f9e44', size: 2.5, stab: 30 },
    { id: 'f5', pen: 'pencil', color: 'ink', size: 3, stab: 30 },
    { id: 'f6', pen: 'highlighter', color: '#ffe033', size: 22, stab: 30 },
  ],
  activeFav: 0,
  hl: { color: '#ffe033', size: 22, straight: false },
  eraser: { mode: 'stroke', size: 1, hlOnly: false },
  shape: { kind: 'line', dashed: false, fill: null, fillOpacity: 0.25, snap: true },
  select: { mode: 'lasso' },
  laser: { mode: 'trail' },
  space: { axis: 'y' },
  text: { fontSize: 24, color: 'ink' },
  axes: { mode: 'xy' },
  tape: { color: TAPE_COLORS[0] },
  rulerKind: 'ruler',
  inkToShape: true,
  scribbleErase: false,
  drawWithFinger: false,
  autoLockImages: true,
  dark: false,
  sidebar: true,
  recentColors: [],
});

const KEY = 'mathboard.settings.v1';

/** First visit (nothing saved yet): start from the system's light / dark preference. */
function systemDark(): boolean {
  try { return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; }
}

export function loadSettings(): Settings {
  const d = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...d, dark: systemDark() };
    const s = JSON.parse(raw) as Partial<Settings>;
    const merged: Settings = {
      ...d, ...s,
      hl: { ...d.hl, ...s.hl }, eraser: { ...d.eraser, ...s.eraser }, shape: { ...d.shape, ...s.shape },
      select: { ...d.select, ...s.select }, laser: { ...d.laser, ...s.laser }, space: { ...d.space, ...s.space },
      text: { ...d.text, ...s.text }, axes: { ...d.axes, ...s.axes }, tape: { ...d.tape, ...s.tape },
    };
    if (!Array.isArray(merged.favs) || !merged.favs.length) merged.favs = d.favs;
    merged.activeFav = Math.max(0, Math.min(merged.favs.length - 1, merged.activeFav | 0));
    return merged;
  } catch {
    return { ...d, dark: systemDark() };
  }
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage full or blocked */ }
}

export interface SelInfo {
  ids: string[];
  /** selection bounds in screen (CSS px) coordinates relative to the board */
  rect: { x: number; y: number; w: number; h: number };
  allLocked: boolean;
  anyLocked: boolean;
  hasColor: boolean;
  hasSize: boolean;
  /** the selection contains at least one shape (dashed / fill can be edited) */
  hasShape: boolean;
  single: BoardObject | null;
}

export interface TextEdit {
  /** unique per editing session, so the editor remounts and refocuses */
  key: number;
  id: string | null;
  x: number; y: number; // world
  text: string;
  fontSize: number;
  color: string;
  rotation: number;
}

export interface Toast { id: number; msg: string; kind: 'info' | 'error'; action?: { label: string; run: () => void } }

export type ExportKind = 'png' | 'pdf';
/** an image being cropped: `rect` is the crop in fractions of the whole source image */
export interface CropEdit { id: string; rect: Crop }
export interface PageInfo { id: string; title: string; background: Background; count: number }

export interface UIState {
  ready: boolean;
  fatal: string | null;
  tool: ToolId;
  /** a tool that is active only while a key is held (hold L for the laser) */
  heldTool: ToolId | null;
  settings: Settings;
  /** the notebook's name (shown in the top bar, the tab title and export file names) */
  title: string;
  pages: PageInfo[];
  pageId: string;
  users: PresenceUser[];
  me: { sid: string; userId: string; name: string; color: string };
  conn: 'connected' | 'reconnecting' | 'offline';
  saving: boolean;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  sel: SelInfo | null;
  /** true while the selection is being dragged / resized / rotated */
  selBusy: boolean;
  ruler: RulerState;
  popover: string | null;
  textEdit: TextEdit | null;
  following: string | null;
  replay: { t: number; total: number; playing: boolean; speed: number } | null;
  focus: boolean;
  toasts: Toast[];
  restore: { reason: 'empty' | 'older' } | null;
  graphInteract: boolean;
  dialog: null | 'shortcuts' | 'settings' | 'pdf' | 'clearPage' | 'clearMine' | 'importJson' | 'export' | 'resetInk' | 'resetInkAll' | 'coverAll';
  /** what the export dialog was opened for */
  exportKind: ExportKind;
  /** shared countdown timer (server state) */
  timer: TimerState | null;
  crop: CropEdit | null;
  /** the file chosen for the 'pdf' / 'importJson' dialogs */
  pendingFile: File | null;
}

type Listener = () => void;

export class Store<T> {
  private listeners = new Set<Listener>();
  constructor(private state: T) {}
  get = (): T => this.state;
  set = (patch: Partial<T> | ((s: T) => Partial<T>)) => {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    let changed = false;
    for (const k in p) if (p[k] !== this.state[k]) { changed = true; break; }
    if (!changed) return;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  };
  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  };
}

/** Subscribe to a slice. Selectors must return a stable reference (a field of the state). */
export function useStore<T, S>(store: Store<T>, selector: (s: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}

export function initialUI(name: string, userId: string): UIState {
  return {
    ready: false, fatal: null, tool: 'pen', heldTool: null, settings: loadSettings(), title: '', pages: [], pageId: '',
    users: [], me: { sid: '', userId, name, color: '#1971c2' }, conn: 'reconnecting', saving: false, zoom: 1,
    canUndo: false, canRedo: false, sel: null, selBusy: false,
    ruler: { visible: false, kind: 'ruler', x: 0, y: 0, angle: 0 },
    popover: null, textEdit: null, following: null, replay: null, focus: false, toasts: [], restore: null,
    graphInteract: false, dialog: null, pendingFile: null, exportKind: 'pdf', timer: null, crop: null,
  };
}

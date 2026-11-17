import { strokeBBox, translateObject } from './geometry';
import { DEFAULT_TITLE, type Background, type BoardObject, type Notebook, type Op, type Page, type PageOp } from './types';

export interface ApplyHooks {
  /** Called when an object is translated, so render caches can be carried over. */
  moved?(oldObj: BoardObject, newObj: BoardObject, dx: number, dy: number): void;
}

export const findPage = (nb: Notebook, id: string): Page | undefined => nb.pages.find((p) => p.id === id);

export function newPage(id: string, title: string, background: Background = 'blank'): Page {
  return { id, title, background, objects: {}, order: [] };
}

export function newNotebook(id: string, pageId: string): Notebook {
  return { id, title: DEFAULT_TITLE, pages: [newPage(pageId, 'Page 1', 'grid')], updatedAt: 0 };
}

const PROTECTED = new Set(['id', 'type', 'authorId', 'createdAt', 'bbox']);

function normalize(obj: BoardObject): BoardObject {
  return obj.type === 'stroke' ? { ...obj, bbox: strokeBBox(obj.points) } : obj;
}

/** The object an `update` patch produces (null clears an optional field; identity fields are protected). */
export function patched(cur: BoardObject, patch: Record<string, unknown>): BoardObject {
  const next: Record<string, unknown> = { ...cur };
  for (const k of Object.keys(patch)) {
    if (PROTECTED.has(k)) continue;
    // null clears an optional field (JSON has no undefined)
    if (patch[k] === null || patch[k] === undefined) delete next[k];
    else next[k] = patch[k];
  }
  return normalize(next as unknown as BoardObject);
}

/** Largest coordinate magnitude the stored-object rules allow. */
export const COORD_LIMIT = 1e9;

/** true when translating the object by (dx, dy) keeps every coordinate inside the allowed range */
export function moveStaysInRange(o: BoardObject, dx: number, dy: number, limit = COORD_LIMIT): boolean {
  const ok = (v: number) => Number.isFinite(v) && Math.abs(v) <= limit;
  if (!ok(dx) || !ok(dy)) return false;
  if (o.type === 'stroke') {
    const b = o.bbox && o.bbox.length === 4 ? o.bbox : strokeBBox(o.points);
    return ok(b[0] + dx) && ok(b[2] + dx) && ok(b[1] + dy) && ok(b[3] + dy);
  }
  if (o.type === 'shape') {
    for (let i = 0; i < o.points.length; i++) if (!ok(o.points[i] + (i % 2 === 0 ? dx : dy))) return false;
    return true;
  }
  return ok(o.x + dx) && ok(o.y + dy);
}

/** Applies one op in place. Returns false when it was a no-op (missing page/object). */
export function applyOp(nb: Notebook, op: Op, hooks?: ApplyHooks): boolean {
  const page = findPage(nb, op.pageId);
  if (!page) return false;
  switch (op.kind) {
    case 'add': {
      const obj = normalize(op.obj);
      const exists = !!page.objects[obj.id];
      page.objects[obj.id] = obj;
      if (exists && op.index === undefined) return true;
      if (exists) page.order.splice(page.order.indexOf(obj.id), 1);
      const idx = op.index === undefined ? page.order.length : Math.max(0, Math.min(page.order.length, op.index));
      page.order.splice(idx, 0, obj.id);
      return true;
    }
    case 'update': {
      const cur = page.objects[op.id];
      if (!cur) return false;
      page.objects[op.id] = patched(cur, op.patch);
      return true;
    }
    case 'delete': {
      if (!page.objects[op.id]) return false;
      delete page.objects[op.id];
      const i = page.order.indexOf(op.id);
      if (i >= 0) page.order.splice(i, 1);
      return true;
    }
    case 'reorder': {
      const i = page.order.indexOf(op.id);
      if (i < 0) return false;
      page.order.splice(i, 1);
      page.order.splice(Math.max(0, Math.min(page.order.length, op.index)), 0, op.id);
      return true;
    }
    case 'move': {
      let any = false;
      for (const id of op.ids) {
        const cur = page.objects[id];
        if (!cur) continue;
        const next = translateObject(cur, op.dx, op.dy);
        page.objects[id] = next;
        hooks?.moved?.(cur, next, op.dx, op.dy);
        any = true;
      }
      return any;
    }
  }
}

/** Inverse of `op` against the current state (call BEFORE applying). opIds are left empty. */
export function inverseOf(nb: Notebook, op: Op): Op[] {
  const page = findPage(nb, op.pageId);
  if (!page) return [];
  const base = { opId: '', pageId: op.pageId };
  switch (op.kind) {
    case 'add': {
      const old = page.objects[op.obj.id];
      if (old) return [{ ...base, kind: 'add', obj: old, index: page.order.indexOf(old.id) }];
      return [{ ...base, kind: 'delete', id: op.obj.id }];
    }
    case 'update': {
      const cur = page.objects[op.id] as unknown as Record<string, unknown> | undefined;
      if (!cur) return [];
      const patch: Record<string, unknown> = {};
      for (const k of Object.keys(op.patch)) if (!PROTECTED.has(k)) patch[k] = cur[k] === undefined ? null : cur[k];
      return [{ ...base, kind: 'update', id: op.id, patch }];
    }
    case 'delete': {
      const cur = page.objects[op.id];
      if (!cur) return [];
      return [{ ...base, kind: 'add', obj: cur, index: page.order.indexOf(op.id) }];
    }
    case 'reorder': {
      const i = page.order.indexOf(op.id);
      if (i < 0) return [];
      return [{ ...base, kind: 'reorder', id: op.id, index: i }];
    }
    case 'move': {
      const ids = op.ids.filter((id) => page.objects[id]);
      if (!ids.length) return [];
      return [{ ...base, kind: 'move', ids, dx: -op.dx, dy: -op.dy }];
    }
  }
}

/** Applies ops in order and returns the op list that undoes them. */
export function applyWithInverse(nb: Notebook, ops: Op[], hooks?: ApplyHooks): Op[] {
  const inv: Op[] = [];
  for (const op of ops) {
    const i = inverseOf(nb, op);
    applyOp(nb, op, hooks);
    inv.unshift(...i);
  }
  return inv;
}

export function applyPageOp(nb: Notebook, op: PageOp): boolean {
  switch (op.kind) {
    case 'add': {
      if (findPage(nb, op.page.id)) return false;
      const idx = Math.max(0, Math.min(nb.pages.length, op.index));
      nb.pages.splice(idx, 0, newPage(op.page.id, op.page.title, op.page.background));
      return true;
    }
    case 'rename': {
      const p = findPage(nb, op.pageId);
      if (!p) return false;
      p.title = op.title;
      return true;
    }
    case 'duplicate': {
      const src = findPage(nb, op.pageId);
      if (!src || findPage(nb, op.newId)) return false;
      const copy = newPage(op.newId, op.title, src.background);
      src.order.forEach((id, i) => {
        const o = src.objects[id];
        if (!o) return;
        const nid = op.seed + i.toString(36);
        copy.objects[nid] = { ...o, id: nid };
        copy.order.push(nid);
      });
      nb.pages.splice(nb.pages.indexOf(src) + 1, 0, copy);
      return true;
    }
    case 'delete': {
      if (nb.pages.length <= 1) return false;
      const i = nb.pages.findIndex((p) => p.id === op.pageId);
      if (i < 0) return false;
      nb.pages.splice(i, 1);
      return true;
    }
    case 'reorder': {
      const i = nb.pages.findIndex((p) => p.id === op.pageId);
      if (i < 0) return false;
      const [p] = nb.pages.splice(i, 1);
      nb.pages.splice(Math.max(0, Math.min(nb.pages.length, op.index)), 0, p);
      return true;
    }
    case 'setBackground': {
      const p = findPage(nb, op.pageId);
      if (!p) return false;
      p.background = op.background;
      return true;
    }
    case 'restorePage': {
      if (findPage(nb, op.page.id)) return false;
      const idx = Math.max(0, Math.min(nb.pages.length, op.index));
      // own containers, so later edits to the notebook never reach into the op
      nb.pages.splice(idx, 0, { ...op.page, objects: { ...op.page.objects }, order: [...op.page.order] });
      return true;
    }
    case 'notebookTitle': {
      const t = op.title.trim().slice(0, 120);
      if (!t || t === nb.title) return false;
      nb.title = t;
      return true;
    }
  }
}

export function notebookIsEmpty(nb: Notebook): boolean {
  return nb.pages.every((p) => p.order.length === 0);
}

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { newNotebook } from '../shared/ops';
import type { Notebook } from '../shared/types';
import { notebook as notebookSchema } from './schema';

export interface Room {
  nb: Notebook;
  seq: number;
  /** recently applied opIds, for de-duplicating re-sent ops after a reconnect */
  seen: Set<string>;
  seenQueue: string[];
  timer: NodeJS.Timeout | null;
  saving: Promise<void> | null;
  dirty: boolean;
}

const SEEN_LIMIT = 30000;
const SAVE_DEBOUNCE_MS = 1000;

/** Drops dangling ids so `order` and `objects` always agree. */
export function sanitize(nb: Notebook): Notebook {
  for (const p of nb.pages) {
    const seen = new Set<string>();
    p.order = p.order.filter((id) => p.objects[id] && !seen.has(id) && !!seen.add(id));
    for (const id of Object.keys(p.objects)) {
      if (!seen.has(id)) p.order.push(id);
      if (p.objects[id].id !== id) p.objects[id] = { ...p.objects[id], id };
    }
  }
  return nb;
}

/** Authoritative in-memory notebooks with debounced, atomic JSON persistence. */
export class Store {
  private rooms = new Map<string, Promise<Room>>();
  onSaved: (id: string, t: number) => void = () => {};

  constructor(readonly dataDir: string) {}

  get uploadsDir() { return path.join(this.dataDir, 'uploads'); }
  private file(id: string) { return path.join(this.dataDir, `${id}.json`); }

  async init() {
    await fs.mkdir(this.uploadsDir, { recursive: true });
  }

  get(id: string): Promise<Room> {
    let r = this.rooms.get(id);
    if (!r) {
      r = this.load(id);
      this.rooms.set(id, r);
    }
    return r;
  }

  private async load(id: string): Promise<Room> {
    let nb: Notebook | null = null;
    try {
      const raw = await fs.readFile(this.file(id), 'utf8');
      const parsed = notebookSchema.safeParse(JSON.parse(raw));
      if (parsed.success) nb = sanitize(parsed.data as Notebook);
      else {
        console.error(`[store] ${id}.json failed validation; keeping a copy as .corrupt`);
        await fs.copyFile(this.file(id), this.file(id) + '.corrupt').catch(() => {});
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[store] could not read ${id}.json:`, (err as Error).message);
        await fs.copyFile(this.file(id), this.file(id) + '.corrupt').catch(() => {});
      }
    }
    if (!nb) nb = newNotebook(id, nanoid(10));
    nb.id = id;
    return { nb, seq: 0, seen: new Set(), seenQueue: [], timer: null, saving: null, dirty: false };
  }

  remember(room: Room, opId: string) {
    room.seen.add(opId);
    room.seenQueue.push(opId);
    if (room.seenQueue.length > SEEN_LIMIT) {
      for (const old of room.seenQueue.splice(0, SEEN_LIMIT / 10)) room.seen.delete(old);
    }
  }

  markDirty(room: Room) {
    room.dirty = true;
    if (room.timer) return;
    room.timer = setTimeout(() => {
      room.timer = null;
      void this.save(room);
    }, SAVE_DEBOUNCE_MS);
  }

  private async save(room: Room): Promise<void> {
    if (room.saving) {
      await room.saving;
      if (!room.dirty) return;
    }
    room.dirty = false;
    const t = room.nb.updatedAt;
    const json = JSON.stringify(room.nb);
    const target = this.file(room.nb.id);
    const tmp = `${target}.${nanoid(6)}.tmp`;
    room.saving = (async () => {
      try {
        await fs.writeFile(tmp, json, 'utf8');
        try {
          await fs.rename(tmp, target);
        } catch {
          // Windows can refuse a rename while the target is briefly open; retry once
          await new Promise((r) => setTimeout(r, 60));
          await fs.rename(tmp, target);
        }
        this.onSaved(room.nb.id, t);
      } catch (err) {
        console.error('[store] save failed:', (err as Error).message);
        room.dirty = true;
        await fs.unlink(tmp).catch(() => {});
      } finally {
        room.saving = null;
      }
    })();
    await room.saving;
  }

  /** Writes everything that is pending (used on shutdown). */
  async flushAll() {
    for (const p of this.rooms.values()) {
      const room = await p;
      if (room.timer) { clearTimeout(room.timer); room.timer = null; }
      if (room.dirty || room.saving) await this.save(room);
    }
  }
}

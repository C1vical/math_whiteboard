import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { findPage, newNotebook, notebookIsEmpty } from '../shared/ops';
import { salvageNotebook, sanitize } from '../shared/schema';
import { ID_RE, type Notebook, type Page, type TimerState } from '../shared/types';

export { sanitize };

export interface Room {
  nb: Notebook;
  seq: number;
  /** recently applied opIds, for de-duplicating re-sent ops after a reconnect */
  seen: Set<string>;
  seenQueue: string[];
  timer: NodeJS.Timeout | null;
  saving: Promise<void> | null;
  dirty: boolean;
  /** pages whose file must be rewritten by the next save */
  dirtyPages: Set<string>;
  /** pages deleted since the last save (their files are removed after the manifest is written) */
  removedPages: Set<string>;
  /** loaded from the old single-file format: the first save writes every page */
  legacy: boolean;
  /** stale page files may exist and are cleared by the next save */
  tidy: boolean;
  /** something was unreadable or dropped at load: uploads of this notebook are never swept */
  loadIssues: boolean;
  /** shared countdown timer (memory only, never written to disk) */
  countdown: TimerState | null;
}

export interface StoreOptions {
  /** how long an empty room stays in memory after the last person left */
  evictDelayMs?: number;
  saveDebounceMs?: number;
  quiet?: boolean;
}

const SEEN_LIMIT = 30000;
const RETIRED_SEEN = 3000;
const RETIRED_ROOMS = 500;
const RETIRED_MS = 24 * 60 * 60 * 1000;
const BACKUPS_KEPT = 5;
export const UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const stamp = () => new Date().toISOString().replace(/[-:.]/g, '');
const tick = () => new Promise<void>((r) => setImmediate(r));

/**
 * File name for a page. Upper-case letters are escaped and a prefix is added, so two page ids
 * never collide on case-insensitive file systems and never hit a reserved device name.
 */
export const pageFileName = (pageId: string) => `p_${pageId.replace(/[A-Z]/g, (c) => `=${c.toLowerCase()}`)}.json`;

async function atomicWrite(target: string, write: (tmp: string) => Promise<void>): Promise<void> {
  const tmp = `${target}.${nanoid(6)}.tmp`;
  try {
    await write(tmp);
    try {
      await fs.rename(tmp, target);
    } catch {
      // Windows can refuse a rename while the target is briefly open; retry once
      await new Promise((r) => setTimeout(r, 60));
      await fs.rename(tmp, target);
    }
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Adds the upload file names a stored (unvalidated) page list refers to. */
function collectUploads(id: string, pages: unknown, into: Set<string>) {
  if (!Array.isArray(pages)) return;
  const prefix = `/uploads/${id}/`;
  for (const p of pages) {
    if (!isObj(p) || !isObj(p.objects)) continue;
    for (const o of Object.values(p.objects)) {
      if (isObj(o) && typeof o.src === 'string' && o.src.startsWith(prefix)) into.add(o.src.slice(prefix.length));
    }
  }
}

/**
 * Authoritative in-memory notebooks with debounced, atomic persistence.
 *
 * On disk a notebook is `<id>.json` (a small manifest: title, page list) plus one file per page
 * in `<id>.pages/`. A save rewrites only the pages that changed, and builds each page from cached
 * per-object JSON, so the event loop is never blocked for long however large the notebook is.
 * Files in the old single-file format still load and are converted by their first save.
 */
export class Store {
  private rooms = new Map<string, Promise<Room>>();
  private refs = new Map<string, number>();
  private evictTimers = new Map<string, NodeJS.Timeout>();
  /** what must outlive an evicted room: op de-duplication memory and a running countdown */
  private retired = new Map<string, { seen: string[]; countdown: TimerState | null; at: number }>();
  /** objects are never mutated in place (every change replaces them), so identity is a valid key */
  private objJson = new WeakMap<object, string>();
  private usage = new Map<string, Promise<number>>();
  private closed = false;
  onSaved: (id: string, t: number) => void = () => {};

  readonly evictDelayMs: number;
  private readonly saveDebounceMs: number;
  private readonly quiet: boolean;

  constructor(readonly dataDir: string, opts: StoreOptions = {}) {
    this.evictDelayMs = opts.evictDelayMs ?? 5 * 60 * 1000;
    this.saveDebounceMs = opts.saveDebounceMs ?? 1000;
    this.quiet = !!opts.quiet;
  }

  get uploadsDir() { return path.join(this.dataDir, 'uploads'); }
  file(id: string) { return path.join(this.dataDir, `${id}.json`); }
  pagesDir(id: string) { return path.join(this.dataDir, `${id}.pages`); }
  pageFile(id: string, pageId: string) { return path.join(this.pagesDir(id), pageFileName(pageId)); }

  private log(...a: unknown[]) { if (!this.quiet) console.error('[store]', ...a); }

  async init() {
    await fs.mkdir(this.uploadsDir, { recursive: true });
  }

  /** number of notebooks currently held in memory */
  get loaded(): number { return this.rooms.size; }
  isLoaded(id: string): boolean { return this.rooms.has(id); }

  get(id: string): Promise<Room> {
    let r = this.rooms.get(id);
    if (!r) {
      r = this.load(id);
      this.rooms.set(id, r);
    }
    return r;
  }

  // ---------- room lifetime ----------

  /** Gets a room and keeps it in memory until `release` is called the same number of times. */
  acquire(id: string): Promise<Room> {
    this.refs.set(id, (this.refs.get(id) ?? 0) + 1);
    const t = this.evictTimers.get(id);
    if (t) { clearTimeout(t); this.evictTimers.delete(id); }
    return this.get(id);
  }

  release(id: string) {
    const n = (this.refs.get(id) ?? 0) - 1;
    if (n > 0) { this.refs.set(id, n); return; }
    this.refs.delete(id);
    this.scheduleEvict(id);
  }

  private scheduleEvict(id: string) {
    if (this.closed || this.evictTimers.has(id) || !this.rooms.has(id)) return;
    const t = setTimeout(() => {
      this.evictTimers.delete(id);
      void this.evict(id).catch((err) => this.log('evict failed:', (err as Error).message));
    }, this.evictDelayMs);
    t.unref?.();
    this.evictTimers.set(id, t);
  }

  /** Drops an idle room from memory once everything it holds is safely on disk. */
  private async evict(id: string): Promise<void> {
    const p = this.rooms.get(id);
    if (!p || this.refs.has(id)) return;
    const room = await p;
    if (this.refs.has(id)) return; // somebody joined while it was loading
    if (room.timer) { clearTimeout(room.timer); room.timer = null; }
    if (room.dirty || room.saving) await this.save(room);
    // decided in one synchronous step: a join that arrived during the save keeps the room
    if (this.refs.has(id) || this.rooms.get(id) !== p) return;
    if (room.dirty || room.saving || room.timer) { this.scheduleEvict(id); return; } // the save failed, or more arrived: try again later
    this.rooms.delete(id);
    if (room.seenQueue.length || room.countdown) {
      this.retired.set(id, { seen: room.seenQueue.slice(-RETIRED_SEEN), countdown: room.countdown, at: Date.now() });
      if (this.retired.size > RETIRED_ROOMS) this.retired.delete(this.retired.keys().next().value as string);
    }
  }

  // ---------- loading ----------

  private blank(nb: Notebook): Room {
    return {
      nb, seq: 0, seen: new Set(), seenQueue: [], timer: null, saving: null, dirty: false,
      dirtyPages: new Set(), removedPages: new Set(), legacy: false, tidy: true, loadIssues: false, countdown: null,
    };
  }

  private async keepCopy(file: string, when: string) {
    await fs.copyFile(file, `${file}.corrupt-${when}`).catch((err) => this.log(`could not keep a copy of ${path.basename(file)}:`, (err as Error).message));
  }

  private async load(id: string): Promise<Room> {
    const room = this.blank(newNotebook(id, nanoid(10)));
    const old = this.retired.get(id);
    if (old) {
      this.retired.delete(id);
      if (Date.now() - old.at < RETIRED_MS) {
        room.seenQueue = old.seen;
        room.seen = new Set(old.seen);
        room.countdown = old.countdown;
      }
    }
    const file = this.file(id);
    const when = stamp();
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log(`could not read ${id}.json:`, (err as Error).message);
        room.loadIssues = true;
      }
      return room;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.log(`${id}.json is not valid JSON; starting empty and keeping a copy as ${id}.json.corrupt-${when}`);
      await this.keepCopy(file, when);
      room.loadIssues = true;
      return room;
    }

    const split = isObj(raw) && raw.format === 2 && Array.isArray(raw.pages);
    const lost: string[] = [];
    const copies = new Set<string>();
    if (split) {
      const m = raw as Record<string, unknown>;
      const pages: unknown[] = [];
      for (const meta of m.pages as unknown[]) {
        if (!isObj(meta) || typeof meta.id !== 'string' || !ID_RE.test(meta.id)) { pages.push(meta); continue; }
        const pf = this.pageFile(id, meta.id);
        let body: unknown = null;
        try {
          body = JSON.parse(await fs.readFile(pf, 'utf8'));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') lost.push(`page ${meta.id}: its file is missing`);
          else { lost.push(`page ${meta.id}: its file is unreadable`); copies.add(pf); }
          room.dirtyPages.add(meta.id); // written again by the next save
        }
        if (body !== null && !isObj(body)) { lost.push(`page ${meta.id}: its file is not a page`); copies.add(pf); body = null; }
        const b = (body ?? { objects: {}, order: [] }) as Record<string, unknown>;
        pages.push({ id: meta.id, title: meta.title, background: meta.background, objects: b.objects, order: b.order });
      }
      raw = { id, title: m.title, updatedAt: m.updatedAt, pages };
    } else if (isObj(raw)) raw = { ...raw, id };

    const s = salvageNotebook(raw);
    lost.push(...s.dropped);
    if (s.dropped.length) {
      copies.add(file);
      if (split) for (const pid of s.damagedPages) copies.add(this.pageFile(id, pid));
    }
    if (lost.length) {
      room.loadIssues = true;
      this.log(`${id}: kept everything valid, dropped ${lost.length} item(s): ${lost.slice(0, 20).join('; ')}${lost.length > 20 ? '; …' : ''}`);
      for (const f of copies) await this.keepCopy(f, when);
      if (copies.size) this.log(`${id}: the original file(s) were kept with the suffix .corrupt-${when}`);
    }
    if (s.nb) {
      s.nb.id = id;
      room.nb = s.nb;
      room.legacy = !split;
    }
    return room;
  }

  remember(room: Room, opId: string) {
    room.seen.add(opId);
    room.seenQueue.push(opId);
    if (room.seenQueue.length > SEEN_LIMIT) {
      for (const old of room.seenQueue.splice(0, SEEN_LIMIT / 10)) room.seen.delete(old);
    }
  }

  // ---------- saving ----------

  /** Marks the notebook as changed. `pages` are the pages whose content (objects, order) changed. */
  markDirty(room: Room, pages?: Iterable<string>) {
    if (pages) for (const p of pages) room.dirtyPages.add(p);
    room.dirty = true;
    if (room.timer) return;
    room.timer = setTimeout(() => {
      room.timer = null;
      void this.save(room);
    }, this.saveDebounceMs);
  }

  /** Replaces a room's whole notebook (restore): every page is rewritten and stale files are cleared. */
  replaceNotebook(room: Room, nb: Notebook) {
    for (const p of room.nb.pages) room.removedPages.add(p.id);
    room.nb = nb;
    room.tidy = true;
    this.markDirty(room, nb.pages.map((p) => p.id));
  }

  /** `"objects":{…},"order":[…]` for a page, assembled from cached per-object JSON. */
  private pageBody(page: Page): string {
    const parts: string[] = [];
    for (const oid of page.order) {
      const o = page.objects[oid];
      if (!o) continue;
      let s = this.objJson.get(o);
      if (s === undefined) { s = JSON.stringify(o); this.objJson.set(o, s); }
      parts.push(`${JSON.stringify(oid)}:${s}`);
    }
    return `"objects":{${parts.join(',')}},"order":${JSON.stringify(page.order)}`;
  }

  /** Serialises whatever is not cached yet in short slices, so `pageBody` afterwards is quick. */
  private async warm(page: Page): Promise<void> {
    let t = performance.now();
    for (const oid of page.order.slice()) {
      const o = page.objects[oid];
      if (!o || this.objJson.has(o)) continue;
      this.objJson.set(o, JSON.stringify(o));
      if (performance.now() - t > 6) { await tick(); t = performance.now(); }
    }
  }

  private manifest(nb: Notebook, t: number): string {
    return JSON.stringify({
      format: 2, id: nb.id, title: nb.title, updatedAt: t,
      pages: nb.pages.map((p) => ({ id: p.id, title: p.title, background: p.background })),
    });
  }

  private async save(room: Room): Promise<void> {
    if (room.saving) {
      await room.saving;
      if (!room.dirty) return;
    }
    room.dirty = false;
    const id = room.nb.id;
    const t = room.nb.updatedAt;
    if (room.legacy) for (const p of room.nb.pages) room.dirtyPages.add(p.id);
    const pages = [...room.dirtyPages];
    const removed = [...room.removedPages];
    room.dirtyPages = new Set();
    room.removedPages = new Set();
    room.saving = (async () => {
      try {
        await fs.mkdir(this.pagesDir(id), { recursive: true });
        for (const pid of pages) {
          const page = findPage(room.nb, pid);
          if (!page) continue; // deleted in the meantime
          await this.warm(page);
          const json = `{"id":${JSON.stringify(page.id)},${this.pageBody(page)}}`;
          await atomicWrite(this.pageFile(id, pid), (tmp) => fs.writeFile(tmp, json, 'utf8'));
        }
        // the manifest goes last: it never points at a page file that was not written
        const manifest = this.manifest(room.nb, t);
        await atomicWrite(this.file(id), (tmp) => fs.writeFile(tmp, manifest, 'utf8'));
        room.legacy = false;
        const live = new Set(room.nb.pages.map((p) => pageFileName(p.id)));
        if (room.tidy) {
          room.tidy = false;
          for (const name of await fs.readdir(this.pagesDir(id))) {
            if (/^p_.*\.json$/.test(name) && !live.has(name)) await fs.unlink(path.join(this.pagesDir(id), name)).catch(() => {});
          }
        } else {
          for (const pid of removed) if (!live.has(pageFileName(pid))) await fs.unlink(this.pageFile(id, pid)).catch(() => {});
        }
        this.onSaved(id, t);
      } catch (err) {
        this.log('save failed:', (err as Error).message);
        room.dirty = true;
        for (const pid of pages) room.dirtyPages.add(pid);
        for (const pid of removed) room.removedPages.add(pid);
      } finally {
        room.saving = null;
      }
    })();
    await room.saving;
  }

  /** Writes everything that is pending (used on shutdown). */
  async flushAll() {
    this.closed = true;
    for (const t of this.evictTimers.values()) clearTimeout(t);
    this.evictTimers.clear();
    for (const p of this.rooms.values()) {
      const room = await p;
      if (room.timer) { clearTimeout(room.timer); room.timer = null; }
      if (room.dirty || room.saving) await this.save(room);
    }
  }

  // ---------- backups ----------

  private backupPrefix(id: string) { return `${id}.backup-`; }

  /**
   * Writes the notebook as it is now to `<id>.backup-<time>.json` (one self-contained file in the
   * single-file format, which still loads) and keeps the newest five. Returns the file name, or
   * null when the notebook is empty and there is nothing worth keeping. Throws when it cannot be written.
   */
  async backup(room: Room): Promise<string | null> {
    const nb = room.nb;
    if (notebookIsEmpty(nb)) return null;
    const name = `${this.backupPrefix(nb.id)}${stamp()}.json`;
    const pages = [...nb.pages];
    await atomicWrite(path.join(this.dataDir, name), async (tmp) => {
      const fh = await fs.open(tmp, 'w');
      try {
        await fh.write(`{"id":${JSON.stringify(nb.id)},"title":${JSON.stringify(nb.title)},"updatedAt":${Number(nb.updatedAt) || 0},"pages":[`);
        for (let i = 0; i < pages.length; i++) {
          const p = pages[i];
          await this.warm(p);
          await fh.write(`${i ? ',' : ''}{"id":${JSON.stringify(p.id)},"title":${JSON.stringify(p.title)},"background":${JSON.stringify(p.background)},${this.pageBody(p)}}`);
        }
        await fh.write(']}');
      } finally {
        await fh.close();
      }
    });
    const mine = (await fs.readdir(this.dataDir)).filter((n) => n.startsWith(this.backupPrefix(nb.id)) && n.endsWith('.json')).sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - BACKUPS_KEPT))) await fs.unlink(path.join(this.dataDir, old)).catch(() => {});
    return name;
  }

  // ---------- uploads: quota and orphan sweep ----------

  /** Bytes stored under uploads/<id>/ (measured once, then kept up to date). */
  uploadUsage(id: string): Promise<number> {
    let u = this.usage.get(id);
    if (!u) {
      u = (async () => {
        let total = 0;
        const dir = path.join(this.uploadsDir, id);
        for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
          total += (await fs.stat(path.join(dir, name)).catch(() => null))?.size ?? 0;
        }
        return total;
      })();
      this.usage.set(id, u);
    }
    return u;
  }

  addUploadUsage(id: string, bytes: number) {
    const cur = this.usage.get(id);
    if (cur) this.usage.set(id, cur.then((n) => Math.max(0, n + bytes)));
  }

  /**
   * Restarts the 24-hour clock of upload files that just stopped being referenced (an image was
   * deleted, a page removed, a notebook replaced), so an Undo shortly afterwards still finds the file.
   */
  touchUploads(srcs: Iterable<string>) {
    const now = new Date();
    for (const src of srcs) {
      const m = /^\/uploads\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64}\.(?:png|jpg|gif|webp))$/.exec(src);
      if (m) void fs.utimes(path.join(this.uploadsDir, m[1], m[2]), now, now).catch(() => {});
    }
  }

  /** Upload file names a notebook still refers to, or null when that cannot be known for certain. */
  private async referencedUploads(id: string, dataFiles: string[]): Promise<Set<string> | null> {
    const refs = new Set<string>();
    // a copy kept from a damaged load means objects were dropped: their images must stay
    if (dataFiles.some((n) => n.startsWith(`${id}.json.corrupt`))) return null;
    const pageFiles = await fs.readdir(this.pagesDir(id)).catch(() => [] as string[]);
    if (pageFiles.some((n) => n.includes('.corrupt'))) return null;

    const loaded = this.rooms.get(id);
    if (loaded) {
      const room = await loaded;
      if (room.loadIssues) return null;
      collectUploads(id, room.nb.pages, refs);
    } else {
      let raw: unknown;
      try {
        raw = JSON.parse(await fs.readFile(this.file(id), 'utf8'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
        raw = null; // no notebook was ever saved under this id
      }
      if (raw !== null) {
        if (!isObj(raw) || !Array.isArray(raw.pages)) return null;
        if (raw.format === 2) {
          for (const meta of raw.pages) {
            if (!isObj(meta) || typeof meta.id !== 'string' || !ID_RE.test(meta.id)) return null;
            let body: unknown;
            try { body = JSON.parse(await fs.readFile(this.pageFile(id, meta.id), 'utf8')); } catch { return null; }
            collectUploads(id, [body], refs);
            await tick();
          }
        } else collectUploads(id, raw.pages, refs);
      }
    }
    // backups stay restorable: what they show is kept as well
    for (const name of dataFiles) {
      if (!name.startsWith(this.backupPrefix(id)) || !name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(this.dataDir, name), 'utf8')) as unknown;
        collectUploads(id, isObj(raw) ? raw.pages : null, refs);
      } catch {
        return null;
      }
      await tick();
    }
    return refs;
  }

  /**
   * Deletes upload files that no object in their notebook refers to and that are older than
   * `maxAgeMs`. A notebook that failed to load cleanly is left alone. Returns what was deleted.
   */
  async sweepUploads(now = Date.now(), maxAgeMs = UPLOAD_MAX_AGE_MS): Promise<string[]> {
    const deleted: string[] = [];
    const dataFiles = await fs.readdir(this.dataDir).catch(() => [] as string[]);
    for (const id of await fs.readdir(this.uploadsDir).catch(() => [] as string[])) {
      if (!ID_RE.test(id)) continue;
      const dir = path.join(this.uploadsDir, id);
      try {
        const names = await fs.readdir(dir);
        // only look closer when something is old enough to go
        const old: { name: string; size: number }[] = [];
        for (const name of names) {
          const st = await fs.stat(path.join(dir, name));
          if (st.isFile() && now - st.mtimeMs > maxAgeMs) old.push({ name, size: st.size });
        }
        if (!old.length) continue;
        const refs = await this.referencedUploads(id, dataFiles);
        if (!refs) { this.log(`uploads of ${id} were not swept: the notebook did not load cleanly`); continue; }
        for (const f of old) {
          if (refs.has(f.name)) continue;
          await fs.unlink(path.join(dir, f.name));
          this.addUploadUsage(id, -f.size);
          deleted.push(`${id}/${f.name}`);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOTDIR') this.log(`sweep of ${id} failed:`, (err as Error).message);
      }
    }
    return deleted;
  }
}

/** Reads a stored notebook from disk in either format, without validating it (tests, tools). */
export async function readNotebookFromDisk(dataDir: string, id: string): Promise<Notebook> {
  const raw = JSON.parse(await fs.readFile(path.join(dataDir, `${id}.json`), 'utf8')) as Record<string, unknown>;
  if (raw.format !== 2) return raw as unknown as Notebook;
  const pages: Page[] = [];
  for (const meta of raw.pages as { id: string; title: string; background: Page['background'] }[]) {
    const body = JSON.parse(await fs.readFile(path.join(dataDir, `${id}.pages`, pageFileName(meta.id)), 'utf8')) as Pick<Page, 'objects' | 'order'>;
    pages.push({ id: meta.id, title: meta.title, background: meta.background, objects: body.objects, order: body.order });
  }
  return { id: raw.id as string, title: raw.title as string, updatedAt: raw.updatedAt as number, pages };
}

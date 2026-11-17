// Part A: data safety and server hardening.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, type AppOptions, type RunningApp } from '../server/app';
import { clientIp, isLocalAddress, RateLimiter } from '../server/limits';
import { pageFileName, readNotebookFromDisk } from '../server/store';
import { moveStaysInRange } from '../shared/ops';
import { salvageNotebook, validUpdate } from '../shared/schema';
import type { BoardObject, ImageObj, JoinAck, Notebook, Op, Stroke } from '../shared/types';
import { mkShape, mkStroke } from './helpers';

const dirs: string[] = [];
const apps: RunningApp[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'mathboard-safety-'));
  dirs.push(d);
  return d;
};
const start = async (o: AppOptions = {}) => {
  const app = await createApp({ port: 0, dataDir: tmp(), quiet: true, sweepUploads: false, ...o });
  apps.push(app);
  return app;
};
afterAll(async () => {
  for (const a of apps) await a.close().catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const client = (port: number, passcode?: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const s = connect(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true, auth: { passcode }, reconnection: false });
    s.once('connect', () => resolve(s));
    s.once('connect_error', (e) => reject(e));
  });
const join = (s: Socket, notebookId: string, name = 'A', extra: Record<string, unknown> = {}): Promise<JoinAck> =>
  new Promise((resolve) => s.emit('join', { notebookId, userId: `user-${name}`, name, ...extra }, resolve));
const once = <T = unknown>(s: Socket, ev: string): Promise<T> => new Promise((resolve) => s.once(ev, resolve));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean | Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await wait(15); }
  throw new Error('condition not reached in time');
};
const send = async (s: Socket, ops: Op[]) => {
  const ack = once<{ opIds: string[] }>(s, 'ack');
  s.emit('ops', { ops });
  return ack;
};
const add = (pageId: string, obj: BoardObject, opId = `op-${obj.id}`): Op => ({ opId, pageId, kind: 'add', obj });
const image = (id: string, src: string): ImageObj => ({ id, type: 'image', authorId: 'u1', createdAt: 1, src, x: 0, y: 0, w: 100, h: 80, naturalW: 100, naturalH: 80 });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const upload = (port: number, id: string, headers: Record<string, string> = {}) =>
  fetch(`http://localhost:${port}/api/upload/${id}`, { method: 'POST', headers: { 'content-type': 'image/png', ...headers }, body: PNG });

const legacyNotebook = (id: string): Notebook => ({
  id, title: 'Algebra 2', updatedAt: 1700000000000,
  pages: [
    { id: 'p1', title: 'Warm-up', background: 'grid', objects: { s1: mkStroke('s1', [0, 0, 0.5, 10, 10, 0.5]), sh: mkShape('sh', 'rect', [0, 0, 50, 40]) }, order: ['s1', 'sh'] },
    { id: 'p2', title: 'Question 2', background: 'lined', objects: { s2: mkStroke('s2', [5, 5, 0.5]) }, order: ['s2'] },
  ],
});

describe('A1 — one bad object must not blank a notebook', () => {
  it('salvage keeps every valid page and object and reports what it dropped', () => {
    const nb = legacyNotebook('x') as unknown as { pages: any[]; title: unknown };
    nb.pages[0].objects.bad = { ...mkShape('bad', 'line', []) }; // points: [] is not a loadable shape
    nb.pages[0].order.push('bad', 'ghost');
    nb.pages[1].background = 'plaid';
    nb.pages.push({ title: 'no id' }, 'junk');
    nb.title = 42;
    const r = salvageNotebook(nb);
    expect(r.nb!.pages.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(r.nb!.pages[0].order).toEqual(['s1', 'sh']);
    expect(Object.keys(r.nb!.pages[0].objects).sort()).toEqual(['s1', 'sh']);
    expect(r.nb!.pages[1].background).toBe('blank');
    expect(r.nb!.pages[1].objects.s2).toBeTruthy();
    expect(r.nb!.title).toBe('Untitled notebook');
    expect(r.dropped.join('|')).toMatch(/object bad/);
    expect(r.damagedPages).toEqual(['p1', 'p2']);
    // nothing usable at all
    expect(salvageNotebook({ pages: [] }).nb).toBeNull();
    expect(salvageNotebook('nope').nb).toBeNull();
    // a clean notebook passes straight through
    expect(salvageNotebook(legacyNotebook('y')).dropped).toEqual([]);
  });

  it('loads a damaged file with everything valid intact and keeps a timestamped copy of the original', async () => {
    const dir = tmp();
    const nb = legacyNotebook('hurt') as unknown as { pages: any[] };
    nb.pages[0].objects.bad = mkShape('bad', 'line', []);
    nb.pages[0].order.push('bad');
    const original = JSON.stringify(nb);
    writeFileSync(path.join(dir, 'hurt.json'), original);
    const srv = await start({ dataDir: dir });
    const a = await client(srv.port);
    const snap = (await join(a, 'hurt')).notebook!;
    expect(snap.title).toBe('Algebra 2');
    expect(snap.pages.map((p) => p.title)).toEqual(['Warm-up', 'Question 2']);
    expect(snap.pages[0].order).toEqual(['s1', 'sh']);
    expect(snap.pages[1].order).toEqual(['s2']);
    const copies = readdirSync(dir).filter((n) => /^hurt\.json\.corrupt-\d{8}T\d+Z$/.test(n));
    expect(copies.length).toBe(1);
    expect(readFileSync(path.join(dir, copies[0]), 'utf8')).toBe(original);
    a.close();
  });

  it('a file that is not JSON at all starts empty but is never lost', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'torn.json'), '{"id":"torn","pages":[{"id":"p1","ti');
    const srv = await start({ dataDir: dir });
    const a = await client(srv.port);
    const snap = (await join(a, 'torn')).notebook!;
    expect(snap.pages.length).toBe(1);
    expect(snap.pages[0].order).toEqual([]);
    expect(readdirSync(dir).some((n) => n.startsWith('torn.json.corrupt-'))).toBe(true);
    a.close();
  });

  it('a damaged page file costs only its bad objects', async () => {
    const dir = tmp();
    let srv = await start({ dataDir: dir });
    let a = await client(srv.port);
    const ja = await join(a, 'split');
    const p1 = ja.notebook!.pages[0].id;
    a.emit('pageop', { op: { opId: 'pg', kind: 'add', page: { id: 'second', title: 'Two', background: 'blank' }, index: 1 } });
    await send(a, [add(p1, mkStroke('a', [0, 0, 0.5])), add('second', mkStroke('b', [1, 1, 0.5])), add('second', mkStroke('c', [2, 2, 0.5]))]);
    a.close();
    await srv.close();
    // break one object inside the second page's file
    const pf = path.join(dir, 'split.pages', pageFileName('second'));
    const body = JSON.parse(readFileSync(pf, 'utf8'));
    body.objects.b.size = 'huge';
    writeFileSync(pf, JSON.stringify(body));
    srv = await start({ dataDir: dir });
    a = await client(srv.port);
    const snap = (await join(a, 'split')).notebook!;
    expect(snap.pages[0].order).toEqual(['a']);
    expect(snap.pages[1].title).toBe('Two');
    expect(snap.pages[1].order).toEqual(['c']);
    expect(readdirSync(path.join(dir, 'split.pages')).some((n) => n.includes('.corrupt-'))).toBe(true);
    a.close();
  });
});

describe('A2 — updates that would leave an invalid object are rejected', () => {
  it('validUpdate: only fields of the object type, and the result must be loadable', () => {
    const sh = mkShape('s', 'line', [0, 0, 5, 5]);
    expect(validUpdate(sh, { points: [] })).toBe(false);
    expect(validUpdate(sh, { points: [1, 2, 3, 4] })).toBe(true);
    expect(validUpdate(sh, { dashed: true, fill: '#ff0000', fillOpacity: 0.5 })).toBe(true);
    expect(validUpdate(sh, { fill: null })).toBe(true);
    expect(validUpdate(sh, { color: null })).toBe(false); // a required field cannot be cleared
    expect(validUpdate(sh, { text: 'hi' })).toBe(false); // not a shape field
    const st = mkStroke('k', [0, 0, 0.5]);
    expect(validUpdate(st, { kind: 'rect' })).toBe(false);
    expect(validUpdate(st, { size: 5, color: '#123456' })).toBe(true);
    expect(validUpdate(image('i', '/uploads/nb/abc.png'), { crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } })).toBe(true);
    expect(validUpdate(image('i', '/uploads/nb/abc.png'), { crop: { x: 0.8, y: 0, w: 0.5, h: 1 } })).toBe(false);
    expect(validUpdate(image('i', '/uploads/nb/abc.png'), { points: [1, 2] })).toBe(false);
  });

  it('moveStaysInRange guards the numeric range', () => {
    expect(moveStaysInRange(mkStroke('a', [0, 0, 0.5, 10, 10, 0.5]), 5e8, 0)).toBe(true);
    expect(moveStaysInRange(mkStroke('a', [0, 0, 0.5, 10, 10, 0.5]), 1e9, 0)).toBe(false);
    expect(moveStaysInRange(mkShape('s', 'line', [9e8, 0, 9.5e8, 5]), 6e7, 0)).toBe(false);
    expect(moveStaysInRange(image('i', '/uploads/nb/a.png'), 0, -1e9 - 1)).toBe(false);
    expect(moveStaysInRange(image('i', '/uploads/nb/a.png'), Number.NaN, 0)).toBe(false);
  });

  it('the server drops the op, still acknowledges it, and the notebook stays loadable', async () => {
    const dir = tmp();
    let srv = await start({ dataDir: dir });
    const a = await client(srv.port), b = await client(srv.port);
    const pageId = (await join(a, 'guard', 'A')).notebook!.pages[0].id;
    await join(b, 'guard', 'B');
    await send(a, [add(pageId, mkShape('sh', 'rect', [0, 0, 50, 40])), add(pageId, mkStroke('st', [9e8, 0, 0.5, 9e8 + 10, 5, 0.5]))]);
    const relayed: Op[] = [];
    b.on('ops', (m: { ops: Op[] }) => relayed.push(...m.ops));
    const ack = await send(a, [
      { opId: 'bad1', pageId, kind: 'update', id: 'sh', patch: { points: [] } },
      { opId: 'bad2', pageId, kind: 'update', id: 'st', patch: { fill: '#ff0000' } },
      { opId: 'bad3', pageId, kind: 'move', ids: ['sh', 'st'], dx: 2e8, dy: 0 },
      { opId: 'good', pageId, kind: 'update', id: 'sh', patch: { dashed: true } },
    ]);
    expect(ack.opIds).toEqual(['bad1', 'bad2', 'bad3', 'good']); // the client's queue drains
    await until(() => relayed.length > 0);
    expect(relayed.map((o) => o.opId)).toEqual(['good']);
    a.close(); b.close();
    await srv.close();

    srv = await start({ dataDir: dir });
    const c = await client(srv.port);
    const page = (await join(c, 'guard')).notebook!.pages[0];
    expect(page.objects.sh).toMatchObject({ points: [0, 0, 50, 40], dashed: true });
    expect((page.objects.st as Stroke).points[0]).toBe(9e8); // not moved out of range
    expect(readdirSync(dir).some((n) => n.includes('.corrupt'))).toBe(false);
    c.close();
  });
});

describe('A3 — a backup is written before restore', () => {
  it('keeps what was replaced, and only the newest five', async () => {
    const dir = tmp();
    const srv = await start({ dataDir: dir });
    const a = await client(srv.port);
    const ja = await join(a, 'bk');
    const pageId = ja.notebook!.pages[0].id;
    const backups = () => readdirSync(dir).filter((n) => /^bk\.backup-.*\.json$/.test(n)).sort();
    const restore = (nb: Notebook) => new Promise<{ ok: boolean }>((res) => a.emit('restore', { notebook: nb }, res));
    const with_ = (id: string): Notebook => {
      const nb: Notebook = JSON.parse(JSON.stringify(ja.notebook));
      nb.pages[0].objects[id] = mkStroke(id, [1, 1, 0.5]);
      nb.pages[0].order = [id];
      return nb;
    };
    // an empty board has nothing worth keeping
    expect((await restore(with_('v0'))).ok).toBe(true);
    expect(backups()).toEqual([]);
    for (let i = 1; i <= 7; i++) {
      expect((await restore(with_(`v${i}`))).ok).toBe(true);
      await wait(8);
    }
    const kept = backups();
    expect(kept.length).toBe(5);
    // the newest backup holds the board as it was just before the last restore
    const last = JSON.parse(readFileSync(path.join(dir, kept[4]), 'utf8')) as Notebook;
    expect(last.pages[0].order).toEqual(['v6']);
    expect(last.pages[0].objects.v6).toBeTruthy();
    const first = JSON.parse(readFileSync(path.join(dir, kept[0]), 'utf8')) as Notebook;
    expect(first.pages[0].order).toEqual(['v2']);
    // a backup is a complete notebook file: put in place of the manifest, it loads
    expect(salvageNotebook(last).dropped).toEqual([]);
    // the explicit backup request used by notebook-wide actions
    await send(a, [add(pageId, mkStroke('extra', [3, 3, 0.5]))]);
    const r = await new Promise<{ ok: boolean; file: string }>((res) => a.emit('backup', {}, res));
    expect(r.ok).toBe(true);
    expect(existsSync(path.join(dir, r.file))).toBe(true);
    expect(backups().length).toBe(5);
    a.close();
  });
});

describe('A4 — idle rooms are evicted', () => {
  it('a notebook that was joined but never changed is dropped from memory and never written', async () => {
    const dir = tmp();
    const srv = await start({ dataDir: dir, evictDelayMs: 30 });
    const a = await client(srv.port);
    await join(a, 'ghost1');
    await join(a, 'ghost2'); // switching boards releases the first
    expect(srv.store.loaded).toBe(2);
    a.close();
    await until(() => srv.store.loaded === 0);
    expect(readdirSync(dir).filter((n) => n !== 'uploads')).toEqual([]);
  });

  it('evicts after the save has flushed, and a later join gets everything back', async () => {
    const dir = tmp();
    const srv = await start({ dataDir: dir, evictDelayMs: 30 });
    const a = await client(srv.port);
    const pageId = (await join(a, 'evict')).notebook!.pages[0].id;
    await send(a, [add(pageId, mkStroke('s', [0, 0, 0.5, 10, 0, 0.5])), { opId: 'mv', pageId, kind: 'move', ids: ['s'], dx: 100, dy: 0 }]);
    a.close(); // well inside the save debounce: eviction has to flush first
    await until(() => !srv.store.isLoaded('evict'));
    expect((await readNotebookFromDisk(dir, 'evict')).pages[0].objects.s).toBeTruthy();
    const b = await client(srv.port);
    // the server still knows which ops it applied, so a re-sent move is not applied twice
    const jb = await join(b, 'evict', 'B', { pending: ['mv', 'never-sent'] });
    expect(jb.seen).toEqual(['mv']);
    expect((jb.notebook!.pages[0].objects.s as Stroke).points).toEqual([100, 0, 0.5, 110, 0, 0.5]);
    b.close();
  });

  it('a join during eviction keeps the room and loses nothing', async () => {
    const dir = tmp();
    const srv = await start({ dataDir: dir, evictDelayMs: 20 });
    for (let round = 0; round < 12; round++) {
      const a = await client(srv.port);
      const pageId = (await join(a, 'race')).notebook!.pages[0].id;
      await send(a, [add(pageId, mkStroke(`r${round}`, [round, 0, 0.5]))]);
      a.close();
      await wait(round * 4); // land before, during and after the eviction
    }
    const b = await client(srv.port);
    const page = (await join(b, 'race')).notebook!.pages[0];
    expect(page.order).toEqual(Array.from({ length: 12 }, (_, i) => `r${i}`));
    b.close();
    await until(() => srv.store.loaded === 0);
    expect((await readNotebookFromDisk(dir, 'race')).pages[0].order.length).toBe(12);
  });
});

describe('A5 — rate limits and quotas', () => {
  it('RateLimiter counts per key inside a window', () => {
    let now = 0;
    const l = new RateLimiter(3, 1000, () => now);
    expect([l.hit('a'), l.hit('a'), l.hit('a')]).toEqual([true, true, true]);
    expect(l.blocked('a')).toBe(true);
    expect(l.hit('a')).toBe(false);
    expect(l.blocked('b')).toBe(false);
    expect(l.retryAfter('a')).toBe(1);
    now = 1001;
    expect(l.blocked('a')).toBe(false);
    expect(l.hit('a')).toBe(true);
  });

  it('clientIp only believes X-Forwarded-For from a local proxy', () => {
    expect(isLocalAddress('127.0.0.1') && isLocalAddress('::1') && isLocalAddress('10.2.3.4') && isLocalAddress('192.168.1.9') && isLocalAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLocalAddress('8.8.8.8') || isLocalAddress('172.32.0.1')).toBe(false);
    expect(clientIp('::ffff:127.0.0.1', '203.0.113.7')).toBe('203.0.113.7'); // cloudflared on the same machine
    expect(clientIp('10.0.0.5', '198.51.100.2, 10.0.0.9')).toBe('198.51.100.2'); // platform proxy chain
    expect(clientIp('203.0.113.7', '1.2.3.4')).toBe('203.0.113.7'); // direct client: the header is ignored
    expect(clientIp('127.0.0.1', '203.0.113.7', false)).toBe('127.0.0.1');
    expect(clientIp('127.0.0.1', undefined)).toBe('127.0.0.1');
    expect(clientIp(undefined, undefined)).toBe('unknown');
  });

  it('the passcode cannot be brute-forced over HTTP or the socket handshake', async () => {
    const srv = await start({ passcode: 'open-sesame', limits: { passcodeFails: 3 } });
    const check = (passcode: string) =>
      fetch(`http://localhost:${srv.port}/api/passcode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode }) });
    for (const guess of ['a', 'b']) expect(await (await check(guess)).json()).toEqual({ ok: false });
    await expect(client(srv.port, 'c')).rejects.toThrow(/passcode/); // the third wrong guess, this time on a socket
    const blocked = await check('open-sesame');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    await expect(client(srv.port, 'open-sesame')).rejects.toThrow(/rate/);
    expect((await upload(srv.port, 'nb', { 'x-passcode': 'open-sesame' })).status).toBe(429);
  });

  it('a correct passcode is never counted', async () => {
    const srv = await start({ passcode: 'pw', limits: { passcodeFails: 2 } });
    for (let i = 0; i < 6; i++) {
      const s = await client(srv.port, 'pw');
      expect((await join(s, 'fine', 'A', { passcode: 'pw' })).ok).toBe(true);
      s.close();
    }
  });

  it('limits uploads per minute and caps the bytes a notebook may hold', async () => {
    const srv = await start({ limits: { uploadsPerMinute: 3 } });
    expect((await upload(srv.port, 'r1')).status).toBe(200);
    expect((await upload(srv.port, 'r1')).status).toBe(200);
    expect((await upload(srv.port, 'r1')).status).toBe(200);
    const over = await upload(srv.port, 'r1');
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);

    const capped = await start({ limits: { uploadQuotaBytes: PNG.length * 2 + 10 } });
    expect((await upload(capped.port, 'q1')).status).toBe(200);
    expect((await upload(capped.port, 'q1')).status).toBe(200);
    const full = await upload(capped.port, 'q1');
    expect(full.status).toBe(413);
    expect(((await full.json()) as { error: string }).error).toMatch(/image storage limit/);
    expect((await upload(capped.port, 'q2')).status).toBe(200); // the cap is per notebook
    expect(readdirSync(path.join(capped.store.uploadsDir, 'q1')).length).toBe(2);
  });
});

describe('A6 — orphaned uploads are swept', () => {
  const age = (file: string, days: number) => { const t = new Date(Date.now() - days * 24 * 3600 * 1000); utimesSync(file, t, t); };

  it('removes old files nothing refers to, and nothing else', async () => {
    const dir = tmp();
    const srv = await start({ dataDir: dir });
    const a = await client(srv.port);
    const pageId = (await join(a, 'sw')).notebook!.pages[0].id;
    const up = async () => ((await (await upload(srv.port, 'sw')).json()) as { url: string }).url;
    const used = await up(), orphan = await up(), fresh = await up(), removed = await up();
    await send(a, [add(pageId, image('img', used)), add(pageId, image('gone', removed))]);
    const file = (url: string) => path.join(dir, url);
    for (const u of [used, orphan, removed]) age(file(u), 3);
    // deleting an image restarts its file's clock, so an Undo soon afterwards still works
    await send(a, [{ opId: 'del', pageId, kind: 'delete', id: 'gone' }]);
    await until(() => Date.now() - statSync(file(removed)).mtimeMs < 60000);
    const deleted = await srv.store.sweepUploads();
    expect(deleted).toEqual([`sw/${path.basename(orphan)}`]);
    expect(existsSync(file(used)) && existsSync(file(fresh)) && existsSync(file(removed))).toBe(true);
    expect(existsSync(file(orphan))).toBe(false);
    a.close();
  });

  it('reads notebooks that are not in memory from disk, in both formats, and respects backups', async () => {
    const dir = tmp();
    mkdirSync(path.join(dir, 'uploads', 'old'), { recursive: true });
    mkdirSync(path.join(dir, 'uploads', 'nofile'), { recursive: true });
    const put = (nb: string, name: string) => { const f = path.join(dir, 'uploads', nb, name); writeFileSync(f, PNG); age(f, 2); return f; };
    const kept = put('old', 'kept.png'), inBackup = put('old', 'backup.png'), lost = put('old', 'lost.png'), stray = put('nofile', 'stray.png');
    const nb = legacyNotebook('old');
    nb.pages[0].objects.i = image('i', '/uploads/old/kept.png');
    nb.pages[0].order.push('i');
    writeFileSync(path.join(dir, 'old.json'), JSON.stringify(nb));
    const bk = legacyNotebook('old');
    bk.pages[1].objects.j = image('j', '/uploads/old/backup.png');
    writeFileSync(path.join(dir, 'old.backup-20250101T000000000Z.json'), JSON.stringify(bk));
    const srv = await start({ dataDir: dir });
    expect((await srv.store.sweepUploads()).sort()).toEqual(['nofile/stray.png', 'old/lost.png']);
    expect(existsSync(kept) && existsSync(inBackup)).toBe(true);
    expect(existsSync(lost) || existsSync(stray)).toBe(false);
    expect(srv.store.loaded).toBe(0); // sweeping does not pull notebooks into memory
  });

  it('never deletes for a notebook that failed to load', async () => {
    const dir = tmp();
    mkdirSync(path.join(dir, 'uploads', 'broken'), { recursive: true });
    mkdirSync(path.join(dir, 'uploads', 'dropped'), { recursive: true });
    const f1 = path.join(dir, 'uploads', 'broken', 'a.png'), f2 = path.join(dir, 'uploads', 'dropped', 'b.png');
    writeFileSync(f1, PNG); age(f1, 9);
    writeFileSync(f2, PNG); age(f2, 9);
    writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    const nb = legacyNotebook('dropped') as unknown as { pages: any[] };
    nb.pages[0].objects.i = { ...image('i', '/uploads/dropped/b.png'), w: 'wide' }; // invalid: dropped at load
    writeFileSync(path.join(dir, 'dropped.json'), JSON.stringify(nb));
    const srv = await start({ dataDir: dir });
    expect(await srv.store.sweepUploads()).toEqual([]); // unreadable on disk
    const a = await client(srv.port);
    await join(a, 'broken');
    await join(a, 'dropped');
    expect(await srv.store.sweepUploads()).toEqual([]); // loaded with losses
    a.close();
    await srv.close();
    // and still not after a restart: the kept .corrupt copy marks the notebook as damaged
    const again = await start({ dataDir: dir });
    expect(await again.store.sweepUploads()).toEqual([]);
    expect(existsSync(f1) && existsSync(f2)).toBe(true);
  });
});

describe('A7 — storage format: a manifest plus one file per page', () => {
  it('a save rewrites only the pages that changed', async () => {
    const dir = tmp();
    const srv = await start({ dataDir: dir });
    const a = await client(srv.port);
    const p1 = (await join(a, 'fmt')).notebook!.pages[0].id;
    a.emit('pageop', { op: { opId: 'pg', kind: 'add', page: { id: 'PageTwo', title: 'Two', background: 'dots' }, index: 1 } });
    let saved = once(a, 'saved');
    await send(a, [add(p1, mkStroke('a', [0, 0, 0.5])), add('PageTwo', mkStroke('b', [1, 1, 0.5]))]);
    await saved;
    const manifest = JSON.parse(readFileSync(path.join(dir, 'fmt.json'), 'utf8'));
    expect(manifest.format).toBe(2);
    expect(manifest.pages).toEqual([{ id: p1, title: 'Page 1', background: 'grid' }, { id: 'PageTwo', title: 'Two', background: 'dots' }]);
    // page ids are escaped so they cannot collide on a case-insensitive file system
    expect(pageFileName('PageTwo')).toBe('p_=page=two.json');
    const f1 = path.join(dir, 'fmt.pages', pageFileName(p1)), f2 = path.join(dir, 'fmt.pages', pageFileName('PageTwo'));
    const before1 = statSync(f1).mtimeMs, before2 = statSync(f2).mtimeMs;
    await wait(30);
    saved = once(a, 'saved');
    await send(a, [add('PageTwo', mkStroke('c', [2, 2, 0.5]))]);
    a.emit('pageop', { op: { opId: 'rn', kind: 'rename', pageId: p1, title: 'Renamed' } });
    await saved;
    expect(statSync(f1).mtimeMs).toBe(before1); // untouched: a rename only changes the manifest
    expect(statSync(f2).mtimeMs).toBeGreaterThan(before2);
    const nb = await readNotebookFromDisk(dir, 'fmt');
    expect(nb.pages.map((p) => `${p.title}:${p.order.join(',')}`)).toEqual(['Renamed:a', 'Two:b,c']);
    // deleting a page removes its file
    saved = once(a, 'saved');
    a.emit('pageop', { op: { opId: 'dl', kind: 'delete', pageId: 'PageTwo' } });
    await saved;
    expect(existsSync(f2)).toBe(false);
    a.close();
  });

  it('a notebook file saved before this change opens intact and is converted by its first save', async () => {
    const dir = tmp();
    const old = legacyNotebook('legacy');
    writeFileSync(path.join(dir, 'legacy.json'), JSON.stringify(old));
    let srv = await start({ dataDir: dir });
    let a = await client(srv.port);
    const snap = (await join(a, 'legacy')).notebook!;
    expect(snap).toEqual(old);
    // opening it changes nothing on disk
    expect(JSON.parse(readFileSync(path.join(dir, 'legacy.json'), 'utf8'))).toEqual(old);
    expect(existsSync(path.join(dir, 'legacy.pages'))).toBe(false);
    const saved = once(a, 'saved');
    await send(a, [add('p2', mkStroke('new', [7, 7, 0.5]))]);
    await saved;
    expect(JSON.parse(readFileSync(path.join(dir, 'legacy.json'), 'utf8')).format).toBe(2);
    expect(readdirSync(path.join(dir, 'legacy.pages')).sort()).toEqual(['p_p1.json', 'p_p2.json']); // every page, not only the edited one
    a.close();
    await srv.close();
    srv = await start({ dataDir: dir });
    a = await client(srv.port);
    const again = (await join(a, 'legacy')).notebook!;
    expect(again.title).toBe('Algebra 2');
    expect(again.pages[0]).toEqual(old.pages[0]);
    expect(again.pages[1].order).toEqual(['s2', 'new']);
    expect(readdirSync(dir).some((n) => n.includes('.corrupt'))).toBe(false);
    a.close();
  });

  it('restore replaces every page file and clears the ones that are gone', async () => {
    const dir = tmp();
    const srv = await start({ dataDir: dir });
    const a = await client(srv.port);
    const ja = await join(a, 'swap');
    const p1 = ja.notebook!.pages[0].id;
    let saved = once(a, 'saved');
    await send(a, [add(p1, mkStroke('a', [0, 0, 0.5]))]);
    await saved;
    saved = once(a, 'saved');
    await new Promise((res) => a.emit('restore', { notebook: legacyNotebook('swap') }, res));
    await saved;
    expect(readdirSync(path.join(dir, 'swap.pages')).sort()).toEqual(['p_p1.json', 'p_p2.json']);
    expect((await readNotebookFromDisk(dir, 'swap')).pages.map((p) => p.order)).toEqual([['s1', 'sh'], ['s2']]);
    a.close();
  });
});

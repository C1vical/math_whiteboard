import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type RunningApp } from '../server/app';
import type { JoinAck, Notebook, Op, Stroke } from '../shared/types';
import { mkStroke } from './helpers';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'mathboard-test-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const client = (port: number, passcode?: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const s = connect(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true, auth: { passcode }, reconnection: false });
    s.once('connect', () => resolve(s));
    s.once('connect_error', (e) => reject(e));
  });

const join = (s: Socket, notebookId: string, name: string, extra: Record<string, unknown> = {}): Promise<JoinAck> =>
  new Promise((resolve) => s.emit('join', { notebookId, userId: `user-${name}`, name, ...extra }, resolve));

const once = <T = unknown>(s: Socket, ev: string): Promise<T> => new Promise((resolve) => s.once(ev, resolve));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const addOp = (pageId: string, obj: Stroke, opId = `op-${obj.id}`): Op => ({ opId, pageId, kind: 'add', obj });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

describe('server integration', () => {
  let app: RunningApp;
  let dataDir: string;
  let url: string;

  beforeAll(async () => {
    dataDir = tmp();
    app = await createApp({ port: 0, dataDir });
    url = `http://localhost:${app.port}`;
  });
  afterAll(async () => {
    await app.close();
  });

  it('relays live strokes point-by-point, in order, before live:end and the commit', async () => {
    const a = await client(app.port), b = await client(app.port);
    const ja = await join(a, 'live1', 'A');
    const jb = await join(b, 'live1', 'B');
    expect(ja.ok && jb.ok).toBe(true);
    expect(ja.color).not.toBe(jb.color); // distinct auto-assigned colours
    const pageId = ja.notebook!.pages[0].id;

    const log: { ev: string; data: any }[] = [];
    for (const ev of ['live:start', 'live:points', 'live:end', 'ops']) b.on(ev, (data) => log.push({ ev, data }));
    const committed = once(b, 'ops');
    const acked = once<{ opIds: string[] }>(a, 'ack');

    const style = { pen: 'ballpoint', color: 'ink', size: 3, opacity: 1, stab: 30, sim: false };
    a.emit('live:start', { strokeId: 's1', pageId, style });
    const all: number[] = [];
    for (let i = 0; i < 6; i++) {
      const pts = [i * 10, i, 0.5, i * 10 + 5, i, 0.55];
      all.push(...pts);
      a.emit('live:points', { strokeId: 's1', points: pts });
    }
    a.emit('live:end', { strokeId: 's1' });
    a.emit('ops', { ops: [addOp(pageId, mkStroke('s1', all))] });
    await committed;
    expect((await acked).opIds).toEqual(['op-s1']);

    const names = log.map((l) => l.ev);
    expect(names).toEqual(['live:start', ...Array(6).fill('live:points'), 'live:end', 'ops']);
    const received = log.filter((l) => l.ev === 'live:points').flatMap((l) => l.data.points);
    expect(received).toEqual(all); // same batches, same order
    expect(log[0].data).toMatchObject({ strokeId: 's1', pageId, sid: a.id, style });
    const ops = log[log.length - 1].data;
    expect(ops.from).toBe(a.id);
    expect(ops.seq).toBeGreaterThan(0);
    expect(ops.ops[0].obj.id).toBe('s1'); // commit has the same id as the preview
    a.close(); b.close();
  });

  it('two people drawing at once never block or overwrite each other', async () => {
    const a = await client(app.port), b = await client(app.port);
    const ja = await join(a, 'both', 'A');
    await join(b, 'both', 'B');
    const pageId = ja.notebook!.pages[0].id;
    const aAck = once(a, 'ack'), bAck = once(b, 'ack');
    for (let i = 0; i < 20; i++) {
      a.emit('live:points', { strokeId: 'a1', points: [i, 0, 0.5] });
      b.emit('live:points', { strokeId: 'b1', points: [i, 9, 0.5] });
    }
    a.emit('ops', { ops: [addOp(pageId, mkStroke('a1', [0, 0, 0.5, 19, 0, 0.5]))] });
    b.emit('ops', { ops: [addOp(pageId, mkStroke('b1', [0, 9, 0.5, 19, 9, 0.5]))] });
    await Promise.all([aAck, bAck]);
    const c = await client(app.port);
    const jc = await join(c, 'both', 'C');
    expect(jc.notebook!.pages[0].order.sort()).toEqual(['a1', 'b1']);
    expect(jc.users!.length).toBe(3);
    a.close(); b.close(); c.close();
  });

  it('persists committed ops to disk and serves them after a restart', async () => {
    const dir = tmp();
    let srv = await createApp({ port: 0, dataDir: dir });
    const a = await client(srv.port);
    const ja = await join(a, 'persist', 'A');
    const pageId = ja.notebook!.pages[0].id;
    const saved = once(a, 'saved');
    a.emit('ops', { ops: [addOp(pageId, mkStroke('keep', [1, 2, 0.5, 30, 40, 0.8], { color: '#1971c2', pen: 'fountain' }))] });
    a.emit('pageop', { op: { opId: 'pg1', kind: 'add', page: { id: 'page2', title: 'Question 2', background: 'graph' }, index: 1 } });
    await saved; // debounced atomic save finished
    const onDisk = JSON.parse(readFileSync(path.join(dir, 'persist.json'), 'utf8')) as Notebook;
    expect(onDisk.pages[0].objects.keep).toBeTruthy();
    a.close();
    await srv.close();

    srv = await createApp({ port: 0, dataDir: dir }); // "server restart"
    const fresh = await client(srv.port);
    const snap = await join(fresh, 'persist', 'New');
    expect(snap.notebook!.pages.map((p) => p.title)).toEqual(['Page 1', 'Question 2']);
    expect(snap.notebook!.pages[1].background).toBe('graph');
    expect(snap.notebook!.pages[0].objects.keep).toMatchObject({ color: '#1971c2', pen: 'fountain', points: [1, 2, 0.5, 30, 40, 0.8], bbox: [1, 2, 30, 40] });
    expect(snap.notebook!.updatedAt).toBeGreaterThan(0);
    fresh.close();
    await srv.close();
  });

  it('flushes unsaved work on shutdown', async () => {
    const dir = tmp();
    const srv = await createApp({ port: 0, dataDir: dir });
    const a = await client(srv.port);
    const ja = await join(a, 'flush', 'A');
    const ack = once(a, 'ack');
    a.emit('ops', { ops: [addOp(ja.notebook!.pages[0].id, mkStroke('late', [0, 0, 0.5]))] });
    await ack;
    a.close();
    await srv.close(); // well inside the 1 s debounce window
    const onDisk = JSON.parse(readFileSync(path.join(dir, 'flush.json'), 'utf8')) as Notebook;
    expect(onDisk.pages[0].objects.late).toBeTruthy();
  });

  it('upload endpoint stores and serves images, rejects everything else', async () => {
    const ok = await fetch(`${url}/api/upload/up1`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG });
    expect(ok.status).toBe(200);
    const { url: imgUrl } = (await ok.json()) as { url: string };
    expect(imgUrl).toMatch(/^\/uploads\/up1\/[A-Za-z0-9_-]+\.png$/);
    expect(existsSync(path.join(dataDir, 'uploads', 'up1', path.basename(imgUrl)))).toBe(true);
    const served = await fetch(url + imgUrl);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);

    const post = (id: string, type: string, body: Buffer | string) =>
      fetch(`${url}/api/upload/${id}`, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : new Uint8Array(body) });
    expect((await post('up1', 'text/plain', 'hello')).status).toBe(415); // not an image type
    expect((await post('up1', 'image/png', Buffer.from('<script>alert(1)</script>'))).status).toBe(415); // magic bytes
    expect((await post('up1', 'image/jpeg', PNG)).status).toBe(415); // type / content mismatch
    expect((await post('up1', 'image/png', Buffer.alloc(0))).status).toBe(400);
    expect((await post('bad.id', 'image/png', PNG)).status).toBe(400);
    expect((await post('..%2F..%2Fevil', 'image/png', PNG)).status).toBe(400); // path traversal
    expect((await post('up1', 'image/png', Buffer.concat([PNG, Buffer.alloc(21 * 1024 * 1024)]))).status).toBe(413);
    expect((await fetch(`${url}/uploads/..%2F..%2Fpackage.json`)).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(`${url}/uploads/up1/missing.png`)).status).toBe(404);
  });

  it('enforces the passcode on sockets, join and uploads', async () => {
    const srv = await createApp({ port: 0, dataDir: tmp(), passcode: 'open-sesame' });
    const base = `http://localhost:${srv.port}`;
    expect(await (await fetch(`${base}/api/config`)).json()).toEqual({ passcodeRequired: true });
    await expect(client(srv.port)).rejects.toThrow(/passcode/);
    await expect(client(srv.port, 'wrong')).rejects.toThrow(/passcode/);
    const good = await client(srv.port, 'open-sesame');
    expect((await join(good, 'locked', 'A', { passcode: 'nope' })).error).toBe('passcode');
    expect((await join(good, 'locked', 'A', { passcode: 'open-sesame' })).ok).toBe(true);
    const up = (pass?: string) =>
      fetch(`${base}/api/upload/locked`, { method: 'POST', headers: { 'content-type': 'image/png', ...(pass ? { 'x-passcode': pass } : {}) }, body: PNG });
    expect((await up()).status).toBe(401);
    expect((await up('wrong')).status).toBe(401);
    expect((await up('open-sesame')).status).toBe(200);
    const check = (passcode: string) =>
      fetch(`${base}/api/passcode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode }) }).then((r) => r.json());
    expect(await check('wrong')).toEqual({ ok: false });
    expect(await check('open-sesame')).toEqual({ ok: true });
    good.close();
    await srv.close();
  });

  it('a reconnecting client resyncs and re-sends pending ops without double-applying', async () => {
    const a = await client(app.port), b = await client(app.port);
    const ja = await join(a, 'recon', 'A');
    await join(b, 'recon', 'B');
    const pageId = ja.notebook!.pages[0].id;

    // op1 reaches the server, but A "loses the connection" before seeing the ack
    const op1 = addOp(pageId, mkStroke('r1', [0, 0, 0.5, 10, 0, 0.5]), 'pending-1');
    const move: Op = { opId: 'pending-2', pageId, kind: 'move', ids: ['r1'], dx: 100, dy: 0 };
    const bGot = once(b, 'ops');
    a.emit('ops', { ops: [op1, move] });
    await bGot;
    a.close();
    // while A is away, B keeps working
    const bAck = once(b, 'ack');
    b.emit('ops', { ops: [addOp(pageId, mkStroke('fromB', [5, 5, 0.5]))] });
    await bAck;

    // A reconnects holding three pending ops: two already applied, one that never left
    const op3 = addOp(pageId, mkStroke('r3', [7, 7, 0.5]), 'pending-3');
    const a2 = await client(app.port);
    const re = await join(a2, 'recon', 'A', { pending: ['pending-1', 'pending-2', 'pending-3'] });
    expect(re.seen!.sort()).toEqual(['pending-1', 'pending-2']); // server tells A what it already has
    const page = re.notebook!.pages[0];
    expect(page.order).toEqual(['r1', 'fromB']); // fresh snapshot includes B's work
    expect((page.objects.r1 as Stroke).points).toEqual([100, 0, 0.5, 110, 0, 0.5]);

    // A re-sends everything it was unsure about; applied ops are ignored, the new one lands
    const bGets = once<{ ops: Op[] }>(b, 'ops');
    const ack = once<{ opIds: string[] }>(a2, 'ack');
    a2.emit('ops', { ops: [op1, move, op3] });
    expect((await ack).opIds).toEqual(['pending-1', 'pending-2', 'pending-3']);
    expect((await bGets).ops.map((o) => o.opId)).toEqual(['pending-3']);

    const c = await client(app.port);
    const final = (await join(c, 'recon', 'C')).notebook!.pages[0];
    expect(final.order).toEqual(['r1', 'fromB', 'r3']);
    expect((final.objects.r1 as Stroke).points).toEqual([100, 0, 0.5, 110, 0, 0.5]); // moved exactly once
    a2.close(); b.close(); c.close();
  });

  it('drops malformed and oversized messages without crashing', async () => {
    const a = await client(app.port), b = await client(app.port);
    const ja = await join(a, 'junk', 'A');
    await join(b, 'junk', 'B');
    const pageId = ja.notebook!.pages[0].id;
    let leaked = 0;
    b.onAny((ev) => { if (ev !== 'presence') leaked++; });
    a.emit('ops', { ops: 'nope' });
    a.emit('ops', { ops: [{ opId: 'x', pageId, kind: 'explode' }] });
    a.emit('ops', { ops: [{ opId: 'x', pageId, kind: 'add', obj: { type: 'stroke', id: '../../etc' } }] });
    a.emit('ops', { ops: [{ opId: 'x', pageId, kind: 'update', id: 'a', patch: { __proto__: { admin: true }, evil: 1 } }] });
    a.emit('ops', { ops: [addOp(pageId, { ...mkStroke('nan', [0, 0, 0.5]), size: Number.NaN })] });
    a.emit('ops', { ops: [{ opId: 'img', pageId, kind: 'add', obj: { id: 'i', type: 'image', authorId: 'u', createdAt: 1, src: 'javascript:alert(1)', x: 0, y: 0, w: 1, h: 1, naturalW: 1, naturalH: 1 } }] });
    a.emit('live:points', { strokeId: 's', points: new Array(40000).fill(1) });
    a.emit('live:start', null);
    a.emit('cursor', { pageId, x: 'a', y: {}, tool: 5 });
    a.emit('pageop', { op: { opId: 'p', kind: 'rename', pageId: 'bad id!', title: 'x' } });
    a.emit('restore', { notebook: { id: 'junk', pages: [] } });
    expect((await join(a, 'bad id!', 'A')).ok).toBe(false);
    await wait(150);
    expect(leaked).toBe(0);
    // the server is still healthy and the notebook untouched
    const ack = once(a, 'ack');
    await join(a, 'junk', 'A');
    a.emit('ops', { ops: [addOp(pageId, mkStroke('fine', [0, 0, 0.5]))] });
    await ack;
    const c = await client(app.port);
    expect((await join(c, 'junk', 'C')).notebook!.pages[0].order).toEqual(['fine']);
    a.close(); b.close(); c.close();
  });

  it('restore replaces the notebook for everyone (server-restart safety)', async () => {
    const a = await client(app.port), b = await client(app.port);
    const ja = await join(a, 'restore', 'A');
    await join(b, 'restore', 'B');
    const nb: Notebook = JSON.parse(JSON.stringify(ja.notebook));
    nb.pages[0].objects.old = mkStroke('old', [3, 3, 0.5, 9, 9, 0.5]);
    nb.pages[0].order.push('old');
    nb.pages[0].title = 'Recovered';
    const got = once<{ notebook: Notebook }>(b, 'snapshot');
    const ok = await new Promise<{ ok: boolean }>((res) => a.emit('restore', { notebook: nb }, res));
    expect(ok.ok).toBe(true);
    const snap = await got;
    expect(snap.notebook.pages[0].title).toBe('Recovered');
    expect(snap.notebook.pages[0].objects.old).toBeTruthy();
    expect(snap.notebook.updatedAt).toBeGreaterThan(ja.notebook!.updatedAt);
    a.close(); b.close();
  });

  it('presence follows joins, page changes and disconnects; transient events are relayed', async () => {
    const a = await client(app.port), b = await client(app.port);
    await join(a, 'pres', 'Ann');
    const seesB = new Promise<any[]>((res) => a.on('presence', (u) => { if (u.length === 2) res(u); }));
    await join(b, 'pres', 'Bob');
    expect((await seesB).map((u) => u.name).sort()).toEqual(['Ann', 'Bob']);

    const moved = new Promise<any[]>((res) => a.on('presence', (u) => { if (u.some((x: any) => x.pageId === 'pageX')) res(u); }));
    b.emit('page', { pageId: 'pageX' });
    expect((await moved).find((u) => u.name === 'Bob').pageId).toBe('pageX');

    const ruler = once<any>(a, 'ruler');
    b.emit('ruler', { pageId: 'pageX', visible: true, x: 1, y: 2, angle: 45, kind: 'ruler' });
    expect(await ruler).toMatchObject({ angle: 45, sid: b.id });
    const laser = once<any>(a, 'laser');
    b.emit('laser', { pageId: 'pageX', points: [1, 2, 3, 4] });
    expect((await laser).points).toEqual([1, 2, 3, 4]);
    const cursor = once<any>(a, 'cursor');
    b.emit('cursor', { pageId: 'pageX', x: 5, y: 6, tool: 'pen' });
    expect(await cursor).toMatchObject({ x: 5, y: 6, tool: 'pen', sid: b.id });
    const viewport = once<any>(a, 'viewport');
    b.emit('viewport', { pageId: 'pageX', camera: { x: 0, y: 0, zoom: 2 }, vw: 800, vh: 600 });
    expect((await viewport).camera.zoom).toBe(2);
    const erase = once<any>(a, 'live:erase');
    b.emit('live:erase', { pageId: 'pageX', x: 1, y: 1, r: 10, active: true });
    expect((await erase).r).toBe(10);

    const left = once<any>(a, 'leave');
    const alone = new Promise<any[]>((res) => a.on('presence', (u) => { if (u.length === 1) res(u); }));
    const bid = b.id;
    b.close();
    expect((await left).sid).toBe(bid);
    expect((await alone)[0].name).toBe('Ann');
    a.close();
  });
});

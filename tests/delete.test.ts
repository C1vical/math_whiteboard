import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, type AppOptions } from '../server/app';
import { DELETED_KEEP_MS, readNotebookFromDisk } from '../server/store';
import type { JoinAck, Op, Stroke } from '../shared/types';
import { mkStroke } from './helpers';

// Deleting a board: for everyone, recoverable from deleted/<id>/ for 30 days, never resurrected.

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'mathboard-del-'));
  dirs.push(d);
  return d;
};
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const start = (o: AppOptions = {}) => createApp({ port: 0, dataDir: tmp(), quiet: true, sweepUploads: false, ...o });
const client = (port: number, passcode?: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const s = connect(`http://localhost:${port}`, { transports: ['websocket'], forceNew: true, auth: { passcode }, reconnection: false });
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
const join = (s: Socket, notebookId: string, name: string, extra: Record<string, unknown> = {}): Promise<JoinAck> =>
  new Promise((resolve) => s.emit('join', { notebookId, userId: `u-${name}`, name, ...extra }, resolve));
const once = <T = unknown>(s: Socket, ev: string): Promise<T> => new Promise((resolve) => s.once(ev, resolve));
const call = <T = any>(s: Socket, ev: string, data: unknown = {}): Promise<T> => new Promise((resolve) => s.emit(ev, data, resolve));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const addOp = (pageId: string, obj: Stroke): Op => ({ opId: `op-${obj.id}`, pageId, kind: 'add', obj });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const deleteHttp = (port: number, id: string, opts: { passcode?: string; by?: string } = {}) =>
  fetch(`http://localhost:${port}/api/boards/${id}/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.passcode ? { 'x-passcode': opts.passcode } : {}) },
    body: JSON.stringify({ by: opts.by ?? '' }),
  });

describe('delete board', () => {
  it('from inside the board: everyone else is sent away, files move to deleted/, the id is refused from then on', async () => {
    const app = await start();
    const dir = app.store.dataDir;
    const a = await client(app.port), b = await client(app.port);
    const ja = await join(a, 'del1', 'Ann');
    await join(b, 'del1', 'Bob');
    const pageId = ja.notebook!.pages[0].id;
    const saved = once(a, 'saved');
    a.emit('ops', { ops: [addOp(pageId, mkStroke('s1', [0, 0, 0.5, 10, 10, 0.5]))] });
    a.emit('pageop', { op: { opId: 'nt', kind: 'notebookTitle', title: 'Algebra 2' } });
    await saved;
    const up = await fetch(`http://localhost:${app.port}/api/upload/del1`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG });
    expect(up.status).toBe(200);
    expect((await call(a, 'backup')).ok).toBe(true);

    let annKicked = false;
    a.on('deleted', () => { annKicked = true; });
    const bobKicked = once<{ by: string }>(b, 'deleted');
    expect(await call(a, 'deleteBoard')).toEqual({ ok: true });
    expect((await bobKicked).by).toBe('Ann');
    await wait(50);
    expect(annKicked).toBe(false); // the one who deleted it gets the ack, not the notice

    // everything of del1 moved; nothing is left in the data folder
    expect(readdirSync(dir).filter((n) => n.startsWith('del1.'))).toEqual([]);
    expect(existsSync(path.join(dir, 'uploads', 'del1'))).toBe(false);
    const kept = path.join(dir, 'deleted', 'del1');
    const names = readdirSync(kept);
    expect(names).toEqual(expect.arrayContaining(['deleted.json', 'del1.json', 'del1.pages', 'uploads']));
    expect(names.some((n) => n.startsWith('del1.backup-'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(kept, 'deleted.json'), 'utf8'))).toMatchObject({ id: 'del1', title: 'Algebra 2', by: 'Ann' });
    expect((await readNotebookFromDisk(kept, 'del1')).pages[0].objects.s1).toBeTruthy(); // recoverable as it was

    // a kicked client's late ops change nothing; joining and uploading are refused
    b.emit('ops', { ops: [addOp(pageId, mkStroke('late', [0, 0, 0.5]))] });
    await wait(1300);
    expect(existsSync(path.join(dir, 'del1.json'))).toBe(false);
    expect((await join(b, 'del1', 'Bob')).error).toBe('deleted');
    const up2 = await fetch(`http://localhost:${app.port}/api/upload/del1`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG });
    expect(up2.status).toBe(410);
    a.close(); b.close();
    await app.close();

    // still deleted after a restart (a device with an old copy cannot bring it back)
    const again = await createApp({ port: 0, dataDir: dir, quiet: true, sweepUploads: false });
    const c = await client(again.port);
    expect((await join(c, 'del1', 'Cat')).error).toBe('deleted');
    expect((await join(c, 'other', 'Cat')).ok).toBe(true); // other boards are untouched
    c.close();
    await again.close();
  });

  it('keeps changes that were not saved yet in the deleted copy', async () => {
    const app = await start();
    const a = await client(app.port);
    const ja = await join(a, 'del2', 'Ann');
    const ack = once(a, 'ack');
    a.emit('ops', { ops: [addOp(ja.notebook!.pages[0].id, mkStroke('fresh', [1, 1, 0.5]))] });
    await ack; // applied, but well inside the 1 s save debounce
    expect(await call(a, 'deleteBoard')).toEqual({ ok: true });
    const kept = path.join(app.store.dataDir, 'deleted', 'del2');
    expect((await readNotebookFromDisk(kept, 'del2')).pages[0].objects.fresh).toBeTruthy();
    a.close();
    await app.close();
  });

  it('from the start page (HTTP): checks the passcode, kicks whoever is in it, ignores boards that never existed', async () => {
    const app = await start({ passcode: 'pw' });
    const a = await client(app.port, 'pw');
    const ja = await join(a, 'del3', 'Ann', { passcode: 'pw' });
    const saved = once(a, 'saved');
    a.emit('ops', { ops: [addOp(ja.notebook!.pages[0].id, mkStroke('x', [0, 0, 0.5]))] });
    await saved;

    expect((await deleteHttp(app.port, 'del3')).status).toBe(401);
    expect((await deleteHttp(app.port, 'del3', { passcode: 'wrong' })).status).toBe(401);
    expect((await deleteHttp(app.port, 'bad.id', { passcode: 'pw' })).status).toBe(400);
    const kicked = once<{ by: string }>(a, 'deleted');
    const res = await deleteHttp(app.port, 'del3', { passcode: 'pw', by: 'Bob' });
    expect(res.status).toBe(200);
    expect((await kicked).by).toBe('Bob');
    expect(existsSync(path.join(app.store.dataDir, 'deleted', 'del3', 'del3.json'))).toBe(true);
    expect((await deleteHttp(app.port, 'del3', { passcode: 'pw' })).status).toBe(200); // again: nothing happens

    // a code nobody ever drew on: nothing is written anywhere
    expect((await deleteHttp(app.port, 'neverused', { passcode: 'pw' })).status).toBe(200);
    expect(existsSync(path.join(app.store.dataDir, 'deleted', 'neverused'))).toBe(false);
    expect(app.store.isDeleted('neverused')).toBe(false);
    a.close();
    await app.close();
  });

  it('is rate limited per address', async () => {
    const app = await start({ limits: { deletes: 2 } });
    expect((await deleteHttp(app.port, 'r1')).status).toBe(200);
    expect((await deleteHttp(app.port, 'r2')).status).toBe(200);
    const third = await deleteHttp(app.port, 'r3');
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBeTruthy();
    await app.close();
  });

  it('removes the kept files after 30 days but remembers that the board was deleted', async () => {
    const app = await start();
    const a = await client(app.port);
    const ja = await join(a, 'del4', 'Ann');
    const saved = once(a, 'saved');
    a.emit('ops', { ops: [addOp(ja.notebook!.pages[0].id, mkStroke('x', [0, 0, 0.5]))] });
    await saved;
    await call(a, 'deleteBoard');
    const kept = path.join(app.store.dataDir, 'deleted', 'del4');
    expect(await app.store.purgeDeleted(Date.now() + DELETED_KEEP_MS - 60000)).toEqual([]); // not yet
    expect(readdirSync(kept).length).toBeGreaterThan(1);
    expect(await app.store.purgeDeleted(Date.now() + DELETED_KEEP_MS + 60000)).toEqual(['del4']);
    expect(readdirSync(kept)).toEqual(['deleted.json']);
    expect((await join(a, 'del4', 'Ann')).error).toBe('deleted');
    a.close();
    await app.close();
  });
});

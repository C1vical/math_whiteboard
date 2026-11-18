import { createServer, type Server as HttpServer } from 'node:http';
import { existsSync, promises as fs } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Server, type Socket } from 'socket.io';
import { nanoid } from 'nanoid';
import type { z } from 'zod';
import { applyOp, applyPageOp, findPage, moveStaysInRange } from '../shared/ops';
import { sanitizePage, validUpdate } from '../shared/schema';
import { timerReduce } from '../shared/timer';
import { ID_RE, USER_COLORS, type JoinAck, type Notebook, type Op, type Page, type PageOp, type PresenceUser } from '../shared/types';
import { clientIp, RateLimiter } from './limits';
import * as S from './schema';
import { sanitize, Store, type Room } from './store';

export interface AppLimits {
  /** wrong passcodes allowed per address per window before further attempts are refused */
  passcodeFails?: number;
  passcodeWindowMs?: number;
  /** image uploads allowed per address per minute */
  uploadsPerMinute?: number;
  /** total bytes of uploads a single notebook may hold */
  uploadQuotaBytes?: number;
  /** boards one address may delete per 10 minutes */
  deletes?: number;
}

export interface AppOptions {
  port?: number;
  dataDir?: string;
  passcode?: string;
  clientDir?: string;
  quiet?: boolean;
  limits?: AppLimits;
  /** how long an empty notebook stays in memory after the last person left (default 5 minutes) */
  evictDelayMs?: number;
  /** believe X-Forwarded-For from local proxies / tunnels when rate limiting (default true) */
  trustProxy?: boolean;
  /** sweep orphaned uploads on startup and then daily (default true) */
  sweepUploads?: boolean;
}

export interface RunningApp {
  httpServer: HttpServer;
  io: Server;
  store: Store;
  port: number;
  close(): Promise<void>;
}

const MAX_UPLOAD = 20 * 1024 * 1024;
const MAX_OBJECTS_PER_PAGE = 60000;
const MAX_PAGES = 500;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const DAY = 24 * 60 * 60 * 1000;

/** Identifies an image by its magic bytes. */
export function sniffImage(buf: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}
const EXT_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

const imageSrcs = (pages: Page[]): Set<string> => {
  const out = new Set<string>();
  for (const p of pages) for (const o of Object.values(p.objects)) if (o.type === 'image') out.add(o.src);
  return out;
};

export async function createApp(opts: AppOptions = {}): Promise<RunningApp> {
  const dataDir = path.resolve(opts.dataDir ?? process.env.DATA_DIR ?? './data');
  const passcode = opts.passcode ?? process.env.APP_PASSCODE ?? '';
  const trustProxy = opts.trustProxy ?? !/^(0|false|off|no)$/i.test(process.env.TRUST_PROXY ?? '');
  const quotaMb = Number(process.env.UPLOAD_QUOTA_MB);
  const quota = opts.limits?.uploadQuotaBytes ?? (quotaMb > 0 ? quotaMb : 500) * 1024 * 1024;
  const store = new Store(dataDir, { evictDelayMs: opts.evictDelayMs, quiet: opts.quiet });
  await store.init();

  // wrong passcodes (HTTP check, socket handshake, join and upload share one allowance per address)
  const fails = new RateLimiter(opts.limits?.passcodeFails ?? 10, opts.limits?.passcodeWindowMs ?? 5 * 60 * 1000);
  const uploads = new RateLimiter(opts.limits?.uploadsPerMinute ?? 120, 60 * 1000);
  const deletes = new RateLimiter(opts.limits?.deletes ?? 30, 10 * 60 * 1000);
  const TOO_MANY_DELETES = 'Too many boards were deleted from this network just now. Wait a few minutes and try again.';

  const passOk = (given: unknown): boolean => {
    if (!passcode) return true;
    if (typeof given !== 'string') return false;
    const a = Buffer.from(given), b = Buffer.from(passcode);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const ipOf = (req: Request) => clientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], trustProxy);
  const tooMany = (res: Response, limiter: RateLimiter, ip: string, error: string) => {
    res.setHeader('Retry-After', String(limiter.retryAfter(ip)));
    res.status(429).json({ ok: false, error });
  };
  const TOO_MANY_TRIES = 'Too many wrong passcodes from this network. Wait a few minutes and try again.';
  const quotaMessage = `This board has reached its image storage limit (${Math.round(quota / 1024 / 1024)} MB). Remove images you no longer need (the space is freed a day later) or start a new board.`;

  // ---------- HTTP ----------
  const app = express();
  app.disable('x-powered-by');

  app.get('/api/config', (_req, res) => {
    res.json({ passcodeRequired: !!passcode });
  });

  app.post('/api/passcode', express.json({ limit: '2kb' }), (req, res) => {
    const ip = ipOf(req);
    if (passcode && fails.blocked(ip)) return void tooMany(res, fails, ip, TOO_MANY_TRIES);
    const ok = passOk(req.body?.passcode);
    if (!ok) fails.hit(ip);
    res.json({ ok });
  });

  // everything that can be decided from the headers is decided before the body is read
  const uploadGate = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const nbId = req.params.notebookId;
      if (!ID_RE.test(nbId)) return void res.status(400).json({ error: 'Invalid notebook id' });
      if (store.isDeleted(nbId)) return void res.status(410).json({ error: 'This board was deleted' });
      const ip = ipOf(req);
      if (passcode) {
        if (fails.blocked(ip)) return void tooMany(res, fails, ip, TOO_MANY_TRIES);
        if (!passOk(req.header('x-passcode'))) { fails.hit(ip); return void res.status(401).json({ error: 'Wrong passcode' }); }
      }
      if (!uploads.hit(ip)) return void tooMany(res, uploads, ip, 'Too many images at once. Wait a moment and try again.');
      const mime = (req.header('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!IMAGE_TYPES.has(mime)) return void res.status(415).json({ error: 'Only PNG, JPEG, GIF or WebP images are allowed' });
      const declared = Number(req.header('content-length')) || 0;
      if (declared <= MAX_UPLOAD && (await store.uploadUsage(nbId)) + declared > quota) return void res.status(413).json({ error: quotaMessage });
      next();
    } catch (err) {
      next(err);
    }
  };

  app.post('/api/upload/:notebookId', uploadGate, express.raw({ type: () => true, limit: MAX_UPLOAD }), async (req, res) => {
    try {
      const nbId = req.params.notebookId;
      const mime = (req.header('content-type') || '').split(';')[0].trim().toLowerCase();
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) return void res.status(400).json({ error: 'Empty upload' });
      const ext = sniffImage(body);
      if (!ext || EXT_MIME[ext] !== mime) return void res.status(415).json({ error: 'File content is not a valid image' });
      if ((await store.uploadUsage(nbId)) + body.length > quota) return void res.status(413).json({ error: quotaMessage });
      if (store.isDeleted(nbId)) return void res.status(410).json({ error: 'This board was deleted' });
      // the path is built only from the validated id and a generated name
      const dir = path.join(store.uploadsDir, nbId);
      await fs.mkdir(dir, { recursive: true });
      const name = `${nanoid(21)}.${ext}`;
      await fs.writeFile(path.join(dir, name), body);
      store.addUploadUsage(nbId, body.length);
      res.json({ url: `/uploads/${nbId}/${name}` });
    } catch (err) {
      console.error('[upload]', (err as Error).message);
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  // deleting from the start page (inside a board the socket's `deleteBoard` is used)
  app.post('/api/boards/:id/delete', express.json({ limit: '2kb' }), async (req, res) => {
    try {
      const id = req.params.id;
      if (!ID_RE.test(id)) return void res.status(400).json({ ok: false, error: 'Invalid board code' });
      const ip = ipOf(req);
      if (passcode) {
        if (fails.blocked(ip)) return void tooMany(res, fails, ip, TOO_MANY_TRIES);
        if (!passOk(req.header('x-passcode'))) { fails.hit(ip); return void res.status(401).json({ ok: false, error: 'Wrong passcode' }); }
      }
      if (!deletes.hit(ip)) return void tooMany(res, deletes, ip, TOO_MANY_DELETES);
      const by = typeof req.body?.by === 'string' ? (req.body.by as string).trim().slice(0, 40) : '';
      // a board that was never saved and is not open has nothing to delete (and leaves no trace)
      if (!store.isDeleted(id) && (await store.exists(id))) await deleteBoard(id, by);
      res.json({ ok: true });
    } catch (err) {
      console.error('[delete]', (err as Error).message);
      res.status(500).json({ ok: false, error: 'The board could not be deleted' });
    }
  });

  app.use('/uploads', express.static(store.uploadsDir, {
    dotfiles: 'deny', index: false, fallthrough: false, immutable: true, maxAge: '365d',
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  }));

  const clientDir = opts.clientDir;
  if (clientDir && existsSync(path.join(clientDir, 'index.html'))) {
    app.use(express.static(clientDir, { index: false, maxAge: '1h' }));
    app.get(['/', '/b/:id'], (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(clientDir, 'index.html'));
    });
  }

  app.use((_req, res) => void res.status(404).json({ error: 'Not found' }));
  app.use((err: { status?: number; statusCode?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[http]', err);
    res.status(status).json({ error: err.type === 'entity.too.large' ? 'File is too large (20 MB max)' : status === 404 ? 'Not found' : 'Request failed' });
  });

  // ---------- sockets ----------
  const httpServer = createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 40 * 1024 * 1024, pingInterval: 10000, pingTimeout: 20000 });

  store.onSaved = (id, t) => io.to(id).emit('saved', { t });

  const socketIp = (socket: Socket) => clientIp(socket.handshake.address, socket.handshake.headers['x-forwarded-for'], trustProxy);

  io.use((socket, next) => {
    if (!passcode) return next();
    const ip = socketIp(socket);
    if (fails.blocked(ip)) return next(new Error('rate'));
    if (passOk(socket.handshake.auth?.passcode)) return next();
    fails.hit(ip);
    next(new Error('passcode'));
  });

  interface Ctx { nbId: string | null; room: Room | null; user: PresenceUser | null }

  const presence = (nbId: string): PresenceUser[] => {
    const out: PresenceUser[] = [];
    for (const s of io.sockets.sockets.values()) {
      const c = s.data.ctx as Ctx | undefined;
      if (c?.nbId === nbId && c.user) out.push(c.user);
    }
    return out;
  };

  const pickColor = (nbId: string, wanted?: string): string => {
    const used = new Set(presence(nbId).map((u) => u.color));
    if (wanted && USER_COLORS.includes(wanted) && !used.has(wanted)) return wanted;
    return USER_COLORS.find((c) => !used.has(c)) ?? `hsl(${Math.floor(Math.random() * 360)} 70% 45%)`;
  };

  const leave = (socket: Socket) => {
    const ctx = socket.data.ctx as Ctx;
    if (!ctx.nbId) return;
    const nbId = ctx.nbId;
    socket.leave(nbId);
    ctx.nbId = null; ctx.room = null; ctx.user = null;
    socket.to(nbId).emit('leave', { sid: socket.id });
    io.to(nbId).emit('presence', presence(nbId));
    store.release(nbId); // the room is dropped from memory once nobody is left and it is saved
  };

  /** Deletes a board and sends everyone in it (except `fromSid`, who asked) back to the start page. */
  async function deleteBoard(nbId: string, by: string, fromSid?: string) {
    const done = store.deleteNotebook(nbId, by); // refuses the id from here on
    for (const s of io.sockets.sockets.values()) {
      if ((s.data.ctx as Ctx | undefined)?.nbId !== nbId) continue;
      if (s.id !== fromSid) s.emit('deleted', { by });
      leave(s);
    }
    await done;
  }

  io.on('connection', (socket) => {
    const ctx: Ctx = { nbId: null, room: null, user: null };
    socket.data.ctx = ctx;

    /** Registers a validated handler; malformed payloads are dropped, errors never crash. */
    const on = <T extends z.ZodTypeAny>(event: string, schema: T, handler: (data: z.infer<T>, ack?: (r: unknown) => void) => void | Promise<void>) => {
      socket.on(event, async (raw: unknown, ack?: unknown) => {
        const reply = typeof ack === 'function' ? (ack as (r: unknown) => void) : undefined;
        try {
          const parsed = schema.safeParse(raw);
          if (!parsed.success) { reply?.({ ok: false, error: 'invalid' }); return; }
          await handler(parsed.data, reply);
        } catch (err) {
          console.error(`[socket] ${event}:`, (err as Error).message);
          reply?.({ ok: false, error: 'server' });
        }
      });
    };

    /** Relays a transient event to everyone else in the notebook. */
    const relay = <T extends z.ZodTypeAny>(event: string, schema: T, volatile = false) => {
      on(event, schema, (data) => {
        if (!ctx.nbId) return;
        const target = volatile ? socket.to(ctx.nbId).volatile : socket.to(ctx.nbId);
        target.emit(event, { ...(data as object), sid: socket.id });
      });
    };

    on('join', S.joinMsg, async (data, ack) => {
      if (!passOk(data.passcode)) {
        fails.hit(socketIp(socket));
        ack?.({ ok: false, error: 'passcode' } satisfies JoinAck);
        return;
      }
      if (ctx.nbId) leave(socket);
      if (store.isDeleted(data.notebookId)) { ack?.({ ok: false, error: 'deleted' } satisfies JoinAck); return; }
      const room = await store.acquire(data.notebookId);
      if (!socket.connected) { store.release(data.notebookId); return; }
      if (store.isDeleted(data.notebookId)) { // deleted while it was loading
        store.release(data.notebookId);
        ack?.({ ok: false, error: 'deleted' } satisfies JoinAck);
        return;
      }
      if (ctx.nbId) leave(socket); // a second join overtook this one
      const color = pickColor(data.notebookId, data.color);
      ctx.nbId = data.notebookId;
      ctx.room = room;
      ctx.user = { sid: socket.id, userId: data.userId, name: data.name, color, pageId: room.nb.pages[0]?.id ?? null };
      socket.join(data.notebookId);
      const users = presence(data.notebookId);
      ack?.({
        ok: true, notebook: room.nb, seq: room.seq, color, sid: socket.id,
        seen: (data.pending ?? []).filter((p) => room.seen.has(p)), users,
        timer: room.countdown, now: Date.now(),
      } satisfies JoinAck);
      io.to(data.notebookId).emit('presence', users);
    });

    on('ops', S.opsMsg, (data) => {
      const room = ctx.room;
      if (!room || !ctx.nbId || !ctx.user) return;
      const applied: Op[] = [];
      const pages = new Set<string>();
      const unreferenced: string[] = [];
      for (const op of data.ops as Op[]) {
        if (room.seen.has(op.opId)) continue;
        store.remember(room, op.opId);
        const page = findPage(room.nb, op.pageId);
        if (!page) continue;
        // An op that would leave something invalid is not applied (and not relayed), but it is
        // still acknowledged below so the sender's queue drains.
        if (op.kind === 'add') {
          const old = page.objects[op.obj.id];
          if (!old && page.order.length >= MAX_OBJECTS_PER_PAGE) continue;
          if (old?.type === 'image' && (op.obj.type !== 'image' || op.obj.src !== old.src)) unreferenced.push(old.src);
        } else if (op.kind === 'update') {
          const cur = page.objects[op.id];
          if (!cur || !validUpdate(cur, op.patch)) continue;
        } else if (op.kind === 'move') {
          if (op.ids.some((oid) => { const o = page.objects[oid]; return !!o && !moveStaysInRange(o, op.dx, op.dy); })) continue;
        } else if (op.kind === 'delete') {
          const cur = page.objects[op.id];
          if (cur?.type === 'image') unreferenced.push(cur.src);
        }
        if (!applyOp(room.nb, op)) continue;
        applied.push(op);
        pages.add(op.pageId);
      }
      const t = Date.now();
      if (applied.length) {
        room.seq++;
        room.nb.updatedAt = t;
        socket.to(ctx.nbId).emit('ops', { seq: room.seq, ops: applied, from: socket.id, t });
        store.markDirty(room, pages);
        if (unreferenced.length) store.touchUploads(unreferenced);
      }
      socket.emit('ack', { seq: room.seq, opIds: data.ops.map((o) => o.opId), t: room.nb.updatedAt });
    });

    on('pageop', S.pageOpMsg, (data) => {
      const room = ctx.room;
      if (!room || !ctx.nbId) return;
      const op = data.op as PageOp;
      const fresh = !room.seen.has(op.opId);
      if (fresh) {
        store.remember(room, op.opId);
        let allowed = true;
        if ((op.kind === 'add' || op.kind === 'duplicate' || op.kind === 'restorePage') && room.nb.pages.length >= MAX_PAGES) allowed = false;
        if (op.kind === 'restorePage') {
          sanitizePage(op.page);
          if (op.page.order.length > MAX_OBJECTS_PER_PAGE) allowed = false;
        }
        const gone = op.kind === 'delete' ? findPage(room.nb, op.pageId) : undefined;
        if (allowed && applyPageOp(room.nb, op)) {
          room.seq++;
          room.nb.updatedAt = Date.now();
          socket.to(ctx.nbId).emit('pageop', { seq: room.seq, op, from: socket.id, t: room.nb.updatedAt });
          // only pages whose content changed are rewritten; titles and order live in the manifest
          const changed = op.kind === 'add' || op.kind === 'restorePage' ? [op.page.id] : op.kind === 'duplicate' ? [op.newId] : [];
          if (gone) {
            room.removedPages.add(gone.id);
            store.touchUploads(imageSrcs([gone]));
          }
          store.markDirty(room, changed);
        }
      }
      socket.emit('ack', { seq: room.seq, opIds: [op.opId], t: room.nb.updatedAt });
    });

    on('page', S.pageMsg, (data) => {
      if (!ctx.nbId || !ctx.user) return;
      ctx.user.pageId = data.pageId;
      io.to(ctx.nbId).emit('presence', presence(ctx.nbId));
    });

    on('rename', S.renameMsg, (data) => {
      if (!ctx.nbId || !ctx.user) return;
      const name = data.name.trim();
      if (!name || name === ctx.user.name) return;
      ctx.user.name = name;
      io.to(ctx.nbId).emit('presence', presence(ctx.nbId));
    });

    on('backup', S.backupMsg, async (_data, ack) => {
      const room = ctx.room;
      if (!room) { ack?.({ ok: false, error: 'not joined' }); return; }
      try {
        const file = await store.backup(room);
        ack?.({ ok: true, file });
      } catch (err) {
        console.error('[backup]', (err as Error).message);
        ack?.({ ok: false, error: 'backup' });
      }
    });

    on('restore', S.restoreMsg, async (data, ack) => {
      const room = ctx.room;
      const nbId = ctx.nbId;
      if (!room || !nbId) return;
      // what is about to be replaced is kept first; without that copy nothing is replaced
      try {
        await store.backup(room);
      } catch (err) {
        console.error('[restore] backup failed:', (err as Error).message);
        ack?.({ ok: false, error: 'backup' });
        return;
      }
      if (ctx.room !== room) { ack?.({ ok: false, error: 'left' }); return; }
      const nb = sanitize(data.notebook as Notebook);
      nb.id = nbId;
      nb.updatedAt = Date.now();
      const kept = imageSrcs(nb.pages);
      store.touchUploads([...imageSrcs(room.nb.pages)].filter((src) => !kept.has(src)));
      store.replaceNotebook(room, nb);
      room.seq++;
      io.to(nbId).emit('snapshot', { notebook: nb, seq: room.seq, t: nb.updatedAt, by: ctx.user?.name ?? '' });
      ack?.({ ok: true });
    });

    on('deleteBoard', S.deleteBoardMsg, async (_data, ack) => {
      if (!ctx.nbId || !ctx.user) { ack?.({ ok: false, error: 'not joined' }); return; }
      if (!deletes.hit(socketIp(socket))) { ack?.({ ok: false, error: TOO_MANY_DELETES }); return; }
      await deleteBoard(ctx.nbId, ctx.user.name, socket.id);
      ack?.({ ok: true });
    });

    on('timer', S.timerMsg, (data) => {
      const room = ctx.room;
      if (!room || !ctx.nbId) return;
      const now = Date.now();
      const next = timerReduce(room.countdown, data, now);
      if (next === undefined) return;
      room.countdown = next;
      io.to(ctx.nbId).emit('timer', { timer: next, now, by: socket.id });
    });

    relay('live:start', S.liveStart);
    relay('live:points', S.livePoints);
    relay('live:end', S.liveEnd);
    relay('live:erase', S.liveErase);
    relay('laser', S.laserMsg);
    relay('ruler', S.rulerMsg);
    relay('summon', S.summonMsg);
    relay('cursor', S.cursorMsg, true);
    relay('viewport', S.viewportMsg, true);

    socket.on('disconnect', () => leave(socket));
  });

  // ---------- housekeeping ----------
  let sweepTimer: NodeJS.Timeout | null = null;
  if (opts.sweepUploads !== false) {
    const sweep = () => {
      fails.prune(); uploads.prune();
      void store.sweepUploads()
        .then((gone) => { if (gone.length && !opts.quiet) console.log(`[uploads] removed ${gone.length} unused image file(s)`); })
        .catch((err) => console.error('[uploads] sweep failed:', (err as Error).message));
      void store.purgeDeleted()
        .then((gone) => { if (gone.length && !opts.quiet) console.log(`[deleted] removed the files of ${gone.length} board(s) deleted more than 30 days ago`); })
        .catch((err) => console.error('[deleted] purge failed:', (err as Error).message));
    };
    sweep();
    sweepTimer = setInterval(sweep, DAY);
    sweepTimer.unref?.();
  }

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port ?? Number(process.env.PORT ?? 3000), () => {
      const addr = httpServer.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  return {
    httpServer, io, store, port,
    async close() {
      if (sweepTimer) clearInterval(sweepTimer);
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await store.flushAll();
    },
  };
}

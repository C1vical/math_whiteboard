import { createServer, type Server as HttpServer } from 'node:http';
import { existsSync, promises as fs } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Server, type Socket } from 'socket.io';
import { nanoid } from 'nanoid';
import type { z } from 'zod';
import { applyOp, applyPageOp, findPage } from '../shared/ops';
import { ID_RE, USER_COLORS, type JoinAck, type Notebook, type Op, type PageOp, type PresenceUser } from '../shared/types';
import * as S from './schema';
import { sanitize, Store, type Room } from './store';

export interface AppOptions {
  port?: number;
  dataDir?: string;
  passcode?: string;
  clientDir?: string;
  quiet?: boolean;
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

export async function createApp(opts: AppOptions = {}): Promise<RunningApp> {
  const dataDir = path.resolve(opts.dataDir ?? process.env.DATA_DIR ?? './data');
  const passcode = opts.passcode ?? process.env.APP_PASSCODE ?? '';
  const store = new Store(dataDir);
  await store.init();

  const passOk = (given: unknown): boolean => {
    if (!passcode) return true;
    if (typeof given !== 'string') return false;
    const a = Buffer.from(given), b = Buffer.from(passcode);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  // ---------- HTTP ----------
  const app = express();
  app.disable('x-powered-by');

  app.get('/api/config', (_req, res) => {
    res.json({ passcodeRequired: !!passcode });
  });

  app.post('/api/passcode', express.json({ limit: '2kb' }), (req, res) => {
    res.json({ ok: passOk(req.body?.passcode) });
  });

  app.post('/api/upload/:notebookId', express.raw({ type: () => true, limit: MAX_UPLOAD }), async (req, res) => {
    try {
      const nbId = req.params.notebookId;
      if (!ID_RE.test(nbId)) return void res.status(400).json({ error: 'Invalid notebook id' });
      if (!passOk(req.header('x-passcode'))) return void res.status(401).json({ error: 'Wrong passcode' });
      const mime = (req.header('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!IMAGE_TYPES.has(mime)) return void res.status(415).json({ error: 'Only PNG, JPEG, GIF or WebP images are allowed' });
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) return void res.status(400).json({ error: 'Empty upload' });
      const ext = sniffImage(body);
      if (!ext || EXT_MIME[ext] !== mime) return void res.status(415).json({ error: 'File content is not a valid image' });
      // the path is built only from the validated id and a generated name
      const dir = path.join(store.uploadsDir, nbId);
      await fs.mkdir(dir, { recursive: true });
      const name = `${nanoid(21)}.${ext}`;
      await fs.writeFile(path.join(dir, name), body);
      res.json({ url: `/uploads/${nbId}/${name}` });
    } catch (err) {
      console.error('[upload]', (err as Error).message);
      res.status(500).json({ error: 'Upload failed' });
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

  io.use((socket, next) => {
    if (passOk(socket.handshake.auth?.passcode)) next();
    else next(new Error('passcode'));
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
  };

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
      if (!passOk(data.passcode)) { ack?.({ ok: false, error: 'passcode' } satisfies JoinAck); return; }
      if (ctx.nbId) leave(socket);
      const room = await store.get(data.notebookId);
      if (!socket.connected) return;
      const color = pickColor(data.notebookId, data.color);
      ctx.nbId = data.notebookId;
      ctx.room = room;
      ctx.user = { sid: socket.id, userId: data.userId, name: data.name, color, pageId: room.nb.pages[0]?.id ?? null };
      socket.join(data.notebookId);
      const users = presence(data.notebookId);
      ack?.({
        ok: true, notebook: room.nb, seq: room.seq, color, sid: socket.id,
        seen: (data.pending ?? []).filter((p) => room.seen.has(p)), users,
      } satisfies JoinAck);
      io.to(data.notebookId).emit('presence', users);
    });

    on('ops', S.opsMsg, (data) => {
      const room = ctx.room;
      if (!room || !ctx.nbId || !ctx.user) return;
      const applied: Op[] = [];
      for (const op of data.ops as Op[]) {
        if (room.seen.has(op.opId)) continue;
        store.remember(room, op.opId);
        if (op.kind === 'add') {
          const page = findPage(room.nb, op.pageId);
          if (page && page.order.length >= MAX_OBJECTS_PER_PAGE && !page.objects[op.obj.id]) continue;
        }
        applyOp(room.nb, op);
        applied.push(op);
      }
      const t = Date.now();
      if (applied.length) {
        room.seq++;
        room.nb.updatedAt = t;
        socket.to(ctx.nbId).emit('ops', { seq: room.seq, ops: applied, from: socket.id, t });
        store.markDirty(room);
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
        const tooMany = (op.kind === 'add' || op.kind === 'duplicate') && room.nb.pages.length >= MAX_PAGES;
        if (!tooMany && applyPageOp(room.nb, op)) {
          room.seq++;
          room.nb.updatedAt = Date.now();
          socket.to(ctx.nbId).emit('pageop', { seq: room.seq, op, from: socket.id, t: room.nb.updatedAt });
          store.markDirty(room);
        }
      }
      socket.emit('ack', { seq: room.seq, opIds: [op.opId], t: room.nb.updatedAt });
    });

    on('page', S.pageMsg, (data) => {
      if (!ctx.nbId || !ctx.user) return;
      ctx.user.pageId = data.pageId;
      io.to(ctx.nbId).emit('presence', presence(ctx.nbId));
    });

    on('restore', S.restoreMsg, (data, ack) => {
      const room = ctx.room;
      if (!room || !ctx.nbId) return;
      const nb = sanitize(data.notebook as Notebook);
      nb.id = ctx.nbId;
      nb.updatedAt = Date.now();
      room.nb = nb;
      room.seq++;
      io.to(ctx.nbId).emit('snapshot', { notebook: nb, seq: room.seq, t: nb.updatedAt, by: ctx.user?.name ?? '' });
      store.markDirty(room);
      ack?.({ ok: true });
    });

    relay('live:start', S.liveStart);
    relay('live:points', S.livePoints);
    relay('live:end', S.liveEnd);
    relay('live:erase', S.liveErase);
    relay('laser', S.laserMsg);
    relay('ruler', S.rulerMsg);
    relay('cursor', S.cursorMsg, true);
    relay('viewport', S.viewportMsg, true);

    socket.on('disconnect', () => leave(socket));
  });

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
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await store.flushAll();
    },
  };
}

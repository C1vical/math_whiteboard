import { io, type Socket } from 'socket.io-client';
import type { JoinAck, Notebook, Op, PageOp, PresenceUser, TimerState } from '../../../shared/types';

export type PendingItem = { type: 'ops'; ops: Op[] } | { type: 'page'; op: PageOp };

export interface SyncHandlers {
  /** A full snapshot arrived (first join, reconnect or restore). Pending items must be re-applied on top. */
  onSnapshot(nb: Notebook, info: { first: boolean; pending: PendingItem[]; restoredBy?: string }): void;
  onRemoteOps(ops: Op[]): void;
  onRemotePageOp(op: PageOp): void;
  onPresence(users: PresenceUser[]): void;
  onJoined(me: { sid: string; color: string }): void;
  /** the shared countdown changed (or was received on join) */
  onTimer(timer: TimerState | null): void;
  onStatus(): void;
  onFatal(reason: string): void;
  /** the board was deleted: by someone while I had it open (`by`, '' if unknown), or before I joined (null) */
  onDeleted(by: string | null): void;
  onLive(event: string, data: any): void;
}

export interface SyncOptions { notebookId: string; userId: string; name: string; color?: string; passcode: string }

const LIVE_EVENTS = ['live:start', 'live:points', 'live:end', 'live:erase', 'cursor', 'laser', 'ruler', 'viewport', 'summon', 'leave'];
const MAX_OPS_PER_MSG = 600;
const MAX_NUMBERS_PER_MSG = 150000;

/** Socket connection, pending-op queue and reconnect logic. */
export class Sync {
  socket: Socket;
  pending: PendingItem[] = [];
  conn: 'connected' | 'reconnecting' | 'offline' = 'reconnecting';
  joined = false;
  /** newest server timestamp we know of, and the newest one the server confirmed on disk */
  latestT = 0;
  savedT = 0;
  /** server clock minus this device's clock, so countdowns agree on every screen */
  clockOffset = 0;
  private clockAt = 0;
  private first = true;
  private offlineTimer = 0;
  private closed = false;

  constructor(private h: SyncHandlers, private opts: SyncOptions) {
    this.socket = io({ auth: { passcode: opts.passcode }, transports: ['websocket', 'polling'], reconnectionDelay: 400, reconnectionDelayMax: 3000 });
    const s = this.socket;
    s.on('connect', () => this.join());
    s.on('disconnect', () => {
      this.joined = false;
      this.setConn(navigator.onLine === false ? 'offline' : 'reconnecting');
      window.clearTimeout(this.offlineTimer);
      this.offlineTimer = window.setTimeout(() => { if (!this.socket.connected) this.setConn('offline'); }, 8000);
    });
    s.on('connect_error', (err: Error) => {
      if (err.message === 'passcode' || err.message === 'rate') { this.h.onFatal(err.message); return; }
      if (this.conn === 'connected') this.setConn('reconnecting');
      window.clearTimeout(this.offlineTimer);
      this.offlineTimer = window.setTimeout(() => { if (!this.socket.connected) this.setConn('offline'); }, 8000);
    });
    s.on('ops', (m: { ops: Op[]; t: number }) => { this.seen(m.t); this.h.onRemoteOps(m.ops); });
    s.on('pageop', (m: { op: PageOp; t: number }) => { this.seen(m.t); this.h.onRemotePageOp(m.op); });
    s.on('ack', (m: { opIds: string[]; t: number }) => this.ack(m.opIds, m.t));
    s.on('saved', (m: { t: number }) => { this.savedT = Math.max(this.savedT, m.t); this.h.onStatus(); });
    s.on('presence', (users: PresenceUser[]) => this.h.onPresence(users));
    s.on('snapshot', (m: { notebook: Notebook; t: number; by: string }) => {
      this.seen(m.t);
      this.h.onSnapshot(m.notebook, { first: false, pending: this.pending, restoredBy: m.by });
    });
    s.on('timer', (m: { timer: TimerState | null; now: number }) => { this.clock(m.now); this.h.onTimer(m.timer); });
    s.on('deleted', (m: { by?: unknown }) => { if (!this.closed) this.h.onDeleted(typeof m?.by === 'string' ? m.by : ''); });
    for (const ev of LIVE_EVENTS) s.on(ev, (data: unknown) => this.h.onLive(ev, data));
    window.addEventListener('offline', this.onOffline);
    window.addEventListener('online', this.onOnline);
  }

  private onOffline = () => this.setConn('offline');
  private onOnline = () => { if (!this.socket.connected) { this.setConn('reconnecting'); this.socket.connect(); } };

  private setConn(c: Sync['conn']) {
    if (this.conn === c) return;
    this.conn = c;
    this.h.onStatus();
  }

  private clock(serverNow: number | undefined) {
    if (typeof serverNow !== 'number') return;
    const now = Date.now(), sample = serverNow - now;
    // a message that was held up (the network, a busy tab) gives too small a sample; the largest
    // recent one is the closest, and after a minute any new sample replaces it (clock changes)
    if (!this.clockAt || sample > this.clockOffset || now - this.clockAt > 60000) { this.clockOffset = sample; this.clockAt = now; }
  }

  /** the server's clock, as well as this device can tell */
  serverNow(): number { return Date.now() + this.clockOffset; }

  private seen(t: number) {
    if (t > this.latestT) this.latestT = t;
    this.h.onStatus();
  }

  /** true while something is not yet safely on the server's disk */
  get saving(): boolean { return this.pending.length > 0 || this.latestT > this.savedT; }

  private pendingIds(): string[] {
    const out: string[] = [];
    for (const it of this.pending) {
      if (it.type === 'ops') for (const o of it.ops) out.push(o.opId); else out.push(it.op.opId);
    }
    return out;
  }

  private join() {
    const { notebookId, userId, name, color, passcode } = this.opts;
    this.socket.emit('join', { notebookId, userId, name, color, passcode: passcode || undefined, pending: this.pendingIds().slice(0, 20000) }, (ack: JoinAck) => {
      if (this.closed) return;
      if (ack?.error === 'deleted') { this.h.onDeleted(null); return; }
      if (!ack?.ok || !ack.notebook) {
        this.h.onFatal(ack?.error === 'passcode' ? 'passcode' : 'join');
        return;
      }
      // drop what the server already applied before we lost the connection
      if (ack.seen?.length) this.removeAcked(new Set(ack.seen));
      this.opts.color = ack.color;
      this.h.onJoined({ sid: ack.sid!, color: ack.color! });
      this.clock(ack.now);
      this.h.onTimer(ack.timer ?? null);
      if (ack.users) this.h.onPresence(ack.users);
      const t = ack.notebook.updatedAt;
      if (this.first) { this.latestT = this.savedT = t; } else if (t > this.latestT) this.latestT = t;
      this.h.onSnapshot(ack.notebook, { first: this.first, pending: this.pending });
      this.first = false;
      this.joined = true;
      window.clearTimeout(this.offlineTimer);
      this.setConn('connected');
      // re-send everything still unacknowledged, in order
      for (const it of this.pending) this.transmit(it);
      this.h.onStatus();
    });
  }

  private transmit(it: PendingItem) {
    if (it.type === 'ops') this.socket.emit('ops', { ops: it.ops });
    else this.socket.emit('pageop', { op: it.op });
  }

  private removeAcked(ids: Set<string>) {
    const next: PendingItem[] = [];
    for (const it of this.pending) {
      if (it.type === 'page') { if (!ids.has(it.op.opId)) next.push(it); continue; }
      const left = it.ops.filter((o) => !ids.has(o.opId));
      if (left.length === it.ops.length) next.push(it);
      else if (left.length) next.push({ type: 'ops', ops: left });
    }
    this.pending = next;
  }

  private ack(opIds: string[], t: number) {
    this.removeAcked(new Set(opIds));
    this.seen(t);
  }

  /** Queues ops (optimistically applied by the caller) and sends them when connected. */
  sendOps(ops: Op[]) {
    let chunk: Op[] = [];
    let weight = 0;
    const flush = () => {
      if (!chunk.length) return;
      const item: PendingItem = { type: 'ops', ops: chunk };
      this.pending.push(item);
      if (this.joined) this.transmit(item);
      chunk = []; weight = 0;
    };
    for (const op of ops) {
      let w = 20;
      if (op.kind === 'add' && 'points' in op.obj) w += op.obj.points.length;
      else if (op.kind === 'update' && Array.isArray(op.patch.points)) w += (op.patch.points as number[]).length;
      else if (op.kind === 'move') w += op.ids.length * 4;
      if (chunk.length >= MAX_OPS_PER_MSG || (chunk.length && weight + w > MAX_NUMBERS_PER_MSG)) flush();
      chunk.push(op);
      weight += w;
    }
    flush();
    this.h.onStatus();
  }

  sendPageOp(op: PageOp) {
    const item: PendingItem = { type: 'page', op };
    this.pending.push(item);
    if (this.joined) this.transmit(item);
    this.h.onStatus();
  }

  /** Transient events (live ink, cursors…): dropped when offline. */
  emit(event: string, data: unknown, volatile = false) {
    if (!this.joined) return;
    if (volatile) this.socket.volatile.emit(event, data); else this.socket.emit(event, data);
  }

  /** My display name changed: tell everyone now, and use it for future re-joins. */
  setName(name: string) {
    this.opts.name = name;
    this.emit('rename', { name });
  }

  /** Asks the server to keep a backup copy of the notebook as it is now. Resolves false if it could not. */
  backup(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.joined) { resolve(false); return; }
      this.socket.timeout(30000).emit('backup', {}, (err: unknown, res?: { ok: boolean }) => resolve(!err && !!res?.ok));
    });
  }

  restore(nb: Notebook): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.joined) { resolve(false); return; }
      this.pending = [];
      this.socket.timeout(30000).emit('restore', { notebook: nb }, (err: unknown, res?: { ok: boolean }) => resolve(!err && !!res?.ok));
    });
  }

  /** Deletes the board for everyone. Resolves with the server's answer. */
  deleteBoard(): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      if (!this.joined) { resolve({ ok: false, error: 'Not connected to the server. Wait until it says Connected and try again.' }); return; }
      this.socket.timeout(30000).emit('deleteBoard', {}, (err: unknown, res?: { ok: boolean; error?: string }) =>
        resolve(err ? { ok: false, error: 'The server did not answer. Try again.' } : res ?? { ok: false }));
    });
  }

  close() {
    this.closed = true;
    window.clearTimeout(this.offlineTimer);
    window.removeEventListener('offline', this.onOffline);
    window.removeEventListener('online', this.onOnline);
    this.socket.close();
  }
}

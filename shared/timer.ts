import { MAX_TIMER_MS, type TimerAction, type TimerState } from './types';

/** Milliseconds left on the countdown at `now` (server clock). Never negative. */
export function timerRemaining(t: TimerState, now: number): number {
  return t.endsAt !== null ? Math.max(0, t.endsAt - now) : Math.max(0, t.remainingMs);
}

export const timerRunning = (t: TimerState, now: number) => t.endsAt !== null && t.endsAt > now;
/** started and run down to zero */
export const timerFinished = (t: TimerState, now: number) => t.endsAt !== null && t.endsAt <= now;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * The shared countdown's state machine. Returns the new state (null = no timer shown), or
 * `undefined` when the action does not apply and nothing changes.
 */
export function timerReduce(t: TimerState | null, a: TimerAction, now: number): TimerState | null | undefined {
  switch (a.action) {
    case 'show': {
      const d = Math.max(1000, Math.min(MAX_TIMER_MS, Math.round(a.durationMs)));
      return { durationMs: d, remainingMs: d, endsAt: null, x: t?.x ?? 0, y: t?.y ?? 0 }; // top left of the board (no panels there) until someone moves it
    }
    case 'start': {
      if (!t || timerRunning(t, now)) return undefined;
      const left = timerRemaining(t, now) || t.durationMs; // starting a finished timer runs it again
      return { ...t, remainingMs: left, endsAt: now + left };
    }
    case 'pause':
      if (!t || t.endsAt === null) return undefined;
      return { ...t, remainingMs: timerRemaining(t, now), endsAt: null };
    case 'reset':
      if (!t) return undefined;
      return { ...t, remainingMs: t.durationMs, endsAt: null };
    case 'dismiss':
      return t ? null : undefined;
    case 'move':
      if (!t) return undefined;
      return { ...t, x: clamp01(a.x), y: clamp01(a.y) };
  }
}

/** m:ss (or h:mm:ss) for a countdown; rounds up so "0:01" shows until the very end. */
export function formatTimer(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/**
 * A custom countdown typed by a teacher: "5" (minutes), "2:30" (m:ss), "1:05:00" (h:mm:ss),
 * "90s" or "1.5" (minutes). Returns milliseconds, or null when it is not a usable time.
 */
export function parseTimerInput(text: string): number | null {
  const s = text.trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  let ms: number;
  const unit = /^(\d+(?:\.\d+)?)(s|sec|m|min|h|hr)$/.exec(s);
  if (unit) {
    const v = Number(unit[1]);
    ms = v * (unit[2].startsWith('s') ? 1000 : unit[2].startsWith('m') ? 60000 : 3600000);
  } else if (/^\d+(?:\.\d+)?$/.test(s)) {
    ms = Number(s) * 60000;
  } else if (/^\d+(?::\d{1,2}){1,2}$/.test(s)) {
    const parts = s.split(':').map(Number);
    if (parts.slice(1).some((p) => p >= 60)) return null;
    ms = parts.reduce((acc, p) => acc * 60 + p, 0) * 1000;
  } else return null;
  ms = Math.round(ms);
  return ms >= 1000 && ms <= MAX_TIMER_MS ? ms : null;
}

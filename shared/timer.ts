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
      return { durationMs: d, remainingMs: d, endsAt: null, x: t?.x ?? 0.5, y: t?.y ?? 0.1 };
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

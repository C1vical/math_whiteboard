import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Pause, Play, RotateCcw, X } from 'lucide-react';
import { formatTimer, parseTimerInput, timerFinished, timerRemaining, timerRunning } from '../../../shared/timer';
import { useEngine, useUI } from './common';

export const TIMER_PRESETS = [1, 2, 5, 10];
/** distance kept from the edges of the board */
const MARGIN = 12;

/** The shared countdown, drawn over the board for both teachers and the Zoom audience. */
export function TimerWidget() {
  const engine = useEngine();
  const t = useUI((s) => s.timer);
  const ref = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => engine.sync.serverNow());
  /** where the widget is while I drag it (fractions), before the server confirms */
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0, W: 0, H: 0 });

  const running = !!t && timerRunning(t, now);
  useEffect(() => {
    setNow(engine.sync.serverNow());
    if (!t || t.endsAt === null) return;
    const endsAt = t.endsAt;
    const id = window.setInterval(() => {
      const n = engine.sync.serverNow();
      setNow(n);
      if (n >= endsAt) window.clearInterval(id); // finished: nothing moves any more
    }, 200);
    return () => window.clearInterval(id);
  }, [engine, t]);

  // the widget's size and the board's, so the position fractions always keep it fully inside
  useLayoutEffect(() => {
    const el = ref.current, parent = el?.parentElement;
    if (!el || !parent) return;
    const measure = () => setBox({ w: el.offsetWidth, h: el.offsetHeight, W: parent.clientWidth, H: parent.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el); ro.observe(parent);
    return () => ro.disconnect();
  }, [t !== null]);

  if (!t) return null;
  const left = timerRemaining(t, now);
  const done = timerFinished(t, now);
  const pos = drag ?? { x: t.x, y: t.y };
  const style = { left: MARGIN + Math.max(0, box.W - box.w - 2 * MARGIN) * pos.x, top: MARGIN + Math.max(0, box.H - box.h - 2 * MARGIN) * pos.y };

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    if ((e.target as HTMLElement).closest('button')) return;
    const el = ref.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const start = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y };
    const spanX = Math.max(1, box.W - box.w - 2 * MARGIN), spanY = Math.max(1, box.H - box.h - 2 * MARGIN);
    let last = 0;
    let cur = { x: pos.x, y: pos.y };
    const move = (ev: PointerEvent) => {
      cur = {
        x: Math.max(0, Math.min(1, start.x + (ev.clientX - start.px) / spanX)),
        y: Math.max(0, Math.min(1, start.y + (ev.clientY - start.py) / spanY)),
      };
      setDrag(cur);
      // the other screens follow along, a few times a second
      if (ev.timeStamp - last > 90) { last = ev.timeStamp; engine.timer({ action: 'move', ...cur }); }
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      engine.timer({ action: 'move', ...cur });
      setDrag(null);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  return (
    <div
      ref={ref} className={`timer-widget ${running ? 'running' : ''} ${done ? 'done' : ''}`} style={style}
      role="timer" aria-label={done ? 'Time is up' : `Countdown: ${formatTimer(left)} left`}
      onPointerDown={onPointerDown}
    >
      <div className="timer-face">
        <span className="timer-time">{done ? '0:00' : formatTimer(left)}</span>
        {done && <span className="timer-done">Time’s up!</span>}
      </div>
      <div className="timer-bar"><i style={{ width: done ? 0 : `${(left / t.durationMs) * 100}%` }} /></div>
      <div className="timer-btns">
        {running
          ? <button type="button" className="ibtn small" data-tip="Pause" aria-label="Pause" onClick={() => engine.timer({ action: 'pause' })}><Pause size={16} /></button>
          : <button type="button" className="ibtn small" data-tip={done ? 'Run again' : 'Start'} aria-label={done ? 'Run again' : 'Start'} onClick={() => engine.timer({ action: 'start' })}><Play size={16} /></button>}
        <button type="button" className="ibtn small" data-tip="Reset" aria-label="Reset" onClick={() => engine.timer({ action: 'reset' })}><RotateCcw size={15} /></button>
        <button type="button" className="ibtn small" data-tip="Close the timer" aria-label="Close the timer" onClick={() => engine.timer({ action: 'dismiss' })}><X size={16} /></button>
      </div>
    </div>
  );
}

/** Presets and a custom time, for the Insert flyout. Picking one shows the timer and starts it. */
export function TimerPresets({ onDone }: { onDone: () => void }) {
  const engine = useEngine();
  const [custom, setCustom] = useState('');
  const [bad, setBad] = useState(false);
  const go = (ms: number) => { engine.timer({ action: 'show', durationMs: ms }, { action: 'start' }); onDone(); };
  const submit = () => {
    const ms = parseTimerInput(custom);
    if (ms === null) { setBad(true); return; }
    go(ms);
  };
  return (
    <div className="timer-presets">
      <div className="timer-row">
        {TIMER_PRESETS.map((m) => (
          <button key={m} type="button" className="btn small" onClick={() => go(m * 60000)}>{m} min</button>
        ))}
      </div>
      <form className="timer-row" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <input
          className={`field small ${bad ? 'invalid' : ''}`} value={custom} placeholder="Custom, e.g. 3 or 2:30" aria-label="Custom time"
          onChange={(e) => { setCustom(e.target.value); setBad(false); }}
        />
        <button type="submit" className="btn small primary" disabled={!custom.trim()}>Start</button>
      </form>
    </div>
  );
}

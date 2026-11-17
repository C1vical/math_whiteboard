import { lazy, Suspense, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { Axes } from '../../../shared/types';
import { IconBtn, NumField, Section, Segmented, Toggle, useEngine, useUI } from './common';
import { clamp } from './util';

const GraphPanel = lazy(() => import('./GraphPanel'));

const LIMIT = 1e9;
const num = (v: number) => clamp(v, -LIMIT, LIMIT);

/** Side panel for the selected graph or axes object. */
export function Inspector() {
  const engine = useEngine();
  const single = useUI((s) => s.sel?.single ?? null);
  if (!single || (single.type !== 'graph' && single.type !== 'axes')) return null;
  return (
    <div className="inspector" onPointerDown={(e) => e.stopPropagation()}>
      <div className="inspector-head">
        <span className="grow">{single.type === 'graph' ? 'Graph' : single.mode === 'numberLine' ? 'Number line' : 'Axes'}</span>
        <IconBtn tip="Close" className="small" onClick={() => engine.setSelection([])}><X size={17} /></IconBtn>
      </div>
      {single.type === 'graph'
        ? <Suspense fallback={<div className="row"><div className="spinner" /> Loading the graph tools…</div>}><GraphPanel key={single.id} g={single} /></Suspense>
        : <AxesPanel key={single.id} a={single} />}
    </div>
  );
}

/** A short text field that commits on Enter or when it loses focus. */
function LabelField({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => { const t = text.trim().slice(0, 24); if (t !== value) onCommit(t); };
  return (
    <label className="numfield">
      <span>{label}</span>
      <input
        type="text" value={text} maxLength={24} style={{ width: 70 }} aria-label={`${label} label`}
        onChange={(e) => setText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
    </label>
  );
}

function AxesPanel({ a }: { a: Axes }) {
  const engine = useEngine();
  const locked = !!a.locked;
  const update = (patch: Partial<Axes>) => engine.commit([{ kind: 'update', id: a.id, patch: patch as Record<string, unknown> }]);
  const setRange = (patch: Partial<Pick<Axes, 'xMin' | 'xMax' | 'yMin' | 'yMax'>>) => {
    const r = { xMin: a.xMin, xMax: a.xMax, yMin: a.yMin, yMax: a.yMax, ...patch };
    if (!(r.xMax > r.xMin) || !(r.yMax > r.yMin)) return; // half-typed value: the field snaps back on blur
    const out: Record<string, number> = {};
    for (const k of Object.keys(patch) as (keyof typeof patch)[]) out[k] = num(r[k]);
    update(out);
  };
  const setStep = (key: 'xStep' | 'yStep', v: number) => {
    if (v > 0) update({ [key]: num(v) });
  };
  /**
   * Four quadrants / first quadrant only. The origin stays where it is on the board and one unit
   * stays the same size, so ticks keep landing on the page's grid lines.
   */
  const preset = (kind: 'four' | 'first') => {
    const ux = a.w / (a.xMax - a.xMin), uy = a.h / (a.yMax - a.yMin);
    const ox = a.x + (0 - a.xMin) * ux, oy = a.y + a.h - (0 - a.yMin) * uy;
    const rx = Math.max(Math.abs(a.xMin), Math.abs(a.xMax)) || 5, ry = Math.max(Math.abs(a.yMin), Math.abs(a.yMax)) || 5;
    const r1 = (v: number) => Math.round(v * 10) / 10;
    if (kind === 'four') update({ xMin: -rx, xMax: rx, yMin: -ry, yMax: ry, x: r1(ox - rx * ux), y: r1(oy - ry * uy), w: r1(2 * rx * ux), h: r1(2 * ry * uy) });
    else update({ xMin: 0, xMax: rx, yMin: 0, yMax: ry, x: r1(ox), y: r1(oy - ry * uy), w: r1(rx * ux), h: r1(ry * uy) });
  };
  const quadrant = a.xMin >= 0 && a.yMin >= 0 ? 'first' : a.xMin < 0 && a.xMax > 0 && a.yMin < 0 && a.yMax > 0 ? 'four' : null;
  return (
    <fieldset disabled={locked} style={{ border: 'none', margin: 0, padding: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {locked && <p className="hint">These axes are locked. Unlock them from the selection bar to edit.</p>}
      <Section title="Type">
        <Segmented
          value={a.mode} options={[{ value: 'xy', label: 'x–y axes' }, { value: 'numberLine', label: 'Number line' }]}
          onChange={(mode) => {
            if (mode === a.mode) return;
            if (mode === 'numberLine') update({ mode, h: Math.min(a.h, 70) });
            else update({ mode, h: Math.max(a.h, Math.min(a.w, 400)), yMin: a.xMin, yMax: a.xMax, yStep: a.xStep });
          }}
        />
      </Section>
      <Section title={a.mode === 'xy' ? 'x axis' : 'Range'}>
        <div className="grid3">
          <NumField label="min" value={a.xMin} onCommit={(v) => setRange({ xMin: v })} width={54} />
          <NumField label="max" value={a.xMax} onCommit={(v) => setRange({ xMax: v })} width={54} />
          <NumField label="step" value={a.xStep} onCommit={(v) => setStep('xStep', v)} width={48} />
        </div>
      </Section>
      {a.mode === 'xy' && (
        <Section title="Layout">
          <div className="row">
            <button type="button" className={`chip ${quadrant === 'four' ? 'on' : ''}`} onClick={() => preset('four')}>Four quadrants</button>
            <button type="button" className={`chip ${quadrant === 'first' ? 'on' : ''}`} onClick={() => preset('first')}>First quadrant</button>
          </div>
        </Section>
      )}
      {a.mode === 'xy' && (
        <Section title="y axis">
          <div className="grid3">
            <NumField label="min" value={a.yMin} onCommit={(v) => setRange({ yMin: v })} width={54} />
            <NumField label="max" value={a.yMax} onCommit={(v) => setRange({ yMax: v })} width={54} />
            <NumField label="step" value={a.yStep} onCommit={(v) => setStep('yStep', v)} width={48} />
          </div>
        </Section>
      )}
      <Section title="Axis labels">
        <div className="grid2">
          <LabelField label="x axis" value={a.xLabel ?? (a.mode === 'xy' ? 'x' : '')} onCommit={(xLabel) => update({ xLabel })} />
          {a.mode === 'xy' && <LabelField label="y axis" value={a.yLabel ?? 'y'} onCommit={(yLabel) => update({ yLabel })} />}
        </div>
      </Section>
      <Toggle label="Show numbers" checked={a.showNumbers} onChange={(showNumbers) => update({ showNumbers })} />
      {a.mode === 'xy' && <Toggle label="Grid lines" hint="Light lines inside the axes, one per tick" checked={!!a.grid} onChange={(on) => update({ grid: on ? true : null })} />}
      <Toggle
        label="Label x in multiples of π" hint="π/2, π, 3π/2 … for trig"
        checked={!!a.piTicks}
        onChange={(on) => update(on ? { piTicks: true, xStep: Math.PI / 2, xMin: Math.min(a.xMin, -2 * Math.PI), xMax: Math.max(a.xMax, 2 * Math.PI) } : { piTicks: null, xStep: 1 })}
      />
      <p className="hint">Ink goes on top of the axes. With a grid background and “Snap to grid” on, the ticks land on grid lines.</p>
    </fieldset>
  );
}

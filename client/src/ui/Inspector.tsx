import { lazy, Suspense } from 'react';
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
        <Section title="y axis">
          <div className="grid3">
            <NumField label="min" value={a.yMin} onCommit={(v) => setRange({ yMin: v })} width={54} />
            <NumField label="max" value={a.yMax} onCommit={(v) => setRange({ yMax: v })} width={54} />
            <NumField label="step" value={a.yStep} onCommit={(v) => setStep('yStep', v)} width={48} />
          </div>
        </Section>
      )}
      <Toggle label="Show numbers" checked={a.showNumbers} onChange={(showNumbers) => update({ showNumbers })} />
      <p className="hint">Ink goes on top of the axes. With a grid background and “Snap to grid” on, the ticks land on grid lines.</p>
    </fieldset>
  );
}

import { useEffect, useMemo } from 'react';
import { Eye, EyeOff, Plus, X } from 'lucide-react';
import { nanoid } from 'nanoid';
import { compileGraph, DEFAULT_SLIDER, fitYRange } from '../../../shared/graph';
import type { Axes, Graph, GraphExpr, GraphSlider } from '../../../shared/types';
import { sliderValues } from '../engine/graphRender';
import { nextGraphColor } from '../engine/tools';
import { IconBtn, NumField, Section, Segmented, Toggle, useEngine, useUI } from './common';
import { clamp, UndoGroup } from './util';

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
      {single.type === 'graph' ? <GraphPanel key={single.id} g={single} /> : <AxesPanel key={single.id} a={single} />}
    </div>
  );
}

function GraphPanel({ g }: { g: Graph }) {
  const engine = useEngine();
  const interact = useUI((s) => s.graphInteract);
  const locked = !!g.locked;
  // typing an expression or dragging a slider is one undo step, not one per keystroke
  const group = useMemo(() => new UndoGroup(engine), [engine]);
  useEffect(() => () => group.end(), [group]);
  const compiled = useMemo(() => compileGraph(g.expressions, sliderValues(g)), [g]);
  const sliders = g.sliders ?? [];

  const update = (patch: Partial<Graph>, grouped = false) => {
    const ops = [{ kind: 'update' as const, id: g.id, patch: patch as Record<string, unknown> }];
    if (grouped) group.apply(ops);
    else { group.end(); engine.commit(ops); }
  };

  /** Any single-letter unknown gets a slider; sliders nobody uses any more are dropped. */
  const withSliders = (expressions: GraphExpr[]): GraphSlider[] => {
    const c = compileGraph(expressions, sliderValues(g));
    const next = c.params.map((name) => sliders.find((s) => s.name === name) ?? { name, ...DEFAULT_SLIDER });
    // while something is half-typed (an error), keep the sliders it may still need
    if (c.items.some((i) => i.kind === 'error')) for (const s of sliders) if (!next.some((n) => n.name === s.name)) next.push(s);
    return next.slice(0, 26);
  };
  const setExpressions = (expressions: GraphExpr[], grouped = false) => update({ expressions, sliders: withSliders(expressions) }, grouped);
  const setExpr = (id: string, patch: Partial<GraphExpr>, grouped = false) =>
    setExpressions(g.expressions.map((e) => (e.id === id ? { ...e, ...patch } : e)), grouped);
  const addExpr = () => {
    if (g.expressions.length >= 40) return;
    setExpressions([...g.expressions, { id: nanoid(6), text: '', color: nextGraphColor(g.expressions.length), visible: true }]);
  };
  const setSlider = (name: string, patch: Partial<GraphSlider>, grouped = false) => {
    update({
      sliders: sliders.map((s) => {
        if (s.name !== name) return s;
        const n = { ...s, ...patch };
        if (!(n.step > 0)) n.step = s.step > 0 ? s.step : 0.1;
        if (!(n.max > n.min)) { if (patch.min !== undefined) n.max = n.min + 1; else n.min = n.max - 1; }
        n.value = clamp(n.value, n.min, n.max);
        return n;
      }),
    }, grouped);
  };
  const setWindow = (patch: Partial<Pick<Graph, 'xMin' | 'xMax' | 'yMin' | 'yMax'>>) => {
    const w = { xMin: g.xMin, xMax: g.xMax, yMin: g.yMin, yMax: g.yMax, ...patch };
    if (!(w.xMax > w.xMin) || !(w.yMax > w.yMin)) return; // half-typed value: the field snaps back on blur
    update({ xMin: num(w.xMin), xMax: num(w.xMax), yMin: num(w.yMin), yMax: num(w.yMax) });
  };
  const zoomToFit = () => {
    const fit = fitYRange(compiled, new Set(g.expressions.filter((e) => e.visible).map((e) => e.id)), g.xMin, g.xMax);
    if (!fit) { engine.toast('Nothing to fit yet — add an expression first'); return; }
    setWindow({ yMin: Number(fit[0].toPrecision(4)), yMax: Number(fit[1].toPrecision(4)) });
  };

  return (
    <fieldset disabled={locked} style={{ border: 'none', margin: 0, padding: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {locked && <p className="hint">This graph is locked. Unlock it from the selection bar to edit.</p>}
      <Section title="Expressions">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {g.expressions.map((ex, i) => {
            const item = compiled.items.find((it) => it.id === ex.id);
            const bad = item?.kind === 'error';
            return (
              <div className="expr" key={ex.id}>
                <div className={`expr-row ${bad ? 'bad' : ''}`}>
                  <input type="color" className="expr-color" value={/^#[0-9a-f]{6}$/i.test(ex.color) ? ex.color : '#1971c2'} aria-label="Curve colour" onChange={(e) => setExpr(ex.id, { color: e.target.value }, true)} onBlur={() => group.end()} />
                  <input
                    type="text" value={ex.text} maxLength={300} spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off"
                    placeholder={i === 0 ? 'y = 2x^2 - 3x + 1' : 'y = …, x = 3, (2, 3), f(x) = …'} aria-label={`Expression ${i + 1}`}
                    onChange={(e) => setExpr(ex.id, { text: e.target.value }, true)}
                    onBlur={() => group.end()}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (i === g.expressions.length - 1) addExpr(); else e.currentTarget.blur(); } }}
                  />
                  <IconBtn tip={ex.visible ? 'Hide' : 'Show'} className="small" onClick={() => setExpr(ex.id, { visible: !ex.visible })}>
                    {ex.visible ? <Eye size={16} /> : <EyeOff size={16} />}
                  </IconBtn>
                  <IconBtn tip="Remove" className="small" disabled={g.expressions.length <= 1 && !ex.text} onClick={() => {
                    const rest = g.expressions.filter((e) => e.id !== ex.id);
                    setExpressions(rest.length ? rest : [{ id: nanoid(6), text: '', color: nextGraphColor(0), visible: true }]);
                  }}>
                    <X size={16} />
                  </IconBtn>
                </div>
                {bad && <div className="expr-error" role="alert">{item?.error}</div>}
              </div>
            );
          })}
          <button type="button" className="btn small" onClick={addExpr} disabled={g.expressions.length >= 40}><Plus size={15} /> Add expression</button>
        </div>
      </Section>

      {sliders.length > 0 && (
        <Section title="Sliders">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {sliders.map((s) => (
              <div className="slider-card" key={s.name}>
                <div className="top">
                  <span>{s.name} =</span>
                  <NumField value={s.value} onCommit={(v) => setSlider(s.name, { value: num(v) })} width={74} />
                </div>
                <input
                  type="range" min={s.min} max={s.max} step={s.step} value={s.value} aria-label={`Slider ${s.name}`}
                  onChange={(e) => setSlider(s.name, { value: Number(e.target.value) }, true)}
                  onPointerUp={() => group.end()} onKeyUp={() => group.end()} onBlur={() => group.end()}
                />
                <div className="lims">
                  <NumField label="min" value={s.min} onCommit={(v) => setSlider(s.name, { min: num(v) })} width={52} />
                  <NumField label="max" value={s.max} onCommit={(v) => setSlider(s.name, { max: num(v) })} width={52} />
                  <NumField label="step" value={s.step} onCommit={(v) => setSlider(s.name, { step: Math.abs(num(v)) })} width={48} />
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="Window">
        <div className="grid2">
          <NumField label="x min" value={g.xMin} onCommit={(v) => setWindow({ xMin: v })} width={76} />
          <NumField label="x max" value={g.xMax} onCommit={(v) => setWindow({ xMax: v })} width={76} />
          <NumField label="y min" value={g.yMin} onCommit={(v) => setWindow({ yMin: v })} width={76} />
          <NumField label="y max" value={g.yMax} onCommit={(v) => setWindow({ yMax: v })} width={76} />
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button type="button" className="btn small" onClick={() => setWindow({ xMin: -10, xMax: 10, yMin: -10, yMax: 10 })}>Standard (−10..10)</button>
          <button type="button" className="btn small" onClick={zoomToFit}>Zoom to fit</button>
        </div>
      </Section>
      <Toggle label="Grid" checked={g.showGrid} onChange={(showGrid) => update({ showGrid })} />
      <Toggle label="Axis numbers" checked={g.showNumbers} onChange={(showNumbers) => update({ showNumbers })} />
      <Toggle label="Interact" hint="Drag to pan and scroll to zoom inside the graph" checked={interact} onChange={(v) => engine.ui.set({ graphInteract: v })} />
      <p className="hint">Try <code>y = a x^2 + b</code> for sliders, <code>y &gt; 2x + 1</code> for shading, or <code>f(x) = sin(x)</code> then <code>y = f(x-1) + 2</code>.</p>
    </fieldset>
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

import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, Pause, Play, Plus, X } from 'lucide-react';
import { nanoid } from 'nanoid';
import { compileGraph, DEFAULT_SLIDER, fitYRange, sliderDirAt, sliderValueAt } from '../../../shared/graph';
import type { Graph, GraphExpr, GraphSlider } from '../../../shared/types';
import { graphNow, sliderValues } from '../engine/graphRender';
import { nextGraphColor } from '../engine/tools';
import { IconBtn, NumField, Section, Segmented, Toggle, useEngine, useUI } from './common';
import { clamp, UndoGroup } from './util';

const LIMIT = 1e9;
const num = (v: number) => clamp(v, -LIMIT, LIMIT);

/** Keys that are awkward to type on an iPad keyboard. `caret` is where the cursor goes, from the end. */
const MATH_KEYS: { label: string; text: string; caret?: number; tip: string }[] = [
  { label: '^', text: '^', tip: 'Power' },
  { label: '√', text: '√()', caret: 1, tip: 'Square root' },
  { label: 'π', text: 'π', tip: 'Pi' },
  { label: '≤', text: '≤', tip: 'Less than or equal' },
  { label: '≥', text: '≥', tip: 'Greater than or equal' },
  { label: '|x|', text: '||', caret: 1, tip: 'Absolute value' },
  { label: '(', text: '(', tip: 'Open bracket' },
  { label: ')', text: ')', tip: 'Close bracket' },
];

/** Re-renders while any slider is playing, so the numbers in the panel move with the curve. */
function useTicking(on: boolean) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = window.setInterval(() => tick((n) => n + 1), 100);
    return () => window.clearInterval(t);
  }, [on]);
}

const round = (v: number, step: number) => {
  const d = Math.max(0, Math.min(8, -Math.floor(Math.log10(step > 0 ? step : 0.1) + 1e-9)));
  return Number(v.toFixed(d));
};

/** Graph side panel (loaded with the graph code, the first time a graph is selected). */
export default function GraphPanel({ g }: { g: Graph }) {
  const engine = useEngine();
  const interact = useUI((s) => s.graphInteract);
  const locked = !!g.locked;
  // typing an expression or dragging a slider is one undo step, not one per keystroke
  const group = useMemo(() => new UndoGroup(engine), [engine]);
  useEffect(() => () => group.end(), [group]);
  const compiled = useMemo(() => compileGraph(g.expressions, sliderValues(g), { angle: g.angle }), [g]);
  const sliders = g.sliders ?? [];
  const playing = sliders.some((s) => s.play);
  useTicking(playing);
  // the expression field that last had focus: where the math keys type
  const lastInput = useRef<HTMLInputElement | null>(null);
  const [focusedExpr, setFocusedExpr] = useState<string | null>(null);

  const update = (patch: Partial<Graph>, grouped = false) => {
    const ops = [{ kind: 'update' as const, id: g.id, patch: patch as Record<string, unknown> }];
    if (grouped) group.apply(ops);
    else { group.end(); engine.commit(ops); }
  };

  /** Any single-letter unknown gets a slider; sliders nobody uses any more are dropped. */
  const withSliders = (expressions: GraphExpr[]): GraphSlider[] => {
    const c = compileGraph(expressions, sliderValues(g), { angle: g.angle });
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
        const n: GraphSlider = { ...s, ...patch };
        if (!(n.step > 0)) n.step = s.step > 0 ? s.step : 0.1;
        if (!(n.max > n.min)) { if (patch.min !== undefined) n.max = n.min + 1; else n.min = n.max - 1; }
        n.value = clamp(n.value, n.min, n.max);
        // touching a playing slider stops it where it is (unless the change is the play itself)
        if (s.play && patch.play === undefined) {
          if (patch.value === undefined) n.value = clamp(round(sliderValueAt(s, graphNow()), n.step), n.min, n.max);
          delete n.play;
        }
        if (n.play === null) delete n.play;
        return n;
      }),
    }, grouped);
  };
  /** Play: the value bounces between min and max on the shared clock, the same on every screen. */
  const togglePlay = (s: GraphSlider) => {
    const now = graphNow();
    if (s.play) setSlider(s.name, { play: null, value: clamp(round(sliderValueAt(s, now), s.step), s.min, s.max) });
    else setSlider(s.name, { play: { t0: Math.round(now), v0: s.value, dir: s.value >= s.max ? -1 : sliderDirAt(s, now) } });
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
  /** Types a math key into the expression being edited (keeping the focus there). */
  const typeKey = (k: (typeof MATH_KEYS)[number]) => {
    const el = lastInput.current;
    const id = focusedExpr ?? g.expressions[g.expressions.length - 1]?.id;
    const ex = g.expressions.find((e) => e.id === id);
    if (!ex) return;
    const start = el && el.dataset.expr === id ? el.selectionStart ?? ex.text.length : ex.text.length;
    const end = el && el.dataset.expr === id ? el.selectionEnd ?? start : start;
    const text = (ex.text.slice(0, start) + k.text + ex.text.slice(end)).slice(0, 300);
    setExpr(ex.id, { text }, true);
    const caret = start + k.text.length - (k.caret ?? 0);
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>(`.inspector input[data-expr="${ex.id}"]`);
      if (input) { input.focus(); input.setSelectionRange(caret, caret); }
    });
  };
  const radians = (g.angle ?? 'rad') === 'rad';

  return (
    <fieldset disabled={locked} style={{ border: 'none', margin: 0, padding: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {locked && <p className="hint">This graph is locked. Unlock it from the selection bar to edit.</p>}
      <Section title="Expressions">
        <div className="math-keys" role="toolbar" aria-label="Math keys">
          {MATH_KEYS.map((k) => (
            <button
              key={k.label} type="button" title={k.tip} aria-label={k.tip}
              // keep the focus (and the caret) in the expression field
              onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()}
              onClick={() => typeKey(k)}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {g.expressions.map((ex, i) => {
            const item = compiled.items.find((it) => it.id === ex.id);
            const bad = item?.kind === 'error';
            return (
              <div className="expr" key={ex.id}>
                <div className={`expr-row ${bad ? 'bad' : ''}`}>
                  <input type="color" className="expr-color" value={/^#[0-9a-f]{6}$/i.test(ex.color) ? ex.color : '#1971c2'} aria-label="Curve colour" onChange={(e) => setExpr(ex.id, { color: e.target.value }, true)} onBlur={() => group.end()} />
                  <input
                    type="text" value={ex.text} maxLength={300} spellCheck={false} autoCapitalize="off" autoCorrect="off" autoComplete="off" data-expr={ex.id}
                    placeholder={i === 0 ? 'y = 2x^2 - 3x + 1' : 'y = …, x^2 + y^2 = 25, (2, 3), y = x {x > 0}'} aria-label={`Expression ${i + 1}`}
                    onFocus={(e) => { lastInput.current = e.currentTarget; setFocusedExpr(ex.id); }}
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
            {sliders.map((s) => {
              const value = s.play ? round(sliderValueAt(s, graphNow()), s.step) : s.value;
              return (
                <div className={`slider-card ${s.play ? 'playing' : ''}`} key={s.name}>
                  <div className="top">
                    <IconBtn tip={s.play ? `Pause ${s.name}` : `Play ${s.name} (moves back and forth, for everyone)`} className="small play" active={!!s.play} onClick={() => togglePlay(s)}>
                      {s.play ? <Pause size={15} /> : <Play size={15} />}
                    </IconBtn>
                    <span>{s.name} =</span>
                    <NumField value={value} onCommit={(v) => setSlider(s.name, { value: num(v) })} width={74} />
                  </div>
                  <input
                    type="range" min={s.min} max={s.max} step={s.step} value={value} aria-label={`Slider ${s.name}`}
                    onChange={(e) => setSlider(s.name, { value: Number(e.target.value) }, true)}
                    onPointerUp={() => group.end()} onKeyUp={() => group.end()} onBlur={() => group.end()}
                  />
                  <div className="lims">
                    <NumField label="min" value={s.min} onCommit={(v) => setSlider(s.name, { min: num(v) })} width={52} />
                    <NumField label="max" value={s.max} onCommit={(v) => setSlider(s.name, { max: num(v) })} width={52} />
                    <NumField label="step" value={s.step} onCommit={(v) => setSlider(s.name, { step: Math.abs(num(v)) })} width={48} />
                  </div>
                </div>
              );
            })}
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
          <button
            type="button" className="btn small" title="x from −2π to 2π, labelled in multiples of π"
            onClick={() => { const yr = Math.max(1.5, Math.round(((2 * Math.PI * g.h) / g.w) * 2) / 2); update({ xMin: -2 * Math.PI, xMax: 2 * Math.PI, yMin: -yr, yMax: yr, piTicks: true }); }}
          >
            Trig (−2π..2π)
          </button>
        </div>
      </Section>
      <Section title="Angles">
        <Segmented
          value={radians ? 'rad' : 'deg'} onChange={(angle) => update({ angle: angle === 'rad' ? null : 'deg' })}
          options={[{ value: 'rad', label: 'Radians', tip: 'sin, cos, tan use radians' }, { value: 'deg', label: 'Degrees', tip: 'sin, cos, tan use degrees; asin etc. answer in degrees' }]}
        />
      </Section>
      <Toggle label="Label x in multiples of π" hint="π/2, π, 3π/2 … for trig graphs" checked={!!g.piTicks} onChange={(on) => update({ piTicks: on ? true : null })} />
      <Toggle label="Grid" checked={g.showGrid} onChange={(showGrid) => update({ showGrid })} />
      <Toggle label="Axis numbers" checked={g.showNumbers} onChange={(showNumbers) => update({ showNumbers })} />
      <Toggle label="Interact" hint="Drag to pan and scroll to zoom inside the graph" checked={interact} onChange={(v) => engine.ui.set({ graphInteract: v })} />
      <p className="hint">
        Tap a curve to read its coordinates; intercepts, turning points and intersections are marked while the graph is selected.
        Try <code>y = a x^2 + b</code> for sliders, <code>y &gt; 2x + 1</code> for shading, <code>x^2 + y^2 = 25</code>, or <code>y = x^2 {'{x > 0}'}</code> to restrict the domain.
      </p>
    </fieldset>
  );
}

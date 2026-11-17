import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft, ArrowRight, ChartSpline, Circle, DraftingCompass, Eraser, Highlighter, ImagePlus, Lasso, Minimize2, Minus, MoveHorizontal,
  MoveRight, Move3d, Plus, Redo2, Ruler, Shapes, Slash, Sparkles, Square, SquareDashed, StickyNote, Trash2, Triangle, TriangleRight,
  Type, Undo2, UnfoldVertical, UnfoldHorizontal, Zap,
} from 'lucide-react';
import { nanoid } from 'nanoid';
import type { PenType } from '../../../shared/types';
import { drawLiveStroke } from '../engine/render';
import { ERASER_SIZES, HL_COLORS, PEN_COLORS, SIZE_PRESETS, TAPE_COLORS, type PenFav, type ShapeTool, type ToolId } from '../engine/store';
import { cssColor, IconBtn, MOD, Popover, Section, Segmented, Slider, Swatches, Toggle, useEngine, useUI } from './common';

/** Pen glyph drawn in the pen's own colour, with a different silhouette per pen type. */
export function PenIcon({ pen, color, dark }: { pen: PenType; color: string; dark: boolean }) {
  const c = cssColor(color, dark);
  const outline = dark ? '#c9ced6' : '#3b414b';
  const body = dark ? '#3a3f48' : '#f1f3f5';
  if (pen === 'highlighter') {
    return (
      <svg width="26" height="30" viewBox="0 0 26 30" aria-hidden>
        <rect x="7" y="2" width="12" height="15" rx="2.5" fill={body} stroke={outline} strokeWidth="1.3" />
        <rect x="7" y="6" width="12" height="4" fill={c} opacity="0.9" />
        <path d="M8.5 17h9l-1.2 5h-6.6z" fill={body} stroke={outline} strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M10 22h6v5l-6 1.5z" fill={c} stroke={outline} strokeWidth="1" strokeLinejoin="round" />
      </svg>
    );
  }
  if (pen === 'marker') {
    return (
      <svg width="26" height="30" viewBox="0 0 26 30" aria-hidden>
        <rect x="8" y="2" width="10" height="15" rx="2.5" fill={c} stroke={outline} strokeWidth="1.3" />
        <path d="M9 17h8l-1 5h-6z" fill={body} stroke={outline} strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M10.5 22h5l-0.6 5.5h-3.8z" fill={c} stroke={outline} strokeWidth="1" strokeLinejoin="round" />
      </svg>
    );
  }
  if (pen === 'pencil') {
    return (
      <svg width="26" height="30" viewBox="0 0 26 30" aria-hidden>
        <rect x="9" y="2" width="8" height="4" rx="1.5" fill="#f4a3b4" stroke={outline} strokeWidth="1.2" />
        <rect x="9" y="6" width="8" height="12" fill={c} stroke={outline} strokeWidth="1.3" />
        <path d="M9 18h8l-4 9.5z" fill="#f0d6a8" stroke={outline} strokeWidth="1.2" strokeLinejoin="round" />
        <path d="M11.6 24.2h2.8L13 27.6z" fill={c} />
      </svg>
    );
  }
  if (pen === 'fountain') {
    return (
      <svg width="26" height="30" viewBox="0 0 26 30" aria-hidden>
        <rect x="9" y="2" width="8" height="13" rx="2" fill={c} stroke={outline} strokeWidth="1.3" />
        <path d="M9 15h8l1.2 4.5L13 28l-5.2-8.5z" fill={body} stroke={outline} strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M13 19.5V27" stroke={outline} strokeWidth="1.1" />
        <circle cx="13" cy="19.5" r="1.1" fill={outline} />
      </svg>
    );
  }
  return (
    <svg width="26" height="30" viewBox="0 0 26 30" aria-hidden>
      <rect x="9.5" y="2" width="7" height="16" rx="2.5" fill={c} stroke={outline} strokeWidth="1.3" />
      <path d="M9.5 18h7L13 26.5z" fill={body} stroke={outline} strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="13" cy="26.2" r="1.6" fill={c} />
    </svg>
  );
}

const PEN_NAMES: Record<PenType, string> = { ballpoint: 'Ballpoint', fountain: 'Fountain', pencil: 'Pencil', marker: 'Marker', highlighter: 'Highlighter' };

/** Live preview squiggle rendered with exactly the engine's ink code. */
function Squiggle({ pen, color, size, stab, dark }: { pen: PenType; color: string; size: number; stab: number; dark: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = 228, H = 58;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const pts: number[] = [];
    for (let i = 0; i <= 60; i++) {
      const t = i / 60;
      pts.push(16 + t * (W - 32), H / 2 + Math.sin(t * Math.PI * 2.4) * 14, 0.25 + 0.6 * Math.sin(t * Math.PI));
    }
    const k = Math.min(1, 26 / size); // keep very thick pens inside the preview
    ctx.save();
    if (k < 1) { ctx.translate(W / 2, H / 2); ctx.scale(k, k); ctx.translate(-W / 2, -H / 2); }
    drawLiveStroke(ctx, { pen, color, size, opacity: pen === 'highlighter' ? 0.4 : 1, stab, sim: false }, pts, { dark, getImage: () => null });
    ctx.restore();
  }, [pen, color, size, stab, dark]);
  return <canvas ref={ref} className="squiggle" style={{ width: 228, height: 58 }} />;
}

function ColorPicker({ value, onPick, dark, colors }: { value: string; onPick: (c: string) => void; dark: boolean; colors: string[] }) {
  const engine = useEngine();
  const recent = useUI((s) => s.settings.recentColors);
  const pickCustom = (c: string) => {
    onPick(c);
    engine.setSettings((s) => ({ recentColors: [c, ...s.recentColors.filter((x) => x !== c)].slice(0, 8) }));
  };
  return (
    <>
      <Swatches colors={colors} value={value} onPick={onPick} dark={dark} />
      <div className="custom-row">
        <label className="custom-color" title="Custom colour">
          <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'} onChange={(e) => pickCustom(e.target.value)} />
          <span>Custom…</span>
        </label>
        {recent.length > 0 && <Swatches colors={recent} value={value} onPick={onPick} dark={dark} size={20} />}
      </div>
    </>
  );
}

function SizePicker({ pen, size, onChange, color, dark }: { pen: PenType; size: number; onChange: (v: number) => void; color: string; dark: boolean }) {
  const presets = SIZE_PRESETS[pen];
  const max = pen === 'highlighter' ? 60 : pen === 'marker' ? 40 : 20;
  return (
    <>
      <div className="size-presets">
        {presets.map((p) => (
          <button key={p} type="button" className={Math.abs(size - p) < 0.01 ? 'on' : ''} onClick={() => onChange(p)} title={`${p} px`}>
            <span style={{ width: Math.min(26, Math.max(3, p * (pen === 'highlighter' ? 0.6 : 1.4))), height: Math.min(26, Math.max(3, p * (pen === 'highlighter' ? 0.6 : 1.4))), background: cssColor(color, dark), opacity: pen === 'highlighter' ? 0.6 : 1 }} />
          </button>
        ))}
      </div>
      <Slider value={size} min={0.5} max={max} step={0.5} onChange={onChange} label={`${size} px`} />
    </>
  );
}

function PenPopover({ index, anchor, onClose }: { index: number; anchor: HTMLElement | null; onClose: () => void }) {
  const engine = useEngine();
  const settings = useUI((s) => s.settings);
  const fav = settings.favs[index];
  const dark = settings.dark;
  if (!fav) return null;
  const update = (patch: Partial<PenFav>) => engine.setSettings((s) => ({ favs: s.favs.map((f, i) => (i === index ? { ...f, ...patch } : f)) }));
  const move = (dir: -1 | 1) => {
    const to = index + dir;
    if (to < 0 || to >= settings.favs.length) return;
    engine.setSettings((s) => {
      const favs = [...s.favs];
      [favs[index], favs[to]] = [favs[to], favs[index]];
      return { favs, activeFav: to };
    });
    engine.ui.set({ popover: `fav:${to}` });
  };
  const remove = () => {
    if (settings.favs.length <= 1) return;
    engine.setSettings((s) => ({ favs: s.favs.filter((_, i) => i !== index), activeFav: Math.max(0, Math.min(s.favs.length - 2, index)) }));
    onClose();
  };
  const setType = (pen: PenType) => {
    // keep a sensible size when switching between thin pens and wide markers/highlighters
    const from = SIZE_PRESETS[fav.pen], to = SIZE_PRESETS[pen];
    let slot = 0;
    from.forEach((v, i) => { if (Math.abs(v - fav.size) < Math.abs(from[slot] - fav.size)) slot = i; });
    update({ pen, size: to[slot], color: pen === 'highlighter' && fav.color === 'ink' ? HL_COLORS[0] : fav.color });
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={268}>
      <Squiggle pen={fav.pen} color={fav.color} size={fav.size} stab={fav.stab} dark={dark} />
      <Section title="Pen type">
        <div className="pen-types">
          {(Object.keys(PEN_NAMES) as PenType[]).map((p) => (
            <button key={p} type="button" className={fav.pen === p ? 'on' : ''} onClick={() => setType(p)} title={PEN_NAMES[p]}>
              <PenIcon pen={p} color={fav.color} dark={dark} />
              <span>{PEN_NAMES[p]}</span>
            </button>
          ))}
        </div>
      </Section>
      <Section title="Colour">
        <ColorPicker value={fav.color} onPick={(color) => update({ color })} dark={dark} colors={fav.pen === 'highlighter' ? [...HL_COLORS, ...PEN_COLORS.slice(1, 12)] : PEN_COLORS} />
      </Section>
      <Section title="Thickness">
        <SizePicker pen={fav.pen} size={fav.size} onChange={(size) => update({ size })} color={fav.color} dark={dark} />
      </Section>
      <Section title="Stabilization">
        <Slider value={fav.stab} min={0} max={100} step={1} onChange={(stab) => update({ stab })} label={`${fav.stab}`} />
      </Section>
      <div className="pop-actions">
        <button type="button" className="btn small" onClick={() => move(-1)} disabled={index === 0} title="Move left"><ArrowLeft size={15} /></button>
        <button type="button" className="btn small" onClick={() => move(1)} disabled={index === settings.favs.length - 1} title="Move right"><ArrowRight size={15} /></button>
        <span className="grow" />
        <button type="button" className="btn small danger" onClick={remove} disabled={settings.favs.length <= 1}><Trash2 size={15} /> Delete pen</button>
      </div>
    </Popover>
  );
}

const SHAPES: { kind: ShapeTool; label: string; icon: ReactNode }[] = [
  { kind: 'line', label: 'Line', icon: <Slash size={20} /> },
  { kind: 'arrow', label: 'Arrow', icon: <MoveRight size={20} /> },
  { kind: 'doubleArrow', label: 'Double arrow', icon: <MoveHorizontal size={20} /> },
  { kind: 'rect', label: 'Rectangle', icon: <Square size={20} /> },
  { kind: 'ellipse', label: 'Ellipse / circle', icon: <Circle size={20} /> },
  { kind: 'triangle', label: 'Triangle', icon: <Triangle size={20} /> },
  { kind: 'rightTriangle', label: 'Right triangle', icon: <TriangleRight size={20} /> },
];

function ToolPopovers({ anchors, close }: { anchors: Record<string, HTMLElement | null>; close: () => void }) {
  const engine = useEngine();
  const popover = useUI((s) => s.popover);
  const st = useUI((s) => s.settings);
  const dark = st.dark;
  if (!popover) return null;
  if (popover.startsWith('fav:')) {
    const i = Number(popover.slice(4));
    return <PenPopover index={i} anchor={anchors[popover]} onClose={close} />;
  }
  const anchor = anchors[popover];
  switch (popover) {
    case 'highlighter':
      return (
        <Popover anchor={anchor} onClose={close} width={260}>
          <Squiggle pen="highlighter" color={st.hl.color} size={st.hl.size} stab={30} dark={dark} />
          <Section title="Colour"><Swatches colors={HL_COLORS} value={st.hl.color} onPick={(color) => engine.setSettings((s) => ({ hl: { ...s.hl, color } }))} dark={dark} size={32} /></Section>
          <Section title="Thickness"><SizePicker pen="highlighter" size={st.hl.size} onChange={(size) => engine.setSettings((s) => ({ hl: { ...s.hl, size } }))} color={st.hl.color} dark={dark} /></Section>
          <Toggle label="Straight highlighter" hint="Or hold Shift while highlighting" checked={st.hl.straight} onChange={(straight) => engine.setSettings((s) => ({ hl: { ...s.hl, straight } }))} />
        </Popover>
      );
    case 'eraser':
      return (
        <Popover anchor={anchor} onClose={close} width={270}>
          <Section title="Eraser">
            <Segmented
              value={st.eraser.mode}
              options={[{ value: 'stroke', label: 'Stroke', tip: 'Touching a stroke deletes all of it' }, { value: 'partial', label: 'Partial', tip: 'Erases only what is under the circle' }]}
              onChange={(mode) => engine.setSettings((s) => ({ eraser: { ...s.eraser, mode } }))}
            />
          </Section>
          <Section title="Size">
            <div className="eraser-sizes">
              {ERASER_SIZES.map((r, i) => (
                <button key={r} type="button" className={st.eraser.size === i ? 'on' : ''} onClick={() => engine.setSettings((s) => ({ eraser: { ...s.eraser, size: i } }))} title={['Small', 'Medium', 'Large'][i]}>
                  <span style={{ width: r * 1.5 + 6, height: r * 1.5 + 6 }} />
                </button>
              ))}
            </div>
          </Section>
          <Toggle label="Erase highlighter only" checked={st.eraser.hlOnly} onChange={(hlOnly) => engine.setSettings((s) => ({ eraser: { ...s.eraser, hlOnly } }))} />
          <Toggle label="Scribble to erase" hint="A fast zigzag with a pen erases the ink under it" checked={st.scribbleErase} onChange={(scribbleErase) => engine.setSettings({ scribbleErase })} />
          <div className="pop-actions column">
            <button type="button" className="btn small" onClick={() => engine.ui.set({ dialog: 'clearMine', popover: null })}>Clear my ink on this page…</button>
            <button type="button" className="btn small danger" onClick={() => engine.ui.set({ dialog: 'clearPage', popover: null })}>Clear page…</button>
          </div>
        </Popover>
      );
    case 'select':
      return (
        <Popover anchor={anchor} onClose={close} width={230}>
          <Section title="Selection mode">
            <Segmented
              value={st.select.mode}
              options={[{ value: 'lasso', label: <><Lasso size={15} /> Lasso</> }, { value: 'rect', label: <><SquareDashed size={15} /> Rectangle</> }]}
              onChange={(mode) => engine.setSettings({ select: { mode } })}
            />
          </Section>
          <p className="hint">Click an object to select it, Shift-click to add. Locked objects are selected with a plain click.</p>
        </Popover>
      );
    case 'shape':
      return (
        <Popover anchor={anchor} onClose={close} width={270}>
          <Section title="Shape">
            <div className="shape-grid">
              {SHAPES.map((s) => (
                <button key={s.kind} type="button" title={s.label} className={st.shape.kind === s.kind ? 'on' : ''} onClick={() => engine.setSettings((x) => ({ shape: { ...x.shape, kind: s.kind } }))}>
                  {s.icon}
                </button>
              ))}
            </div>
          </Section>
          <Toggle label="Dashed line" checked={st.shape.dashed} onChange={(dashed) => engine.setSettings((s) => ({ shape: { ...s.shape, dashed } }))} />
          <Section title="Fill">
            <div className="swatches">
              <button type="button" className={`swatch none ${st.shape.fill === null ? 'on' : ''}`} title="No fill" style={{ width: 26, height: 26 }} onClick={() => engine.setSettings((s) => ({ shape: { ...s.shape, fill: null } }))} />
            </div>
            <Swatches colors={PEN_COLORS} value={st.shape.fill} onPick={(fill) => engine.setSettings((s) => ({ shape: { ...s.shape, fill } }))} dark={dark} />
            {st.shape.fill && (
              <Slider value={Math.round(st.shape.fillOpacity * 100)} min={5} max={100} step={5} label={`${Math.round(st.shape.fillOpacity * 100)}%`}
                onChange={(v) => engine.setSettings((s) => ({ shape: { ...s.shape, fillOpacity: v / 100 } }))} />
            )}
          </Section>
          <Toggle label="Snap to grid" hint="When the page has a grid, graph or dot background" checked={st.shape.snap} onChange={(snap) => engine.setSettings((s) => ({ shape: { ...s.shape, snap } }))} />
          <p className="hint">Uses the current pen's colour and size. Hold Shift for 15° angles, squares and circles.</p>
        </Popover>
      );
    case 'laser':
      return (
        <Popover anchor={anchor} onClose={close} width={220}>
          <Section title="Laser pointer">
            <Segmented value={st.laser.mode} options={[{ value: 'trail', label: 'Trail' }, { value: 'dot', label: 'Dot' }]} onChange={(mode) => engine.setSettings({ laser: { mode } })} />
          </Section>
        </Popover>
      );
    case 'space':
      return (
        <Popover anchor={anchor} onClose={close} width={250}>
          <Section title="Insert / remove space">
            <Segmented
              value={st.space.axis}
              options={[{ value: 'y', label: <><UnfoldVertical size={15} /> Rows</>, tip: 'Drag down to open space, up to close it' }, { value: 'x', label: <><UnfoldHorizontal size={15} /> Columns</>, tip: 'Drag right to open space, left to close it' }]}
              onChange={(axis) => engine.setSettings({ space: { axis } })}
            />
          </Section>
          <p className="hint">Drag from where the gap should start. Everything beyond the line moves with your pen.</p>
        </Popover>
      );
    case 'text':
      return (
        <Popover anchor={anchor} onClose={close} width={260}>
          <Section title="Font size">
            <div className="chip-row">
              {[16, 20, 24, 32, 48, 64].map((n) => (
                <button key={n} type="button" className={`chip ${st.text.fontSize === n ? 'on' : ''}`} onClick={() => engine.setSettings((s) => ({ text: { ...s.text, fontSize: n } }))}>{n}</button>
              ))}
            </div>
          </Section>
          <Section title="Colour"><Swatches colors={PEN_COLORS} value={st.text.color} onPick={(color) => engine.setSettings((s) => ({ text: { ...s.text, color } }))} dark={dark} /></Section>
          <p className="hint">Click the board to place a text box. Double-click a text box to edit it.</p>
        </Popover>
      );
    case 'axes':
      return (
        <Popover anchor={anchor} onClose={close} width={240}>
          <Section title="Insert">
            <Segmented value={st.axes.mode} options={[{ value: 'xy', label: 'x–y axes' }, { value: 'numberLine', label: 'Number line' }]} onChange={(mode) => engine.setSettings({ axes: { mode } })} />
          </Section>
          <p className="hint">Drag out a box on the board. Select it afterwards to edit the range and step.</p>
        </Popover>
      );
    case 'tape':
      return (
        <Popover anchor={anchor} onClose={close} width={230}>
          <Section title="Tape colour"><Swatches colors={TAPE_COLORS} value={st.tape.color} onPick={(color) => engine.setSettings({ tape: { color } })} dark={dark} size={32} /></Section>
          <p className="hint">Drag a strip over an answer. Tap the tape to reveal or hide it for everyone.</p>
        </Popover>
      );
  }
  return null;
}

export function Toolbar({ onInsertImage }: { onInsertImage: () => void }) {
  const engine = useEngine();
  const tool = useUI((s) => s.tool);
  const settings = useUI((s) => s.settings);
  const canUndo = useUI((s) => s.canUndo);
  const canRedo = useUI((s) => s.canRedo);
  const ruler = useUI((s) => s.ruler);
  const popover = useUI((s) => s.popover);
  const dark = settings.dark;
  const anchors = useRef<Record<string, HTMLElement | null>>({});
  const [, force] = useState(0);
  const dragFrom = useRef<number | null>(null);
  const close = useCallback(() => engine.ui.set({ popover: null }), [engine]);
  const anchor = (key: string) => (el: HTMLButtonElement | null) => { anchors.current[key] = el; };

  // clicking the tool that is already selected opens its settings (like OneNote / GoodNotes)
  const pick = (t: ToolId, hasPopover = true) => {
    if (tool === t) {
      if (hasPopover) { engine.ui.set({ popover: popover === t ? null : t }); force((n) => n + 1); }
    } else engine.setTool(t);
  };
  const pickFav = (i: number) => {
    if (tool === 'pen' && settings.activeFav === i) {
      engine.ui.set({ popover: popover === `fav:${i}` ? null : `fav:${i}` });
      force((n) => n + 1);
    } else engine.selectFav(i);
  };
  const addFav = () => {
    if (settings.favs.length >= 15) return;
    const base = settings.favs[settings.activeFav] ?? settings.favs[0];
    const next = { ...base, id: nanoid(6) };
    engine.setSettings((s) => ({ favs: [...s.favs, next], activeFav: s.favs.length }));
    engine.setTool('pen');
    // open the new pen's settings once its button exists
    requestAnimationFrame(() => { engine.ui.set({ popover: `fav:${settings.favs.length}` }); force((n) => n + 1); });
  };
  const dropFav = (to: number) => {
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from === null || from === to) return;
    engine.setSettings((s) => {
      const favs = [...s.favs];
      const [moved] = favs.splice(from, 1);
      favs.splice(to, 0, moved);
      const activeId = s.favs[s.activeFav]?.id;
      return { favs, activeFav: Math.max(0, favs.findIndex((f) => f.id === activeId)) };
    });
  };

  return (
    <div className="toolbar" role="toolbar" aria-label="Drawing tools">
      <IconBtn tip={`Undo (${MOD}+Z)`} disabled={!canUndo} onClick={() => engine.undo()}><Undo2 size={20} /></IconBtn>
      <IconBtn tip={`Redo (${MOD}+Shift+Z)`} disabled={!canRedo} onClick={() => engine.redo()}><Redo2 size={20} /></IconBtn>
      <span className="sep" />
      <IconBtn tip="Lasso select (V or S)" active={tool === 'select'} onClick={() => pick('select')} btnRef={anchor('select')}><Lasso size={20} /></IconBtn>
      <IconBtn tip={`Eraser — ${settings.eraser.mode} (E)`} active={tool === 'eraser'} onClick={() => pick('eraser')} btnRef={anchor('eraser')}><Eraser size={20} /></IconBtn>
      <span className="sep" />
      <div className="favs" onDragOver={(e) => e.preventDefault()}>
        {settings.favs.map((f, i) => (
          <button
            key={f.id} type="button" ref={anchor(`fav:${i}`)} draggable
            className={`fav ${tool === 'pen' && settings.activeFav === i ? 'active' : ''}`}
            data-tip={`${PEN_NAMES[f.pen]} ${f.size}px${i < 9 ? ` (${i + 1})` : ''} — click again for settings`}
            aria-label={`Pen ${i + 1}: ${PEN_NAMES[f.pen]}`}
            onClick={() => pickFav(i)}
            onDragStart={(e) => { dragFrom.current = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); dropFav(i); }}
          >
            <PenIcon pen={f.pen} color={f.color} dark={dark} />
          </button>
        ))}
        {settings.favs.length < 15 && <IconBtn tip="Add a pen" onClick={addFav} className="add-fav"><Plus size={18} /></IconBtn>}
      </div>
      <span className="sep" />
      <IconBtn tip="Highlighter (H)" active={tool === 'highlighter'} onClick={() => pick('highlighter')} btnRef={anchor('highlighter')}>
        <Highlighter size={20} />
        <span className="color-dot" style={{ background: settings.hl.color }} />
      </IconBtn>
      <IconBtn tip="Shapes (Shift+R)" active={tool === 'shape'} onClick={() => pick('shape')} btnRef={anchor('shape')}><Shapes size={20} /></IconBtn>
      <IconBtn tip={`Ink to shape: ${settings.inkToShape ? 'on' : 'off'}`} active={settings.inkToShape} onClick={() => engine.setSettings({ inkToShape: !settings.inkToShape })} className="toggle-btn"><Sparkles size={20} /></IconBtn>
      <IconBtn tip="Ruler (R)" active={ruler.visible && ruler.kind === 'ruler'} onClick={() => engine.toggleRuler('ruler')} className="toggle-btn"><Ruler size={20} /></IconBtn>
      <IconBtn tip="Protractor" active={ruler.visible && ruler.kind === 'protractor'} onClick={() => engine.toggleRuler('protractor')} className="toggle-btn"><DraftingCompass size={20} /></IconBtn>
      <IconBtn tip="Laser pointer (L)" active={tool === 'laser'} onClick={() => pick('laser')} btnRef={anchor('laser')}><Zap size={20} /></IconBtn>
      <IconBtn tip="Insert / remove space" active={tool === 'space'} onClick={() => pick('space')} btnRef={anchor('space')}>
        {settings.space.axis === 'y' ? <UnfoldVertical size={20} /> : <UnfoldHorizontal size={20} />}
      </IconBtn>
      <IconBtn tip="Text (T)" active={tool === 'text'} onClick={() => pick('text')} btnRef={anchor('text')}><Type size={20} /></IconBtn>
      <span className="sep" />
      <IconBtn tip="Graph (G)" active={tool === 'graph'} onClick={() => pick('graph', false)}><ChartSpline size={20} /></IconBtn>
      <IconBtn tip={settings.axes.mode === 'xy' ? 'Coordinate axes' : 'Number line'} active={tool === 'axes'} onClick={() => pick('axes')} btnRef={anchor('axes')}>
        {settings.axes.mode === 'xy' ? <Move3d size={20} /> : <Minus size={20} />}
      </IconBtn>
      <IconBtn tip="Tape — cover and reveal" active={tool === 'tape'} onClick={() => pick('tape')} btnRef={anchor('tape')}><StickyNote size={20} /></IconBtn>
      <IconBtn tip={`Insert image (or paste with ${MOD}+V)`} onClick={onInsertImage}><ImagePlus size={20} /></IconBtn>
      <ToolPopovers anchors={anchors.current} close={close} />
    </div>
  );
}

/** Small floating bar for Focus / presentation mode. */
export function FocusBar() {
  const engine = useEngine();
  const tool = useUI((s) => s.tool);
  const settings = useUI((s) => s.settings);
  const canUndo = useUI((s) => s.canUndo);
  const canRedo = useUI((s) => s.canRedo);
  return (
    <div className="focusbar" role="toolbar" aria-label="Focus mode tools">
      {settings.favs.map((f, i) => (
        <button key={f.id} type="button" className={`fav ${tool === 'pen' && settings.activeFav === i ? 'active' : ''}`} aria-label={`Pen ${i + 1}`} onClick={() => engine.selectFav(i)}>
          <PenIcon pen={f.pen} color={f.color} dark={settings.dark} />
        </button>
      ))}
      <span className="sep" />
      <IconBtn tip="Highlighter (H)" active={tool === 'highlighter'} onClick={() => engine.setTool('highlighter')}>
        <Highlighter size={19} /><span className="color-dot" style={{ background: settings.hl.color }} />
      </IconBtn>
      <IconBtn tip="Eraser (E)" active={tool === 'eraser'} onClick={() => engine.setTool('eraser')}><Eraser size={19} /></IconBtn>
      <IconBtn tip="Lasso (V)" active={tool === 'select'} onClick={() => engine.setTool('select')}><Lasso size={19} /></IconBtn>
      <IconBtn tip={`Undo (${MOD}+Z)`} disabled={!canUndo} onClick={() => engine.undo()}><Undo2 size={19} /></IconBtn>
      <IconBtn tip="Redo" disabled={!canRedo} onClick={() => engine.redo()}><Redo2 size={19} /></IconBtn>
      <span className="sep" />
      <IconBtn tip="Exit focus mode (F)" onClick={() => engine.ui.set({ focus: false })}><Minimize2 size={19} /></IconBtn>
    </div>
  );
}

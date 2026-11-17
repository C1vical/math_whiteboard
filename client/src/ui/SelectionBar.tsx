import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AArrowDown, AArrowUp, BringToFront, ClipboardCopy, Copy, Hand, Lock, LockOpen, Pencil, Scissors, SendToBack, SlidersHorizontal, Trash2 } from 'lucide-react';
import type { BoardObject } from '../../../shared/types';
import { HL_COLORS, PEN_COLORS, TAPE_COLORS } from '../engine/store';
import { cssColor, IconBtn, MOD, Popover, Section, Slider, Swatches, useEngine, useUI } from './common';
import { clamp, copyText, UndoGroup } from './util';

const colorOf = (o: BoardObject): string | null => (o.type === 'stroke' || o.type === 'shape' || o.type === 'text' || o.type === 'tape' ? o.color : null);
const sizeOf = (o: BoardObject): number | null => (o.type === 'stroke' || o.type === 'shape' ? o.size : null);

/** Small floating action bar that follows the current selection. */
export function SelectionBar() {
  const engine = useEngine();
  const sel = useUI((s) => s.sel);
  const dark = useUI((s) => s.settings.dark);
  const recent = useUI((s) => s.settings.recentColors);
  const interact = useUI((s) => s.graphInteract);
  const textEdit = useUI((s) => s.textEdit);
  const busy = useUI((s) => s.selBusy);
  const ref = useRef<HTMLDivElement>(null);
  const colorBtn = useRef<HTMLButtonElement | null>(null);
  const sizeBtn = useRef<HTMLButtonElement | null>(null);
  const [pop, setPop] = useState<'color' | 'size' | null>(null);
  const group = useMemo(() => new UndoGroup(engine), [engine]);
  const key = sel ? sel.ids.join(',') : '';

  // keep the bar next to the selection, inside the board
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !sel) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    const r = sel.rect;
    // stay clear of the graph / axes side panel when it is open
    const panel = el.parentElement?.querySelector<HTMLElement>('.inspector');
    const right = panel && panel.offsetLeft > w + 24 ? panel.offsetLeft - 8 : engine.vw - 8;
    const left = clamp(r.x + r.w / 2 - w / 2, 8, Math.max(8, right - w));
    // above the rotate handle when there is room, otherwise below the selection
    let top = r.y - h - 46;
    if (top < 8) top = r.y + r.h + 14;
    if (top > engine.vh - h - 60) top = clamp(r.y + 10, 8, Math.max(8, engine.vh - h - 60));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  });

  useLayoutEffect(() => { setPop(null); group.end(); }, [key, group]);

  if (!sel || textEdit || busy) return null;
  const page = engine.page;
  const objs = sel.ids.map((id) => page.objects[id]).filter(Boolean);
  if (!objs.length) return null;
  const single = objs.length === 1 ? objs[0] : null;
  const locked = sel.allLocked;
  const color = objs.map(colorOf).find((c) => c !== null) ?? null;
  const size = objs.map(sizeOf).find((s) => s !== null) ?? null;
  const onlyTape = objs.every((o) => o.type === 'tape');
  const closePop = () => { setPop(null); group.end(); };

  const copy = () => {
    const marker = engine.copySelection();
    if (marker) void copyText(marker).then(() => engine.toast(`Copied — paste with ${MOD}+V`));
  };
  const cut = () => {
    const marker = engine.copySelection();
    if (!marker) return;
    void copyText(marker);
    engine.deleteSelection();
  };
  const fontStep = (dir: 1 | -1) => {
    if (single?.type !== 'text') return;
    const sizes = [12, 14, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128];
    const next = dir > 0 ? sizes.find((s) => s > single.fontSize) : [...sizes].reverse().find((s) => s < single.fontSize);
    if (next) engine.patchSelection((o) => (o.type === 'text' ? { fontSize: next } : null));
  };

  return (
    <div ref={ref} className="float selbar" role="toolbar" aria-label="Selection actions" onPointerDown={(e) => e.stopPropagation()}>
      {!locked && sel.hasColor && color !== null && (
        <IconBtn tip="Colour" className="swatch-btn" active={pop === 'color'} btnRef={(el) => { colorBtn.current = el; }} onClick={() => setPop(pop === 'color' ? null : 'color')}>
          <span style={{ background: cssColor(color, dark) }} />
        </IconBtn>
      )}
      {!locked && sel.hasSize && size !== null && (
        <IconBtn tip="Thickness" active={pop === 'size'} btnRef={(el) => { sizeBtn.current = el; }} onClick={() => setPop(pop === 'size' ? null : 'size')}>
          <SlidersHorizontal size={17} />
        </IconBtn>
      )}
      {!locked && single?.type === 'text' && (
        <>
          <IconBtn tip="Edit text (double-click)" onClick={() => engine.beginText(single)}><Pencil size={17} /></IconBtn>
          <IconBtn tip="Smaller text" onClick={() => fontStep(-1)}><AArrowDown size={18} /></IconBtn>
          <IconBtn tip="Larger text" onClick={() => fontStep(1)}><AArrowUp size={18} /></IconBtn>
        </>
      )}
      {single?.type === 'graph' && (
        <button
          type="button" className={`txt ${interact ? 'active' : ''}`} aria-pressed={interact}
          data-tip="Interact: drag to pan and scroll to zoom inside the graph"
          onClick={() => engine.ui.set({ graphInteract: !interact })}
        >
          <Hand size={16} /> Interact
        </button>
      )}
      {!locked && (
        <>
          <IconBtn tip={`Duplicate (${MOD}+D)`} onClick={() => engine.duplicateSelection()}><Copy size={17} /></IconBtn>
          <IconBtn tip={`Copy (${MOD}+C)`} onClick={copy}><ClipboardCopy size={17} /></IconBtn>
          <IconBtn tip={`Cut (${MOD}+X)`} onClick={cut}><Scissors size={17} /></IconBtn>
        </>
      )}
      <IconBtn tip="Bring to front" onClick={() => engine.reorderSelection('front')}><BringToFront size={17} /></IconBtn>
      <IconBtn tip="Send to back" onClick={() => engine.reorderSelection('back')}><SendToBack size={17} /></IconBtn>
      <IconBtn tip={locked ? 'Unlock' : 'Lock (ignore drags, so you can write on top)'} active={locked} onClick={() => engine.toggleLockSelection()}>
        {locked ? <LockOpen size={17} /> : <Lock size={17} />}
      </IconBtn>
      <IconBtn tip="Delete (Del)" onClick={() => engine.deleteSelection()}><Trash2 size={17} /></IconBtn>

      {pop === 'color' && (
        <Popover anchor={colorBtn.current} onClose={closePop} width={236}>
          <Section title="Colour">
            <Swatches colors={onlyTape ? TAPE_COLORS : PEN_COLORS} value={color} onPick={(c) => engine.recolorSelection(c)} dark={dark} />
          </Section>
          {!onlyTape && (
            <Section title="Highlighter colours">
              <Swatches colors={HL_COLORS} value={color} onPick={(c) => engine.recolorSelection(c)} dark={dark} />
            </Section>
          )}
          {!onlyTape && recent.length > 0 && (
            <Section title="Recent"><Swatches colors={recent} value={color} onPick={(c) => engine.recolorSelection(c)} dark={dark} size={22} /></Section>
          )}
        </Popover>
      )}
      {pop === 'size' && size !== null && (
        <Popover anchor={sizeBtn.current} onClose={closePop} width={250}>
          <Section title="Thickness">
            <div onPointerUp={() => group.end()} onKeyUp={() => group.end()}>
              <Slider
                value={size} min={0.5} max={40} step={0.5} label={`${size} px`}
                onChange={(v) => {
                  const ops = engine.selObjects()
                    .filter((o) => o.type === 'stroke' || o.type === 'shape')
                    .map((o) => ({ kind: 'update' as const, id: o.id, patch: { size: v } }));
                  if (ops.length) group.apply(ops);
                }}
              />
            </div>
          </Section>
        </Popover>
      )}
    </div>
  );
}

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import type { Engine } from '../engine/Engine';
import { useStore, type Store, type UIState } from '../engine/store';

export const Ctx = createContext<{ engine: Engine; ui: Store<UIState> }>(null as never);
export const useEngine = () => useContext(Ctx).engine;
/** Subscribe to a slice of UI state (the selector must return a stable field). */
export function useUI<S>(selector: (s: UIState) => S): S {
  return useStore(useContext(Ctx).ui, selector);
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl';

/** CSS colour for a board colour ('ink' adapts to the theme). */
export const cssColor = (c: string, dark: boolean) => (c === 'ink' ? (dark ? '#f1f3f5' : '#16181d') : c);

interface BtnProps {
  tip: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  btnRef?: (el: HTMLButtonElement | null) => void;
  style?: CSSProperties;
}
export function IconBtn({ tip, active, disabled, onClick, children, className = '', btnRef, style }: BtnProps) {
  return (
    <button
      type="button" ref={btnRef} className={`ibtn ${active ? 'active' : ''} ${className}`} data-tip={tip} aria-label={tip}
      aria-pressed={active} disabled={disabled} onClick={onClick} style={style}
    >
      {children}
    </button>
  );
}

/** Floating panel anchored under an element; closes on outside press. */
export function Popover({ anchor, onClose, children, width = 260, align = 'left' }: {
  anchor: HTMLElement | null; onClose: () => void; children: ReactNode; width?: number; align?: 'left' | 'right';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxH: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor?.getBoundingClientRect();
      if (!r) return;
      const w = Math.min(width, window.innerWidth - 16);
      let left = align === 'right' ? r.right - w : r.left;
      left = Math.max(8, Math.min(window.innerWidth - w - 8, left));
      const top = Math.min(r.bottom + 8, window.innerHeight - 120);
      setPos({ left, top, maxH: window.innerHeight - top - 12 });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor, width, align]);
  useEffect(() => {
    const down = (ev: PointerEvent) => {
      const t = ev.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [anchor, onClose]);
  if (!anchor) return null;
  // rendered at the document root so no toolbar / sidebar stacking context can cover it
  return createPortal(
    <div ref={ref} className="popover" style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0, width: Math.min(width, window.innerWidth - 16), maxHeight: pos?.maxH, visibility: pos ? 'visible' : 'hidden' }}>
      {children}
    </div>,
    document.body,
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="section">
      <div className="section-title">{title}</div>
      {children}
    </div>
  );
}

export function Swatches({ colors, value, onPick, dark, size = 26 }: { colors: string[]; value: string | null; onPick: (c: string) => void; dark: boolean; size?: number }) {
  return (
    <div className="swatches">
      {colors.map((c) => (
        <button
          key={c} type="button" className={`swatch ${value === c ? 'on' : ''}`} title={c === 'ink' ? 'Ink (black / white in dark mode)' : c}
          style={{ background: cssColor(c, dark), width: size, height: size }} onClick={() => onPick(c)}
        >
          {value === c && <Check size={14} color={luminance(cssColor(c, dark)) > 0.6 ? '#000' : '#fff'} />}
        </button>
      ))}
    </div>
  );
}

export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="toggle">
      <span className="toggle-text">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" />
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode; tip?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} type="button" title={o.tip} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Slider({ value, min, max, step, onChange, label }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; label?: string }) {
  return (
    <div className="slider-row">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
      <span className="slider-value">{label ?? value}</span>
    </div>
  );
}

/** Numeric text field that only commits valid numbers. */
export function NumField({ value, onCommit, label, width = 64 }: { value: number; onCommit: (v: number) => void; label?: string; width?: number }) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(String(Math.round(value * 1e6) / 1e6)); }, [value, focused]);
  const commit = (s: string) => {
    const v = Number(s.replace(',', '.').replace('−', '-'));
    if (s.trim() !== '' && Number.isFinite(v) && v !== value) onCommit(v);
  };
  return (
    <label className="numfield">
      {label && <span>{label}</span>}
      <input
        type="text" inputMode="decimal" value={text} style={{ width }}
        onFocus={() => setFocused(true)}
        onBlur={() => { setFocused(false); commit(text); }}
        onChange={(e) => { setText(e.target.value); commit(e.target.value); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    </label>
  );
}

export function Dialog({ title, onClose, children, width = 460, actions }: { title: string; onClose?: () => void; children: ReactNode; width?: number; actions?: ReactNode }) {
  return createPortal(
    <div className="backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} style={{ width }}>
        <div className="dialog-title">{title}</div>
        <div className="dialog-body">{children}</div>
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}

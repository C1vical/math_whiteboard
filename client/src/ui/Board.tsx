import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Maximize2, Minus, PanelLeftOpen, Pause, Play, Plus, Scan, X } from 'lucide-react';
import { textSize } from '../../../shared/geometry';
import { Engine } from '../engine/Engine';
import { FONT, resolveColor } from '../engine/render';
import { initialUI, Store, type UIState } from '../engine/store';
import { Ctx, IconBtn, MOD, useEngine, useUI } from './common';
import { Dialogs } from './Dialogs';
import { Inspector } from './Inspector';
import { SelectionBar } from './SelectionBar';
import { Sidebar } from './Sidebar';
import { FocusBar, Toolbar } from './Toolbar';
import { TopRight } from './TopRight';
import { DEFAULT_TITLE } from '../../../shared/types';
import { pickFiles, rememberBoard } from './util';

interface BoardProps {
  notebookId: string;
  name: string;
  userId: string;
  passcode: string;
  onExit: () => void;
  onBadPasscode: () => void;
}

export function Board({ notebookId, name, userId, passcode, onExit, onBadPasscode }: BoardProps) {
  const host = useRef<HTMLDivElement>(null);
  const [ctx, setCtx] = useState<{ engine: Engine; ui: Store<UIState> } | null>(null);

  useEffect(() => {
    const ui = new Store<UIState>(initialUI(name, userId));
    const engine = new Engine(host.current!, ui, { notebookId, userId, name, passcode });
    setCtx({ engine, ui });
    // handle for debugging from the browser console
    (window as unknown as { mathboard?: Engine }).mathboard = engine;

    // keep the browser's own zoom and file-drop navigation away from the app
    const wheel = (ev: WheelEvent) => { if (ev.ctrlKey || ev.metaKey) ev.preventDefault(); };
    const gesture = (ev: Event) => ev.preventDefault();
    const dragOver = (ev: DragEvent) => ev.preventDefault();
    const drop = (ev: DragEvent) => {
      ev.preventDefault();
      if ((ev.target as HTMLElement | null)?.tagName === 'CANVAS') return; // the board handles its own drops
      const files = Array.from(ev.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
      void engine.insertImages(files);
    };
    const beforeUnload = (ev: BeforeUnloadEvent) => {
      if (engine.sync.pending.length) { ev.preventDefault(); ev.returnValue = ''; }
    };
    window.addEventListener('wheel', wheel, { passive: false });
    document.addEventListener('gesturestart', gesture);
    window.addEventListener('dragover', dragOver);
    window.addEventListener('drop', drop);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('wheel', wheel);
      document.removeEventListener('gesturestart', gesture);
      window.removeEventListener('dragover', dragOver);
      window.removeEventListener('drop', drop);
      window.removeEventListener('beforeunload', beforeUnload);
      setCtx(null);
      engine.destroy();
    };
  }, [notebookId, name, userId, passcode]);

  return (
    <div className="app">
      <Ctx.Provider value={ctx as never}>
        {ctx && <TopBar onExit={onExit} />}
        <div className="main">
          {ctx && <Sidebar />}
          <div className="board-wrap">
            <div className="board" ref={host} />
            {ctx && <Overlays onExit={onExit} onBadPasscode={onBadPasscode} />}
          </div>
        </div>
        {ctx && <Dialogs />}
        {ctx && <Toasts />}
        {ctx && <TitleSync notebookId={notebookId} />}
        <Tooltips />
      </Ctx.Provider>
    </div>
  );
}

/** Keeps the browser tab title and the "recent boards" list in step with the board's name. */
function TitleSync({ notebookId }: { notebookId: string }) {
  const title = useUI((s) => s.title);
  const ready = useUI((s) => s.ready);
  const conn = useUI((s) => s.conn);
  const engine = useEngine();
  useEffect(() => {
    const named = !!title && title !== DEFAULT_TITLE;
    document.title = named ? `${title} — MathBoard` : `MathBoard — ${notebookId}`;
    if (ready) rememberBoard(notebookId, named ? title : undefined);
  }, [title, ready, notebookId]);
  // after an outage (shown by ConnBanner), say when it is over
  const lost = useRef(false);
  useEffect(() => {
    if (!ready) return;
    if (conn !== 'connected') lost.current = true;
    else if (lost.current) { lost.current = false; engine.toast('Connected again — everything is synced'); }
  }, [conn, ready, engine]);
  return null;
}

function useInsertImage() {
  const engine = useEngine();
  return useCallback(() => {
    void pickFiles('image/png,image/jpeg,image/gif,image/webp,image/*', true).then((files) => engine.insertImages(files));
  }, [engine]);
}

function TopBar({ onExit }: { onExit: () => void }) {
  const focus = useUI((s) => s.focus);
  const dark = useUI((s) => s.settings.dark);
  const insertImage = useInsertImage();
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, [dark]);
  if (focus) return null;
  return (
    <header className="topbar">
      <Toolbar onInsertImage={insertImage} />
      <TopRight onExit={onExit} onInsertImage={insertImage} />
    </header>
  );
}

function Overlays({ onExit, onBadPasscode }: { onExit: () => void; onBadPasscode: () => void }) {
  const ready = useUI((s) => s.ready);
  const fatal = useUI((s) => s.fatal);
  const focus = useUI((s) => s.focus);
  const replay = useUI((s) => s.replay);

  useEffect(() => { if (fatal === 'passcode') onBadPasscode(); }, [fatal, onBadPasscode]);

  if (fatal) {
    return (
      <div className="center-note">
        <strong style={{ color: 'var(--text)', fontSize: 16 }}>This board could not be opened</strong>
        <span>
          {fatal === 'passcode' ? 'The passcode was not accepted.'
            : fatal === 'rate' ? 'Too many wrong passcodes were tried from this network. Wait a few minutes and try again.'
              : 'The server refused the connection. Check the link and try again.'}
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn primary" onClick={() => location.reload()}>Try again</button>
          <button type="button" className="btn" onClick={onExit}>Back to start</button>
        </div>
      </div>
    );
  }
  return (
    <>
      {!ready && <div className="center-note"><div className="spinner" />Opening board…</div>}
      <TextEditor />
      {!replay && <SelectionBar />}
      {!replay && <Inspector />}
      {focus && <FocusBar />}
      <div className={`banners ${focus ? 'below-focusbar' : ''}`}>
        <ConnBanner />
        <FollowBanner />
      </div>
      {replay ? <ReplayBar /> : <Pager />}
      <ZoomControls />
    </>
  );
}

/** The plain-text box editor: a textarea laid exactly over where the text is drawn. */
function TextEditor() {
  const engine = useEngine();
  const te = useUI((s) => s.textEdit);
  const dark = useUI((s) => s.settings.dark);
  const ref = useRef<HTMLTextAreaElement>(null);
  const key = te?.key;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || key === undefined) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [key]);

  // follow the camera while the box is open (pan / zoom do not go through React)
  useEffect(() => {
    if (key === undefined) return;
    let raf = 0;
    const place = () => {
      const el = ref.current, cur = engine.ui.get().textEdit;
      if (el && cur) {
        const z = engine.cam.zoom;
        const [sx, sy] = engine.toScreen(cur.x, cur.y);
        const size = textSize({ text: cur.text || ' ', fontSize: cur.fontSize });
        el.style.fontSize = `${cur.fontSize * z}px`;
        el.style.width = `${Math.ceil((size.w + cur.fontSize * 1.2) * z)}px`;
        el.style.height = `${Math.ceil(size.h * z) + 2}px`;
        el.style.transform = `translate(${sx}px, ${sy}px)${cur.rotation ? ` rotate(${cur.rotation}rad)` : ''}`;
      }
      raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [engine, key]);

  if (!te) return null;
  return (
    <textarea
      key={te.key} ref={ref} className="text-edit" value={te.text} maxLength={5000} spellCheck={false} autoCapitalize="off"
      style={{ color: resolveColor(te.color, dark), fontFamily: FONT, caretColor: resolveColor(te.color, dark) }}
      onChange={(e) => {
        const cur = engine.ui.get().textEdit;
        if (cur) engine.ui.set({ textEdit: { ...cur, text: e.target.value } });
      }}
      onBlur={() => {
        const cur = engine.ui.get().textEdit;
        if (cur && cur.key === te.key) engine.commitText(cur.text);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); e.currentTarget.blur(); }
        e.stopPropagation();
      }}
    />
  );
}

function ZoomControls() {
  const engine = useEngine();
  const zoom = useUI((s) => s.zoom);
  const focus = useUI((s) => s.focus);
  return (
    <div className="float zoom">
      <IconBtn tip={`Zoom out (${MOD}+−)`} onClick={() => engine.zoomStep(-1)}><Minus size={18} /></IconBtn>
      <button type="button" className="pct" data-tip={`Reset to 100% (${MOD}+0)`} aria-label="Reset zoom" onClick={() => engine.resetZoom()}>{Math.round(zoom * 100)}%</button>
      <IconBtn tip={`Zoom in (${MOD}++)`} onClick={() => engine.zoomStep(1)}><Plus size={18} /></IconBtn>
      <IconBtn tip="Fit to content" onClick={() => engine.fitContent()}><Scan size={18} /></IconBtn>
      {!focus && <IconBtn tip="Focus mode (F)" onClick={() => engine.ui.set({ focus: true, popover: null })}><Maximize2 size={17} /></IconBtn>}
    </div>
  );
}

function Pager() {
  const engine = useEngine();
  const pages = useUI((s) => s.pages);
  const pageId = useUI((s) => s.pageId);
  const sidebar = useUI((s) => s.settings.sidebar);
  const focus = useUI((s) => s.focus);
  const i = pages.findIndex((p) => p.id === pageId);
  if (i < 0) return null;
  return (
    <div className="float pager">
      {!sidebar && !focus && <IconBtn tip="Show pages" onClick={() => engine.setSettings({ sidebar: true })}><PanelLeftOpen size={18} /></IconBtn>}
      <IconBtn tip="Previous page (PageUp)" disabled={i === 0} onClick={() => engine.stepPage(-1)}><ChevronLeft size={18} /></IconBtn>
      <span className="where" data-tip={pages[i].title}>{i + 1} / {pages.length}</span>
      <IconBtn tip="Next page (PageDown)" disabled={i === pages.length - 1} onClick={() => engine.stepPage(1)}><ChevronRight size={18} /></IconBtn>
    </div>
  );
}

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function ReplayBar() {
  const engine = useEngine();
  const r = useUI((s) => s.replay);
  if (!r) return null;
  return (
    <div className="float replaybar">
      <IconBtn tip={r.playing ? 'Pause' : 'Play'} onClick={() => engine.replayControl({ playing: !r.playing })}>
        {r.playing ? <Pause size={18} /> : <Play size={18} />}
      </IconBtn>
      <input
        type="range" min={0} max={r.total} step={0.01} value={r.t} aria-label="Replay position"
        onChange={(e) => engine.replayControl({ t: Number(e.target.value), playing: false })}
      />
      <span className="time">{fmtTime(r.t)} / {fmtTime(r.total)}</span>
      <select value={r.speed} aria-label="Replay speed" onChange={(e) => engine.replayControl({ speed: Number(e.target.value) })}>
        {[0.5, 1, 2, 4, 8].map((v) => <option key={v} value={v}>{v}×</option>)}
      </select>
      <IconBtn tip="Close replay (Esc)" onClick={() => engine.stopReplay()}><X size={18} /></IconBtn>
    </div>
  );
}

/** Connection trouble, said in words over the board (the top bar only has room for a coloured dot). */
function ConnBanner() {
  const conn = useUI((s) => s.conn);
  const ready = useUI((s) => s.ready);
  const [show, setShow] = useState(false);
  // a blip shorter than a second and a half is not worth a banner
  useEffect(() => {
    if (conn === 'connected' || !ready) { setShow(false); return; }
    const t = window.setTimeout(() => setShow(true), 1500);
    return () => window.clearTimeout(t);
  }, [conn, ready]);
  if (!show || conn === 'connected') return null;
  return (
    <div className={`banner conn ${conn}`} role="status">
      {conn === 'offline' ? 'Offline' : 'Reconnecting…'} — keep writing, it will sync when the connection returns
    </div>
  );
}

function FollowBanner() {
  const engine = useEngine();
  const following = useUI((s) => s.following);
  const users = useUI((s) => s.users);
  if (!following) return null;
  const u = users.find((x) => x.sid === following);
  return (
    <div className="banner" style={{ background: u?.color }}>
      Following {u?.name ?? 'collaborator'}
      <button type="button" onClick={() => engine.stopFollow()}>Stop</button>
    </div>
  );
}

function Toasts() {
  const toasts = useUI((s) => s.toasts);
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.msg}</span>
          {t.action && <button type="button" className="toast-action" onClick={t.action.run}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  );
}

/** One shared tooltip for every element carrying a `data-tip` attribute. */
function Tooltips() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  useEffect(() => {
    let timer = 0;
    let cur: Element | null = null;
    const hide = () => { cur = null; window.clearTimeout(timer); setTip(null); };
    const over = (ev: PointerEvent) => {
      const el = (ev.target as Element | null)?.closest?.('[data-tip]') ?? null;
      if (el === cur) return;
      hide();
      if (!el || ev.pointerType === 'touch') return;
      cur = el;
      timer = window.setTimeout(() => {
        if (!el.isConnected) return;
        const text = el.getAttribute('data-tip');
        if (!text) return;
        const r = el.getBoundingClientRect();
        const half = Math.min(window.innerWidth / 2 - 4, text.length * 3.3 + 10);
        const x = Math.max(half + 4, Math.min(window.innerWidth - half - 4, r.left + r.width / 2));
        const below = r.bottom + 34 < window.innerHeight;
        setTip({ text, x, y: below ? r.bottom + 6 : r.top - 30 });
      }, 420);
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);
  if (!tip) return null;
  return <div className="tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>;
}

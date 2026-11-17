import { useEffect, useRef, useState } from 'react';
import {
  Check, CirclePlay, CloudOff, Eraser, FileDown, FileJson, FileUp, ImageDown, ImagePlus, Keyboard, LoaderCircle, LogOut, Maximize2, Menu, Moon, RotateCcw, Settings,
  Share2, StickyNote, Sun,
} from 'lucide-react';
import { DEFAULT_TITLE, type Background } from '../../../shared/types';
import { exportNotebookJson } from '../engine/exporter';
import type { ExportKind } from '../engine/store';
import { IconBtn, Popover, Section, useEngine, useUI } from './common';
import { copyText, initials, pickFiles } from './util';

const BACKGROUNDS: { id: Background; label: string }[] = [
  { id: 'blank', label: 'Blank' }, { id: 'grid', label: 'Grid' }, { id: 'graph', label: 'Graph' }, { id: 'lined', label: 'Lined' }, { id: 'dots', label: 'Dots' },
];

/** The notebook's name: click to rename it for everyone. */
function BoardTitle() {
  const engine = useEngine();
  const title = useUI((s) => s.title);
  const ready = useUI((s) => s.ready);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const btn = useRef<HTMLButtonElement | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const named = !!title && title !== DEFAULT_TITLE;
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    input.current?.select();
  }, [open]);
  const commit = () => {
    engine.setTitle(text);
    setOpen(false);
  };
  return (
    <>
      <button
        type="button" ref={btn} className={`board-title ${named ? '' : 'unnamed'}`} disabled={!ready} aria-label="Board name"
        data-tip={named ? `${title} — click to rename` : 'Name this board'}
        onClick={() => { setText(named ? title : ''); setOpen(!open); }}
      >
        <span>{named ? title : 'Untitled'}</span>
      </button>
      {open && (
        <Popover anchor={btn.current} onClose={commit} width={280} align="right">
          <Section title="Board name">
            <input
              ref={input} className="field" value={text} maxLength={120} placeholder="e.g. Algebra 2 — Period 3" aria-label="Board name"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') commit();
                else if (e.key === 'Escape') setOpen(false);
              }}
            />
          </Section>
          <p className="hint">Everyone on the board sees the name. It is also used for the browser tab, the recent boards list and export file names.</p>
          <p className="hint">Board code: <code>{engine.opts.notebookId}</code></p>
        </Popover>
      )}
    </>
  );
}

function Presence() {
  const engine = useEngine();
  const users = useUI((s) => s.users);
  const me = useUI((s) => s.me);
  const pages = useUI((s) => s.pages);
  const following = useUI((s) => s.following);
  const myPage = useUI((s) => s.pageId);
  const pageNo = (id: string | null) => pages.findIndex((p) => p.id === id) + 1;
  // me first, then everyone else in a stable order
  const sorted = [...users].sort((a, b) => Number(b.sid === me.sid) - Number(a.sid === me.sid) || a.name.localeCompare(b.name) || a.sid.localeCompare(b.sid));
  return (
    <div className="users">
      {sorted.slice(0, 8).map((u) => {
        const mine = u.sid === me.sid;
        const n = pageNo(u.pageId);
        const where = n ? `page ${n}${pages[n - 1] ? ` (${pages[n - 1].title})` : ''}` : 'another page';
        const body = (
          <>
            <span className="avatar" style={{ background: u.color }}>{initials(u.name)}</span>
            <span className="uname">{mine ? `${u.name} (you)` : u.name}</span>
            {n > 0 && <span className="upage">p{n}</span>}
          </>
        );
        // in a narrow window the page number only shows for people who are somewhere else
        const here = u.pageId === myPage ? 'here' : '';
        if (mine) return <span key={u.sid} className={`user-chip me ${here}`} data-tip={`You — ${u.name}, on ${where}`}>{body}</span>;
        const on = following === u.sid;
        return (
          <button
            key={u.sid} type="button" className={`user-chip ${here} ${on ? 'following' : ''}`} aria-pressed={on}
            data-tip={on ? `Following ${u.name} — click to stop` : `${u.name} is on ${where} — click to follow`}
            onClick={() => engine.follow(on ? null : u.sid)}
          >
            {body}
          </button>
        );
      })}
      {sorted.length > 8 && <span className="user-chip me more">+{sorted.length - 8}</span>}
    </div>
  );
}

function Status() {
  const conn = useUI((s) => s.conn);
  const saving = useUI((s) => s.saving);
  const label = conn === 'connected' ? 'Connected' : conn === 'reconnecting' ? 'Reconnecting…' : 'Offline';
  const tip = conn === 'connected' ? 'Connected — changes sync live'
    : conn === 'reconnecting' ? 'Connection lost — reconnecting. You can keep writing; it will sync.'
      : 'Offline — you can keep writing; it will sync when the connection returns.';
  const saveTip = !saving ? 'Everything is saved'
    : conn === 'connected' ? 'Saving…' : 'Your changes are kept on this device and will be sent when the connection returns';
  return (
    <span className="status">
      <span className={`pill ${conn}`} data-tip={tip} role="status" aria-label={label}><span className="dot" /><span className="label">{label}</span></span>
      <span className={`save-ind ${saving ? 'saving' : ''} ${conn}`} role="status" data-tip={saveTip} aria-label={saveTip}>
        {saving
          ? (conn === 'connected' ? <><LoaderCircle size={14} className="spin" /><span className="label">Saving…</span></> : <><CloudOff size={14} /><span className="label">Not saved yet</span></>)
          : <><Check size={14} /><span className="label">Saved</span></>}
      </span>
    </span>
  );
}

export function TopRight({ onExit, onInsertImage }: { onExit: () => void; onInsertImage: () => void }) {
  const engine = useEngine();
  const popover = useUI((s) => s.popover);
  const settings = useUI((s) => s.settings);
  const pages = useUI((s) => s.pages);
  const pageId = useUI((s) => s.pageId);
  const menuBtn = useRef<HTMLButtonElement | null>(null);
  const background = pages.find((p) => p.id === pageId)?.background ?? 'blank';
  const close = () => engine.ui.set({ popover: null });
  const run = (fn: () => void | Promise<void>) => () => {
    close();
    void Promise.resolve().then(fn).catch((err: unknown) => engine.toast(`That did not work: ${(err as Error).message}`, 'error'));
  };

  const share = async () => {
    const url = `${location.origin}/b/${engine.opts.notebookId}`;
    if (await copyText(url)) engine.toast('Link copied — send it to your co-teacher');
    else window.prompt('Copy this link:', url);
  };
  const choosePdf = async () => {
    const [file] = await pickFiles('application/pdf,.pdf');
    if (file) engine.ui.set({ pendingFile: file, dialog: 'pdf' });
  };
  const chooseBackup = async () => {
    const [file] = await pickFiles('application/json,.json');
    if (file) engine.ui.set({ pendingFile: file, dialog: 'importJson' });
  };
  const openExport = (exportKind: ExportKind) => engine.ui.set({ dialog: 'export', exportKind });

  return (
    <div className="topright">
      <BoardTitle />
      <Presence />
      <Status />
      <button type="button" className="btn small primary share-btn" data-tip="Copy the link to this board" aria-label="Share" onClick={() => void share()}>
        <Share2 size={15} /><span>Share</span>
      </button>
      <IconBtn tip="Menu" active={popover === 'menu'} btnRef={(el) => { menuBtn.current = el; }} onClick={() => engine.ui.set({ popover: popover === 'menu' ? null : 'menu' })}>
        <Menu size={20} />
      </IconBtn>
      {popover === 'menu' && (
        <Popover anchor={menuBtn.current} onClose={close} width={292} align="right">
          <Section title="Page background">
            <div className="bg-options">
              {BACKGROUNDS.map((b) => (
                <button key={b.id} type="button" className={background === b.id ? 'on' : ''} onClick={() => engine.setBackground(b.id)}>
                  <span className={`bg-thumb ${b.id}`} />
                  {b.label}
                </button>
              ))}
            </div>
          </Section>
          <div className="menu">
            <button type="button" className="menu-item" onClick={run(() => engine.setSettings({ dark: !settings.dark }))}>
              {settings.dark ? <Sun size={17} /> : <Moon size={17} />}{settings.dark ? 'Light mode' : 'Dark mode'}
            </button>
            <button type="button" className="menu-item" onClick={run(() => engine.ui.set({ focus: true }))}>
              <Maximize2 size={17} />Focus mode <span className="key">F</span>
            </button>
            <button type="button" className="menu-item" onClick={run(() => engine.startReplay())}>
              <CirclePlay size={17} />Replay this page's ink
            </button>
            <div className="menu-sep" />
            <button type="button" className="menu-item" onClick={run(onInsertImage)}><ImagePlus size={17} />Insert image…</button>
            <button type="button" className="menu-item" onClick={run(choosePdf)}><FileUp size={17} />Import PDF…</button>
            <div className="menu-sep" />
            <button type="button" className="menu-item" onClick={run(() => openExport('png'))}><ImageDown size={17} />Export this page as PNG…</button>
            <button type="button" className="menu-item" onClick={run(() => openExport('pdf'))}><FileDown size={17} />Export as PDF…</button>
            <button type="button" className="menu-item" onClick={run(() => exportNotebookJson(engine))}><FileJson size={17} />Back up notebook (.json)</button>
            <button type="button" className="menu-item" onClick={run(chooseBackup)}><RotateCcw size={17} />Restore from a backup…</button>
            <div className="menu-sep" />
            <ResetMenu run={run} />
            <div className="menu-sep" />
            <button type="button" className="menu-item" onClick={run(() => engine.ui.set({ dialog: 'settings' }))}><Settings size={17} />Settings</button>
            <button type="button" className="menu-item" onClick={run(() => engine.ui.set({ dialog: 'shortcuts' }))}>
              <Keyboard size={17} />Keyboard shortcuts <span className="key">?</span>
            </button>
            <button type="button" className="menu-item" onClick={run(onExit)}><LogOut size={17} />Leave board</button>
          </div>
        </Popover>
      )}
    </div>
  );
}

/** "Reset for the next class": clear the ink but keep the prepared material, and cover the answers again. */
export function ResetMenu({ run }: { run: (fn: () => void | Promise<void>) => () => void }) {
  const engine = useEngine();
  return (
    <>
      <div className="menu-title">Reset for the next class</div>
      <button type="button" className="menu-item" onClick={run(() => engine.ui.set({ dialog: 'resetInk' }))}><Eraser size={17} />Clear ink, keep everything else…</button>
      <button type="button" className="menu-item" onClick={run(() => engine.coverTape('page'))}><StickyNote size={17} />Cover all tape again</button>
      <button type="button" className="menu-item" onClick={run(() => engine.ui.set({ dialog: 'resetInkAll' }))}><Eraser size={17} />Clear ink in the whole notebook…</button>
      <button type="button" className="menu-item" onClick={run(() => engine.ui.set({ dialog: 'coverAll' }))}><StickyNote size={17} />Cover all tape in the notebook…</button>
    </>
  );
}

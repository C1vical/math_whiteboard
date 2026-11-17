import { useRef } from 'react';
import {
  Check, CirclePlay, FileDown, FileJson, FileUp, ImageDown, ImagePlus, Keyboard, LogOut, Maximize2, Menu, Moon, RotateCcw, Settings, Share2, Sun,
} from 'lucide-react';
import type { Background } from '../../../shared/types';
import { exportNotebookJson, exportNotebookPdf, exportPagePng } from '../engine/exporter';
import { IconBtn, Popover, Section, useEngine, useUI } from './common';
import { copyText, initials, pickFiles } from './util';

const BACKGROUNDS: { id: Background; label: string }[] = [
  { id: 'blank', label: 'Blank' }, { id: 'grid', label: 'Grid' }, { id: 'graph', label: 'Graph' }, { id: 'lined', label: 'Lined' }, { id: 'dots', label: 'Dots' },
];

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
      {sorted.length > 8 && <span className="user-chip me">+{sorted.length - 8}</span>}
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
  return (
    <span className="status">
      <span className={`pill ${conn}`} data-tip={tip} role="status"><span className="dot" /><span className="label">{label}</span></span>
      <span className={`save-ind ${saving ? 'saving' : ''}`} role="status" data-tip={saving && conn !== 'connected' ? 'Your changes are kept on this device and will be sent when the connection returns' : undefined}>
        {saving ? (conn === 'connected' ? 'Saving…' : 'Not saved yet') : <><Check size={14} /> Saved</>}
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

  return (
    <div className="topright">
      <Presence />
      <Status />
      <button type="button" className="btn small primary share-btn" data-tip="Copy the link to this board" onClick={() => void share()}>
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
            <button type="button" className="menu-item" onClick={run(() => exportPagePng(engine))}><ImageDown size={17} />Export this page as PNG</button>
            <button type="button" className="menu-item" onClick={run(async () => { engine.toast('Building the PDF…'); await exportNotebookPdf(engine); })}>
              <FileDown size={17} />Export notebook as PDF
            </button>
            <button type="button" className="menu-item" onClick={run(() => exportNotebookJson(engine))}><FileJson size={17} />Back up notebook (.json)</button>
            <button type="button" className="menu-item" onClick={run(chooseBackup)}><RotateCcw size={17} />Restore from a backup…</button>
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

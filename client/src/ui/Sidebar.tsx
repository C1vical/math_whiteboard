import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Ellipsis, PanelLeftClose, Pencil, Plus, Trash2 } from 'lucide-react';
import type { PageInfo } from '../engine/store';
import { Dialog, IconBtn, Popover, useEngine, useUI } from './common';

function RenameInput({ page, onDone }: { page: PageInfo; onDone: (title: string | null) => void }) {
  const [text, setText] = useState(page.title);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return (
    <input
      ref={ref} className="rename" value={text} maxLength={120} aria-label="Page title"
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onDone(text)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onDone(text);
        else if (e.key === 'Escape') onDone(null);
      }}
    />
  );
}

/** OneNote-style pages list: add, rename, duplicate, delete, drag to reorder. */
export function Sidebar() {
  const engine = useEngine();
  const pages = useUI((s) => s.pages);
  const pageId = useUI((s) => s.pageId);
  const users = useUI((s) => s.users);
  const me = useUI((s) => s.me);
  const open = useUI((s) => s.settings.sidebar);
  const focus = useUI((s) => s.focus);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PageInfo | null>(null);
  const [dropAt, setDropAt] = useState<string | null>(null);
  const dragId = useRef<string | null>(null);
  const moreBtns = useRef<Record<string, HTMLButtonElement | null>>({});

  if (!open || focus) return null;

  const finishRename = (id: string, title: string | null) => {
    setRenaming(null);
    if (title !== null && title.trim()) engine.renamePage(id, title);
  };
  const drop = (targetId: string) => {
    const from = dragId.current;
    dragId.current = null;
    setDropAt(null);
    if (!from || from === targetId) return;
    const to = pages.findIndex((p) => p.id === targetId);
    if (to >= 0) engine.reorderPage(from, to);
  };
  const menuPage = pages.find((p) => p.id === menu);
  const menuIndex = pages.findIndex((p) => p.id === menu);

  return (
    <aside className="sidebar" aria-label="Pages">
      <div className="sidebar-head">
        <span className="grow">Pages</span>
        <IconBtn tip="Add page" className="small" onClick={() => engine.addPage()}><Plus size={17} /></IconBtn>
        <IconBtn tip="Hide pages" className="small" onClick={() => engine.setSettings({ sidebar: false })}><PanelLeftClose size={17} /></IconBtn>
      </div>
      <div className="page-list" onDragOver={(e) => e.preventDefault()}>
        {pages.map((p, i) => {
          const here = users.filter((u) => u.pageId === p.id && u.sid !== me.sid);
          return (
            <div
              key={p.id} role="button" tabIndex={0} draggable={renaming !== p.id}
              className={`page-row ${p.id === pageId ? 'active' : ''} ${dropAt === p.id ? 'drop' : ''}`}
              onClick={() => engine.gotoPage(p.id)}
              onDoubleClick={() => setRenaming(p.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) engine.gotoPage(p.id); }}
              onDragStart={(e) => { dragId.current = p.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p.title); }}
              onDragOver={(e) => { e.preventDefault(); if (dragId.current && dropAt !== p.id) setDropAt(p.id); }}
              onDragEnd={() => { dragId.current = null; setDropAt(null); }}
              onDrop={(e) => { e.preventDefault(); e.stopPropagation(); drop(p.id); }}
            >
              <span className="num">{i + 1}</span>
              {renaming === p.id
                ? <RenameInput page={p} onDone={(t) => finishRename(p.id, t)} />
                : <span className="title" data-tip={p.title.length > 18 ? p.title : undefined}>{p.title}</span>}
              {here.length > 0 && (
                <span className="dots" data-tip={`${here.map((u) => u.name).join(', ')} ${here.length === 1 ? 'is' : 'are'} here`}>
                  {here.slice(0, 4).map((u) => <i key={u.sid} style={{ background: u.color }} />)}
                </span>
              )}
              <button
                type="button" className={`ibtn small more ${menu === p.id ? 'active' : ''}`} aria-label={`Options for ${p.title}`}
                ref={(el) => { moreBtns.current[p.id] = el; }}
                onClick={(e) => { e.stopPropagation(); setMenu(menu === p.id ? null : p.id); }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <Ellipsis size={17} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="sidebar-foot">
        <button type="button" className="btn small block" onClick={() => engine.addPage()}><Plus size={15} /> Add page</button>
      </div>

      {menuPage && (
        <Popover anchor={moreBtns.current[menuPage.id] ?? null} onClose={() => setMenu(null)} width={196}>
          <div className="menu">
            <button type="button" className="menu-item" onClick={() => { setMenu(null); setRenaming(menuPage.id); }}><Pencil size={16} />Rename</button>
            <button type="button" className="menu-item" onClick={() => { setMenu(null); engine.duplicatePage(menuPage.id); }}><Copy size={16} />Duplicate</button>
            <button type="button" className="menu-item" disabled={menuIndex <= 0} onClick={() => engine.reorderPage(menuPage.id, menuIndex - 1)}><ArrowUp size={16} />Move up</button>
            <button type="button" className="menu-item" disabled={menuIndex >= pages.length - 1} onClick={() => engine.reorderPage(menuPage.id, menuIndex + 1)}><ArrowDown size={16} />Move down</button>
            <div className="menu-sep" />
            <button type="button" className="menu-item danger" disabled={pages.length <= 1} onClick={() => { setMenu(null); setConfirm(menuPage); }}><Trash2 size={16} />Delete…</button>
          </div>
        </Popover>
      )}
      {confirm && (
        <Dialog
          title={`Delete “${confirm.title}”?`} onClose={() => setConfirm(null)} width={400}
          actions={<>
            <button type="button" className="btn" onClick={() => setConfirm(null)}>Cancel</button>
            <button type="button" className="btn danger solid" onClick={() => { engine.deletePage(confirm.id); setConfirm(null); }}>Delete page</button>
          </>}
        >
          <p>
            {confirm.count > 0
              ? `This page has ${confirm.count} item${confirm.count === 1 ? '' : 's'} on it. Deleting it removes them for everyone and cannot be undone.`
              : 'This page is empty. Deleting it removes it for everyone.'}
          </p>
        </Dialog>
      )}
    </aside>
  );
}

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { customAlphabet, nanoid } from 'nanoid';
import { ID_RE } from '../../../shared/types';
import { forgetCachedBoard } from '../engine/idb';
import { loadSettings } from '../engine/store';
import { Board } from './Board';
import { Trash2 } from 'lucide-react';
import { Dialog } from './common';
import { forgetBoard, loadRecent, ls, rememberBoard, type RecentBoard } from './util';

const KEYS = { name: 'mathboard.name', user: 'mathboard.userId', pass: 'mathboard.passcode' };
// no look-alike characters, so a code can be read out loud over Zoom
const newBoardId = customAlphabet('abcdefghjkmnpqrstuvwxyz23456789', 9);

const routeId = (): string | null => {
  const m = /^\/b\/([A-Za-z0-9_-]{1,64})\/?$/.exec(location.pathname);
  return m ? m[1] : null;
};

function getUserId(): string {
  let id = ls.get(KEYS.user);
  if (!id || !ID_RE.test(id)) {
    id = nanoid(16);
    ls.set(KEYS.user, id);
  }
  return id;
}

/** Accepts a bare code or a pasted share link. */
function parseCode(input: string): string | null {
  const s = input.trim();
  const m = /\/b\/([A-Za-z0-9_-]{1,64})/.exec(s);
  if (m) return m[1];
  return ID_RE.test(s) ? s : null;
}

/** Deletes a board from the start page. Resolves with an error message, or null when it is gone. */
async function deleteBoardRemote(id: string, passcode: string, by: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/boards/${encodeURIComponent(id)}/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-passcode': passcode }, body: JSON.stringify({ by }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return res.status === 401 ? 'Wrong passcode.' : body.error ?? 'The board could not be deleted.';
  } catch {
    return 'Could not reach the server. Is it running?';
  }
}

async function checkPasscode(passcode: string): Promise<boolean | null | 'wait'> {
  try {
    const res = await fetch('/api/passcode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode }) });
    if (res.status === 429) return 'wait';
    if (!res.ok) return null;
    return !!((await res.json()) as { ok?: boolean }).ok;
  } catch {
    return null;
  }
}

export function App() {
  const [boardId, setBoardId] = useState<string | null>(routeId);
  const [name, setName] = useState(() => (ls.get(KEYS.name) ?? '').trim().slice(0, 40));
  const [passcode, setPasscode] = useState(() => ls.get(KEYS.pass) ?? '');
  const [passcodeRequired, setPasscodeRequired] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [userId] = useState(getUserId);

  useEffect(() => {
    document.documentElement.dataset.theme = loadSettings().dark ? 'dark' : 'light';
    const onPop = () => setBoardId(routeId());
    window.addEventListener('popstate', onPop);
    let alive = true;
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((c: { passcodeRequired?: boolean }) => { if (alive) setPasscodeRequired(!!c.passcodeRequired); })
      .catch(() => { if (alive) setPasscodeRequired(false); });
    return () => { alive = false; window.removeEventListener('popstate', onPop); };
  }, []);

  const go = useCallback((id: string | null) => {
    const path = id ? `/b/${id}` : '/';
    if (location.pathname !== path) history.pushState(null, '', path);
    setBoardId(id);
  }, []);

  const inBoard = !!boardId && !!name && passcodeRequired !== null && (!passcodeRequired || !!passcode);

  useEffect(() => {
    // inside a board the title follows the board's name (see TitleSync in Board.tsx)
    if (!inBoard) document.title = 'MathBoard';
    else if (boardId) rememberBoard(boardId);
  }, [inBoard, boardId]);

  const onExit = useCallback(() => go(null), [go]);
  const onDeleted = useCallback((message: string) => {
    if (boardId) forgetBoard(boardId);
    setNotice(message);
    go(null);
  }, [boardId, go]);
  const onBadPasscode = useCallback(() => {
    ls.del(KEYS.pass);
    setPasscode('');
    setPasscodeRequired(true);
    setNotice('This server needs a passcode. Enter it to open the board.');
  }, []);

  if (passcodeRequired === null) {
    return <div className="landing"><div className="spinner" /></div>;
  }
  if (inBoard && boardId) {
    return <Board key={boardId} notebookId={boardId} name={name} userId={userId} passcode={passcode} onExit={onExit} onBadPasscode={onBadPasscode} onDeleted={onDeleted} />;
  }
  return (
    <Landing
      boardId={boardId} name={name} passcode={passcode} passcodeRequired={passcodeRequired} notice={notice}
      onEnter={(n, p, id) => {
        ls.set(KEYS.name, n);
        if (p) ls.set(KEYS.pass, p);
        setNotice(null);
        setName(n);
        setPasscode(p);
        go(id);
      }}
    />
  );
}

function Landing({ boardId, name: name0, passcode: pass0, passcodeRequired, notice, onEnter }: {
  boardId: string | null; name: string; passcode: string; passcodeRequired: boolean; notice: string | null;
  onEnter: (name: string, passcode: string, id: string) => void;
}) {
  const [name, setName] = useState(name0);
  const [pass, setPass] = useState(pass0);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState(loadRecent);
  const [toDelete, setToDelete] = useState<RecentBoard | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deletedMsg, setDeletedMsg] = useState<string | null>(null);

  const askDelete = (r: RecentBoard) => {
    if (passcodeRequired && !pass) { setError('Enter the passcode first, then delete the board.'); return; }
    setError(null);
    setDeleteError(null);
    setToDelete(r);
  };
  const confirmDelete = async () => {
    if (!toDelete) return;
    setDeleting(true);
    const err = await deleteBoardRemote(toDelete.id, passcodeRequired ? pass : '', name.trim().slice(0, 40));
    setDeleting(false);
    if (err) { setDeleteError(err); return; }
    forgetBoard(toDelete.id);
    void forgetCachedBoard(toDelete.id);
    setRecent(loadRecent());
    setDeletedMsg(`${toDelete.title ? `“${toDelete.title}”` : `Board ${toDelete.id}`} was deleted.`);
    setToDelete(null);
  };

  const enter = async (id: string | null) => {
    const n = name.trim().slice(0, 40);
    if (!n) { setError('Please enter your name first.'); return; }
    if (!id) { setError('That does not look like a board code or link.'); return; }
    if (passcodeRequired) {
      if (!pass) { setError('Please enter the passcode.'); return; }
      setBusy(true);
      const ok = await checkPasscode(pass);
      setBusy(false);
      if (ok === 'wait') { setError('Too many wrong passcodes were tried from this network. Wait a few minutes and try again.'); return; }
      if (ok === false) { setError('Wrong passcode.'); return; }
      if (ok === null) { setError('Could not reach the server. Is it running?'); return; }
    }
    setError(null);
    onEnter(n, passcodeRequired ? pass : '', id);
  };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    void enter(boardId ?? (code.trim() ? parseCode(code) : newBoardId()));
  };

  return (
    <div className="landing">
      <form className="card" onSubmit={submit}>
        <div className="brand">
          <div className="logo">
            <svg width="30" height="30" viewBox="0 0 64 64" aria-hidden><path d="M12 46c9-26 13-26 20-9s11 16 20-17" fill="none" stroke="#fff" strokeWidth="6.5" strokeLinecap="round" /></svg>
          </div>
          <div>
            <h1>MathBoard</h1>
            <p>A live pen whiteboard for teaching math together.</p>
          </div>
        </div>
        {notice && <div className="notice">{notice}</div>}
        {error && <div className="notice error" role="alert">{error}</div>}
        <label>
          Your name
          <input className="field" value={name} maxLength={40} autoFocus={!name} autoComplete="name" placeholder="e.g. Alex" onChange={(e) => setName(e.target.value)} />
        </label>
        {passcodeRequired && (
          <label>
            Passcode
            <input className="field" type="password" value={pass} maxLength={200} autoComplete="current-password" onChange={(e) => setPass(e.target.value)} />
          </label>
        )}
        {boardId ? (
          <>
            <button type="submit" className="btn primary block" disabled={busy}>Join board “{boardId}”</button>
            <button type="button" className="btn block" disabled={busy} onClick={() => void enter(newBoardId())}>Start a new board instead</button>
          </>
        ) : (
          <>
            <button type="button" className="btn primary block" disabled={busy} onClick={() => void enter(newBoardId())}>Create a new board</button>
            <div className="or">or join one</div>
            <div className="join-row">
              <input className="field" value={code} placeholder="Board code or link" aria-label="Board code or link" autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setCode(e.target.value)} />
              <button type="submit" className="btn" disabled={busy || !code.trim()}>Join</button>
            </div>
            {recent.length > 0 && (
              <div className="recent">
                <div className="recent-title">Recent boards on this device</div>
                {recent.map((r) => (
                  <div key={r.id} className="recent-row">
                    <button type="button" className="recent-open" disabled={busy} onClick={() => void enter(r.id)}>
                      <span className="recent-name">{r.title ? <strong>{r.title}</strong> : <em>Untitled</em>}<code>{r.id}</code></span>
                      <span>{new Date(r.t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                    </button>
                    <button
                      type="button" className="recent-delete" disabled={busy} onClick={() => askDelete(r)}
                      title={`Delete ${r.title ? `“${r.title}”` : r.id}`} aria-label={`Delete board ${r.title || r.id}`}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        {deletedMsg && <div className="notice" role="status">{deletedMsg}</div>}
      </form>
      {toDelete && (
        <Dialog
          title={toDelete.title ? `Delete “${toDelete.title}”?` : `Delete board ${toDelete.id}?`} onClose={deleting ? undefined : () => setToDelete(null)} width={420}
          actions={<>
            <button type="button" className="btn" disabled={deleting} onClick={() => setToDelete(null)}>Cancel</button>
            <button type="button" className="btn danger solid" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? 'Deleting…' : 'Delete board'}</button>
          </>}
        >
          <p>The board is deleted for everyone who has its link, with all its pages and images. Anyone who has it open now is sent back to the start page.</p>
          <p className="hint">If it was a mistake, the server keeps the board's files for 30 days, so it can still be recovered (see “Deleted boards” in the README).</p>
          {deleteError && <div className="notice error" role="alert">{deleteError}</div>}
        </Dialog>
      )}
    </div>
  );
}

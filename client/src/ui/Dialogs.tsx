import { useEffect, useRef, useState } from 'react';
import { importNotebookJson } from '../engine/exporter';
import { importPdfPages, openPdf, type OpenPdf } from '../engine/pdfImport';
import { defaultSettings } from '../engine/store';
import { Dialog, MOD, Segmented, Toggle, useEngine, useUI } from './common';

const SHORTCUTS: [string[], string][] = [
  [['P'], 'Pen (last used favorite)'],
  [['1', '…', '9'], 'Pen favorites 1–9'],
  [['H'], 'Highlighter'],
  [['E'], 'Eraser (press again: stroke ↔ partial)'],
  [['V', 'S'], 'Lasso select'],
  [['R'], 'Ruler on / off'],
  [['Shift', 'R'], 'Shapes'],
  [['L'], 'Laser pointer'],
  [['T'], 'Text'],
  [['G'], 'Graph'],
  [['[', ']'], 'Thinner / thicker'],
  [['F'], 'Focus mode'],
  [['Delete'], 'Delete selection'],
  [['Arrows'], 'Nudge selection (Shift: bigger steps)'],
  [[MOD, 'Z'], 'Undo'],
  [[MOD, 'Shift', 'Z'], `Redo (also ${MOD}+Y)`],
  [[MOD, 'C / X / V'], 'Copy / cut / paste'],
  [[MOD, 'D'], 'Duplicate selection'],
  [[MOD, 'A'], 'Select everything unlocked'],
  [[MOD, 'V'], 'Paste a screenshot or image'],
  [[MOD, '0'], 'Reset zoom to 100%'],
  [[MOD, '+ / −'], 'Zoom in / out'],
  [[MOD, 'wheel'], 'Zoom toward the cursor'],
  [['Space', 'drag'], 'Pan (also middle-drag)'],
  [['Shift', 'wheel'], 'Scroll sideways'],
  [['Alt', 'wheel'], 'Rotate the ruler (Shift: 5° steps)'],
  [['Shift'], 'While drawing: straight highlighter, 15° lines, squares, circles'],
  [['PageUp', 'PageDown'], 'Previous / next page'],
  [['Esc'], 'Cancel, deselect, leave focus mode'],
  [['?'], 'This list'],
];

export function Dialogs() {
  const engine = useEngine();
  const dialog = useUI((s) => s.dialog);
  const restore = useUI((s) => s.restore);
  const close = () => engine.ui.set({ dialog: null, pendingFile: null });

  if (restore) return <RestoreDialog reason={restore.reason} />;
  switch (dialog) {
    case 'shortcuts':
      return (
        <Dialog title="Keyboard shortcuts" onClose={close} width={520} actions={<button type="button" className="btn primary" onClick={close}>Done</button>}>
          <table className="shortcuts">
            <tbody>
              {SHORTCUTS.map(([keys, what]) => (
                <tr key={what}>
                  <td>{keys.map((k, i) => <span key={i}>{i > 0 && ' + '}<kbd>{k}</kbd></span>)}</td>
                  <td>{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">Pen hardware: the eraser end erases, and holding the barrel button while dragging lassos. Click a tool that is already selected to open its settings.</p>
        </Dialog>
      );
    case 'settings':
      return <SettingsDialog onClose={close} />;
    case 'clearPage':
      return (
        <Dialog
          title="Clear this page?" onClose={close} width={400}
          actions={<>
            <button type="button" className="btn" onClick={close}>Cancel</button>
            <button type="button" className="btn danger solid" onClick={() => { engine.clearPage(); close(); }}>Clear page</button>
          </>}
        >
          <p>Everything on this page is removed for everyone — ink, images, graphs and text. You can bring it back with Undo ({MOD}+Z).</p>
        </Dialog>
      );
    case 'clearMine':
      return (
        <Dialog
          title="Clear my ink on this page?" onClose={close} width={400}
          actions={<>
            <button type="button" className="btn" onClick={close}>Cancel</button>
            <button type="button" className="btn danger solid" onClick={() => { engine.clearMyInk(); close(); }}>Clear my ink</button>
          </>}
        >
          <p>Only the strokes and shapes you drew are removed. Other people's writing, images and graphs stay. You can bring it back with Undo ({MOD}+Z).</p>
        </Dialog>
      );
    case 'pdf':
      return <PdfDialog onClose={close} />;
    case 'importJson':
      return <ImportJsonDialog onClose={close} />;
    default:
      return null;
  }
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const st = useUI((s) => s.settings);
  const me = useUI((s) => s.me);
  return (
    <Dialog title="Settings" onClose={onClose} width={440} actions={<button type="button" className="btn primary" onClick={onClose}>Done</button>}>
      <Toggle label="Draw with finger" hint="For touch-only devices. Off: one finger pans, two fingers zoom, only the pen draws." checked={st.drawWithFinger} onChange={(drawWithFinger) => engine.setSettings({ drawWithFinger })} />
      <Toggle label="Lock pasted images" hint="Pasted and dropped images cannot be moved by accident. Unlock them with Select." checked={st.autoLockImages} onChange={(autoLockImages) => engine.setSettings({ autoLockImages })} />
      <Toggle label="Ink to shape" hint="A hand-drawn line, arrow, triangle, rectangle or circle becomes a clean shape." checked={st.inkToShape} onChange={(inkToShape) => engine.setSettings({ inkToShape })} />
      <Toggle label="Scribble to erase" hint="A fast back-and-forth scribble over ink erases it instead of drawing." checked={st.scribbleErase} onChange={(scribbleErase) => engine.setSettings({ scribbleErase })} />
      <Toggle label="Snap shapes and axes to the grid" hint="When the page has a grid, graph or dot background." checked={st.shape.snap} onChange={(snap) => engine.setSettings((s) => ({ shape: { ...s.shape, snap } }))} />
      <Toggle label="Dark mode" hint="Only for you. Black ink shows as white on a dark board." checked={st.dark} onChange={(dark) => engine.setSettings({ dark })} />
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="hint">Signed in as <strong>{me.name}</strong>. Change your name from the start screen (Menu → Leave board).</span>
      </div>
      <div className="row">
        <button
          type="button" className="btn small"
          onClick={() => { const d = defaultSettings(); engine.setSettings({ favs: d.favs, activeFav: 0, hl: d.hl }); engine.toast('Pens reset to the default set'); }}
        >
          Reset pens to defaults
        </button>
      </div>
    </Dialog>
  );
}

function RestoreDialog({ reason }: { reason: 'empty' | 'older' }) {
  const engine = useEngine();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title="Restore this board from this device?" width={440}
      actions={<>
        <button type="button" className="btn" disabled={busy} onClick={() => engine.declineRestore()}>No, keep the server's copy</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => { setBusy(true); void engine.restoreFromDevice().finally(() => setBusy(false)); }}>
          {busy ? 'Restoring…' : 'Restore'}
        </button>
      </>}
    >
      <p>
        {reason === 'empty'
          ? 'The server has no content for this board, but this device has a saved copy. This usually means the server was restarted and lost its files.'
          : 'This device has a newer copy of this board than the server. This usually means the server was restarted before it finished saving.'}
      </p>
      <p>Restoring uploads the copy from this device and makes it the board for everyone.</p>
    </Dialog>
  );
}

function ImportJsonDialog({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const file = useUI((s) => s.pendingFile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!file) return null;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await importNotebookJson(engine, file);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Restore from a backup?" onClose={busy ? undefined : onClose} width={440}
      actions={<>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="btn danger solid" disabled={busy} onClick={() => void run()}>{busy ? 'Restoring…' : 'Replace this board'}</button>
      </>}
    >
      <p>
        <strong>{file.name}</strong> will replace everything in this board — all pages — for everyone who has it open.
        Export a backup of the current board first if you might want it back.
      </p>
      {error && <div className="notice error" role="alert">{error}</div>}
    </Dialog>
  );
}

function PdfThumb({ pdf, pageNo }: { pdf: OpenPdf; pageNo: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    // render only when scrolled into view, so a 200-page PDF opens instantly
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      pdf.render(pageNo, 0.4, 220).then((r) => { if (!cancelled) setCanvas(r.canvas); }).catch(() => { /* placeholder stays */ });
    });
    io.observe(el);
    return () => { cancelled = true; io.disconnect(); };
  }, [pdf, pageNo]);
  // the canvas goes into its own slot that React never puts children in
  useEffect(() => {
    const el = slot.current;
    if (!el || !canvas) return;
    el.replaceChildren(canvas);
  }, [canvas]);
  return (
    <div ref={ref} style={{ width: '100%' }}>
      {!canvas && <div className="ph" />}
      <div ref={slot} style={{ display: 'flex' }} />
    </div>
  );
}

function PdfDialog({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const file = useUI((s) => s.pendingFile);
  const [pdf, setPdf] = useState<OpenPdf | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<'stack' | 'pages'>('stack');
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    if (!file) return;
    let alive = true;
    let opened: OpenPdf | null = null;
    openPdf(file).then((p) => {
      if (!alive) { p.destroy(); return; }
      opened = p;
      setPdf(p);
      setPicked(new Set(Array.from({ length: Math.min(p.numPages, 30) }, (_, i) => i + 1)));
    }).catch((err: unknown) => { if (alive) setError(`Could not open that PDF: ${(err as Error).message || 'unknown error'}`); });
    return () => { alive = false; opened?.destroy(); };
  }, [file]);

  if (!file) return null;
  const busy = progress !== null;
  const pages = [...picked].sort((a, b) => a - b);
  const toggle = (n: number) => setPicked((old) => { const next = new Set(old); if (next.has(n)) next.delete(n); else next.add(n); return next; });
  const run = async () => {
    if (!pdf || !pages.length) return;
    setProgress(0);
    try {
      const ok = await importPdfPages(engine, pdf, pages, mode, setProgress);
      engine.toast(ok === pages.length ? `Imported ${ok} page${ok === 1 ? '' : 's'} as locked images` : `Imported ${ok} of ${pages.length} pages`, ok === pages.length ? 'info' : 'error');
      if (mode === 'stack' && ok) engine.fitContent();
      onClose();
    } catch (err) {
      setError(`Import failed: ${(err as Error).message}`);
      setProgress(null);
    }
  };

  return (
    <Dialog
      title={`Import PDF — ${file.name}`} onClose={busy ? undefined : onClose} width={620}
      actions={<>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy || !pdf || !pages.length} onClick={() => void run()}>
          {busy ? `Importing ${progress} / ${pages.length}…` : `Import ${pages.length} page${pages.length === 1 ? '' : 's'}`}
        </button>
      </>}
    >
      {error && <div className="notice error" role="alert">{error}</div>}
      {!pdf && !error && <div className="row"><div className="spinner" /> Reading the PDF…</div>}
      {pdf && (
        <>
          <div className="pdf-tools">
            <span>{pdf.numPages} page{pdf.numPages === 1 ? '' : 's'} — click to choose</span>
            <span className="grow" />
            <button type="button" className="btn small" disabled={busy} onClick={() => setPicked(new Set(Array.from({ length: pdf.numPages }, (_, i) => i + 1)))}>All</button>
            <button type="button" className="btn small" disabled={busy} onClick={() => setPicked(new Set())}>None</button>
          </div>
          <div className="pdf-grid">
            {Array.from({ length: pdf.numPages }, (_, i) => i + 1).map((n) => (
              <button key={n} type="button" disabled={busy} className={`pdf-page ${picked.has(n) ? 'on' : ''}`} aria-pressed={picked.has(n)} onClick={() => toggle(n)}>
                <PdfThumb pdf={pdf} pageNo={n} />
                Page {n}
              </button>
            ))}
          </div>
          <Segmented
            value={mode}
            options={[{ value: 'stack', label: 'Stack on this page' }, { value: 'pages', label: 'One board page each' }]}
            onChange={(m) => { if (!busy) setMode(m); }}
          />
          {busy && <div className="progress"><div style={{ width: `${(100 * (progress ?? 0)) / Math.max(1, pages.length)}%` }} /></div>}
          <p className="hint">Each page is rendered at 2× and inserted as a locked image, so you can write straight on top of it.</p>
        </>
      )}
    </Dialog>
  );
}

import { useEffect, useRef, useState } from 'react';
import { DEFAULT_EXPORT, exportPagePng, exportPdf, importNotebookJson, type ExportOptions } from '../engine/exporter';
import { importPdfPages, openPdf, type OpenPdf } from '../engine/pdfImport';
import { defaultSettings } from '../engine/store';
import { Dialog, MOD, Section, Segmented, Toggle, useEngine, useUI } from './common';
import { ls } from './util';

const SHORTCUTS: [string[], string][] = [
  [['P'], 'Pen (last used favorite)'],
  [['1', '…', '9'], 'Pen favorites 1–9'],
  [['H'], 'Highlighter'],
  [['E'], 'Eraser (press again: stroke ↔ partial)'],
  [['V', 'S'], 'Lasso select'],
  [['R'], 'Ruler on / off'],
  [['Shift', 'P'], 'Protractor on / off'],
  [['Shift', 'R'], 'Shapes'],
  [['L'], 'Laser pointer (hold L: laser only while held)'],
  [['T'], 'Text'],
  [['G'], 'Graph'],
  [['A'], 'Axes (press again: x–y axes ↔ number line)'],
  [['K'], 'Tape'],
  [['I'], 'Insert / remove space'],
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
          <p className="hint">Touch: tap with two fingers to undo, with three fingers to redo.</p>
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
    case 'resetInk':
      return (
        <Dialog
          title="Clear the ink on this page?" onClose={close} width={420}
          actions={<>
            <button type="button" className="btn" onClick={close}>Cancel</button>
            <button type="button" className="btn danger solid" onClick={() => { engine.clearInk(); close(); }}>Clear ink</button>
          </>}
        >
          <p>Strokes and shapes that are not locked are removed for everyone. Images, graphs, axes, text and tape stay, so the page is ready for the next class.</p>
          <p>You can bring the ink back with Undo ({MOD}+Z).</p>
        </Dialog>
      );
    case 'resetInkAll':
    case 'coverAll':
      return <ResetNotebookDialog what={dialog === 'resetInkAll' ? 'ink' : 'tape'} onClose={close} />;
    case 'export':
      return <ExportDialog onClose={close} />;
    case 'pdf':
      return <PdfDialog onClose={close} />;
    case 'importJson':
      return <ImportJsonDialog onClose={close} />;
    default:
      return null;
  }
}

/** Notebook-wide reset. States how many pages are affected; the server keeps a backup first. */
function ResetNotebookDialog({ what, onClose }: { what: 'ink' | 'tape'; onClose: () => void }) {
  const engine = useEngine();
  const [busy, setBusy] = useState(false);
  const [stats] = useState(() => engine.resetStats());
  const pages = what === 'ink' ? stats.inkPages : stats.tapePages;
  const count = what === 'ink' ? stats.ink : stats.tape;
  const total = engine.nb.pages.length;
  const run = () => {
    setBusy(true);
    void engine.resetNotebook(what).finally(onClose);
  };
  return (
    <Dialog
      title={what === 'ink' ? 'Clear the ink in the whole notebook?' : 'Cover all tape in the notebook?'} onClose={busy ? undefined : onClose} width={440}
      actions={<>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className={`btn ${what === 'ink' ? 'danger solid' : 'primary'}`} disabled={busy || !pages} onClick={run}>
          {busy ? 'Working…' : what === 'ink' ? `Clear ink on ${pages} page${pages === 1 ? '' : 's'}` : `Cover tape on ${pages} page${pages === 1 ? '' : 's'}`}
        </button>
      </>}
    >
      {pages === 0 ? (
        <p>{what === 'ink' ? 'There is no ink to clear in this notebook.' : 'Every tape in this notebook is already covering its answer.'}</p>
      ) : what === 'ink' ? (
        <>
          <p><strong>{pages} of {total} page{total === 1 ? '' : 's'}</strong> will be affected: {count} stroke{count === 1 ? '' : 's'} and shape{count === 1 ? '' : 's'} that are not locked are removed for everyone.</p>
          <p>Images, graphs, axes, text and tape stay. The server keeps a backup copy of the notebook first, and each page can still be undone with {MOD}+Z while you are on it.</p>
        </>
      ) : (
        <>
          <p><strong>{pages} of {total} page{total === 1 ? '' : 's'}</strong> will be affected: {count} revealed tape{count === 1 ? '' : 's'} will cover {count === 1 ? 'its answer' : 'their answers'} again for everyone.</p>
          <p>The server keeps a backup copy of the notebook first.</p>
        </>
      )}
    </Dialog>
  );
}

const EXPORT_KEY = 'mathboard.export';
function loadExportOptions(): ExportOptions {
  try {
    const s = JSON.parse(ls.get(EXPORT_KEY) ?? '{}') as Partial<ExportOptions>;
    return {
      scope: s.scope === 'page' ? 'page' : 'notebook',
      paper: s.paper === 'letter' || s.paper === 'a4' ? s.paper : 'fit',
      tape: s.tape === 'reveal' ? 'reveal' : 'cover',
      background: s.background === 'page' ? 'page' : 'white',
    };
  } catch {
    return DEFAULT_EXPORT;
  }
}

function ExportDialog({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const kind = useUI((s) => s.exportKind);
  const pageCount = useUI((s) => s.pages.length);
  const [opts, setOpts] = useState(loadExportOptions);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<ExportOptions>) => setOpts((o) => ({ ...o, ...patch }));
  const run = async () => {
    setBusy(true);
    ls.set(EXPORT_KEY, JSON.stringify(opts));
    try {
      if (kind === 'png') await exportPagePng(engine, opts);
      else {
        const r = await exportPdf(engine, opts);
        if (r.sheets > r.pages) engine.toast(`PDF ready: ${r.pages} page${r.pages === 1 ? '' : 's'} on ${r.sheets} sheets`);
      }
      onClose();
    } catch (err) {
      engine.toast(`Export failed: ${(err as Error).message}`, 'error');
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={kind === 'png' ? 'Export this page as PNG' : 'Export as PDF'} onClose={busy ? undefined : onClose} width={460}
      actions={<>
        <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void run()}>{busy ? 'Exporting…' : 'Export'}</button>
      </>}
    >
      <div className="export-form">
        {kind === 'pdf' && (
          <>
            <Section title="Pages">
              <Segmented
                value={opts.scope} onChange={(scope) => set({ scope })}
                options={[{ value: 'page', label: 'This page' }, { value: 'notebook', label: `Whole notebook (${pageCount})` }]}
              />
            </Section>
            <Section title="Paper">
              <Segmented
                value={opts.paper} onChange={(paper) => set({ paper })}
                options={[{ value: 'fit', label: 'Fit to content' }, { value: 'letter', label: 'Letter' }, { value: 'a4', label: 'A4' }]}
              />
              <p className="hint">
                {opts.paper === 'fit'
                  ? 'Each board page becomes one PDF page, sized to what is on it.'
                  : 'Content is fitted inside the margins. A page much taller than one sheet continues on more sheets instead of being shrunk.'}
              </p>
            </Section>
          </>
        )}
        <Section title="Tape">
          <Segmented
            value={opts.tape} onChange={(tape) => set({ tape })}
            options={[{ value: 'cover', label: 'Keep answers covered' }, { value: 'reveal', label: 'Reveal everything' }]}
          />
          <p className="hint">{opts.tape === 'cover' ? 'Every tape hides what is under it.' : 'An answer-key copy: the tape is left out.'}</p>
        </Section>
        <Section title="Background">
          <Segmented
            value={opts.background} onChange={(background) => set({ background })}
            options={[{ value: 'white', label: 'Plain white' }, { value: 'page', label: 'Grid, lines or dots' }]}
          />
        </Section>
        {kind === 'pdf' && <p className="hint">Ink is exported as vector outlines, so it stays sharp when the PDF is zoomed in.</p>}
      </div>
    </Dialog>
  );
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const engine = useEngine();
  const st = useUI((s) => s.settings);
  const me = useUI((s) => s.me);
  const [name, setName] = useState(me.name);
  const saveName = () => {
    if (name.trim()) engine.rename(name); else setName(me.name);
  };
  return (
    <Dialog title="Settings" onClose={() => { saveName(); onClose(); }} width={440} actions={<button type="button" className="btn primary" onClick={() => { saveName(); onClose(); }}>Done</button>}>
      <label className="name-row">
        <span className="toggle-text">Your name<small>Shown on your chip and next to your cursor. Everyone sees a change straight away.</small></span>
        <input
          className="field" value={name} maxLength={40} aria-label="Your name" autoComplete="name"
          onChange={(e) => setName(e.target.value)} onBlur={saveName}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); }}
        />
      </label>
      <Toggle label="Draw with finger" hint="For touch-only devices. Off: one finger pans, two fingers zoom, only the pen draws." checked={st.drawWithFinger} onChange={(drawWithFinger) => engine.setSettings({ drawWithFinger })} />
      <Toggle label="Lock pasted images" hint="Pasted and dropped images cannot be moved by accident. Unlock them with Select." checked={st.autoLockImages} onChange={(autoLockImages) => engine.setSettings({ autoLockImages })} />
      <Toggle label="Ink to shape" hint="A hand-drawn line, arrow, triangle, rectangle or circle becomes a clean shape." checked={st.inkToShape} onChange={(inkToShape) => engine.setSettings({ inkToShape })} />
      <Toggle label="Scribble to erase" hint="A fast back-and-forth scribble over ink erases it instead of drawing." checked={st.scribbleErase} onChange={(scribbleErase) => engine.setSettings({ scribbleErase })} />
      <Toggle label="Snap shapes and axes to the grid" hint="When the page has a grid, graph or dot background." checked={st.shape.snap} onChange={(snap) => engine.setSettings((s) => ({ shape: { ...s.shape, snap } }))} />
      <Toggle label="Dark mode" hint="Only for you. Black ink shows as white on a dark board. Starts from your system setting." checked={st.dark} onChange={(dark) => engine.setSettings({ dark })} />
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

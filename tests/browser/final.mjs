// Parts B and C of the final round, in two (or three) browser windows on one board:
// board names, image placement, cross-board paste, shape styling, page-delete undo, renaming,
// shortcuts, export options, the toolbar at 1280×720, theme, manifest; then thumbnails, summon,
// reset, the shared timer, graph and axes upgrades, crop, touch gestures and hold-for-laser.
// Usage: start the app (npm start), then: BASE=http://localhost:3000 node tests/browser/final.mjs
// ONLY=toolbar takes just the 1280×720 toolbar screenshot (also works against an older build).
import os from 'node:os';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

/** The PDF's content streams, inflated. */
function pdfStreams(buf) {
  const out = [];
  const bin = buf.toString('latin1');
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(bin))) {
    const start = m.index + m[0].length;
    const end = bin.indexOf('endstream', start);
    if (end < 0) break;
    const raw = buf.subarray(start, end);
    try { out.push(inflateSync(raw).toString('latin1')); } catch { out.push(raw.toString('latin1')); }
    re.lastIndex = end;
  }
  return out;
}

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = process.env.SHOTS || path.join(os.tmpdir(), 'mathboard-shots');
const ONLY = process.env.ONLY || '';
mkdirSync(OUT, { recursive: true });
const board = 'fin' + Date.now().toString(36);
const log = (...a) => console.log(...a);
const errors = [];
let failures = 0;

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
const FAVS = Array.from({ length: 15 }, (_, i) => ({ id: 'f' + i, pen: ['ballpoint', 'fountain', 'pencil', 'marker', 'highlighter'][i % 5], color: ['ink', '#1971c2', '#e03131', '#2f9e44', '#ffe033'][i % 5], size: 2.5 + (i % 4), stab: 30 }));
async function user(name, opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, acceptDownloads: true, hasTouch: true, colorScheme: opts.scheme ?? 'light',
  });
  await ctx.addInitScript(({ n, favs }) => {
    if (!localStorage.getItem('mathboard.name')) localStorage.setItem('mathboard.name', n);
    if (favs && !localStorage.getItem('mathboard.settings.v1')) localStorage.setItem('mathboard.settings.v1', JSON.stringify({ favs, activeFav: 0 }));
  }, { n: name, favs: opts.favs ?? null });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`[${name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${name}] PAGEERROR ${e.stack || e.message}`));
  if (opts.goto !== false) {
    await page.goto(BASE + '/b/' + (opts.board ?? board));
    await page.waitForFunction(() => window.mathboard?.ui.get().ready);
  }
  return page;
}
const shot = (p, n) => p.screenshot({ path: path.join(OUT, n + '.png') });
const st = (p, fn, arg) => p.evaluate(fn, arg);
const objs = (p) => st(p, () => { const pg = window.mathboard.page; return pg.order.map((id) => pg.objects[id]); });
let current = [];
const only = process.env.STEPS ? process.env.STEPS.split(',') : null;
const step = async (name, fn) => {
  if (only && !only.some((p) => name.startsWith(p))) return;
  try { await fn(); log('OK  ', name); } catch (e) {
    failures++;
    log('FAIL', name, '-', String(e.message).split('\n')[0]);
    const at = String(e.stack).split('\n').find((l) => /final(-c)?\.mjs:\d+/.test(l));
    if (at) log('     at', at.trim().replace(/^.*[\\/]/, ''));
    const tag = name.split(' ')[0];
    for (const [i, p] of current.entries()) await shot(p, `fail-${tag}-${i}`).catch(() => {});
  }
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

/** Checks that nothing in the top bar overflows, wraps or is clipped, and takes a screenshot. */
async function toolbarCheck(p, name) {
  await p.waitForTimeout(400);
  await shot(p, name);
  return st(p, () => {
    const bar = document.querySelector('.topbar').getBoundingClientRect();
    const items = [...document.querySelectorAll('.topbar .toolbar > *, .topbar .toolbar .favs > *, .topbar .topright > *, .topbar .users > *')]
      .filter((el) => el.offsetParent !== null && !el.classList.contains('popover'));
    const bad = [];
    const tops = new Set();
    for (const el of items) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      tops.add(Math.round(r.top + r.height / 2));
      if (r.right > window.innerWidth + 0.5 || r.left < -0.5 || r.bottom > bar.bottom + 0.5) bad.push(`${el.className || el.tagName}@${Math.round(r.left)},${Math.round(r.top)}`);
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow === 'hidden') bad.push(`clipped ${el.className}`);
    }
    const centres = [...tops];
    const oneRow = Math.max(...centres) - Math.min(...centres) <= 6;
    return { height: Math.round(bar.height), oneRow, bad, count: items.length };
  });
}

if (ONLY === 'toolbar') {
  // three people on the board, 15 pens, the sidebar open
  const P = await user('Alexandra', { favs: FAVS, board: 'tb' + Date.now().toString(36) });
  const id = await st(P, () => window.mathboard.opts.notebookId);
  const Q = await user('Benjamin', { board: id }), R = await user('Christina', { board: id });
  await P.waitForFunction(() => window.mathboard.ui.get().users.length === 3);
  log('toolbar', JSON.stringify(await toolbarCheck(P, process.env.SHOT_NAME || 'toolbar-1280x720')));
  await browser.close();
  process.exit(0);
}

const A = await user('Alice', { favs: FAVS });
const B = await user('Bob');
current = [A, B];
await A.waitForFunction(() => window.mathboard.ui.get().users.length === 2);
const box = await A.locator('.board').boundingBox();
const X = (x) => box.x + x, Y = (y) => box.y + y;
const drag = async (p, pts, opts = {}) => {
  await p.mouse.move(X(pts[0][0]), Y(pts[0][1]));
  await p.mouse.down();
  for (const [x, y] of pts.slice(1)) await p.mouse.move(X(x), Y(y), { steps: opts.steps ?? 6 });
  if (opts.hold) await p.waitForTimeout(opts.hold);
  await p.mouse.up();
  await p.waitForTimeout(120);
};
/** Makes PNG files in the page and hands them to fn(files). */
const withImages = (p, sizes, fn) => st(p, async ({ sizes, fn }) => {
  const files = [];
  for (const [i, [w, h]] of sizes.entries()) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.fillStyle = ['#dde', '#ede', '#eed', '#dee'][i % 4]; x.fillRect(0, 0, w, h);
    x.fillStyle = '#234'; x.font = '40px sans-serif'; x.fillText('img ' + i, 20, 60);
    files.push(new File([await new Promise((r) => c.toBlob(r, 'image/png'))], `i${i}.png`, { type: 'image/png' }));
  }
  return new Function('files', fn)(files);
}, { sizes, fn });
const overlap = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;

// ======================= Part B =======================

await step('B10 toolbar at 1280×720: 15 pens, 3 people, sidebar open — nothing overflows or wraps', async () => {
  const C = await user('Carol');
  await A.waitForFunction(() => window.mathboard.ui.get().users.length === 3);
  // a long board name must not push the tools onto a second row either
  await st(A, () => window.mathboard.setTitle('Algebra 2 — Period 3 — Unit 4 review (systems of equations)'));
  await A.waitForFunction(() => window.mathboard.ui.get().title.startsWith('Algebra 2'));
  const r = await toolbarCheck(A, 'B10-toolbar-1280x720');
  log('   ', JSON.stringify(r));
  await C.context().close();
  expect(r.oneRow && !r.bad.length && r.height <= 56, JSON.stringify(r));
});

await step('B1 board name: edit in the top bar, live on the other side, tab title, recent list, reload', async () => {
  await A.click('.board-title');
  await A.fill('.popover input.field', 'Algebra 2 — Period 3');
  await A.keyboard.press('Enter');
  await B.waitForFunction(() => window.mathboard.ui.get().title === 'Algebra 2 — Period 3');
  expect((await B.title()).startsWith('Algebra 2 — Period 3'), 'tab title ' + (await B.title()));
  expect((await B.textContent('.board-title')).includes('Algebra 2'), 'top bar');
  const recent = await st(B, () => JSON.parse(localStorage.getItem('mathboard.recent')));
  expect(recent[0].title === 'Algebra 2 — Period 3', 'recent ' + JSON.stringify(recent));
  // the landing page shows it next to the code
  const L = await B.context().newPage();
  await L.goto(BASE + '/');
  await L.waitForSelector('.recent button');
  expect((await L.textContent('.recent button')).includes('Algebra 2'), 'landing');
  await shot(L, 'B1-landing-recent');
  await L.close();
  await shot(A, 'B1-title');
});

await step('B2 dropped images land at the drop point, several never cover each other; paste inserts every image', async () => {
  const before = (await objs(A)).length;
  await withImages(A, [[800, 500], [600, 600], [500, 900]], `
    const el = document.querySelector('canvas.layer-live'), r = el.getBoundingClientRect();
    const dt = new DataTransfer(); for (const f of files) dt.items.add(f);
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 300, clientY: r.top + 260 }));`);
  await B.waitForFunction((n) => window.mathboard.page.order.length === n + 3, before, { timeout: 15000 });
  const imgs = (await objs(B)).filter((o) => o.type === 'image');
  for (let i = 0; i < imgs.length; i++) for (let j = i + 1; j < imgs.length; j++) expect(!overlap(imgs[i], imgs[j]), 'images overlap');
  const [wx, wy] = await st(A, () => window.mathboard.toWorld(300, 260));
  const minX = Math.min(...imgs.map((o) => o.x)), maxX = Math.max(...imgs.map((o) => o.x + o.w));
  const minY = Math.min(...imgs.map((o) => o.y)), maxY = Math.max(...imgs.map((o) => o.y + o.h));
  expect(Math.abs((minX + maxX) / 2 - wx) < 2 && Math.abs((minY + maxY) / 2 - wy) < 2, 'not centred on the drop point');
  await withImages(A, [[400, 300], [300, 400]], `
    const dt = new DataTransfer(); for (const f of files) dt.items.add(f);
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));`);
  await B.waitForFunction((n) => window.mathboard.page.order.length === n + 5, before, { timeout: 15000 });
  await shot(B, 'B2-images-B');
  // clean up for the next steps
  await st(A, () => { const e = window.mathboard; e.commit(e.page.order.filter((id) => e.page.objects[id].type === 'image').map((id) => ({ kind: 'delete', id }))); });
});

await step('B3 copy and paste across tabs and boards (ink and images)', async () => {
  await A.keyboard.press('1');
  await drag(A, [[200, 400], [260, 440], [320, 400]]);
  await withImages(A, [[300, 200]], `return window.mathboard.insertImage(files[0], { locked: false, rect: { x: 400, y: 300, w: 300, h: 200 } });`);
  await A.waitForFunction(() => window.mathboard.page.order.length >= 2);
  await A.keyboard.press('Control+a');
  const text = await st(A, () => { const dt = new DataTransfer(); document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true })); return dt.getData('text/plain'); });
  expect(text.startsWith('mathboard-clip:{'), 'clipboard holds the objects');
  await A.keyboard.press('Escape');
  const other = 'fin2' + Date.now().toString(36);
  const C = await user('Alice', { board: other });
  await st(C, (t) => { const dt = new DataTransfer(); dt.setData('text/plain', t); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, text);
  await C.waitForFunction(() => window.mathboard.page.order.length === 2, null, { timeout: 15000 });
  const pasted = await objs(C);
  const img = pasted.find((o) => o.type === 'image');
  expect(img && img.src.startsWith(`/uploads/${other}/`), 'image copied into the other board: ' + img?.src);
  expect(pasted.some((o) => o.type === 'stroke'), 'stroke pasted');
  await C.waitForFunction(() => { const o = window.mathboard.page.order.map((id) => window.mathboard.page.objects[id]).find((x) => x.type === 'image'); return window.mathboard.images.state(o.src) === 'ready'; });
  await shot(C, 'B3-pasted-other-board');
  // junk on the clipboard is refused politely
  await st(C, () => { const dt = new DataTransfer(); dt.setData('text/plain', 'mathboard-clip:{"v":1,"token":"x","board":"y","objs":[{"type":"shape","points":[]}]}'); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
  await C.waitForTimeout(300);
  expect((await objs(C)).length === 2, 'invalid paste added something');
  await C.context().close();
  await st(A, () => { const e = window.mathboard; e.commit(e.page.order.map((id) => ({ kind: 'delete', id }))); });
});

await step('B4 edit a shape after drawing it: dashed, fill colour, fill opacity (one undo step per drag)', async () => {
  await A.keyboard.press('Shift+R');
  await A.click('.toolbar .ibtn.active[aria-label^="Shapes"]');
  await A.click('.popover .shape-grid button[title="Rectangle"]');
  await A.keyboard.press('Escape');
  await drag(A, [[300, 200], [520, 340]]);
  await A.keyboard.press('v');
  // click its left edge (the corners snap to the grid, so ask where it ended up)
  const [ex, ey] = await st(A, () => { const e = window.mathboard; const o = e.page.objects[e.page.order.at(-1)]; return e.toScreen(o.points[0], (o.points[1] + o.points[3]) / 2); });
  await A.mouse.click(X(ex), Y(ey));
  await A.waitForSelector('.selbar');
  await A.click('.selbar .ibtn[aria-label^="Thickness, dashes and fill"]');
  await A.waitForSelector('.popover .toggle');
  await shot(A, 'B4-shape-popover');
  await A.click('.popover .toggle:has-text("Dashed line")');
  await A.click('.popover .section:has-text("Fill") .swatch[title="#1971c2"]');
  const sh = () => st(B, () => window.mathboard.page.objects[window.mathboard.page.order.at(-1)]);
  await B.waitForFunction(() => { const o = window.mathboard.page.objects[window.mathboard.page.order.at(-1)]; return o.dashed && o.fill === '#1971c2'; });
  // drag the opacity slider: many commits, one undo step
  const slider = A.locator('.popover .section:has-text("Fill") input[type=range]');
  const sb = await slider.boundingBox();
  await A.mouse.move(sb.x + sb.width * 0.2, sb.y + sb.height / 2); await A.mouse.down();
  for (let i = 3; i <= 9; i++) await A.mouse.move(sb.x + sb.width * i / 10, sb.y + sb.height / 2);
  await A.mouse.up();
  await A.waitForTimeout(150);
  const o = await sh();
  expect(o.fillOpacity > 0.8, 'opacity on B ' + o.fillOpacity);
  await A.keyboard.press('Escape');
  await A.keyboard.press('Escape');
  await A.keyboard.press('Control+z');
  await A.waitForTimeout(150);
  const u = await sh();
  expect(Math.abs(u.fillOpacity - 0.25) < 1e-9 && u.fill === '#1971c2', 'one undo should restore the opacity before the drag: ' + u.fillOpacity);
  await A.keyboard.press('Control+z'); await A.keyboard.press('Control+z');
  await A.waitForTimeout(150);
  const v = await sh();
  expect(!v.dashed && !v.fill, 'undo all styling');
});

await step('B5 deleting a page shows Undo; Undo restores it with its content at its old position, for everyone', async () => {
  await A.click('.sidebar-foot button');
  await A.waitForFunction(() => window.mathboard.nb.pages.length === 2);
  await A.keyboard.press('1');
  await drag(A, [[300, 300], [400, 360], [500, 300]]);
  await A.click('.sidebar-foot button'); // a third, empty page after it
  await B.waitForFunction(() => window.mathboard.nb.pages.length === 3);
  const ids = await st(A, () => window.mathboard.nb.pages.map((p) => p.id));
  // empty page: deleted at once, no dialog
  await A.hover('.page-row:nth-child(3)');
  await A.click('.page-row:nth-child(3) .more');
  await A.click('.popover .menu-item:has-text("Delete")');
  await B.waitForFunction(() => window.mathboard.nb.pages.length === 2);
  expect(!(await A.$('.dialog')), 'no confirm for an empty page');
  await A.waitForTimeout(100);
  // page with content: confirm, then Undo
  await A.click('.page-row:nth-child(2) .more');
  await A.click('.popover .menu-item:has-text("Delete")');
  await A.waitForSelector('.dialog:has-text("Undo")');
  await shot(A, 'B5-confirm');
  await A.click('.dialog-actions .btn.danger');
  await B.waitForFunction(() => window.mathboard.nb.pages.length === 1);
  await A.waitForSelector('.toast .toast-action');
  await shot(A, 'B5-undo-toast');
  // two toasts are up (the empty page went first): undo the one for Page 2
  await A.click('.toast:has-text("Page 2") .toast-action');
  await B.waitForFunction((id) => window.mathboard.nb.pages[1]?.id === id && window.mathboard.nb.pages[1].order.length === 1, ids[1]);
  // and it is saved: survives a reload
  await A.waitForFunction(() => !window.mathboard.ui.get().saving, null, { timeout: 8000 });
  await B.reload();
  await B.waitForFunction(() => window.mathboard?.ui.get().ready);
  expect(await st(B, (id) => window.mathboard.nb.pages[1]?.id === id, ids[1]), 'restored page not saved');
  await st(A, () => window.mathboard.gotoPage(window.mathboard.nb.pages[0].id));
});

await step('B6 change my name in Settings: chips and my cursor label update live', async () => {
  await A.click('.topright .ibtn[aria-label="Menu"]');
  await A.click('.menu-item:has-text("Settings")');
  await A.fill('.dialog input[aria-label="Your name"]', 'Alice Smith');
  await A.click('.dialog-actions .btn.primary');
  await B.waitForFunction(() => window.mathboard.ui.get().users.some((u) => u.name === 'Alice Smith'));
  await A.mouse.move(X(600), Y(300)); await A.mouse.move(X(620), Y(320));
  await B.waitForFunction(() => window.mathboard.cursors.size > 0);
  await shot(B, 'B6-renamed-B');
  expect(await st(A, () => localStorage.getItem('mathboard.name')) === 'Alice Smith', 'remembered');
});

await step('B7 focus mode has the laser', async () => {
  await A.keyboard.press('f');
  await A.waitForSelector('.focusbar');
  await A.click('.focusbar .ibtn[aria-label^="Laser"]');
  expect(await st(A, () => window.mathboard.ui.get().tool) === 'laser', 'laser not selected');
  await shot(A, 'B7-focus-laser');
  await A.keyboard.press('f');
});

await step('B8 shortcuts: K tape, A axes (again: number line), I insert space, Shift+P protractor', async () => {
  const tool = () => st(A, () => window.mathboard.ui.get().tool);
  await A.keyboard.press('k'); expect(await tool() === 'tape', 'K');
  await A.keyboard.press('a'); expect(await tool() === 'axes', 'A');
  await A.keyboard.press('a'); expect(await st(A, () => window.mathboard.settings.axes.mode) === 'numberLine', 'A again');
  await A.keyboard.press('a');
  await A.keyboard.press('i'); expect(await tool() === 'space', 'I');
  await A.keyboard.press('Shift+P');
  expect(await st(A, () => { const r = window.mathboard.ui.get().ruler; return r.visible && r.kind === 'protractor'; }), 'Shift+P');
  await A.keyboard.press('Shift+P');
  await A.keyboard.press('?');
  await A.waitForSelector('.dialog .shortcuts');
  const text = await A.textContent('.dialog .shortcuts');
  expect(['Tape', 'Insert / remove space', 'Protractor', 'Axes'].every((s) => text.includes(s)), 'overlay lists the new keys');
  await A.keyboard.press('Escape');
  const tips = await st(A, () => [...document.querySelectorAll('.toolbar [data-tip]')].map((e) => e.getAttribute('data-tip')).join(' | '));
  expect(/\(I\)/.test(tips) && /\(K\)/.test(tips) && /Shift\+P/.test(tips) && /\(A\)/.test(tips), 'tooltips: ' + tips);
});

await step('B9 export dialog: page / notebook, Letter / A4 / fit, tape covered / revealed, background', async () => {
  await A.keyboard.press('1');
  // a tall page: 30 lines of writing down the board
  await st(A, () => {
    const e = window.mathboard, ops = [];
    for (let i = 0; i < 30; i++) {
      const pts = [];
      for (let k = 0; k < 30; k++) pts.push(100 + k * 12, 100 + i * 140 + Math.sin(k / 2) * 14, 0.5);
      ops.push({ kind: 'add', obj: { id: 'tall' + i, type: 'stroke', authorId: 'x', createdAt: Date.now(), pen: 'ballpoint', color: 'ink', size: 3, opacity: 1, points: pts, bbox: [0, 0, 0, 0], stab: 30 } });
    }
    ops.push({ kind: 'add', obj: { id: 'tp', type: 'tape', authorId: 'x', createdAt: Date.now(), x: 90, y: 90, w: 400, h: 60, color: '#f6c453', revealed: false } });
    e.commit(ops);
  });
  const run = async (choices) => {
    await A.click('.topright .ibtn[aria-label="Menu"]');
    await A.click('.menu-item:has-text("Export as PDF")');
    await A.waitForSelector('.dialog .export-form');
    for (const c of choices) await A.click(`.dialog .segmented button:has-text("${c}")`);
    const [dl] = await Promise.all([A.waitForEvent('download', { timeout: 30000 }), A.click('.dialog-actions .btn.primary')]);
    const f = path.join(OUT, dl.suggestedFilename().replace(/[^\w.() -]+/g, '_'));
    await dl.saveAs(f);
    const buf = readFileSync(f);
    return { name: dl.suggestedFilename(), pdf: buf.toString('latin1'), streams: pdfStreams(buf) };
  };
  await A.click('.topright .ibtn[aria-label="Menu"]');
  await A.click('.menu-item:has-text("Export as PDF")');
  await shot(A, 'B9-export-dialog');
  await A.click('.dialog-actions .btn:has-text("Cancel")');
  const letter = await run(['This page', 'Letter', 'Reveal everything', 'Grid, lines or dots']);
  const pages = (letter.pdf.match(/\/Type \/Page\b/g) || []).length;
  const box612 = letter.pdf.includes('/MediaBox [0 0 612. 792.]') || /MediaBox \[0 0 612(\.0+)? 792(\.0+)?\]/.test(letter.pdf);
  log('   letter:', letter.name, 'sheets', pages, 'letter-size', box612);
  expect(pages > 1 && box612, 'tall page should split across Letter sheets');
  expect(letter.name.includes('Algebra 2') && letter.name.includes('answer key'), 'file name ' + letter.name);
  // vector ink: path operators, and no picture per stroke
  const ops = letter.streams.join('\n');
  const curves = (ops.match(/ c\n/g) || []).length, images = (letter.pdf.match(/\/Subtype \/Image/g) || []).length;
  log('   vector curve segments', curves, 'embedded images', images);
  expect(curves >= 30 * 8 && images === 0, 'ink should be vector paths, not pictures');
  const a4 = await run(['Whole notebook', 'A4', 'Keep answers covered', 'Plain white']);
  expect(/MediaBox \[0 0 595\.2/.test(a4.pdf), 'A4 size');
  const fit = await run(['Whole notebook', 'Fit to content']);
  log('   a4:', a4.name, ' fit:', fit.name);
  // PNG gets tape and background options too
  await A.click('.topright .ibtn[aria-label="Menu"]');
  await A.click('.menu-item:has-text("Export this page as PNG")');
  expect(!(await A.$('.dialog .segmented button:has-text("Letter")')), 'PNG has no paper choice');
  await A.click('.dialog .segmented button:has-text("Reveal everything")');
  const [dl] = await Promise.all([A.waitForEvent('download'), A.click('.dialog-actions .btn.primary')]);
  expect(dl.suggestedFilename().endsWith('.png'), 'png');
  await st(A, () => { const e = window.mathboard; e.commit(e.page.order.filter((id) => id.startsWith('tall') || id === 'tp').map((id) => ({ kind: 'delete', id }))); });
});

await step('B11 first visit follows the system theme', async () => {
  const D = await user('Dee', { scheme: 'dark', goto: false });
  await D.goto(BASE + '/');
  await D.waitForSelector('.card');
  expect(await st(D, () => document.documentElement.dataset.theme) === 'dark', 'dark scheme → dark');
  await shot(D, 'B11-dark-landing');
  const L = await user('Lee', { scheme: 'light', goto: false });
  await L.goto(BASE + '/');
  expect(await st(L, () => document.documentElement.dataset.theme) === 'light', 'light scheme → light');
  await D.context().close(); await L.context().close();
});

await step('B12 manifest, icons and Apple tags are served', async () => {
  const r = await st(A, async () => {
    const m = await fetch('/manifest.webmanifest');
    const json = await m.json();
    const icons = await Promise.all(json.icons.map((i) => fetch(i.src).then((x) => x.status + ' ' + x.headers.get('content-type'))));
    const apple = await fetch(document.querySelector('link[rel=apple-touch-icon]').href);
    return { type: m.headers.get('content-type'), name: json.name, icons, apple: apple.status };
  });
  log('   ', JSON.stringify(r));
  expect(/manifest\+json|json/.test(r.type) && r.icons.every((s) => s.startsWith('200 image/png')) && r.apple === 200, JSON.stringify(r));
});


// ======================= Part C =======================

const clearPage = (p) => st(p, () => { const e = window.mathboard; e.commit(e.page.order.map((id) => ({ kind: 'delete', id }))); });
const firstPage = (p) => st(p, () => window.mathboard.gotoPage(window.mathboard.nb.pages[0].id));
/** both windows on page 1 at 100 %, nothing selected, no menus */
const fresh = async () => {
  for (const p of [A, B]) {
    await p.keyboard.press('Escape');
    await st(p, () => { const e = window.mathboard; e.gotoPage(e.nb.pages[0].id); e.setSelection([]); e.ui.set({ dialog: null, popover: null }); e.fitRect([0, 0, 900, 560], 0, 1); });
  }
  // no countdown left over from an earlier step
  if (await st(A, () => !!window.mathboard.ui.get().timer)) {
    await st(A, () => window.mathboard.timer({ action: 'dismiss' }));
    await B.waitForFunction(() => !window.mathboard.ui.get().timer);
  }
};
/** frame times while drawing for `ms`: several strokes, lifting the pen in between */
async function frameTrace(p, ms) {
  await st(p, () => {
    window.__ft = { last: 0, d: [], long: 0, on: true, thumb0: window.mathboard.thumbs.workMs };
    const tick = (t) => { const f = window.__ft; if (!f.on) return; if (f.last) f.d.push(t - f.last); f.last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    try { new PerformanceObserver((l) => { window.__ft.long += l.getEntries().length; }).observe({ type: 'longtask' }); } catch { /* not supported */ }
  });
  const t0 = Date.now();
  let k = 0;
  while (Date.now() - t0 < ms) {
    const y = 120 + (k % 8) * 50;
    await p.mouse.move(X(150), Y(y)); await p.mouse.down();
    for (let i = 1; i <= 30; i++) await p.mouse.move(X(150 + i * 14), Y(y + Math.sin(i / 3) * 18));
    await p.mouse.up();
    // pen lifted: this is when the thumbnail work is allowed to run
    await p.waitForTimeout(k % 3 === 2 ? 1100 : 250);
    k++;
  }
  return st(p, () => {
    const f = window.__ft; f.on = false;
    const d = [...f.d].sort((a, b) => a - b);
    const q = (x) => d[Math.min(d.length - 1, Math.floor(d.length * x))];
    return { frames: d.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), p99: +q(0.99).toFixed(1), max: +d[d.length - 1].toFixed(1), over50: d.filter((x) => x > 50).length, longTasks: f.long, thumbMs: Math.round(window.mathboard.thumbs.workMs - f.thumb0) };
  });
}

/** Exports the current page as PNG through the menu and returns the image's size. */
async function exportPngSize(p) {
  await p.click('.topright .ibtn[aria-label="Menu"]');
  await p.click('.menu-item:has-text("Export this page as PNG")');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('.dialog-actions .btn.primary')]);
  const buf = readFileSync(await dl.path());
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

await step('C1 page thumbnails: every row shows its page, they follow edits on both sides', async () => {
  await firstPage(A); await firstPage(B);
  // start from one empty page
  await st(A, () => { const e = window.mathboard; for (const p of e.nb.pages.slice(1)) e.deletePage(p.id); });
  await B.waitForFunction(() => window.mathboard.nb.pages.length === 1);
  await clearPage(A);
  await A.keyboard.press('1');
  await drag(A, [[200, 200], [300, 260], [400, 200], [500, 260]]);
  await A.click('.sidebar-foot button');
  await A.waitForFunction(() => window.mathboard.nb.pages.length === 2);
  await B.waitForFunction(() => document.querySelectorAll('.page-row .page-thumb.ready').length === 2, null, { timeout: 8000 });
  // the page number, title, presence dots and menu are all still there
  const row = await st(B, () => { const r = document.querySelector('.page-row'); return { num: !!r.querySelector('.num'), title: !!r.querySelector('.title'), more: !!r.querySelector('.more'), dots: document.querySelectorAll('.page-row .dots').length }; });
  expect(row.num && row.title && row.more && row.dots === 1, JSON.stringify(row));
  const inked = (p, n) => st(p, (n) => {
    const c = document.querySelectorAll('.page-row .page-thumb')[n];
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let blue = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 2] - d[i] > 50) blue++;
    return blue;
  }, n);
  await A.keyboard.press('2'); // a blue pen
  await A.click('.page-row:nth-child(2)');
  const before = await inked(B, 1);
  await drag(A, [[200, 300], [350, 360], [500, 300]]);
  await B.waitForFunction((b) => { const c = document.querySelectorAll('.page-row .page-thumb')[1]; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 2] - d[i] > 50) n++; return n > b + 10; }, before, { timeout: 8000 });
  await shot(B, 'C1-thumbnails-B');
  await firstPage(A);
});

await step('C1 frame trace: drawing on a 5,000-stroke page with the sidebar open', async () => {
  const pid = await st(A, () => window.mathboard.addPage('Heavy page'));
  await st(A, ({ pid }) => {
    const e = window.mathboard;
    for (let c = 0; c < 10; c++) {
      const bodies = [];
      for (let i = 0; i < 500; i++) {
        const n = c * 500 + i, x = (n % 50) * 22, y = Math.floor(n / 50) * 7;
        bodies.push({ kind: 'add', obj: { id: 'hv' + n, type: 'stroke', authorId: 'test', createdAt: 1, pen: 'ballpoint', color: '#1971c2', size: 2, opacity: 1, points: [x, y, 0.5, x + 8, y + 3, 0.5, x + 16, y, 0.5, x + 20, y + 2, 0.5], bbox: [x, y, x + 20, y + 3] } });
      }
      e.commit(bodies, { pageId: pid, undo: false });
    }
  }, { pid });
  await A.waitForFunction(() => window.mathboard.page.order.length === 5000);
  await A.waitForFunction(() => document.querySelectorAll('.page-row .page-thumb.ready').length === window.mathboard.nb.pages.length, null, { timeout: 15000 });
  await A.keyboard.press('1');
  await st(A, () => window.mathboard.setSettings({ sidebar: false }));
  await A.waitForTimeout(800);
  const closed = await frameTrace(A, 6000);
  log('    sidebar closed', JSON.stringify(closed));
  await st(A, () => window.mathboard.setSettings({ sidebar: true }));
  await A.waitForTimeout(800);
  const open = await frameTrace(A, 6000);
  log('    sidebar open  ', JSON.stringify(open));
  await st(A, (pid) => window.mathboard.deletePage(pid), pid);
  await A.waitForTimeout(200);
  expect(open.thumbMs > 0, 'thumbnails were never redrawn while drawing');
  // the thumbnail work must not show up as stutter: no worse than the same drawing without the sidebar
  expect(open.p95 <= closed.p95 * 1.5 + 4 && open.over50 <= closed.over50 + 3, 'thumbnails make drawing stutter');
});

await step('C2 bring everyone here: once, with a toast, never in the middle of a stroke', async () => {
  await fresh();
  await st(B, () => window.mathboard.gotoPage(window.mathboard.nb.pages[1].id));
  await st(A, () => { const e = window.mathboard; e.fitRect([100, 100, 500, 400], 0, 8); });
  // B is writing when the summons arrives
  await B.keyboard.press('1');
  await B.mouse.move(X(200), Y(500)); await B.mouse.down();
  await B.mouse.move(X(260), Y(520), { steps: 4 });
  await A.click('.users .summon');
  await B.waitForTimeout(400);
  expect(await st(B, () => window.mathboard.pageId === window.mathboard.nb.pages[1].id), 'B was moved while the pen was down');
  await B.mouse.move(X(330), Y(500), { steps: 4 });
  await B.mouse.up();
  await B.waitForFunction(() => window.mathboard.pageId === window.mathboard.nb.pages[0].id, null, { timeout: 3000 });
  expect(await st(B, () => window.mathboard.nb.pages[1].order.length) >= 2, 'B\'s stroke was not finished on page 2');
  const za = await st(A, () => window.mathboard.cam.zoom), zb = await st(B, () => window.mathboard.cam.zoom);
  expect(Math.abs(za - zb) / za < 0.05, `zoom ${za} vs ${zb}`);
  await B.waitForSelector('.toast:has-text("brought you to page 1")');
  expect(!(await st(B, () => window.mathboard.ui.get().following)), 'summon must not start a lasting follow');
  await shot(B, 'C2-summoned-B');
  await st(A, () => window.mathboard.fitRect([0, 0, 1200, 700], 0, 1));
});

await step('C3 reset for the next class: clear ink (page, undoable), cover tape, notebook-wide with a backup', async () => {
  await fresh();
  await clearPage(A);
  await st(A, () => {
    const e = window.mathboard;
    e.commit([
      { kind: 'add', obj: { id: 'ink1', type: 'stroke', authorId: 'a', createdAt: 1, pen: 'ballpoint', color: '#000', size: 3, opacity: 1, points: [100, 100, 0.5, 200, 120, 0.5], bbox: [100, 100, 200, 120] } },
      { kind: 'add', obj: { id: 'ink2', type: 'stroke', authorId: 'a', createdAt: 1, pen: 'ballpoint', color: '#000', size: 3, opacity: 1, points: [100, 200, 0.5, 200, 220, 0.5], bbox: [100, 200, 200, 220], locked: true } },
      { kind: 'add', obj: { id: 'txt1', type: 'text', authorId: 'a', createdAt: 1, text: 'Solve for x', x: 300, y: 100, fontSize: 24, color: 'ink' } },
      { kind: 'add', obj: { id: 'tp1', type: 'tape', authorId: 'a', createdAt: 1, x: 300, y: 200, w: 200, h: 60, color: '#ffd43b', revealed: true } },
    ]);
    // ink on the second page too, for the notebook-wide reset
    e.commit([{ kind: 'add', obj: { id: 'ink3', type: 'stroke', authorId: 'a', createdAt: 1, pen: 'ballpoint', color: '#000', size: 3, opacity: 1, points: [100, 100, 0.5, 200, 120, 0.5], bbox: [100, 100, 200, 120] } }], { pageId: e.nb.pages[1].id });
  });
  await A.click('.topright .ibtn[aria-label="Menu"]');
  await A.click('.menu-item:has-text("Clear ink, keep everything else")');
  await A.click('.dialog-actions .btn.danger');
  await B.waitForFunction(() => { const o = window.mathboard.page.objects; return !o.ink1 && o.ink2 && o.txt1 && o.tp1; });
  await A.keyboard.press('Control+z');
  await B.waitForFunction(() => !!window.mathboard.page.objects.ink1);
  // cover the tape again, from the eraser popover
  await A.keyboard.press('e');
  await A.click('.toolbar .ibtn.active[aria-label^="Eraser"]');
  await A.click('.popover .btn:has-text("Cover all tape again")');
  await B.waitForFunction(() => window.mathboard.page.objects.tp1.revealed === false);
  await A.keyboard.press('Control+z');
  await B.waitForFunction(() => window.mathboard.page.objects.tp1.revealed === true);
  // the whole notebook: the confirm says how many pages, and the server keeps a backup first
  await A.keyboard.press('1');
  await A.click('.topright .ibtn[aria-label="Menu"]');
  await A.click('.menu-item:has-text("Clear ink in the whole notebook")');
  const text = await A.textContent('.dialog');
  expect(/2 of 2 pages/.test(text) && /Clear ink on 2 pages/.test(text), 'confirm text: ' + text);
  await shot(A, 'C3-confirm-notebook');
  await A.click('.dialog-actions .btn.danger');
  await B.waitForFunction(() => { const e = window.mathboard, p2 = e.nb.pages[1]; return !e.page.objects.ink1 && e.page.objects.ink2 && !p2.order.some((id) => p2.objects[id].type === 'stroke'); });
  await A.waitForSelector('.toast:has-text("backup")');
  const dataDir = process.env.DATA_DIR;
  if (dataDir && existsSync(dataDir)) {
    const backups = readdirSync(dataDir).filter((n) => n.startsWith(board + '.backup-'));
    expect(backups.length >= 1, 'no backup file in ' + dataDir);
    log('    backup', backups.at(-1));
  }
  await A.click('.topright .ibtn[aria-label="Menu"]');
  await A.click('.menu-item:has-text("Cover all tape in the notebook")');
  await A.click('.dialog-actions .btn.primary');
  await B.waitForFunction(() => window.mathboard.page.objects.tp1.revealed === false);
});

await step('C4 shared countdown: presets, custom time, pause/reset/dismiss, late joiner, finish, focus mode', async () => {
  await fresh();
  await A.click('.toolbar .ibtn[aria-label^="Insert:"]');
  await A.click('.popover .timer-row .btn:has-text("2 min")');
  await B.waitForSelector('.timer-widget.running');
  const tb = await B.textContent('.timer-time');
  expect(/^(2:00|1:5\d)$/.test(tb), 'B shows ' + tb);
  await B.click('.timer-widget .ibtn[aria-label="Pause"]');
  await A.waitForSelector('.timer-widget:not(.running)');
  const paused = await A.textContent('.timer-time');
  await A.waitForTimeout(1500);
  expect(await A.textContent('.timer-time') === paused, 'paused timer kept counting');
  // a late joiner sees the same time
  const C = await user('Carol');
  await C.waitForSelector('.timer-widget');
  expect(await C.textContent('.timer-time') === paused, 'late joiner sees ' + (await C.textContent('.timer-time')) + ' not ' + paused);
  await C.context().close();
  await A.click('.timer-widget .ibtn[aria-label="Start"]');
  await B.waitForSelector('.timer-widget.running');
  await A.click('.timer-widget .ibtn[aria-label="Reset"]');
  await B.waitForFunction(() => document.querySelector('.timer-time')?.textContent === '2:00' && !document.querySelector('.timer-widget.running'));
  // drag it: the other side follows
  const wb = await A.locator('.timer-widget').boundingBox();
  const bBefore = await B.locator('.timer-widget').boundingBox();
  await A.mouse.move(wb.x + 20, wb.y + 20); await A.mouse.down();
  await A.mouse.move(wb.x + 300, wb.y + 250, { steps: 8 }); await A.mouse.up();
  await B.waitForFunction((x) => document.querySelector('.timer-widget').getBoundingClientRect().x > x + 200, bBefore.x);
  // a custom time, run to the end: a clear visual finish, no sound
  await A.click('.toolbar .ibtn[aria-label^="Insert:"]');
  await A.fill('.popover .timer-row input', '0:02');
  await A.click('.popover .timer-row .btn.primary');
  await B.waitForSelector('.timer-widget.done', { timeout: 10000 });
  await shot(B, 'C4-timer-done-B');
  expect(await st(B, () => document.querySelectorAll('audio').length) === 0, 'no sound');
  // stays visible in focus mode
  await A.keyboard.press('f');
  await A.waitForSelector('.focusbar');
  expect(await A.isVisible('.timer-widget'), 'timer hidden in focus mode');
  await shot(A, 'C4-timer-focus');
  await A.keyboard.press('f');
  await A.click('.timer-widget .ibtn[aria-label="Close the timer"]');
  await B.waitForSelector('.timer-widget', { state: 'detached' });
});

await step('C5 graph upgrades: degrees, domain, implicit, points of interest, π ticks, play, math keys', async () => {
  await fresh();
  await clearPage(A);
  await st(A, () => {
    const e = window.mathboard;
    e.commit([{ kind: 'add', obj: {
      id: 'gr', type: 'graph', authorId: 'a', createdAt: 1, x: 120, y: 60, w: 520, h: 420, xMin: -10, xMax: 10, yMin: -8, yMax: 8, showGrid: true, showNumbers: true,
      expressions: [
        { id: 'e1', text: 'y = x^2 - 4 {x > -1}', color: '#1971c2', visible: true },
        { id: 'e2', text: 'x^2/9 + y^2/4 = 1', color: '#e03131', visible: true },
        { id: 'e3', text: 'y = a sin(x)', color: '#2f9e44', visible: true },
      ],
      sliders: [{ name: 'a', min: 0, max: 3, step: 0.1, value: 1 }],
    } }]);
    e.setTool('select');
    e.setSelection(['gr']);
  });
  await A.waitForSelector('.inspector .math-keys');
  await A.waitForTimeout(300);
  // tap on the parabola: the coordinates show (display only)
  const n = (await objs(A)).length;
  const [sx, sy] = await st(A, () => { const e = window.mathboard; const g = e.page.objects.gr; const wx = g.x + ((2 - g.xMin) / (g.xMax - g.xMin)) * g.w, wy = g.y + g.h - ((0 - g.yMin) / (g.yMax - g.yMin)) * g.h; return e.toScreen(wx, wy); });
  await A.mouse.click(X(sx), Y(sy));
  await A.waitForFunction(() => !!window.mathboard.graphProbe, null, { timeout: 3000 });
  const probe = await st(A, () => window.mathboard.graphProbe);
  expect(Math.abs(probe.x - 2) < 0.05 && Math.abs(probe.y) < 0.05, 'probe at the x-intercept: ' + JSON.stringify(probe));
  expect((await objs(A)).length === n, 'probing added something to the board');
  await shot(A, 'C5-graph-poi');
  // math keys type into the focused expression
  await A.click('.inspector input[aria-label="Expression 3"]');
  await A.keyboard.press('End');
  await A.click('.inspector .math-keys button[aria-label="Square root"]');
  await A.keyboard.type('x');
  await B.waitForFunction(() => window.mathboard.page.objects.gr.expressions[2].text.endsWith('√(x)'));
  await A.click('.inspector input[aria-label="Expression 3"]');
  await A.keyboard.press('Control+a'); await A.keyboard.type('y = a sin(x)'); await A.keyboard.press('Tab');
  // degrees, π labels, play — all synced
  await A.click('.inspector .segmented button:has-text("Degrees")');
  await A.click('.inspector .toggle:has-text("multiples of π")');
  await A.click('.inspector .slider-card .ibtn.play');
  await B.waitForFunction(() => { const g = window.mathboard.page.objects.gr; return g.angle === 'deg' && g.piTicks === true && !!g.sliders[0].play; });
  await B.waitForTimeout(400);
  await shot(B, 'C5-graph-B');
  await A.click('.inspector .slider-card .ibtn.play');
  await B.waitForFunction(() => !window.mathboard.page.objects.gr.sliders[0].play);
  await A.keyboard.press('Escape');
});

await step('C6 axes upgrades: four / first quadrant, grid lines, labels, π ticks', async () => {
  await fresh();
  await clearPage(A);
  await st(A, () => {
    const e = window.mathboard;
    e.commit([{ kind: 'add', obj: { id: 'ax', type: 'axes', authorId: 'a', createdAt: 1, x: 200, y: 100, w: 400, h: 400, xMin: -5, xMax: 5, yMin: -5, yMax: 5, xStep: 1, yStep: 1, showNumbers: true, mode: 'xy' } }]);
    e.setTool('select');
    e.setSelection(['ax']);
  });
  await A.waitForSelector('.inspector button:has-text("First quadrant")');
  await A.click('.inspector button:has-text("First quadrant")');
  await B.waitForFunction(() => { const a = window.mathboard.page.objects.ax; return a.xMin === 0 && a.yMin === 0 && a.xMax === 5; });
  // the origin stays put on the board
  const a1 = await st(B, () => window.mathboard.page.objects.ax);
  expect(Math.abs(a1.x - 400) < 0.5 && Math.abs(a1.y + a1.h - 300) < 0.5, 'origin moved: ' + JSON.stringify(a1));
  await A.click('.inspector .toggle:has-text("Grid lines")');
  await A.fill('.inspector input[aria-label="x axis label"]', 't');
  await A.keyboard.press('Enter');
  await A.fill('.inspector input[aria-label="y axis label"]', 'd(t)');
  await A.keyboard.press('Enter');
  await B.waitForFunction(() => { const a = window.mathboard.page.objects.ax; return a.grid === true && a.xLabel === 't' && a.yLabel === 'd(t)'; });
  await A.click('.inspector button:has-text("Four quadrants")');
  await A.click('.inspector .toggle:has-text("multiples of π")');
  await B.waitForFunction(() => { const a = window.mathboard.page.objects.ax; return a.piTicks === true && a.xMin < 0 && a.yMin < 0; });
  await shot(B, 'C6-axes-B');
  await A.keyboard.press('Escape');
});

await step('C7 crop an image: handles, Done, synced, bounds, duplicate, export, undo, reset', async () => {
  await fresh();
  await clearPage(A);
  await withImages(A, [[400, 300]], `return window.mathboard.insertImage(files[0], { locked: false, rect: { x: 200, y: 150, w: 400, h: 300 } });`);
  await A.waitForFunction(() => { const e = window.mathboard; const o = e.page.objects[e.page.order[0]]; return o?.type === 'image' && !o.src.startsWith('local:'); }, null, { timeout: 10000 });
  const id = await st(A, () => window.mathboard.page.order[0]);
  await st(A, (id) => window.mathboard.setSelection([id]), id);
  await A.click('.selbar .ibtn[aria-label^="Crop"]');
  await A.waitForSelector('.cropbar');
  // the selection frame is hidden: only the crop handles show
  await shot(A, 'C7-crop-handles');
  // drag the right-middle handle 100 units left, then the bottom-middle one 60 up
  const sp = (wx, wy) => st(A, ([wx, wy]) => window.mathboard.toScreen(wx, wy), [wx, wy]);
  await drag(A, [await sp(600, 300), await sp(500, 300)]);
  await drag(A, [await sp(350, 450), await sp(350, 390)]);
  await A.click('.cropbar .txt.primary');
  await B.waitForFunction((id) => { const o = window.mathboard.page.objects[id]; return o?.crop && Math.abs(o.w - 300) < 2 && Math.abs(o.h - 240) < 2; }, id);
  const o = await st(B, (id) => window.mathboard.page.objects[id], id);
  expect(Math.abs(o.crop.w - 0.75) < 0.01 && Math.abs(o.crop.h - 0.8) < 0.01 && o.x === 200 && o.y === 150, 'crop ' + JSON.stringify(o.crop));
  // the selection bounds follow the crop
  const f = await st(A, () => { const fr = window.mathboard.selFrame(); return fr && [fr.w, fr.h]; });
  // (the frame has the same small margin on every side)
  expect(f && Math.abs((f[0] - o.w) - (f[1] - o.h)) < 0.5 && f[0] - o.w < 24, 'selection frame ' + JSON.stringify(f) + ' for ' + [o.w, o.h]);
  // hit-testing: the cut-off part is empty
  await A.keyboard.press('Escape');
  const [cx, cy] = await sp(560, 300);
  await A.keyboard.press('v');
  await A.mouse.click(X(cx), Y(cy));
  expect(await st(A, () => window.mathboard.sel.size) === 0, 'clicking the cropped-off part selected the image');
  // duplicate keeps the crop
  await st(A, (id) => window.mathboard.setSelection([id]), id);
  await A.keyboard.press('Control+d');
  await B.waitForFunction(() => window.mathboard.page.order.length === 2);
  const dup = await st(B, () => { const p = window.mathboard.page; return p.objects[p.order[1]]; });
  expect(dup.crop && Math.abs(dup.crop.w - 0.75) < 0.01 && dup.src === o.src, 'duplicate lost the crop');
  await A.keyboard.press('Control+z');
  await B.waitForFunction(() => window.mathboard.page.order.length === 1);
  await shot(B, 'C7-cropped-B');
  const cropped = await exportPngSize(A);
  // undo the crop
  await st(A, () => window.mathboard.setSelection([]));
  await A.keyboard.press('Control+z');
  await B.waitForFunction((id) => !window.mathboard.page.objects[id].crop && window.mathboard.page.objects[id].w === 400, id);
  const whole = await exportPngSize(A);
  log('    export', JSON.stringify({ cropped, whole }));
  // 300×240 (plus margins) against 400×300: the export follows the crop
  expect(cropped.w / cropped.h < whole.w / whole.h - 0.02, 'the export ignores the crop');
  // crop again and reset from the crop bar
  await A.keyboard.press('Control+y');
  await B.waitForFunction((id) => !!window.mathboard.page.objects[id].crop, id);
  await st(A, (id) => window.mathboard.setSelection([id]), id);
  await A.click('.selbar .ibtn[aria-label^="Crop"]');
  await A.click('.cropbar .txt:has-text("Reset")');
  await A.click('.cropbar .txt.primary');
  await B.waitForFunction((id) => { const o = window.mathboard.page.objects[id]; return !o.crop && o.w === 400 && o.h === 300; }, id);
  await A.keyboard.press('Escape');
});

await step('C8 touch: two-finger tap undoes, three-finger tap redoes; a pinch does neither and never draws', async () => {
  await fresh();
  await clearPage(A);
  await A.keyboard.press('1');
  await drag(A, [[300, 300], [400, 340], [500, 300]]);
  await A.waitForFunction(() => window.mathboard.page.order.length === 1);
  const cdp = await A.context().newCDPSession(A);
  const touch = async (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x: X(x), y: Y(y), id })) });
  const tap = async (n) => {
    const pts = Array.from({ length: n }, (_, i) => [400 + i * 60, 400]);
    await touch('touchStart', pts);
    await A.waitForTimeout(60);
    await touch('touchEnd', []);
    await A.waitForTimeout(250);
  };
  await tap(2);
  await B.waitForFunction(() => window.mathboard.page.order.length === 0);
  await tap(3);
  await B.waitForFunction(() => window.mathboard.page.order.length === 1);
  // a pinch: two fingers that move apart
  const z0 = await st(A, () => window.mathboard.cam.zoom);
  await touch('touchStart', [[400, 400], [460, 400]]);
  for (let i = 1; i <= 8; i++) { await touch('touchMove', [[400 - i * 12, 400], [460 + i * 12, 400]]); await A.waitForTimeout(16); }
  await touch('touchEnd', []);
  await A.waitForTimeout(400);
  const after = await st(A, () => ({ n: window.mathboard.page.order.length, z: window.mathboard.cam.zoom }));
  expect(after.n === 1, 'the pinch undid, redid or drew: ' + after.n);
  expect(after.z > z0 * 1.2, 'the pinch did not zoom');
  await st(A, () => window.mathboard.fitRect([0, 0, 1200, 700], 0, 1));
});

await step('C9 hold L for the laser; a quick L press still switches tools', async () => {
  await fresh();
  await A.keyboard.press('1');
  expect(await st(A, () => window.mathboard.ui.get().tool) === 'pen', 'pen first');
  await A.keyboard.down('l');
  await A.waitForTimeout(400);
  expect(await st(A, () => window.mathboard.ui.get().heldTool) === 'laser', 'laser while held');
  await A.mouse.move(X(300), Y(300)); await A.mouse.down(); await A.mouse.move(X(400), Y(330), { steps: 6 });
  await B.waitForFunction(() => window.mathboard.lasers.size > 0);
  await A.mouse.up();
  await A.keyboard.up('l');
  const s1 = await st(A, () => ({ tool: window.mathboard.ui.get().tool, held: window.mathboard.ui.get().heldTool, n: window.mathboard.page.order.length }));
  expect(s1.tool === 'pen' && !s1.held, 'back to the pen: ' + JSON.stringify(s1));
  expect(s1.n === 1, 'the laser drew ink');
  await A.keyboard.press('l');
  expect(await st(A, () => window.mathboard.ui.get().tool) === 'laser', 'a quick press picks the laser');
  await A.keyboard.press('1');
});

console.log(failures ? `${failures} step(s) FAILED` : 'all steps OK');
console.log('ERRORS', errors);
await browser.close();

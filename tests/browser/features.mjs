// Walks through the feature set in two browsers: paste, ink-to-shape, hold, shapes, ruler, text,
// graph, axes, tape, insert space, laser, pages, follow, menu, dark / focus mode, replay, exports, reload.
// Usage: start the app (npm start), then: BASE=http://localhost:3000 node tests/browser/features.mjs
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = process.env.SHOTS || path.join(os.tmpdir(), 'mathboard-shots');
mkdirSync(OUT, { recursive: true });
const board = 'feat' + Date.now().toString(36);
const log = (...a) => console.log(...a);
const errors = [];

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
async function user(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, acceptDownloads: true });
  await ctx.addInitScript((n) => { if (!localStorage.getItem('mathboard.name')) localStorage.setItem('mathboard.name', n); }, name);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${name}] PAGEERROR ${e.stack || e.message}`));
  await page.goto(BASE + '/b/' + board);
  await page.waitForFunction(() => window.mathboard?.ui.get().ready);
  return page;
}
const shot = (p, n) => p.screenshot({ path: path.join(OUT, n + '.png') });
const st = (p, fn, arg) => p.evaluate(fn, arg);
const types = (p) => st(p, () => { const pg = window.mathboard.page; return pg.order.map((id) => pg.objects[id].type + (pg.objects[id].kind ? ':' + pg.objects[id].kind : '')); });
const step = async (name, fn) => { try { await fn(); log('OK  ', name); } catch (e) { log('FAIL', name, '-', String(e.message).split('\n')[0]); } };

const A = await user('Alice');
const B = await user('Bob');
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

await step('paste image', async () => {
  await st(A, async () => {
    const c = document.createElement('canvas'); c.width = 800; c.height = 500;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 800, 500); x.fillStyle = '#234'; x.font = '48px sans-serif'; x.fillText('Homework: 3x + 5 = 20', 60, 200);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  await B.waitForFunction(() => { const pg = window.mathboard.page; return pg.order.some((id) => pg.objects[id].type === 'image'); }, null, { timeout: 5000 });
  const img = await st(B, () => { const pg = window.mathboard.page; const o = pg.objects[pg.order[0]]; return { locked: o.locked, w: o.w, src: o.src }; });
  log('   image on B:', JSON.stringify(img));
  await B.waitForFunction(() => window.mathboard.images.state(window.mathboard.page.objects[window.mathboard.page.order[0]].src) === 'ready');
});

await step('write over the locked image', async () => {
  await A.keyboard.press('3');
  await drag(A, [[400, 300], [470, 330], [540, 300], [610, 335]]);
  if ((await types(A)).length !== 2) throw new Error('stroke not added: ' + (await types(A)));
});

await step('ink-to-shape rectangle + undo restores ink', async () => {
  await A.keyboard.press('1');
  await drag(A, [[760, 80], [960, 80], [960, 200], [760, 200], [760, 82]], { steps: 14 });
  let t = await types(A);
  if (t[t.length - 1] !== 'shape:rect') throw new Error('got ' + t);
  await A.keyboard.press('Control+z');
  await A.waitForTimeout(100);
  t = await types(A);
  if (t[t.length - 1] !== 'stroke') throw new Error('undo gave ' + t);
  await A.keyboard.press('Control+Shift+z');
  await A.waitForTimeout(100);
  t = await types(B);
  if (t[t.length - 1] !== 'shape:rect') throw new Error('redo gave (B) ' + t);
});

await step('draw-and-hold → straight line', async () => {
  await A.keyboard.press('2');
  await drag(A, [[760, 240], [800, 250], [850, 244], [900, 256], [960, 246]], { hold: 700 });
  const t = await types(A);
  if (t[t.length - 1] !== 'shape:line') throw new Error('got ' + t);
});

await step('shape tool (ellipse with shift = circle)', async () => {
  await A.keyboard.press('Shift+R');
  await A.click('.toolbar .ibtn.active[aria-label^="Shapes"]');
  await A.waitForSelector('.popover .shape-grid');
  await shot(A, '10-shape-popover');
  await A.click('.popover .shape-grid button[title="Ellipse / circle"]');
  await A.keyboard.press('Escape');
  await A.keyboard.down('Shift');
  await drag(A, [[1000, 80], [1100, 150]]);
  await A.keyboard.up('Shift');
  const o = await st(A, () => { const pg = window.mathboard.page; return pg.objects[pg.order[pg.order.length - 1]]; });
  if (o.kind !== 'ellipse' || Math.abs((o.points[2] - o.points[0]) - (o.points[3] - o.points[1])) > 0.5) throw new Error(JSON.stringify(o));
});

await step('ruler snap', async () => {
  await A.keyboard.press('r');
  await A.waitForTimeout(100);
  const r = await st(A, () => window.mathboard.ui.get().ruler);
  if (!r.visible) throw new Error('ruler not visible');
  await B.waitForFunction(() => [...window.mathboard.rulers.values()].some((x) => x.visible));
  await shot(A, '11-ruler');
  // start a stroke right at the top edge of the ruler (ruler centre is at view centre; width 100)
  const [sx, sy] = await st(A, () => { const e = window.mathboard; const r = e.ui.get().ruler; return e.toScreen(r.x, r.y - 50); });
  await A.keyboard.press('1');
  await drag(A, [[sx - 150, sy - 3], [sx - 60, sy - 12], [sx + 40, sy + 6], [sx + 160, sy - 9]]);
  const o = await st(A, () => { const pg = window.mathboard.page; return pg.objects[pg.order[pg.order.length - 1]]; });
  const ys = o.points.filter((_, i) => i % 3 === 1);
  if (o.type !== 'stroke' || Math.max(...ys) - Math.min(...ys) > 0.2) throw new Error('not straight: ' + (Math.max(...ys) - Math.min(...ys)));
  await A.keyboard.press('r');
});

await step('text tool', async () => {
  await A.keyboard.press('t');
  await A.mouse.click(X(120), Y(520));
  await A.waitForSelector('textarea.text-edit');
  await A.keyboard.type('x = 5\nCheck: 3(5) + 5 = 20');
  await shot(A, '12-text-edit');
  await A.mouse.click(X(700), Y(600)); // commits, starts a new empty box
  await A.keyboard.press('Escape');
  await B.waitForFunction(() => { const pg = window.mathboard.page; return pg.order.some((id) => pg.objects[id].type === 'text'); });
  const n = (await types(A)).filter((t) => t === 'text').length;
  if (n !== 1) throw new Error('text count ' + n);
});

await step('graph + inspector', async () => {
  await A.keyboard.press('g');
  await drag(A, [[640, 300], [1000, 600]]);
  await A.waitForSelector('.inspector');
  const inputs = A.locator('.inspector .expr-row input[type=text]');
  await inputs.nth(0).fill('y = a x^2 + b');
  await inputs.nth(0).press('Enter');
  await A.locator('.inspector .expr-row input[type=text]').nth(1).fill('y = tan(x)');
  await A.locator('.inspector .expr-row input[type=text]').nth(1).press('Enter');
  await A.locator('.inspector .expr-row input[type=text]').nth(2).fill('y > 2x + 1');
  await A.locator('.inspector .expr-row input[type=text]').nth(2).press('Enter');
  await A.locator('.inspector .expr-row input[type=text]').nth(3).fill('y = 3 +* 2');
  await A.waitForTimeout(150);
  const g = await st(B, () => { const pg = window.mathboard.page; const o = pg.order.map((id) => pg.objects[id]).find((x) => x.type === 'graph'); return { ex: o.expressions.map((e) => e.text), sl: o.sliders }; });
  log('   graph on B:', JSON.stringify(g));
  if (g.sl.length !== 2) throw new Error('sliders ' + JSON.stringify(g.sl));
  await shot(A, '13-graph');
  // slider drag
  const sl = A.locator('.inspector .slider-card input[type=range]').first();
  await sl.focus();
  for (let i = 0; i < 5; i++) await A.keyboard.press('ArrowRight');
  await A.waitForTimeout(100);
  const a = await st(B, () => { const pg = window.mathboard.page; const o = pg.order.map((id) => pg.objects[id]).find((x) => x.type === 'graph'); return o.sliders[0].value; });
  if (Math.abs(a - 1.5) > 1e-9) throw new Error('slider value on B ' + a);
});
await shot(B, '13-graph-B');

await step('axes', async () => {
  await A.keyboard.press('Escape');
  await A.click('.toolbar .ibtn[aria-label="Coordinate axes"]');
  await drag(A, [[80, 60], [330, 250]]);
  await A.waitForSelector('.inspector');
  await shot(A, '14-axes');
  const t = await types(B);
  if (!t.includes('axes')) throw new Error('no axes on B ' + t);
});

await step('tape + reveal by tap', async () => {
  await A.keyboard.press('Escape');
  await A.click('.toolbar .ibtn[aria-label^="Tape"]');
  await drag(A, [[100, 500], [420, 590]]);
  let tp = await st(B, () => { const pg = window.mathboard.page; return pg.order.map((id) => pg.objects[id]).find((x) => x.type === 'tape'); });
  if (!tp || tp.revealed) throw new Error('tape missing');
  await shot(A, '15-tape');
  await B.keyboard.press('v');
  await B.mouse.click(X(200), Y(540));
  await A.waitForFunction(() => { const pg = window.mathboard.page; return pg.order.map((id) => pg.objects[id]).find((x) => x.type === 'tape')?.revealed === true; });
});

await step('insert space', async () => {
  const before = await st(A, () => { const pg = window.mathboard.page; return pg.order.map((id) => pg.objects[id]).find((x) => x.type === 'text').y; });
  await A.click('.toolbar .ibtn[aria-label^="Insert / remove space"]');
  await drag(A, [[50, 480], [50, 560]]);
  const after = await st(B, () => { const pg = window.mathboard.page; return pg.order.map((id) => pg.objects[id]).find((x) => x.type === 'text').y; });
  if (Math.abs(after - before - 80) > 1) throw new Error(`moved ${after - before}`);
  await A.keyboard.press('Control+z');
  await A.waitForTimeout(120);
  const undone = await st(B, () => { const pg = window.mathboard.page; return pg.order.map((id) => pg.objects[id]).find((x) => x.type === 'text').y; });
  if (Math.abs(undone - before) > 0.2) throw new Error('undo space');
});

await step('laser', async () => {
  await A.keyboard.press('l');
  await A.mouse.move(X(500), Y(100)); await A.mouse.down();
  for (let i = 0; i < 12; i++) await A.mouse.move(X(500 + i * 15), Y(100 + i * 4));
  await B.waitForFunction(() => window.mathboard.lasers.size > 0);
  await shot(B, '16-laser-B');
  await A.mouse.up();
});

await step('pages: add, rename, switch, presence', async () => {
  await A.click('.sidebar-foot button');
  await A.waitForFunction(() => window.mathboard.nb.pages.length === 2);
  await B.waitForFunction(() => window.mathboard.nb.pages.length === 2);
  await A.keyboard.press('1');
  await drag(A, [[300, 200], [380, 260], [460, 200]]);
  await A.dblclick('.page-row.active .title');
  await A.keyboard.type('Question 2');
  await A.keyboard.press('Enter');
  await B.waitForFunction(() => window.mathboard.nb.pages[1].title === 'Question 2');
  await B.waitForFunction(() => window.mathboard.ui.get().users.some((u) => u.name === 'Alice' && u.pageId === window.mathboard.nb.pages[1].id));
  await shot(B, '17-pages-B');
  // follow Alice
  await B.click('button.user-chip');
  await B.waitForFunction(() => window.mathboard.pageId === window.mathboard.nb.pages[1].id);
  await shot(B, '18-follow-B');
  await B.keyboard.press('Escape');
  await A.keyboard.press('PageUp');
  await A.waitForFunction(() => window.mathboard.pageId === window.mathboard.nb.pages[0].id);
});

await step('menu, dark mode, focus mode, shortcuts', async () => {
  await A.click('.topright .ibtn[aria-label="Menu"]');
  await A.waitForSelector('.popover .menu');
  await shot(A, '19-menu');
  await A.click('.menu-item:has-text("Dark mode")');
  await A.waitForTimeout(250);
  await shot(A, '20-dark');
  await A.keyboard.press('f');
  await A.waitForSelector('.focusbar');
  await A.waitForTimeout(200);
  await shot(A, '21-focus');
  await A.keyboard.press('f');
  await A.keyboard.press('?');
  await A.waitForSelector('.dialog');
  await shot(A, '22-shortcuts');
  await A.keyboard.press('Escape');
  await A.click('.topright .ibtn[aria-label="Menu"]');
  await A.click('.menu-item:has-text("Light mode")');
});

await step('pen popover', async () => {
  await A.keyboard.press('1');
  await A.click('.fav.active');
  await A.waitForSelector('.popover .squiggle');
  await shot(A, '23-pen-popover');
  await A.keyboard.press('Escape');
  await A.keyboard.press('e');
  await A.click('.toolbar .ibtn.active[aria-label^="Eraser"]');
  await A.waitForSelector('.popover .eraser-sizes');
  await shot(A, '24-eraser-popover');
  await A.mouse.click(X(600), Y(40));
});

await step('replay', async () => {
  await A.click('.topright .ibtn[aria-label="Menu"]');
  await A.click('.menu-item:has-text("Replay")');
  await A.waitForSelector('.replaybar');
  await A.waitForTimeout(400);
  await shot(A, '25-replay');
  await A.keyboard.press('Escape');
});

await step('export PNG / PDF / JSON', async () => {
  for (const label of ['Export this page as PNG', 'Export notebook as PDF', 'Back up notebook']) {
    await A.click('.topright .ibtn[aria-label="Menu"]');
    const [dl] = await Promise.all([A.waitForEvent('download', { timeout: 20000 }), A.click(`.menu-item:has-text("${label}")`)]);
    const f = path.join(OUT, dl.suggestedFilename().replace(/[^\w.-]+/g, '_'));
    await dl.saveAs(f);
    log('   downloaded', path.basename(f));
  }
});

await step('reload persistence', async () => {
  const before = await st(A, () => window.mathboard.nb.pages.map((p) => p.order.length));
  await A.waitForFunction(() => !window.mathboard.ui.get().saving, null, { timeout: 8000 });
  await A.reload();
  await A.waitForFunction(() => window.mathboard?.ui.get().ready);
  const after = await st(A, () => window.mathboard.nb.pages.map((p) => p.order.length));
  log('   counts', before, after);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('mismatch');
  await A.waitForTimeout(600);
  await shot(A, '26-reloaded');
});

console.log('ERRORS', errors);
await browser.close();

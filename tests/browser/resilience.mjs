// Pen / touch input, selection transforms, PDF import, backup restore, offline queue, device restore,
// passcode, and pan / zoom frame times with 5,000 strokes. Starts its own server from dist/ on port 3412.
// Usage: npm run build, then: node tests/browser/resilience.mjs
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { rmSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.env.APP_ROOT || fileURLToPath(new URL('../..', import.meta.url));
const PORT = 3412;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), 'mathboard-test-data');
const OUT = process.env.SHOTS || path.join(os.tmpdir(), 'mathboard-shots');
mkdirSync(OUT, { recursive: true });
const board = 'adv' + Date.now().toString(36);
const log = (...a) => console.log(...a);
const errors = [];
rmSync(DATA, { recursive: true, force: true });

let server = null;
async function startServer(env = {}) {
  server = spawn(process.execPath, [path.join(ROOT, 'dist/server/index.js')], { env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    server.stdout.on('data', (d) => { if (String(d).includes('listening')) res(); });
    server.on('exit', (c) => rej(new Error('server exited ' + c)));
    setTimeout(() => rej(new Error('server start timeout')), 8000);
  });
}
async function stopServer(hard = false) {
  if (!server) return;
  const s = server; server = null;
  await new Promise((res) => { s.on('exit', res); s.kill(hard ? 'SIGKILL' : 'SIGTERM'); });
}

await startServer();
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
async function user(name, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: opts.dpr ?? 1, acceptDownloads: true, hasTouch: true });
  await ctx.addInitScript((n) => { if (!localStorage.getItem('mathboard.name')) localStorage.setItem('mathboard.name', n); }, name);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|WebSocket|Failed to load resource/.test(m.text())) errors.push(`[${name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${name}] PAGEERROR ${e.stack || e.message}`));
  await page.goto(BASE + '/b/' + (opts.board ?? board));
  if (opts.wait !== false) await page.waitForFunction(() => window.mathboard?.ui.get().ready);
  return page;
}
const shot = (p, n) => p.screenshot({ path: path.join(OUT, n + '.png') });
const st = (p, fn, arg) => p.evaluate(fn, arg);
const objs = (p) => st(p, () => { const pg = window.mathboard.page; return pg.order.map((id) => pg.objects[id]); });
const step = async (name, fn) => { try { await fn(); log('OK  ', name); } catch (e) { log('FAIL', name, '-', String(e.message).split('\n')[0]); } };

const A = await user('Alice');
const B = await user('Bob');
const box = await A.locator('.board').boundingBox();
const X = (x) => box.x + x, Y = (y) => box.y + y;

/** Synthetic pointer stream (pen / touch) dispatched on the live canvas. */
const ptr = (p, type, id, events) => st(p, async ({ type, id, events }) => {
  const el = document.querySelector('canvas.layer-live');
  const r = el.getBoundingClientRect();
  for (const ev of events) {
    if (ev.wait) { await new Promise((res) => setTimeout(res, ev.wait)); continue; }
    el.dispatchEvent(new PointerEvent(ev.t, {
      pointerId: id, pointerType: type, isPrimary: true, bubbles: true, cancelable: true,
      clientX: r.left + ev.x, clientY: r.top + ev.y, pressure: ev.p ?? (ev.t === 'pointerup' ? 0 : 0.5),
      buttons: ev.t === 'pointerup' ? 0 : (ev.buttons ?? 1), button: ev.t === 'pointermove' ? -1 : (ev.button ?? 0),
    }));
    await new Promise((res) => requestAnimationFrame(res));
  }
}, { type, id, events });
const path2 = (pts, extra = {}) => [
  { t: 'pointerdown', x: pts[0][0], y: pts[0][1], ...extra, p: pts[0][2] },
  ...pts.slice(1).map(([x, y, p]) => ({ t: 'pointermove', x, y, p, ...extra })),
  { t: 'pointerup', x: pts[pts.length - 1][0], y: pts[pts.length - 1][1] },
];

await step('pen pressure is recorded; stroke not simulated', async () => {
  await ptr(A, 'pen', 11, path2([[100, 100, 0.2], [140, 110, 0.5], [180, 100, 0.9], [220, 115, 0.4], [260, 100, 0.1]]));
  const o = (await objs(A)).at(-1);
  const pr = o.points.filter((_, i) => i % 3 === 2);
  if (o.sim || Math.max(...pr) < 0.85 || Math.min(...pr) > 0.25) throw new Error(JSON.stringify(pr));
});

await step('palm rejection: touch pans after a pen was seen', async () => {
  const n = (await objs(A)).length;
  const cam0 = await st(A, () => ({ ...window.mathboard.cam }));
  await ptr(A, 'touch', 21, path2([[400, 300], [430, 320], [460, 340]]));
  const cam1 = await st(A, () => ({ ...window.mathboard.cam }));
  if ((await objs(A)).length !== n) throw new Error('touch drew');
  if (Math.abs(cam1.x - cam0.x + 60) > 1 || Math.abs(cam1.y - cam0.y + 40) > 1) throw new Error(`cam ${JSON.stringify(cam0)} → ${JSON.stringify(cam1)}`);
  await ptr(A, 'touch', 21, path2([[460, 340], [400, 300]]));
});

await step('two-finger pinch zooms', async () => {
  await st(A, async () => {
    const el = document.querySelector('canvas.layer-live'); const r = el.getBoundingClientRect();
    const ev = (t, id, x, y) => el.dispatchEvent(new PointerEvent(t, { pointerId: id, pointerType: 'touch', bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + y, buttons: t === 'pointerup' ? 0 : 1, pressure: 0.5 }));
    ev('pointerdown', 31, 400, 300); ev('pointerdown', 32, 500, 300);
    for (let i = 1; i <= 10; i++) { ev('pointermove', 31, 400 - i * 5, 300); ev('pointermove', 32, 500 + i * 5, 300); }
    ev('pointerup', 31, 350, 300); ev('pointerup', 32, 550, 300);
  });
  const z = await st(A, () => window.mathboard.cam.zoom);
  if (Math.abs(z - 2) > 0.05) throw new Error('zoom ' + z);
  await A.keyboard.press('Control+0');
  await st(A, () => window.mathboard.setCamera({ x: -40, y: -40, zoom: 1 }));
});

await step('pen eraser end erases; barrel button lassos', async () => {
  const n = (await objs(A)).length;
  await ptr(A, 'pen', 11, path2([[180, 60], [180, 100], [180, 140]], { buttons: 32, button: 5 }));
  if ((await objs(A)).length !== n - 1) throw new Error('eraser end did not erase');
  await A.keyboard.press('Control+z');
  await A.waitForTimeout(80);
  const loop = [];
  for (let i = 0; i <= 40; i++) { const t = (i / 40) * Math.PI * 2; loop.push([190 + 130 * Math.cos(t), 108 + 50 * Math.sin(t)]); }
  await ptr(A, 'pen', 11, path2(loop, { buttons: 2, button: 2 }));
  const sel = await st(A, () => window.mathboard.sel.size);
  if (sel !== 1) throw new Error('barrel lasso selected ' + sel);
  if (await st(A, () => window.mathboard.ui.get().tool) !== 'pen') throw new Error('tool changed');
});

await step('selection: resize by corner, rotate, lock, duplicate, copy/paste, z-order', async () => {
  await A.keyboard.press('v');
  await A.mouse.click(X(180), Y(100));
  const before = (await objs(A)).at(-1);
  let r = await st(A, () => window.mathboard.ui.get().sel.rect);
  await shot(A, '30-selected');
  // drag bottom-right corner outwards
  await A.mouse.move(X(r.x + r.w), Y(r.y + r.h)); await A.mouse.down();
  await A.mouse.move(X(r.x + r.w * 2), Y(r.y + r.h * 2), { steps: 6 }); await A.mouse.up();
  await A.waitForTimeout(100);
  let o = (await objs(B)).at(-1);
  const w0 = before.bbox[2] - before.bbox[0], w1 = o.bbox[2] - o.bbox[0];
  if (w1 / w0 < 1.6) throw new Error(`resize ratio ${w1 / w0}`);
  // rotate handle
  r = await st(A, () => window.mathboard.ui.get().sel.rect);
  await A.mouse.move(X(r.x + r.w / 2), Y(r.y - 30)); await A.mouse.down();
  await A.mouse.move(X(r.x + r.w / 2 + 120), Y(r.y + r.h / 2), { steps: 8 }); await A.mouse.up();
  await A.waitForTimeout(100);
  o = (await objs(B)).at(-1);
  const h1 = o.bbox[3] - o.bbox[1];
  if (h1 < w1 * 0.7) throw new Error('rotate did not happen: h=' + h1 + ' w=' + w1);
  // duplicate, copy, paste
  await A.keyboard.press('Control+d');
  await A.waitForTimeout(80);
  await st(A, () => { const dt = new DataTransfer(); const ev = new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }); document.dispatchEvent(ev); window.__clip = dt.getData('text/plain'); });
  await st(A, () => { const dt = new DataTransfer(); dt.setData('text/plain', window.__clip); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
  await A.waitForTimeout(100);
  const n = (await objs(B)).length;
  if (n !== 3) throw new Error('expected 3 objects, got ' + n);
  // lock via the bar: a locked object ignores drags
  await A.click('.selbar .ibtn[aria-label^="Lock"]');
  const lockedId = await st(A, () => [...window.mathboard.sel][0]);
  const pos0 = (await objs(A)).find((x) => x.id === lockedId).bbox;
  r = await st(A, () => window.mathboard.ui.get().sel.rect);
  await A.mouse.move(X(r.x + r.w / 2), Y(r.y + r.h / 2)); await A.mouse.down();
  await A.mouse.move(X(r.x + r.w / 2 + 80), Y(r.y + r.h / 2 + 80), { steps: 5 }); await A.mouse.up();
  await A.waitForTimeout(80);
  const pos1 = (await objs(A)).find((x) => x.id === lockedId).bbox;
  if (pos0[0] !== pos1[0]) throw new Error('locked object moved');
  await shot(A, '31-locked');
  await A.keyboard.press('Escape');
});

await step('protractor: stroke from the centre snaps to a whole-degree ray', async () => {
  await A.click('.toolbar .ibtn[aria-label="Protractor"]');
  await A.waitForTimeout(100);
  const [cx, cy] = await st(A, () => { const e = window.mathboard; const r = e.ui.get().ruler; return e.toScreen(r.x, r.y); });
  await shot(A, '32-protractor');
  await A.keyboard.press('1');
  await A.mouse.move(X(cx), Y(cy)); await A.mouse.down();
  await A.mouse.move(X(cx + 100), Y(cy - 58), { steps: 6 });
  await A.mouse.move(X(cx + 150), Y(cy - 80), { steps: 6 });
  await A.mouse.up();
  await A.waitForTimeout(100);
  const o = (await objs(A)).at(-1);
  const p = o.points; const ang = (Math.atan2(-(p[p.length - 2] - p[1]), p[p.length - 3] - p[0]) * 180) / Math.PI;
  if (Math.abs(ang - Math.round(ang)) > 0.05) throw new Error('angle ' + ang);
  log('   ray angle', ang.toFixed(2));
  await A.click('.toolbar .ibtn[aria-label="Protractor"]');
});

await step('ruler rotate knob is on screen and rotates', async () => {
  await A.click('.toolbar .ibtn[aria-label="Ruler (R)"]');
  const k = await st(A, () => { const e = window.mathboard; const r = e.ui.get().ruler; const a = r.angle * Math.PI / 180; return e.toScreen(r.x + 210 * Math.cos(a) - 4 * Math.sin(a), r.y + 210 * Math.sin(a) + 4 * Math.cos(a)); });
  if (k[0] < 0 || k[0] > box.width) throw new Error('knob off-screen ' + k);
  await A.mouse.move(X(k[0]), Y(k[1])); await A.mouse.down();
  await A.mouse.move(X(k[0] - 30), Y(k[1] + 120), { steps: 10 }); await A.mouse.up();
  const ang = await st(A, () => window.mathboard.ui.get().ruler.angle);
  if (Math.abs(ang) < 20) throw new Error('angle ' + ang);
  log('   ruler angle', ang);
  await shot(A, '33-ruler-rotated');
  await A.click('.toolbar .ibtn[aria-label="Ruler (R)"]');
  if (await st(A, () => window.mathboard.ui.get().ruler.visible)) throw new Error('ruler still visible');
});

await step('text: commit has no jump; double-click edits', async () => {
  await A.keyboard.press('t');
  await A.mouse.click(X(600), Y(120));
  await A.keyboard.type('Area = 1/2 b h');
  const ed = await A.locator('textarea.text-edit').boundingBox();
  await A.keyboard.press('Escape');
  await A.waitForTimeout(100);
  const t = (await objs(B)).find((o) => o.type === 'text');
  if (!t || t.text !== 'Area = 1/2 b h') throw new Error('text not synced');
  await A.keyboard.press('v');
  await A.mouse.dblclick(X(640), Y(ed.y - box.y + ed.height / 2));
  await A.waitForSelector('textarea.text-edit');
  await A.keyboard.type(' !');
  await A.keyboard.press('Control+Enter');
  await A.waitForTimeout(100);
  const t2 = (await objs(B)).find((o) => o.type === 'text');
  if (t2.text !== 'Area = 1/2 b h !') throw new Error('edit not synced: ' + t2.text);
});

await step('PDF import (2 pages → new board pages)', async () => {
  // build a small 2-page PDF with the notebook export, then import it
  await A.click('.sidebar-foot button');
  await A.keyboard.press('1');
  await A.mouse.move(X(300), Y(300)); await A.mouse.down(); await A.mouse.move(X(500), Y(380), { steps: 5 }); await A.mouse.up();
  await A.click('.topright .ibtn[aria-label="Menu"]');
  const [dl] = await Promise.all([A.waitForEvent('download'), A.click('.menu-item:has-text("Export notebook as PDF")')]);
  const pdfPath = path.join(OUT, 'adv.pdf');
  await dl.saveAs(pdfPath);
  await A.click('.topright .ibtn[aria-label="Menu"]');
  const [fc] = await Promise.all([A.waitForEvent('filechooser'), A.click('.menu-item:has-text("Import PDF")')]);
  await fc.setFiles(pdfPath);
  await A.waitForSelector('.pdf-grid .pdf-page');
  await A.waitForSelector('.pdf-grid canvas');
  await A.waitForTimeout(400);
  await shot(A, '34-pdf-dialog');
  await A.click('.segmented button:has-text("One board page each")');
  await A.click('.dialog-actions .btn.primary');
  await A.waitForSelector('.dialog', { state: 'detached', timeout: 30000 });
  await B.waitForFunction(() => window.mathboard.nb.pages.length === 4, null, { timeout: 10000 });
  const pg = await st(B, () => window.mathboard.nb.pages.map((p) => p.title + ':' + p.order.map((id) => p.objects[id].type + (p.objects[id].locked ? '(locked)' : '')).join(',')));
  log('   pages', JSON.stringify(pg));
  if (!pg[2].includes('image(locked)') || !pg[3].includes('image(locked)')) throw new Error('images missing');
});

await step('JSON backup → restore', async () => {
  await A.click('.topright .ibtn[aria-label="Menu"]');
  const [dl] = await Promise.all([A.waitForEvent('download'), A.click('.menu-item:has-text("Back up notebook")')]);
  const jsonPath = path.join(OUT, 'adv.json');
  await dl.saveAs(jsonPath);
  await A.keyboard.press('PageUp'); await A.keyboard.press('PageUp'); await A.keyboard.press('PageUp');
  await st(A, () => window.mathboard.clearPage());
  await B.waitForFunction(() => window.mathboard.nb.pages[0].order.length === 0);
  await A.click('.topright .ibtn[aria-label="Menu"]');
  const [fc] = await Promise.all([A.waitForEvent('filechooser'), A.click('.menu-item:has-text("Restore from a backup")')]);
  await fc.setFiles(jsonPath);
  await A.waitForSelector('.dialog');
  await shot(A, '35-restore-json');
  await A.click('.dialog-actions .btn.danger');
  await B.waitForFunction(() => window.mathboard.nb.pages[0].order.length > 0, null, { timeout: 15000 });
  await A.waitForSelector('.dialog', { state: 'detached' });
});

await step('offline edits are re-sent after the server comes back', async () => {
  await A.waitForFunction(() => !window.mathboard.ui.get().saving, null, { timeout: 8000 });
  const n = (await objs(A)).length;
  const h0 = (await A.locator('.topbar').boundingBox()).height;
  await stopServer();
  await A.waitForFunction(() => window.mathboard.ui.get().conn !== 'connected', null, { timeout: 15000 });
  const h1 = (await A.locator('.topbar').boundingBox()).height;
  if (h0 !== h1 || h0 > 56) throw new Error(`toolbar reflowed when the connection dropped: ${h0} → ${h1}`);
  await A.keyboard.press('2');
  await A.mouse.move(X(700), Y(400)); await A.mouse.down(); await A.mouse.move(X(900), Y(450), { steps: 6 }); await A.mouse.up();
  await A.waitForTimeout(200);
  await shot(A, '36-offline');
  log('   status while down:', await st(A, () => window.mathboard.ui.get().conn), 'pending', await st(A, () => window.mathboard.sync.pending.length));
  await startServer();
  await A.waitForFunction(() => window.mathboard.ui.get().conn === 'connected', null, { timeout: 20000 });
  await B.waitForFunction((n) => window.mathboard?.ui.get().conn === 'connected' && window.mathboard.page.order.length === n + 1, n, { timeout: 20000 });
  await A.waitForFunction(() => window.mathboard.sync.pending.length === 0);
});

await step('server wiped → "Restore from this device?" → restore', async () => {
  await A.waitForFunction(() => !window.mathboard.ui.get().saving, null, { timeout: 8000 });
  await A.waitForTimeout(1800); // let the IndexedDB snapshot flush
  const counts = await st(A, () => window.mathboard.nb.pages.map((p) => p.order.length));
  await stopServer();
  for (const f of readdirSync(DATA)) if (f !== 'uploads') rmSync(path.join(DATA, f), { recursive: true, force: true }); // notebooks, page files, backups
  await startServer();
  await A.waitForSelector('.dialog:has-text("Restore this board")', { timeout: 25000 });
  await shot(A, '37-restore-prompt');
  await A.click('.dialog-actions .btn.primary');
  await A.waitForSelector('.dialog', { state: 'detached', timeout: 20000 });
  await B.waitForFunction((c) => JSON.stringify(window.mathboard.nb.pages.map((p) => p.order.length)) === JSON.stringify(c), counts, { timeout: 20000 });
  log('   restored counts', JSON.stringify(counts));
});

await step('5,000 strokes + 10 images: pan/zoom frame time', async () => {
  const P = await user('Perf', { board: board + 'perf' });
  await st(P, async () => {
    const e = window.mathboard;
    const c = document.createElement('canvas'); c.width = 1600; c.height = 1200;
    const x = c.getContext('2d'); x.fillStyle = '#dde'; x.fillRect(0, 0, 1600, 1200); x.fillStyle = '#345'; x.font = '90px sans-serif'; x.fillText('image', 100, 300);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    for (let i = 0; i < 10; i++) await e.insertImage(blob, { rect: { x: (i % 5) * 700, y: Math.floor(i / 5) * 560, w: 640, h: 480 } });
    const ops = [];
    for (let i = 0; i < 5000; i++) {
      const ox = Math.random() * 3400, oy = Math.random() * 1100;
      const pts = [];
      for (let k = 0; k < 40; k++) pts.push(Math.round((ox + k * 2 + Math.sin(k / 3) * 8) * 10) / 10, Math.round((oy + Math.cos(k / 4) * 14 + k) * 10) / 10, 0.5);
      ops.push({ kind: 'add', obj: { id: 's' + i, type: 'stroke', authorId: 'perf', createdAt: Date.now(), pen: i % 9 === 0 ? 'pencil' : 'ballpoint', color: ['ink', '#1971c2', '#e03131'][i % 3], size: 2.5, opacity: 1, points: pts, bbox: [0, 0, 0, 0], stab: 30 } });
    }
    e.commit(ops, { undo: false });
  });
  await P.waitForTimeout(1500);
  const res = await st(P, async () => {
    const e = window.mathboard;
    const run = async (fn, frames) => {
      const times = []; let last = performance.now();
      for (let i = 0; i < frames; i++) { fn(i); await new Promise((r) => requestAnimationFrame(r)); const now = performance.now(); times.push(now - last); last = now; }
      times.sort((a, b) => a - b);
      return { avg: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1), p95: +times[Math.floor(times.length * 0.95)].toFixed(1), max: +times[times.length - 1].toFixed(1) };
    };
    e.setCamera({ x: 0, y: 0, zoom: 1 });
    const pan = await run((i) => e.panBy(-6, i % 40 < 20 ? -2 : 2), 180);
    const zoom = await run((i) => e.zoomAt(600, 300, i % 60 < 30 ? 1.02 : 1 / 1.02), 180);
    e.setCamera({ x: 0, y: 0, zoom: 0.3 });
    const far = await run((i) => e.panBy(i % 40 < 20 ? -5 : 5, 0), 120);
    return { pan, zoom, zoomedOut: far, count: e.page.order.length };
  });
  log('   frame ms', JSON.stringify(res));
  await shot(P, '38-perf');
  await P.close();
});

await stopServer();
await step('passcode: landing asks, wrong is refused, right is remembered', async () => {
  await startServer({ APP_PASSCODE: 'pi314' });
  const C = await user('Carol', { board: 'pc' + Date.now().toString(36), wait: false });
  await C.waitForSelector('input[type=password]');
  await C.fill('input[type=password]', 'nope');
  await C.click('button.primary');
  await C.waitForSelector('.notice.error');
  await C.fill('input[type=password]', 'pi314');
  await C.click('button.primary');
  await C.waitForFunction(() => window.mathboard?.ui.get().ready, null, { timeout: 8000 });
  await C.reload();
  await C.waitForFunction(() => window.mathboard?.ui.get().ready, null, { timeout: 8000 });
  await C.close();
});

console.log('ERRORS', errors);
await browser.close();
await stopServer();

// Two browsers on one board: live strokes, simultaneous drawing, undo, erasers, lasso, recolour.
// Usage: start the app (npm start), then: BASE=http://localhost:3000 node tests/browser/smoke.mjs
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = process.env.SHOTS || path.join(os.tmpdir(), 'mathboard-shots');
mkdirSync(OUT, { recursive: true });
const board = 'smoke' + Date.now().toString(36);
const log = (...a) => console.log(...a);
const errors = [];

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
async function user(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${name}] PAGEERROR ${e.stack || e.message}`));
  return page;
}
const shot = (p, n) => p.screenshot({ path: path.join(OUT, n + '.png') });
const st = (p, fn, arg) => p.evaluate(fn, arg);
const count = (p) => st(p, () => window.mathboard.page.order.length);

const A = await user('A');
await A.goto(BASE + '/');
await A.waitForSelector('.card');
await shot(A, '01-landing');
await A.fill('input[placeholder="e.g. Alex"]', 'Alice');
await A.fill('input[placeholder="Board code or link"]', board);
await A.click('button:has-text("Join")');
await A.waitForFunction(() => window.mathboard?.ui.get().ready);
await A.waitForTimeout(300);
await shot(A, '02-board');
log('A url', A.url());

const B = await user('B');
await B.goto(BASE + '/b/' + board);
await B.waitForSelector('.card');
await B.fill('input[placeholder="e.g. Alex"]', 'Bob');
await B.click('button.primary');
await B.waitForFunction(() => window.mathboard?.ui.get().ready);
await A.waitForFunction(() => window.mathboard.ui.get().users.length === 2);
log('users', await st(A, () => window.mathboard.ui.get().users.map((u) => u.name + ':' + u.color)));

// board canvas origin
const box = await A.locator('.board').boundingBox();
const X = (x) => box.x + x, Y = (y) => box.y + y;

// --- live stroke ---
await A.mouse.move(X(200), Y(200));
await A.mouse.down();
for (let i = 1; i <= 20; i++) await A.mouse.move(X(200 + i * 10), Y(200 + Math.sin(i / 3) * 40));
await A.waitForTimeout(150);
const liveMid = await st(B, () => [...window.mathboard.remoteStrokes.values()].map((r) => r.points.length / 3));
log('B sees live stroke points mid-draw:', liveMid);
await A.mouse.up();
await B.waitForFunction(() => window.mathboard.page.order.length === 1);
log('after stroke: A', await count(A), 'B', await count(B));

// single tap leaves a dot
await A.mouse.click(X(450), Y(200));
await B.waitForFunction(() => window.mathboard.page.order.length === 2);
log('dot ok');

// --- each pen favourite ---
for (let k = 1; k <= 6; k++) {
  await A.keyboard.press(String(k));
  await A.mouse.move(X(150), Y(260 + k * 30));
  await A.mouse.down();
  for (let i = 1; i <= 25; i++) await A.mouse.move(X(150 + i * 12), Y(260 + k * 30 + Math.sin(i / 2) * 9));
  await A.mouse.up();
}
await B.waitForFunction(() => window.mathboard.page.order.length === 8);
log('pens:', await st(B, () => window.mathboard.page.order.map((id) => window.mathboard.page.objects[id].pen)));

// --- B draws at the same time as A ---
await B.keyboard.press('2');
await A.keyboard.press('3');
await A.mouse.move(X(600), Y(150)); await A.mouse.down();
await B.mouse.move(X(600), Y(250)); await B.mouse.down();
for (let i = 1; i <= 15; i++) { await A.mouse.move(X(600 + i * 10), Y(150 + i * 2)); await B.mouse.move(X(600 + i * 10), Y(250 - i * 2)); }
await A.mouse.up(); await B.mouse.up();
await A.waitForFunction(() => window.mathboard.page.order.length === 10);
await B.waitForFunction(() => window.mathboard.page.order.length === 10);
log('simultaneous ok');

// --- highlighter goes under ink ---
await A.keyboard.press('h');
await A.mouse.move(X(180), Y(200)); await A.mouse.down();
for (let i = 1; i <= 20; i++) await A.mouse.move(X(180 + i * 12), Y(200));
await A.mouse.up();
await A.waitForTimeout(100);
log('highlighter index (should be 0):', await st(A, () => { const p = window.mathboard.page; return p.order.findIndex((id) => p.objects[id].pen === 'highlighter' && p.objects[id].points.length > 30); }));
await shot(A, '03-ink');
await B.waitForTimeout(200);
await shot(B, '03-ink-B');

// --- undo / redo ---
await A.keyboard.press('Control+z');
await B.waitForFunction(() => window.mathboard.page.order.length === 10);
await A.keyboard.press('Control+Shift+z');
await B.waitForFunction(() => window.mathboard.page.order.length === 11);
log('undo/redo ok');

// --- stroke eraser ---
await A.keyboard.press('e');
await A.mouse.move(X(640), Y(100)); await A.mouse.down();
for (let i = 1; i <= 10; i++) await A.mouse.move(X(640), Y(100 + i * 20));
await A.mouse.up();
await A.waitForTimeout(150);
log('after stroke-erase: A', await count(A), 'B', await count(B));
await A.keyboard.press('Control+z');
await A.waitForTimeout(150);
log('after undo erase: A', await count(A), 'B', await count(B));

// --- partial eraser ---
await A.keyboard.press('e'); // toggles to partial
await A.mouse.move(X(300), Y(150)); await A.mouse.down();
for (let i = 1; i <= 10; i++) await A.mouse.move(X(300), Y(150 + i * 10));
await A.mouse.up();
await A.waitForTimeout(150);
log('after partial erase: A', await count(A), 'B', await count(B));
await A.keyboard.press('Control+z');
await A.waitForTimeout(150);
log('after undo partial: A', await count(A), 'B', await count(B));
await A.keyboard.press('e'); // back to stroke mode

// --- lasso select + selection bar ---
await A.keyboard.press('v');
await A.mouse.move(X(120), Y(270)); await A.mouse.down();
const lasso = [[520, 270], [520, 470], [120, 470], [120, 270]];
for (const [lx, ly] of lasso) await A.mouse.move(X(lx), Y(ly), { steps: 8 });
await A.mouse.up();
await A.waitForTimeout(150);
log('lasso selected:', await st(A, () => window.mathboard.sel.size));
await shot(A, '04-selection');
// move
const r = await st(A, () => window.mathboard.ui.get().sel.rect);
await A.mouse.move(X(r.x + r.w / 2), Y(r.y + r.h / 2)); await A.mouse.down();
await A.mouse.move(X(r.x + r.w / 2 + 60), Y(r.y + r.h / 2 + 40), { steps: 6 });
await A.mouse.up();
await A.waitForTimeout(150);
// recolor via bar
await A.click('.selbar .swatch-btn');
await A.waitForSelector('.popover .swatch');
await shot(A, '05-recolor');
await A.click('.popover .swatch >> nth=2');
await A.waitForTimeout(150);
log('recolored on B:', await st(B, () => { const p = window.mathboard.page; return p.order.map((id) => p.objects[id].color); }));
await A.keyboard.press('Escape');
await A.keyboard.press('Escape');

console.log('ERRORS', errors);
await browser.close();

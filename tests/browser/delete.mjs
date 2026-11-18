// One highlighter in the toolbar, and deleting a board (from its ☰ menu and from the start page).
// Usage: start the app (npm start), then: BASE=http://localhost:3000 node tests/browser/delete.mjs
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = process.env.SHOTS || path.join(os.tmpdir(), 'mathboard-shots');
mkdirSync(OUT, { recursive: true });
const stamp = Date.now().toString(36);
const errors = [];
let failures = 0;
const log = (...a) => console.log(...a);
const expect = (cond, what) => { if (!cond) throw new Error(what); };
async function step(name, fn) {
  try { await fn(); log('OK  ', name); } catch (err) { failures++; log('FAIL', name, '—', err.message); }
}

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
// an older save: the five default pens plus the yellow highlighter pen f6
const OLD_FAVS = [
  ['f1', 'ballpoint', 'ink'], ['f2', 'ballpoint', '#1971c2'], ['f3', 'ballpoint', '#e03131'], ['f4', 'ballpoint', '#2f9e44'],
  ['f5', 'pencil', 'ink'], ['f6', 'highlighter', '#ffe033'],
].map(([id, pen, color]) => ({ id, pen, color, size: pen === 'highlighter' ? 22 : 2.5, stab: 30 }));

async function user(name, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, colorScheme: opts.scheme ?? 'light' });
  await ctx.addInitScript(({ n, favs }) => {
    if (!localStorage.getItem('mathboard.name')) localStorage.setItem('mathboard.name', n);
    if (favs && !localStorage.getItem('mathboard.settings.v1')) localStorage.setItem('mathboard.settings.v1', JSON.stringify({ favs, activeFav: 5 }));
  }, { n: name, favs: opts.favs ?? null });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`[${name}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[${name}] PAGEERROR ${e.stack || e.message}`));
  return page;
}
const open = async (p, id) => {
  await p.goto(`${BASE}/b/${id}`);
  await p.waitForFunction(() => window.mathboard?.ui.get().ready && window.mathboard.ui.get().conn === 'connected');
};
const draw = async (p) => {
  await p.mouse.move(300, 300); await p.mouse.down();
  for (let i = 1; i <= 10; i++) await p.mouse.move(300 + i * 20, 300 + i * 6);
  await p.mouse.up();
  await p.waitForFunction(() => !window.mathboard.ui.get().saving);
};
const shot = (p, n) => p.screenshot({ path: path.join(OUT, `${n}.png`) });
const cachedIds = (p) => p.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('mathboard', 1);
  req.onsuccess = () => { const r = req.result.transaction('notebooks').objectStore('notebooks').getAllKeys(); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve([]); };
  req.onerror = () => resolve([]);
}));

const board1 = `del${stamp}a`, board2 = `del${stamp}b`;
const A = await user('Ann', { favs: OLD_FAVS });
const B = await user('Bob', { scheme: 'dark' });

await step('one highlighter: the old default highlighter pen is gone, the H tool stays', async () => {
  await open(A, board1);
  const pens = await A.$$eval('[aria-label^="Pen "]', (els) => els.map((e) => e.getAttribute('aria-label')));
  expect(pens.length === 5 && !pens.some((p) => /Highlighter/.test(p)), 'pens: ' + pens.join(', '));
  expect((await A.$$('[aria-label="Highlighter (H)"]')).length === 1, 'one Highlighter tool button');
  const saved = await A.evaluate(() => JSON.parse(localStorage.getItem('mathboard.settings.v1') ?? '{}'));
  expect(saved.v === 2 || saved.v === undefined, 'saved v ' + saved.v); // written on the next settings change
  const ui = await A.evaluate(() => { const s = window.mathboard.ui.get().settings; return { n: s.favs.length, active: s.activeFav }; });
  expect(ui.n === 5 && ui.active === 4, 'settings ' + JSON.stringify(ui));
  await shot(A, 'del-toolbar');
});

await step('delete from the ☰ menu: confirm, the other teacher is sent to the start page with a message', async () => {
  await draw(A);
  await A.click('.board-title');
  await A.fill('.popover input.field', 'Geometry review');
  await A.keyboard.press('Enter');
  await open(B, board1);
  await A.click('.topright .ibtn[aria-label="Menu"]');
  await A.click('.menu-item.danger:has-text("Delete board")');
  await A.waitForSelector('.dialog:has-text("Delete “Geometry review”?")');
  const body = await A.textContent('.dialog');
  expect(body.includes('Bob') && body.includes('30 days'), 'dialog text: ' + body);
  await shot(A, 'del-dialog');
  // Cancel keeps it
  await A.click('.dialog .btn:has-text("Cancel")');
  expect(await A.evaluate(() => window.mathboard.ui.get().deleted === null), 'cancel');
  await A.click('.topright .ibtn[aria-label="Menu"]');
  await A.click('.menu-item.danger:has-text("Delete board")');
  await A.click('.dialog .btn.danger:has-text("Delete board")');
  await A.waitForSelector('.landing .notice:has-text("was deleted")');
  await B.waitForSelector('.landing .notice:has-text("“Geometry review” was deleted by Ann.")');
  expect(new URL(A.url()).pathname === '/' && new URL(B.url()).pathname === '/', 'both on the start page');
  for (const [p, who] of [[A, 'A'], [B, 'B']]) {
    const recent = await p.evaluate(() => JSON.parse(localStorage.getItem('mathboard.recent') ?? '[]').map((r) => r.id));
    expect(!recent.includes(board1), `${who} recent still lists it`);
    expect(!(await cachedIds(p)).includes(board1), `${who} device copy still there`);
  }
  await shot(B, 'del-kicked-dark');
});

await step('an old link to a deleted board says so and creates nothing', async () => {
  await B.goto(`${BASE}/b/${board1}`);
  await B.waitForSelector('.landing .notice:has-text("was deleted, so it can no longer be opened")');
  expect(!(await cachedIds(B)).includes(board1), 'no device copy');
});

await step('delete from the start page: trash button, confirm, the row disappears', async () => {
  await open(A, board2);
  await draw(A);
  await open(B, board2);
  await A.goto(`${BASE}/`);
  await A.waitForSelector(`.recent-row:has-text("${board2}")`);
  await A.click(`.recent-row:has-text("${board2}") .recent-delete`);
  await A.waitForSelector(`.dialog:has-text("Delete board ${board2}?")`);
  await shot(A, 'del-landing-dialog');
  await A.click('.dialog .btn.danger:has-text("Delete board")');
  await A.waitForSelector(`.landing .notice:has-text("Board ${board2} was deleted.")`);
  expect((await A.$$(`.recent-row:has-text("${board2}")`)).length === 0, 'row gone');
  await B.waitForSelector(`.landing .notice:has-text("was deleted by Ann")`);
  await shot(A, 'del-landing-after');
});

log('console errors:', errors.length ? errors : 'none');
await browser.close();
log(failures ? `${failures} FAILED` : 'ALL OK');
process.exit(failures ? 1 : 0);

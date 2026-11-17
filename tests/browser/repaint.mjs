// The committed layer is maintained incrementally (slide + strips, dirty rectangles). This compares it
// with a fresh full repaint after every kind of operation. Only anti-aliasing on seam pixels may differ.
// Usage: start the app (npm start), then: BASE=http://localhost:3000 [DPR=2] node tests/browser/repaint.mjs
import os from 'node:os';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import path from 'node:path';
const OUT = process.env.SHOTS || path.join(os.tmpdir(), 'mathboard-shots');
mkdirSync(OUT, { recursive: true });
const BASE = process.env.BASE || 'http://localhost:3000';
const DPR = Number(process.env.DPR || 1);
const board = 'pix' + Date.now().toString(36);
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true, args: ['--disable-accelerated-2d-canvas'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: DPR });
await ctx.addInitScript(() => localStorage.setItem('mathboard.name', 'Pix'));
const P = await ctx.newPage();
const errors = [];
P.on('pageerror', (e) => errors.push(e.message));
P.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await P.goto(BASE + '/b/' + board);
await P.waitForFunction(() => window.mathboard?.ui.get().ready);
const box = await P.locator('.board').boundingBox();
const X = (x) => box.x + x, Y = (y) => box.y + y;

await P.evaluate(() => {
  const e = window.mathboard;
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const ops = [];
  for (let i = 0; i < 400; i++) {
    const ox = rnd() * 2400 - 400, oy = rnd() * 1600 - 300;
    const pts = [];
    for (let k = 0; k < 30; k++) pts.push(Math.round((ox + k * 3 + Math.sin(k / 3) * 9) * 10) / 10, Math.round((oy + Math.cos(k / 4) * 16 + k) * 10) / 10, 0.3 + 0.5 * rnd());
    const pen = ['ballpoint', 'fountain', 'pencil', 'marker', 'highlighter'][i % 5];
    ops.push({ kind: 'add', obj: { id: 's' + i, type: 'stroke', authorId: 'x', createdAt: 1, pen, color: ['ink', '#1971c2', '#e03131', '#ffe033'][i % 4], size: pen === 'highlighter' ? 22 : pen === 'marker' ? 8 : 3, opacity: pen === 'highlighter' ? 0.4 : 1, points: pts, bbox: [0, 0, 0, 0], stab: 30 } });
  }
  ops.push({ kind: 'add', obj: { id: 'ax', type: 'axes', authorId: 'x', createdAt: 1, x: 300, y: 200, w: 300, h: 300, xMin: -5, xMax: 5, yMin: -5, yMax: 5, xStep: 1, yStep: 1, showNumbers: true, mode: 'xy' } });
  ops.push({ kind: 'add', obj: { id: 'sh', type: 'shape', kind: 'arrow', authorId: 'x', createdAt: 1, points: [100, 100, 420, 180], color: '#2f9e44', size: 5 } });
  ops.push({ kind: 'add', obj: { id: 'tx', type: 'text', authorId: 'x', createdAt: 1, text: 'Hello MathBoard', x: 500, y: 90, fontSize: 32, color: 'ink' } });
  e.commit(ops, { undo: false });
});
await P.waitForTimeout(400);

/** returns the number of differing pixels between the incremental bitmap and a fresh full repaint */
const check = async (label) => {
  await P.waitForTimeout(260); // let the idle recentre run
  const r = await P.evaluate(async () => {
    const e = window.mathboard;
    const raf = () => new Promise((res) => requestAnimationFrame(res));
    await raf(); await raf();
    const c = document.querySelector('canvas.layer-main');
    const read = () => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const synced = e.cam.x === e.mainCam.x && e.cam.y === e.mainCam.y && e.cam.zoom === e.mainCam.zoom && c.style.transform === '';
    const a = read();
    e.invalidateMain();
    await raf(); await raf();
    const b = read();
    let diff = 0, ink = 0, big = 0, max = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (b[i + 3]) ink++;
      // compare as composited over white, which is what the eye sees
      let d = 0;
      for (let ch = 0; ch < 3; ch++) d = Math.max(d, Math.abs((255 - (255 - a[i + ch]) * a[i + 3] / 255) - (255 - (255 - b[i + ch]) * b[i + 3] / 255)));
      if (d > 10) diff++;
      // A stroke edge rasterised under a narrow strip clip can differ from the unclipped result by one
      // anti-aliasing sub-sample (a quarter of a pixel's coverage, about 60/255 for dark ink). That is not
      // a repaint error: a missed or doubled repaint differs by far more, so only larger deltas count.
      if (d > 80) big++;
      if (d > max) max = d;
    }
    return { diff, big, max: Math.round(max), ink, synced, w: c.width, h: c.height };
  });
  console.log(`${r.big === 0 && r.synced ? 'OK  ' : 'FAIL'} ${label}: ${r.diff} px differ slightly, ${r.big} visibly, max delta ${r.max}/255 (ink px ${r.ink}, synced ${r.synced})`);
};
const drag = async (pts, steps = 6) => {
  await P.mouse.move(X(pts[0][0]), Y(pts[0][1])); await P.mouse.down();
  for (const [x, y] of pts.slice(1)) await P.mouse.move(X(x), Y(y), { steps });
  await P.mouse.up(); await P.waitForTimeout(60);
};

await check('initial');
await P.mouse.move(X(500), Y(300));
await P.mouse.wheel(0, 137); await check('wheel pan down 137');
await P.mouse.wheel(0, 333); await P.mouse.wheel(0, 333); await check('wheel pan down 666 (beyond the overscan)');
await P.keyboard.down('Shift'); await P.mouse.wheel(0, -251); await P.keyboard.up('Shift'); await check('shift+wheel pan left');
for (let i = 0; i < 30; i++) await P.mouse.wheel(i % 3 ? 17 : -9, -23);
await check('many small diagonal pans');
// draw while the bitmap is still slid (no wait)
await P.mouse.wheel(0, -40);
await P.keyboard.press('1');
await drag([[200, 200], [260, 240], [330, 190], [400, 260]]);
await check('stroke drawn right after a pan');
await P.keyboard.press('h'); await drag([[150, 300], [600, 310]]); await check('highlighter inserted beneath ink');
await P.keyboard.press('4'); await drag([[220, 350], [300, 420], [380, 350]]); await check('another pen');
await P.keyboard.press('e'); await drag([[100, 150], [700, 500]], 30); await check('stroke eraser sweep');
await P.keyboard.press('Control+z'); await check('undo erase');
await P.keyboard.press('e'); await drag([[700, 150], [100, 500]], 30); await check('partial eraser sweep');
await P.keyboard.press('Control+z'); await check('undo partial erase');
await P.keyboard.press('e');
await P.keyboard.press('v');
await drag([[250, 150], [650, 150], [650, 420], [450, 440], [250, 420], [250, 152]], 10);
console.log('   selected', await P.evaluate(() => window.mathboard.sel.size));
let r = await P.evaluate(() => window.mathboard.ui.get().sel?.rect);
if (r) { await drag([[r.x + r.w / 2, r.y + r.h / 2], [r.x + r.w / 2 + 130, r.y + r.h / 2 - 70]]); await check('moved a lasso selection'); }
r = await P.evaluate(() => window.mathboard.ui.get().sel?.rect);
if (r) { await drag([[r.x + r.w, r.y + r.h], [r.x + r.w + 60, r.y + r.h + 40]]); await check('scaled the selection'); }
await P.keyboard.press('Control+z'); await P.keyboard.press('Control+z'); await check('undo scale + move');
await P.keyboard.press('Delete'); await check('delete selection');
await P.keyboard.press('Control+z'); await check('undo delete');
await P.keyboard.press('Escape');
await P.keyboard.down('Control'); await P.mouse.wheel(0, -240); await P.keyboard.up('Control'); await check('zoom in');
await P.mouse.wheel(0, 211); await check('pan while zoomed in');
await P.keyboard.press('2'); await drag([[300, 300], [380, 360], [460, 300]]); await check('stroke while zoomed');
await P.keyboard.down('Control'); await P.mouse.wheel(0, 700); await P.keyboard.up('Control'); await check('zoom far out');
await P.mouse.wheel(-300, -200); await check('pan zoomed out');
await P.screenshot({ path: path.join(OUT, `40-pix-dpr${DPR}.png`) });
console.log('cam', await P.evaluate(() => JSON.stringify(window.mathboard.cam)), 'ERRORS', errors);
await browser.close();

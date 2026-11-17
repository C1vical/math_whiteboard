// Measures how long a save blocks the event loop with a large notebook (20 pages x 5,000 strokes).
// Usage: npx tsx tests/perf/save-stall.ts   (or: npm run perf:save)
import { mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyOp } from '../../shared/ops';
import { Store } from '../../server/store';
import type { Page, Stroke } from '../../shared/types';

const PAGES = Number(process.env.PAGES ?? 20), STROKES = Number(process.env.STROKES ?? 5000);
const dir = mkdtempSync(path.join(tmpdir(), 'mathboard-perf-'));

const stroke = (id: string): Stroke => {
  const ox = Math.random() * 3400, oy = Math.random() * 1100;
  const pts: number[] = [];
  for (let k = 0; k < 40; k++) pts.push(Math.round((ox + k * 2 + Math.sin(k / 3) * 8) * 10) / 10, Math.round((oy + Math.cos(k / 4) * 14 + k) * 10) / 10, Math.round(Math.random() * 100) / 100);
  return { id, type: 'stroke', authorId: 'perf-user-0123456', createdAt: Date.now(), pen: 'ballpoint', color: '#1971c2', size: 2.5, opacity: 1, points: pts, bbox: [ox, oy, ox + 80, oy + 50], stab: 30 };
};

/** Longest gap between two turns of the event loop while `run` is in flight. */
async function stall(run: () => Promise<void>): Promise<number> {
  let worst = 0, last = performance.now(), on = true;
  const spin = () => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
    if (on) setImmediate(spin);
  };
  setImmediate(spin);
  await run();
  on = false;
  await new Promise((r) => setImmediate(r));
  return worst;
}

const store = new Store(dir, { saveDebounceMs: 0, quiet: true });
await store.init();
const room = await store.get('big');
const first = room.nb.pages[0];
room.nb.pages = Array.from({ length: PAGES }, (_, p): Page => {
  const page: Page = { id: p === 0 ? first.id : `page${p}`, title: `Page ${p + 1}`, background: 'grid', objects: {}, order: [] };
  for (let i = 0; i < STROKES; i++) { const s = stroke(`s${p}_${i}`); page.objects[s.id] = s; page.order.push(s.id); }
  return page;
});
const saved = () => new Promise<void>((res) => { store.onSaved = () => res(); });

// what the previous version did on every save: one JSON.stringify of the whole notebook
const t0 = performance.now();
const whole = JSON.stringify(room.nb);
const oldMs = performance.now() - t0;

const fullSave = await stall(async () => { const done = saved(); store.markDirty(room, room.nb.pages.map((p) => p.id)); await done; });

const incremental: number[] = [];
for (let i = 0; i < 12; i++) {
  const page = room.nb.pages[i % PAGES];
  incremental.push(await stall(async () => {
    const done = saved();
    applyOp(room.nb, { opId: `o${i}`, pageId: page.id, kind: 'add', obj: stroke(`new${i}`) });
    room.nb.updatedAt = Date.now();
    store.markDirty(room, [page.id]);
    await done;
  }));
}
const files = readdirSync(path.join(dir, 'big.pages'));
const bytes = files.reduce((n, f) => n + statSync(path.join(dir, 'big.pages', f)).size, 0);
const f1 = (n: number) => n.toFixed(1);
console.log(`notebook: ${PAGES} pages x ${STROKES} strokes, ${f1(whole.length / 1e6)} MB as one JSON document, ${files.length} page files (${f1(bytes / 1e6)} MB)`);
console.log(`before (single file): each save blocked the event loop for ${f1(oldMs)} ms (JSON.stringify of everything)`);
console.log(`now, first save of everything (cold): longest block ${f1(fullSave)} ms`);
console.log(`now, save after one new stroke: longest block ${f1(Math.max(...incremental))} ms worst, ${f1(incremental.slice().sort((a, b) => a - b)[Math.floor(incremental.length / 2)])} ms median (${incremental.length} saves)`);
await store.flushAll();
rmSync(dir, { recursive: true, force: true });

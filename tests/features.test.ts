// Part B: fixes and changes to existing features (pure logic).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backgroundMarks, breakBelow, layoutSheets, MARGIN_PT, outlineCubics, PAPER_SIZE, quadToCubic } from '../shared/exportLayout';
import { cascade, placeImages } from '../shared/imageSize';
import { applyPageOp, newNotebook } from '../shared/ops';
import { parseClipboard } from '../shared/schema';
import { CLIP_MAX_CHARS, CLIP_PREFIX, type BBox, type Notebook } from '../shared/types';
import { mkShape, mkStroke } from './helpers';

const root = path.resolve(__dirname, '..');

describe('B1 — board names', () => {
  it('notebookTitle renames the notebook, trimmed, and ignores empty or unchanged names', () => {
    const nb = newNotebook('nb', 'p1');
    expect(applyPageOp(nb, { opId: 'a', kind: 'notebookTitle', title: '  Algebra 2 — Period 3  ' })).toBe(true);
    expect(nb.title).toBe('Algebra 2 — Period 3');
    expect(applyPageOp(nb, { opId: 'b', kind: 'notebookTitle', title: 'Algebra 2 — Period 3' })).toBe(false);
    expect(applyPageOp(nb, { opId: 'c', kind: 'notebookTitle', title: '   ' })).toBe(false);
    expect(nb.title).toBe('Algebra 2 — Period 3');
  });
});

describe('B2 — dropped and pasted images do not pile up', () => {
  const view = { x: 0, y: 0, w: 1000, h: 800 };
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it('one image is centred on the drop point', () => {
    const [r] = placeImages([{ w: 400, h: 200 }], view, { x: 300, y: 250 });
    expect(r.x + r.w / 2).toBeCloseTo(300);
    expect(r.y + r.h / 2).toBeCloseTo(250);
    expect(r.w).toBeCloseTo(600); // the usual 60% of the view width
    const [c] = placeImages([{ w: 400, h: 200 }], view);
    expect(c.x + c.w / 2).toBeCloseTo(500);
  });

  it('several images are laid out so none hides another, around the drop point', () => {
    for (const n of [2, 3, 4, 5, 7, 9]) {
      const sizes = Array.from({ length: n }, (_, i) => ({ w: 300 + i * 40, h: 200 + (i % 3) * 90 }));
      const rects = placeImages(sizes, view, { x: 400, y: 300 });
      expect(rects.length).toBe(n);
      for (let i = 0; i < n; i++) {
        expect(rects[i].w / rects[i].h).toBeCloseTo(sizes[i].w / sizes[i].h); // aspect kept
        for (let j = i + 1; j < n; j++) expect(overlaps(rects[i], rects[j]), `${n}: ${i} vs ${j}`).toBe(false);
      }
      const minX = Math.min(...rects.map((r) => r.x)), maxX = Math.max(...rects.map((r) => r.x + r.w));
      const minY = Math.min(...rects.map((r) => r.y)), maxY = Math.max(...rects.map((r) => r.y + r.h));
      expect((minX + maxX) / 2).toBeCloseTo(400, 0);
      expect((minY + maxY) / 2).toBeCloseTo(300, 0);
      expect(maxX - minX).toBeLessThanOrEqual(view.w * 0.8 + 1);
    }
    expect(placeImages([], view)).toEqual([]);
  });

  it('a second paste in the same spot cascades instead of landing exactly on the first', () => {
    const r = { x: 100, y: 100, w: 50, h: 50 };
    expect(cascade(r, [], 24)).toEqual(r);
    expect(cascade(r, [{ x: 100, y: 100 }], 24)).toMatchObject({ x: 124, y: 124 });
    expect(cascade(r, [{ x: 100, y: 100 }, { x: 124, y: 124 }], 24)).toMatchObject({ x: 148, y: 148 });
  });
});

describe('B3 — copy and paste across tabs and boards', () => {
  const payload = (objs: unknown[], extra: Record<string, unknown> = {}) => CLIP_PREFIX + JSON.stringify({ v: 1, token: 't1', board: 'nb1', objs, ...extra });

  it('accepts board objects that pass the server rules, including images', () => {
    const img = { id: 'i', type: 'image', authorId: 'u', createdAt: 1, src: '/uploads/other/abc.png', x: 0, y: 0, w: 10, h: 10, naturalW: 10, naturalH: 10 };
    const p = parseClipboard(payload([mkStroke('a', [0, 0, 0.5]), mkShape('s', 'rect', [0, 0, 5, 5], { fill: '#ff0000' }), img]));
    expect(p?.objs.map((o) => o.type)).toEqual(['stroke', 'shape', 'image']);
    expect(p?.board).toBe('nb1');
  });

  it('rejects anything else', () => {
    expect(parseClipboard('hello')).toBeNull();
    expect(parseClipboard(CLIP_PREFIX + '{not json')).toBeNull();
    expect(parseClipboard(payload([]))).toBeNull(); // nothing to paste
    expect(parseClipboard(payload([{ ...mkShape('s', 'line', []) }]))).toBeNull(); // an invalid object
    expect(parseClipboard(payload([{ id: 'i', type: 'image', authorId: 'u', createdAt: 1, src: 'javascript:alert(1)', x: 0, y: 0, w: 1, h: 1, naturalW: 1, naturalH: 1 }]))).toBeNull();
    expect(parseClipboard(payload([mkStroke('a', [0, 0, 0.5])], { v: 2 }))).toBeNull();
    expect(parseClipboard(payload([mkStroke('a', [0, 0, 0.5])], { board: '../x' }))).toBeNull();
    // size cap
    const huge = CLIP_PREFIX + JSON.stringify({ v: 1, token: 't', board: 'nb', objs: [mkStroke('a', new Array(CLIP_MAX_CHARS / 2).fill(1))] });
    expect(huge.length).toBeGreaterThan(CLIP_MAX_CHARS);
    expect(parseClipboard(huge)).toBeNull();
  });
});

describe('B5 — a deleted page can be restored', () => {
  it('restorePage puts the page back with all its content at its old position', () => {
    const nb: Notebook = newNotebook('nb', 'p1');
    applyPageOp(nb, { opId: '1', kind: 'add', page: { id: 'p2', title: 'Two', background: 'dots' }, index: 1 });
    applyPageOp(nb, { opId: '2', kind: 'add', page: { id: 'p3', title: 'Three', background: 'blank' }, index: 2 });
    const page = nb.pages[1];
    page.objects.s = mkStroke('s', [1, 1, 0.5]);
    page.order.push('s');
    const saved = JSON.parse(JSON.stringify(page));
    expect(applyPageOp(nb, { opId: '3', kind: 'delete', pageId: 'p2' })).toBe(true);
    expect(nb.pages.map((p) => p.id)).toEqual(['p1', 'p3']);
    expect(applyPageOp(nb, { opId: '4', kind: 'restorePage', page: saved, index: 1 })).toBe(true);
    expect(nb.pages.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(nb.pages[1]).toEqual(saved);
    // never twice, and the op's page is not shared with the notebook
    expect(applyPageOp(nb, { opId: '5', kind: 'restorePage', page: saved, index: 0 })).toBe(false);
    nb.pages[1].order.push('x');
    expect(saved.order).toEqual(['s']);
  });
});

describe('B9 — export layout', () => {
  const tall: BBox = [0, 0, 800, 6000];

  it('fit to content: one sheet sized to the content', () => {
    const [s] = layoutSheets([100, 200, 500, 400], [], 'fit');
    expect(s.w).toBeCloseTo(480);
    expect(s.h).toBeCloseTo(280);
    expect(s.scale).toBe(1);
    expect(layoutSheets(null, [], 'fit').length).toBe(1);
  });

  it('Letter / A4: content is fitted inside the margins on paper of that size', () => {
    for (const paper of ['letter', 'a4'] as const) {
      const [s] = layoutSheets([0, 0, 1200, 500], [], paper);
      const size = PAPER_SIZE[paper];
      expect([s.w, s.h].sort((a, b) => a - b)).toEqual([size.w, size.h].sort((a, b) => a - b));
      expect(s.w).toBeGreaterThan(s.h); // a wide page goes landscape
      const right = s.ox + (s.src[2] - s.src[0]) * s.scale, bottom = s.oy + (s.src[3] - s.src[1]) * s.scale;
      expect(s.ox).toBeGreaterThanOrEqual(MARGIN_PT - 0.01);
      expect(right).toBeLessThanOrEqual(s.w - MARGIN_PT + 0.01);
      expect(s.oy).toBeGreaterThanOrEqual(MARGIN_PT - 0.01);
      expect(bottom).toBeLessThanOrEqual(s.h - MARGIN_PT + 0.01);
    }
    // small content is not blown up beyond 1.5x
    expect(layoutSheets([0, 0, 50, 30], [], 'letter')[0].scale).toBe(1.5);
  });

  it('content much taller than a sheet is split across sheets at a readable size, not shrunk', () => {
    const sheets = layoutSheets(tall, [], 'letter');
    expect(sheets.length).toBeGreaterThan(5);
    for (const s of sheets) {
      expect(s.scale).toBeGreaterThan(0.5);
      expect(s.clip).toBe(true);
      expect([s.w, s.h]).toEqual([PAPER_SIZE.letter.w, PAPER_SIZE.letter.h]);
      expect((s.src[3] - s.src[1]) * s.scale).toBeLessThanOrEqual(s.h - 2 * MARGIN_PT + 0.01);
    }
    // the sheets cover the content exactly, top to bottom, without gaps
    expect(sheets[0].src[1]).toBeLessThan(0);
    for (let i = 1; i < sheets.length; i++) expect(sheets[i].src[1]).toBeCloseTo(sheets[i - 1].src[3]);
    expect(sheets[sheets.length - 1].src[3]).toBeGreaterThan(6000);
  });

  it('a cut avoids running through a line of writing when it can', () => {
    const boxes: BBox[] = [[0, 900, 300, 960], [0, 1000, 300, 1060]];
    expect(breakBelow(boxes, 800, 1030)).toBe(1000); // just above the second line
    expect(breakBelow(boxes, 800, 990)).toBe(990);
    expect(breakBelow(boxes, 800, 950)).toBe(900); // just above the first line
    expect(breakBelow(boxes, 800, 980)).toBe(980); // already clear
    expect(breakBelow([[0, 0, 10, 5000]], 800, 1000)).toBe(1000); // nothing better: cut anyway
    const sheets = layoutSheets(tall, Array.from({ length: 60 }, (_, i): BBox => [0, i * 100 + 20, 700, i * 100 + 80]), 'a4');
    for (const s of sheets.slice(0, -1)) {
      const y = s.src[3];
      expect(Array.from({ length: 60 }, (_, i) => y > i * 100 + 20 && y < i * 100 + 80).some(Boolean)).toBe(false);
    }
  });

  it('page backgrounds become plain geometry', () => {
    const b: BBox = [0, 0, 400, 400];
    expect(backgroundMarks('blank', b)).toEqual({ minor: [], major: [], dots: [] });
    const grid = backgroundMarks('grid', b);
    expect(grid.minor.length).toBe(22); // 11 vertical + 11 horizontal lines, 40 apart
    const lined = backgroundMarks('lined', b);
    expect(lined.major.every((l) => l[1] === l[3])).toBe(true);
    const graph = backgroundMarks('graph', b);
    expect(graph.minor.length).toBe(42);
    expect(graph.major.length).toBe(10);
    expect(backgroundMarks('dots', b).dots.length).toBe(121);
    expect(backgroundMarks('dots', [0, 0, 1e6, 1e6]).dots.length).toBeLessThanOrEqual(6000);
  });

  it('ink outlines become the same smooth curve as on screen (quadratics as cubics)', () => {
    expect(quadToCubic(0, 0, 3, 3, 6, 0)).toEqual([2, 2, 4, 2, 6, 0]);
    const c = outlineCubics([[0, 0], [10, 0], [10, 10], [0, 10]])!;
    expect(c.start).toEqual([5, 0]);
    expect(c.segs.length).toBe(4);
    expect(c.segs[3].slice(4)).toEqual([5, 0]); // closes where it began
    expect(outlineCubics([[0, 0], [1, 1]])).toBeNull();
  });
});

describe('B11 — first visit follows the system theme', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  const storage = (saved: string | null) => ({ getItem: () => saved, setItem: () => {}, removeItem: () => {} });

  it('uses prefers-color-scheme when nothing is saved, and the saved choice otherwise', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(prefers-color-scheme: dark)' }));
    vi.stubGlobal('localStorage', storage(null));
    let { loadSettings } = await import('../client/src/engine/store');
    expect(loadSettings().dark).toBe(true);
    vi.stubGlobal('localStorage', storage(JSON.stringify({ dark: false })));
    expect(loadSettings().dark).toBe(false);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('localStorage', storage(null));
    ({ loadSettings } = await import('../client/src/engine/store'));
    expect(loadSettings().dark).toBe(false);
  });
});

describe('B12 — installable on iPad', () => {
  const pngSize = (f: string) => { const b = readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

  it('has a manifest with a name and icons, and the Apple tags', () => {
    const m = JSON.parse(readFileSync(path.join(root, 'client/public/manifest.webmanifest'), 'utf8'));
    expect(m.name).toBe('MathBoard');
    expect(m.display).toBe('standalone');
    for (const icon of m.icons) {
      const f = path.join(root, 'client/public', icon.src);
      expect(existsSync(f)).toBe(true);
      expect(pngSize(f).join('x')).toBe(icon.sizes);
    }
    expect(m.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true);
    const html = readFileSync(path.join(root, 'client/index.html'), 'utf8');
    for (const tag of ['rel="manifest"', 'apple-mobile-web-app-capable', 'apple-mobile-web-app-title', 'rel="apple-touch-icon"']) expect(html).toContain(tag);
    expect(pngSize(path.join(root, 'client/public/icons/apple-touch-icon.png'))).toEqual([180, 180]);
  });
});

describe('B13 — smaller first load', () => {
  it('the graph code builds only the parser from mathjs, and nothing at startup imports it', () => {
    const g = readFileSync(path.join(root, 'shared/graph.ts'), 'utf8');
    expect(g).not.toMatch(/create\(\s*all/);
    expect(g).toMatch(/parseDependencies/);
    // renderer and toolbar code reach the graph only through the lazy loader
    for (const f of ['client/src/engine/render.ts', 'client/src/engine/Engine.ts', 'client/src/engine/axesRender.ts', 'client/src/ui/Inspector.tsx', 'client/src/ui/Board.tsx']) {
      const src = readFileSync(path.join(root, f), 'utf8');
      expect(src, f).not.toMatch(/from '[./]*\/shared\/graph'|from '\.\/graphRender'|from '\.\/GraphPanel'/);
    }
  });
});

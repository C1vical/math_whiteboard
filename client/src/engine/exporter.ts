import { objBounds, unionBounds } from '../../../shared/geometry';
import type { Notebook, Page } from '../../../shared/types';
import type { Engine } from './Engine';
import { drawObject, type RenderEnv } from './render';

const PAD = 40;

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'mathboard';

async function loadImages(e: Engine, pages: Page[]): Promise<Map<string, ImageBitmap | HTMLImageElement>> {
  const out = new Map<string, ImageBitmap | HTMLImageElement>();
  const srcs = new Set<string>();
  for (const p of pages) for (const id of p.order) { const o = p.objects[id]; if (o?.type === 'image') srcs.add(o.src); }
  await Promise.all([...srcs].map(async (src) => {
    const blob = await e.images.blob(src);
    if (!blob) return;
    try {
      out.set(src, await createImageBitmap(blob));
    } catch {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      await new Promise<void>((res) => { img.onload = () => res(); img.onerror = () => res(); img.src = url; });
      if (img.naturalWidth) out.set(src, img);
    }
  }));
  return out;
}

/** Renders a page's content bounds (+ padding) on white, in light-mode colours. */
function renderPage(page: Page, images: Map<string, ImageBitmap | HTMLImageElement>, maxSide: number): HTMLCanvasElement | null {
  const objs = page.order.map((id) => page.objects[id]).filter(Boolean);
  const b = unionBounds(objs);
  if (!b) return null;
  const w = b[2] - b[0] + PAD * 2, h = b[3] - b[1] + PAD * 2;
  const scale = Math.min(2, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, (-b[0] + PAD) * scale, (-b[1] + PAD) * scale);
  const env: RenderEnv = { dark: false, getImage: (src) => images.get(src) ?? null, imageState: () => 'error' };
  const tapes = [];
  for (const o of objs) {
    if (o.type === 'tape' && !o.revealed) { tapes.push(o); continue; }
    drawObject(ctx, o, env);
  }
  for (const t of tapes) drawObject(ctx, t, env);
  void objBounds;
  return canvas;
}

export async function exportPagePng(e: Engine): Promise<void> {
  const page = e.page;
  const canvas = renderPage(page, await loadImages(e, [page]), 8000);
  if (!canvas) { e.toast('This page is empty — nothing to export'); return; }
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) { e.toast('Could not create the PNG', 'error'); return; }
  download(blob, `${safeName(page.title)}.png`);
}

export async function exportNotebookPdf(e: Engine): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const pages = e.nb.pages;
  const images = await loadImages(e, pages);
  let doc: InstanceType<typeof jsPDF> | null = null;
  for (const page of pages) {
    const canvas = renderPage(page, images, 3200);
    // PDF points; blank pages become an empty A4 landscape sheet
    let w = 842, h = 595;
    if (canvas) {
      const k = Math.min(1, 14000 / Math.max(canvas.width, canvas.height));
      w = Math.max(72, canvas.width * 0.5 * k);
      h = Math.max(72, canvas.height * 0.5 * k);
    }
    const orientation = w >= h ? 'landscape' : 'portrait';
    if (!doc) doc = new jsPDF({ unit: 'pt', format: [w, h], orientation, compress: true });
    else doc.addPage([w, h], orientation);
    if (canvas) doc.addImage(canvas.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, w, h, undefined, 'FAST');
  }
  if (!doc) return;
  download(doc.output('blob'), `${safeName(e.nb.title === 'Untitled notebook' ? `MathBoard ${e.nb.id}` : e.nb.title)}.pdf`);
}

interface BackupFile { format: 'mathboard'; version: 1; exportedAt: string; notebook: Notebook; images: Record<string, string> }

const toDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

/** Full backup: the notebook plus every image it uses, embedded as data URLs. */
export async function exportNotebookJson(e: Engine): Promise<void> {
  const images: Record<string, string> = {};
  let missing = 0;
  for (const p of e.nb.pages) {
    for (const id of p.order) {
      const o = p.objects[id];
      if (o?.type !== 'image' || images[o.src]) continue;
      const blob = await e.images.blob(o.src);
      if (blob) images[o.src] = await toDataUrl(blob); else missing++;
    }
  }
  const file: BackupFile = { format: 'mathboard', version: 1, exportedAt: new Date().toISOString(), notebook: e.nb, images };
  download(new Blob([JSON.stringify(file)], { type: 'application/json' }), `mathboard-${e.nb.id}-${new Date().toISOString().slice(0, 10)}.json`);
  if (missing) e.toast(`${missing} image(s) could not be read and were left out of the backup`, 'error');
}

/** Restores a backup file into the current notebook (replacing its contents for everyone). */
export async function importNotebookJson(e: Engine, file: File): Promise<void> {
  let data: BackupFile;
  try {
    data = JSON.parse(await file.text()) as BackupFile;
  } catch {
    throw new Error('That file is not valid JSON');
  }
  if (!data || data.format !== 'mathboard' || !data.notebook || !Array.isArray(data.notebook.pages) || !data.notebook.pages.length) {
    throw new Error('That file is not a MathBoard backup');
  }
  const blobs = new Map<string, Blob>();
  for (const [src, url] of Object.entries(data.images ?? {})) {
    if (typeof url === 'string' && url.startsWith('data:image/')) blobs.set(src, await (await fetch(url)).blob());
  }
  await e.uploadNotebook(data.notebook, async (src) => blobs.get(src) ?? null);
}

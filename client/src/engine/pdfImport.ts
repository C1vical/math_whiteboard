import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Engine } from './Engine';

export interface OpenPdf {
  name: string;
  numPages: number;
  /** renders a page; `scale` 1 = 72 dpi */
  render(pageNo: number, scale: number, maxSide?: number): Promise<{ canvas: HTMLCanvasElement; wPt: number; hPt: number }>;
  destroy(): void;
}

export async function openPdf(file: File): Promise<OpenPdf> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  return {
    name: file.name.replace(/\.pdf$/i, ''),
    numPages: doc.numPages,
    async render(pageNo, scale, maxSide = 2400) {
      const page = await doc.getPage(pageNo);
      const base = page.getViewport({ scale: 1 });
      const k = Math.min(scale, maxSide / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale: k });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup();
      return { canvas, wPt: base.width, hPt: base.height };
    },
    destroy() { void task.destroy(); },
  };
}

/**
 * Renders the chosen pages at 2× and inserts them as locked images — stacked on
 * the current page, or one per new board page.
 */
export async function importPdfPages(e: Engine, pdf: OpenPdf, pages: number[], mode: 'stack' | 'pages', onProgress: (done: number) => void): Promise<number> {
  const v = e.viewBox();
  let y = v[1] + 30;
  const left = v[0] + 40;
  let ok = 0;
  for (let i = 0; i < pages.length; i++) {
    const { canvas, wPt, hPt } = await pdf.render(pages[i], 2);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
    if (!blob) continue;
    // 1 PDF point = 1/72 in; the board uses 96 units per inch
    const w = Math.round((wPt * 96) / 72), h = Math.round((hPt * 96) / 72);
    let id: string | null;
    if (mode === 'pages') {
      const pageId = e.addPage(`${pdf.name} — p.${pages[i]}`.slice(0, 110), false);
      id = await e.insertImage(blob, { locked: true, pageId, rect: { x: 0, y: 0, w, h } });
    } else {
      id = await e.insertImage(blob, { locked: true, rect: { x: left, y, w, h } });
      y += h + 24;
    }
    if (id) ok++;
    onProgress(i + 1);
  }
  return ok;
}

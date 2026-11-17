import { downscaleSize } from '../../../shared/imageSize';
import { getCachedImage, putCachedImage } from './idb';

type Drawable = ImageBitmap | HTMLImageElement;
interface Entry { img: Drawable | null; state: 'loading' | 'ready' | 'error'; blob?: Blob; retryAt?: number }

async function decode(blob: Blob): Promise<Drawable> {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(blob); } catch { /* fall through (e.g. SVG) */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not decode image'));
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

export const drawableSize = (d: Drawable) =>
  d instanceof HTMLImageElement ? { w: d.naturalWidth, h: d.naturalHeight } : { w: d.width, h: d.height };

/** Loads board images, keeps decoded bitmaps, and mirrors the blobs into IndexedDB. */
export class ImageCache {
  private map = new Map<string, Entry>();
  constructor(private onLoad: () => void) {}

  get(src: string): Drawable | null {
    let e = this.map.get(src);
    if (!e || (e.state === 'error' && e.retryAt && Date.now() > e.retryAt)) {
      e = { img: null, state: 'loading' };
      this.map.set(src, e);
      void this.load(src, e);
    }
    return e.img;
  }

  state(src: string) { return this.map.get(src)?.state ?? 'loading'; }

  /** Pre-fills the cache with an image we already decoded locally (instant paste). */
  seed(src: string, img: Drawable, blob: Blob) {
    this.map.set(src, { img, state: 'ready', blob });
    void putCachedImage(src, blob);
  }

  /** Blob for export / restore: memory → IndexedDB → network. */
  async blob(src: string): Promise<Blob | null> {
    const e = this.map.get(src);
    if (e?.blob) return e.blob;
    const cached = await getCachedImage(src);
    if (cached) return cached;
    try {
      const res = await fetch(src);
      return res.ok ? await res.blob() : null;
    } catch {
      return null;
    }
  }

  private async load(src: string, e: Entry) {
    try {
      let blob: Blob | null = null;
      try {
        const res = await fetch(src);
        if (res.ok) {
          blob = await res.blob();
          void putCachedImage(src, blob);
        }
      } catch { /* offline: fall back to the device cache */ }
      if (!blob) blob = await getCachedImage(src);
      if (!blob) throw new Error('missing');
      e.img = await decode(blob);
      e.blob = blob;
      e.state = 'ready';
    } catch {
      e.state = 'error';
      e.retryAt = Date.now() + 8000;
    }
    this.onLoad();
  }
}

export interface PreparedImage { blob: Blob; w: number; h: number; drawable: Drawable }

const PASSTHROUGH = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function hasTransparency(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
  return false;
}

/**
 * Decodes an image and, if its longest side exceeds 2400 px (or its format is not
 * directly storable), downsizes and re-encodes it: JPEG q0.9, or PNG when it has
 * transparency.
 */
export async function prepareImage(file: Blob): Promise<PreparedImage> {
  const drawable = await decode(file);
  const nat = drawableSize(drawable);
  if (!nat.w || !nat.h) throw new Error('Could not read that image');
  const target = downscaleSize(nat.w, nat.h);
  if (!target.scaled && PASSTHROUGH.has(file.type)) return { blob: file, w: nat.w, h: nat.h, drawable };

  const canvas = document.createElement('canvas');
  canvas.width = target.w;
  canvas.height = target.h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(drawable, 0, 0, target.w, target.h);
  const alpha = file.type !== 'image/jpeg' && hasTransparency(ctx, target.w, target.h);
  const type = alpha ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, 0.9));
  return { blob, w: target.w, h: target.h, drawable: await decode(blob) };
}

export async function uploadImage(notebookId: string, blob: Blob, passcode: string): Promise<string> {
  const res = await fetch(`/api/upload/${notebookId}`, {
    method: 'POST',
    headers: { 'content-type': blob.type, ...(passcode ? { 'x-passcode': passcode } : {}) },
    body: blob,
  });
  if (!res.ok) {
    let msg = `Upload failed (${res.status})`;
    try { msg = ((await res.json()) as { error?: string }).error || msg; } catch { /* keep default */ }
    throw new Error(msg);
  }
  return ((await res.json()) as { url: string }).url;
}

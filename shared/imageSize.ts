export const MAX_IMAGE_SIDE = 2400;

/** Target pixel size for an image before upload (never upscales). */
export function downscaleSize(w: number, h: number, max = MAX_IMAGE_SIDE): { w: number; h: number; scaled: boolean } {
  const longest = Math.max(w, h);
  if (longest <= max || longest <= 0) return { w, h, scaled: false };
  const k = max / longest;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), scaled: true };
}

export interface Rect { x: number; y: number; w: number; h: number }

/** World-space placement: centred in view, ~60% of viewport width, capped to 80% of its height. */
export function placeImage(natW: number, natH: number, view: Rect): Rect {
  let w = view.w * 0.6;
  let h = (w * natH) / natW;
  if (h > view.h * 0.8) { h = view.h * 0.8; w = (h * natW) / natH; }
  return { x: view.x + (view.w - w) / 2, y: view.y + (view.h - h) / 2, w, h };
}

/**
 * Placement for one or more images that arrive together (a drop or a paste).
 * One image keeps the usual size and is centred on `at` (the drop point) or in the view.
 * Several are laid out in a grid of rows, so none hides another; the block is centred on `at`.
 */
export function placeImages(sizes: { w: number; h: number }[], view: Rect, at?: { x: number; y: number } | null): Rect[] {
  const n = sizes.length;
  if (!n) return [];
  const cx = at ? at.x : view.x + view.w / 2, cy = at ? at.y : view.y + view.h / 2;
  if (n === 1) {
    const r = placeImage(sizes[0].w, sizes[0].h, view);
    return [{ x: cx - r.w / 2, y: cy - r.h / 2, w: r.w, h: r.h }];
  }
  const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
  const gap = view.w * 0.015;
  const cellW = (view.w * 0.8 - gap * (cols - 1)) / cols;
  const cellH = (view.h * 0.8 - gap * (rows - 1)) / rows;
  const fitted = sizes.map((s) => {
    const k = Math.min(cellW / s.w, cellH / s.h);
    return { w: s.w * k, h: s.h * k };
  });
  // each row is as tall as its tallest image and as wide as its images; rows are centred
  const rowH: number[] = [], rowW: number[] = [];
  for (let r = 0; r < rows; r++) {
    const row = fitted.slice(r * cols, (r + 1) * cols);
    rowH.push(Math.max(...row.map((f) => f.h)));
    rowW.push(row.reduce((sum, f) => sum + f.w, 0) + gap * (row.length - 1));
  }
  const totalH = rowH.reduce((a, b) => a + b, 0) + gap * (rows - 1);
  const out: Rect[] = [];
  let y = cy - totalH / 2;
  for (let r = 0; r < rows; r++) {
    let x = cx - rowW[r] / 2;
    for (const f of fitted.slice(r * cols, (r + 1) * cols)) {
      out.push({ x, y: y + (rowH[r] - f.h) / 2, w: f.w, h: f.h });
      x += f.w + gap;
    }
    y += rowH[r] + gap;
  }
  return out;
}

/**
 * Moves `rect` diagonally by `step` until its corner is not (almost) exactly on one of
 * `taken`, so a second paste in the same view does not land precisely on the first.
 */
export function cascade(rect: Rect, taken: { x: number; y: number }[], step: number): Rect {
  let { x, y } = rect;
  for (let i = 0; i < 40 && taken.some((t) => Math.abs(t.x - x) < step / 2 && Math.abs(t.y - y) < step / 2); i++) { x += step; y += step; }
  return { ...rect, x, y };
}

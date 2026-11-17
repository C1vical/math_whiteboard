export const MAX_IMAGE_SIDE = 2400;

/** Target pixel size for an image before upload (never upscales). */
export function downscaleSize(w: number, h: number, max = MAX_IMAGE_SIDE): { w: number; h: number; scaled: boolean } {
  const longest = Math.max(w, h);
  if (longest <= max || longest <= 0) return { w, h, scaled: false };
  const k = max / longest;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), scaled: true };
}

/** World-space placement: centred in view, ~60% of viewport width, capped to 80% of its height. */
export function placeImage(natW: number, natH: number, view: { x: number; y: number; w: number; h: number }) {
  let w = view.w * 0.6;
  let h = (w * natH) / natW;
  if (h > view.h * 0.8) { h = view.h * 0.8; w = (h * natW) / natH; }
  return { x: view.x + (view.w - w) / 2, y: view.y + (view.h - h) / 2, w, h };
}

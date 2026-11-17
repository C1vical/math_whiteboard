import type { Page } from './types';

// "Reset for the next class": what the reset actions touch on a page.

/** Strokes and shapes that are not locked (images, graphs, axes, text and tape stay). */
export function inkToClear(page: Page): string[] {
  return page.order.filter((id) => {
    const o = page.objects[id];
    return !!o && (o.type === 'stroke' || o.type === 'shape') && !o.locked;
  });
}

/** Tape that is currently revealed (so covering it again changes something). */
export function tapeToCover(page: Page): string[] {
  return page.order.filter((id) => { const o = page.objects[id]; return o?.type === 'tape' && o.revealed; });
}

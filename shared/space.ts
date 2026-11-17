import { objBounds } from './geometry';
import type { Op, Page } from './types';

/** Ids of the objects that an insert/remove-space drag starting at `at` will push. */
export function spaceTargets(page: Page, axis: 'x' | 'y', at: number): string[] {
  const out: string[] = [];
  for (const id of page.order) {
    const o = page.objects[id];
    if (!o) continue;
    const b = objBounds(o);
    if ((axis === 'y' ? b[1] : b[0]) >= at) out.push(id);
  }
  return out;
}

/** The single op that inserts (delta > 0) or removes (delta < 0) space. */
export function spaceOp(page: Page, axis: 'x' | 'y', at: number, delta: number): Op | null {
  const ids = spaceTargets(page, axis, at);
  if (!ids.length || !delta) return null;
  return { opId: '', pageId: page.id, kind: 'move', ids, dx: axis === 'x' ? delta : 0, dy: axis === 'y' ? delta : 0 };
}

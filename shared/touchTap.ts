// Two-finger tap = undo, three-finger tap = redo (as in GoodNotes and Procreate).
// A tap is: fingers put down together, lifted quickly, without moving. Anything that pans or
// pinches, takes too long, or happens around pen input is not a tap.

export const TAP_MAX_MS = 350;
/** later fingers must land this soon after the first */
export const TAP_GATHER_MS = 200;
/** how far (CSS px) a finger may wander and still count as a tap */
export const TAP_SLOP = 12;

export type TapResult = 'undo' | 'redo' | null;

export class MultiTapDetector {
  private t0 = 0;
  private origins = new Map<number, { x: number; y: number }>();
  private down = new Set<number>();
  private max = 0;
  private spoiled = false;

  /** a finger touched down */
  start(id: number, x: number, y: number, t: number) {
    if (this.down.size === 0) {
      this.t0 = t;
      this.origins.clear();
      this.max = 0;
      this.spoiled = false;
    } else if (t - this.t0 > TAP_GATHER_MS) this.spoiled = true;
    this.origins.set(id, { x, y });
    this.down.add(id);
    this.max = Math.max(this.max, this.down.size);
    if (this.max > 3) this.spoiled = true;
  }

  move(id: number, x: number, y: number) {
    const o = this.origins.get(id);
    if (o && Math.hypot(x - o.x, y - o.y) > TAP_SLOP) this.spoiled = true;
  }

  /** a finger lifted; returns what to do once the last one is up */
  end(id: number, t: number): TapResult {
    if (!this.down.delete(id)) return null;
    if (this.down.size > 0) return null;
    const ok = !this.spoiled && t - this.t0 <= TAP_MAX_MS;
    this.spoiled = true;
    if (!ok) return null;
    return this.max === 2 ? 'undo' : this.max === 3 ? 'redo' : null;
  }

  /** something else is going on (pen input, the system cancelled a touch): no tap this time */
  spoil() { this.spoiled = true; }
  cancel(id: number) { this.down.delete(id); this.spoiled = true; }
}

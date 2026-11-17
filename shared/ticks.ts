// Axis tick helpers. Kept apart from shared/graph.ts so the axes renderer does not load the parser.

/** A "nice" step (1, 2 or 5 × 10^k) giving roughly `target` divisions over `range`. */
export function niceStep(range: number, target: number): number {
  if (!(range > 0) || !(target > 0)) return 1;
  const raw = range / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / pow;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * pow;
}

export function formatTick(v: number, step: number): string {
  if (Math.abs(v) < step / 1e6) return '0';
  const decimals = Math.max(0, Math.min(8, -Math.floor(Math.log10(step) + 1e-9)));
  const s = v.toFixed(decimals);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

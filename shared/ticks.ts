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

// ---------- multiples of π (for trig graphs) ----------

/** Steps offered for a π axis, as fractions of π. */
const PI_STEPS = [1 / 12, 1 / 6, 1 / 4, 1 / 2, 1, 2, 5, 10, 20, 50, 100];

/** A tick step that is a simple fraction or multiple of π, giving roughly `target` divisions. */
export function piStep(range: number, target: number): number {
  if (!(range > 0) || !(target > 0)) return Math.PI;
  const raw = range / target / Math.PI;
  const k = PI_STEPS.find((s) => s >= raw * 0.999) ?? Math.ceil(raw / 100) * 100;
  return k * Math.PI;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** Label for v as a multiple of π: 0, π/2, π, 3π/2, −2π, 5π/6 … (`step` is the tick step). */
export function formatPi(v: number, step: number): string {
  const unit = step / Math.PI;
  // denominator of the step (12, 6, 4, 2 or 1)
  const den = unit >= 1 ? 1 : Math.round(1 / unit);
  let num = Math.round((v / Math.PI) * den);
  if (num === 0) return '0';
  const sign = num < 0 ? '−' : '';
  num = Math.abs(num);
  const g = gcd(num, den);
  const n = num / g, d = den / g;
  const top = n === 1 ? 'π' : `${n}π`;
  return d === 1 ? `${sign}${top}` : `${sign}${top}/${d}`;
}

import { formatPi, formatTick, niceStep, piStep } from '../../../shared/ticks';
import type { Axes } from '../../../shared/types';
import type { RenderEnv } from './render';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const validRange = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && b - a > 1e-9;

function arrow(ctx: CanvasRenderingContext2D, tx: number, ty: number, ang: number, size: number) {
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx - size * Math.cos(ang - 0.42), ty - size * Math.sin(ang - 0.42));
  ctx.lineTo(tx - size * Math.cos(ang + 0.42), ty - size * Math.sin(ang + 0.42));
  ctx.closePath();
  ctx.fill();
}

/** Ticks from min..max, thinning the step if there would be far too many. */
function ticks(min: number, max: number, step: number): { values: number[]; step: number } {
  let s = Number.isFinite(step) && step > 0 ? step : niceStep(max - min, 10);
  while ((max - min) / s > 80) s *= 2;
  const values: number[] = [];
  const first = Math.ceil(min / s - 1e-9) * s;
  for (let v = first; v <= max + s * 1e-9; v += s) values.push(Math.abs(v) < s / 1e6 ? 0 : v);
  return { values, step: s };
}

/** x ticks: the axes' own step, or multiples of π (the step is rounded to a fraction of π). */
function xTicks(a: Axes) {
  if (!a.piTicks) { const t = ticks(a.xMin, a.xMax, a.xStep); return { ...t, label: (v: number) => formatTick(v, t.step) }; }
  let step = Number.isFinite(a.xStep) && a.xStep > 0 ? a.xStep : piStep(a.xMax - a.xMin, 8);
  const k = step / Math.PI;
  // snap to the nearest simple fraction or multiple of π
  step = (k >= 1 ? Math.round(k) : 1 / Math.max(1, Math.round(1 / k))) * Math.PI;
  const t = ticks(a.xMin, a.xMax, step);
  return { ...t, label: (v: number) => formatPi(v, t.step) };
}

const label = (s: string | null | undefined, fallback: string) => (s ?? fallback).trim();

/** Hand-drawable coordinate axes / number line (transparent, so ink goes on top). */
export function drawAxes(ctx: CanvasRenderingContext2D, a: Axes, x: number, y: number, w: number, h: number, env: RenderEnv) {
  const color = env.dark ? '#f1f3f5' : '#16181d';
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.font = `13px ${FONT}`;
  const head = 10;
  const tick = 5;

  if (a.mode === 'numberLine') {
    if (!validRange(a.xMin, a.xMax)) { ctx.restore(); return; }
    const cy = y + h / 2;
    ctx.beginPath(); ctx.moveTo(x, cy); ctx.lineTo(x + w, cy); ctx.stroke();
    arrow(ctx, x + w, cy, 0, head); arrow(ctx, x, cy, Math.PI, head);
    // keep ticks clear of the arrow heads
    const pad = 22;
    const fx = (v: number) => x + pad + ((v - a.xMin) / (a.xMax - a.xMin)) * (w - 2 * pad);
    const t = xTicks(a);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.beginPath();
    for (const v of t.values) { ctx.moveTo(fx(v), cy - tick - 1); ctx.lineTo(fx(v), cy + tick + 1); }
    ctx.stroke();
    if (a.showNumbers) for (const v of t.values) ctx.fillText(t.label(v), fx(v), cy + tick + 5);
    const xl = label(a.xLabel, '');
    if (xl) {
      ctx.font = `italic 15px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(xl, x + w, cy - tick - 4);
    }
    ctx.restore();
    return;
  }

  if (!validRange(a.xMin, a.xMax) || !validRange(a.yMin, a.yMax)) { ctx.restore(); return; }
  const fx = (v: number) => x + ((v - a.xMin) / (a.xMax - a.xMin)) * w;
  const fy = (v: number) => y + h - ((v - a.yMin) / (a.yMax - a.yMin)) * h;
  const ax = fx(Math.max(a.xMin, Math.min(a.xMax, 0))), ay = fy(Math.max(a.yMin, Math.min(a.yMax, 0)));
  const ext = 14; // axes extend a little past the last tick, ending in arrows
  const tx = xTicks(a), ty = ticks(a.yMin, a.yMax, a.yStep);
  if (a.grid) {
    // light grid lines inside the axes box, one per tick
    ctx.save();
    ctx.strokeStyle = env.dark ? 'rgba(255,255,255,0.13)' : 'rgba(40,70,120,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const v of tx.values) { ctx.moveTo(fx(v), y); ctx.lineTo(fx(v), y + h); }
    for (const v of ty.values) { ctx.moveTo(x, fy(v)); ctx.lineTo(x + w, fy(v)); }
    ctx.stroke();
    ctx.restore();
  }
  ctx.beginPath();
  ctx.moveTo(x - ext, ay); ctx.lineTo(x + w + ext, ay);
  ctx.moveTo(ax, y - ext); ctx.lineTo(ax, y + h + ext);
  ctx.stroke();
  arrow(ctx, x + w + ext, ay, 0, head); arrow(ctx, x - ext, ay, Math.PI, head);
  arrow(ctx, ax, y - ext, -Math.PI / 2, head); arrow(ctx, ax, y + h + ext, Math.PI / 2, head);

  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const v of tx.values) if (v !== 0 || ax !== fx(0)) { ctx.moveTo(fx(v), ay - tick); ctx.lineTo(fx(v), ay + tick); }
  for (const v of ty.values) if (v !== 0 || ay !== fy(0)) { ctx.moveTo(ax - tick, fy(v)); ctx.lineTo(ax + tick, fy(v)); }
  ctx.stroke();
  if (a.showNumbers) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of tx.values) if (v !== 0) ctx.fillText(tx.label(v), fx(v), ay + tick + 3);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of ty.values) if (v !== 0) ctx.fillText(formatTick(v, ty.step), ax - tick - 4, fy(v));
  }
  // axis labels at the arrow ends (kept inside the box's width so repaints cover them)
  ctx.font = `italic 15px ${FONT}`;
  const xl = label(a.xLabel, 'x'), yl = label(a.yLabel, 'y');
  if (xl) {
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(xl, x + w + ext, ay - 7);
  }
  if (yl) {
    const right = ax < x + w / 2;
    ctx.textAlign = right ? 'left' : 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(yl, ax + (right ? 9 : -9), y - ext + 4);
  }
  ctx.restore();
}

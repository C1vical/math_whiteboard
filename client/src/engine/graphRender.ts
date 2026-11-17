import { compileGraph, formatTick, niceStep, sampleFunction, type CompiledGraph } from '../../../shared/graph';
import type { Axes, Graph } from '../../../shared/types';
import type { RenderEnv } from './render';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

interface GraphData { compiled: CompiledGraph; curves: Map<string, number[][]> }
// objects are replaced on every update, so identity is a valid cache key
const cache = new WeakMap<Graph, GraphData>();

export function sliderValues(g: Graph): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of g.sliders ?? []) out[s.name] = s.value;
  return out;
}

function graphData(g: Graph): GraphData {
  let d = cache.get(g);
  if (d) return d;
  const compiled = compileGraph(g.expressions, sliderValues(g));
  const curves = new Map<string, number[][]>();
  const n = Math.max(200, Math.min(700, Math.round(g.w)));
  for (const it of compiled.items) {
    if (it.kind === 'fn' && it.fn) curves.set(it.id, sampleFunction(it.fn, g.xMin, g.xMax, g.yMin, g.yMax, n));
  }
  d = { compiled, curves };
  cache.set(g, d);
  return d;
}

const validRange = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && b - a > 1e-9;

/** Desmos-lite graph panel, drawn in world units inside (x, y, w, h). */
export function drawGraph(ctx: CanvasRenderingContext2D, g: Graph, x: number, y: number, w: number, h: number, env: RenderEnv) {
  const dark = env.dark;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 6);
  ctx.fillStyle = dark ? '#17181b' : '#ffffff';
  ctx.fill();
  ctx.clip();

  if (validRange(g.xMin, g.xMax) && validRange(g.yMin, g.yMax)) {
    const sx = w / (g.xMax - g.xMin), sy = h / (g.yMax - g.yMin);
    const fx = (v: number) => x + (v - g.xMin) * sx;
    const fy = (v: number) => y + h - (v - g.yMin) * sy;
    const xStep = niceStep(g.xMax - g.xMin, Math.max(2, w / 55));
    const yStep = niceStep(g.yMax - g.yMin, Math.max(2, h / 45));
    const axisColor = dark ? '#d5d9df' : '#30343b';

    if (g.showGrid) {
      for (const [step, color, lw] of [[1 / 5, dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)', 1], [1, dark ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.13)', 1]] as const) {
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        ctx.beginPath();
        const xs = xStep * step, ys = yStep * step;
        for (let v = Math.ceil(g.xMin / xs) * xs; v <= g.xMax; v += xs) { ctx.moveTo(fx(v), y); ctx.lineTo(fx(v), y + h); }
        for (let v = Math.ceil(g.yMin / ys) * ys; v <= g.yMax; v += ys) { ctx.moveTo(x, fy(v)); ctx.lineTo(x + w, fy(v)); }
        ctx.stroke();
      }
    }

    // axes
    const ax = Math.max(x, Math.min(x + w, fx(0))), ay = Math.max(y, Math.min(y + h, fy(0)));
    ctx.strokeStyle = axisColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (g.yMin <= 0 && g.yMax >= 0) { ctx.moveTo(x, ay); ctx.lineTo(x + w, ay); }
    if (g.xMin <= 0 && g.xMax >= 0) { ctx.moveTo(ax, y); ctx.lineTo(ax, y + h); }
    ctx.stroke();

    if (g.showNumbers) {
      ctx.fillStyle = dark ? '#aeb4bd' : '#555c66';
      ctx.font = `11px ${FONT}`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'center';
      const ly = Math.max(y + 2, Math.min(y + h - 14, ay + 3));
      for (let v = Math.ceil(g.xMin / xStep) * xStep; v <= g.xMax; v += xStep) {
        if (Math.abs(v) < xStep / 1e6) continue;
        const px = fx(v);
        if (px > x + 10 && px < x + w - 10) ctx.fillText(formatTick(v, xStep), px, ly);
      }
      ctx.textBaseline = 'middle';
      for (let v = Math.ceil(g.yMin / yStep) * yStep; v <= g.yMax; v += yStep) {
        if (Math.abs(v) < yStep / 1e6) continue;
        const py = fy(v);
        if (py < y + 8 || py > y + h - 8) continue;
        const label = formatTick(v, yStep);
        const tw = ctx.measureText(label).width;
        const lx = ax - 5 - tw < x + 2 ? Math.min(x + w - tw - 2, Math.max(x + 3, ax + 5)) : ax - 5 - tw;
        ctx.textAlign = 'left';
        ctx.fillText(label, lx, py);
      }
    }

    // curves
    const data = graphData(g);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const expr of g.expressions) {
      if (!expr.visible) continue;
      const it = data.compiled.items.find((i) => i.id === expr.id);
      if (!it) continue;
      ctx.strokeStyle = expr.color;
      ctx.fillStyle = expr.color;
      ctx.lineWidth = 2.4;
      const strict = it.rel === '<' || it.rel === '>';
      const above = it.rel === '>' || it.rel === '>=';
      ctx.setLineDash(strict ? [8, 6] : []);
      if (it.kind === 'fn') {
        const paths = data.curves.get(it.id) ?? [];
        if (it.rel && it.rel !== '=') {
          ctx.globalAlpha = 0.16;
          const edge = above ? y - 10 : y + h + 10;
          for (const p of paths) {
            ctx.beginPath();
            ctx.moveTo(fx(p[0]), edge);
            for (let i = 0; i < p.length; i += 2) ctx.lineTo(fx(p[i]), fy(p[i + 1]));
            ctx.lineTo(fx(p[p.length - 2]), edge);
            ctx.closePath();
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
        ctx.beginPath();
        for (const p of paths) {
          ctx.moveTo(fx(p[0]), fy(p[1]));
          for (let i = 2; i < p.length; i += 2) ctx.lineTo(fx(p[i]), fy(p[i + 1]));
        }
        ctx.stroke();
      } else if (it.kind === 'vline' && it.value !== undefined) {
        const px = fx(it.value);
        if (it.rel && it.rel !== '=') {
          ctx.globalAlpha = 0.16;
          if (above) ctx.fillRect(px, y, x + w - px, h); else ctx.fillRect(x, y, px - x, h);
          ctx.globalAlpha = 1;
        }
        ctx.beginPath();
        ctx.moveTo(px, y); ctx.lineTo(px, y + h);
        ctx.stroke();
      } else if (it.kind === 'point' && it.point) {
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(fx(it.point[0]), fy(it.point[1]), 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = dark ? '#17181b' : '#ffffff';
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  } else {
    ctx.fillStyle = dark ? '#aeb4bd' : '#555c66';
    ctx.font = `13px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Invalid window (min must be less than max)', x + w / 2, y + h / 2);
  }
  ctx.restore();
  ctx.strokeStyle = dark ? '#555b66' : '#b6bcc6';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 6);
  ctx.stroke();
  ctx.textAlign = 'left';
}

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
    const t = ticks(a.xMin, a.xMax, a.xStep);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.beginPath();
    for (const v of t.values) { ctx.moveTo(fx(v), cy - tick - 1); ctx.lineTo(fx(v), cy + tick + 1); }
    ctx.stroke();
    if (a.showNumbers) for (const v of t.values) ctx.fillText(formatTick(v, t.step), fx(v), cy + tick + 5);
    ctx.restore();
    return;
  }

  if (!validRange(a.xMin, a.xMax) || !validRange(a.yMin, a.yMax)) { ctx.restore(); return; }
  const fx = (v: number) => x + ((v - a.xMin) / (a.xMax - a.xMin)) * w;
  const fy = (v: number) => y + h - ((v - a.yMin) / (a.yMax - a.yMin)) * h;
  const ax = fx(Math.max(a.xMin, Math.min(a.xMax, 0))), ay = fy(Math.max(a.yMin, Math.min(a.yMax, 0)));
  const ext = 14; // axes extend a little past the last tick, ending in arrows
  ctx.beginPath();
  ctx.moveTo(x - ext, ay); ctx.lineTo(x + w + ext, ay);
  ctx.moveTo(ax, y - ext); ctx.lineTo(ax, y + h + ext);
  ctx.stroke();
  arrow(ctx, x + w + ext, ay, 0, head); arrow(ctx, x - ext, ay, Math.PI, head);
  arrow(ctx, ax, y - ext, -Math.PI / 2, head); arrow(ctx, ax, y + h + ext, Math.PI / 2, head);

  const tx = ticks(a.xMin, a.xMax, a.xStep), ty = ticks(a.yMin, a.yMax, a.yStep);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const v of tx.values) if (v !== 0 || ax !== fx(0)) { ctx.moveTo(fx(v), ay - tick); ctx.lineTo(fx(v), ay + tick); }
  for (const v of ty.values) if (v !== 0 || ay !== fy(0)) { ctx.moveTo(ax - tick, fy(v)); ctx.lineTo(ax + tick, fy(v)); }
  ctx.stroke();
  if (a.showNumbers) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of tx.values) if (v !== 0) ctx.fillText(formatTick(v, tx.step), fx(v), ay + tick + 3);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of ty.values) if (v !== 0) ctx.fillText(formatTick(v, ty.step), ax - tick - 4, fy(v));
  }
  ctx.restore();
}

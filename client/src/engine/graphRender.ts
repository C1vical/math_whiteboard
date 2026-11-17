import { compileGraph, formatTick, niceStep, sampleFunction, type CompiledGraph } from '../../../shared/graph';
import type { Graph } from '../../../shared/types';
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

import {
  compileGraph, contourImplicit, findPOIs, nearestCurvePoint, sampleFunction, sliderValueAt, type CompiledGraph, type Poi,
} from '../../../shared/graph';
import { formatPi, formatTick, niceStep, piStep } from '../../../shared/ticks';
import type { Graph } from '../../../shared/types';
import type { RenderEnv } from './render';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

interface GraphData {
  compiled: CompiledGraph;
  curves: Map<string, number[][]>;
  pois: Poi[] | null;
}
/** Objects are replaced on every update, so identity (plus the slider values, which can move with time) is the cache key. */
const cache = new WeakMap<Graph, { key: string; data: GraphData }>();

/** Clock used for playing sliders (the engine installs the server clock). */
let clock: () => number = () => Date.now();
export function setGraphClock(fn: () => number) { clock = fn; }
export const graphNow = () => clock();

/** true when any slider of the graph is playing (the graph has to be redrawn every frame). */
export const isAnimated = (g: Graph) => (g.sliders ?? []).some((s) => !!s.play);

export function sliderValues(g: Graph, now = clock()): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of g.sliders ?? []) out[s.name] = sliderValueAt(s, now);
  return out;
}

const visibleIds = (g: Graph) => new Set(g.expressions.filter((e) => e.visible).map((e) => e.id));

function graphData(g: Graph, now = clock()): GraphData {
  const values = sliderValues(g, now);
  const key = isAnimated(g) ? JSON.stringify(values) : '';
  const hit = cache.get(g);
  if (hit && hit.key === key) return hit.data;
  const compiled = compileGraph(g.expressions, values, { angle: g.angle });
  const curves = new Map<string, number[][]>();
  const n = Math.max(200, Math.min(700, Math.round(g.w)));
  for (const it of compiled.items) {
    if (it.kind === 'fn' && it.fn) curves.set(it.id, sampleFunction(it.fn, g.xMin, g.xMax, g.yMin, g.yMax, n));
    else if (it.kind === 'implicit' && it.F) {
      // about one cell per 3 world units, so curves are smooth at the size the graph is shown
      curves.set(it.id, contourImplicit(it.F, g.xMin, g.xMax, g.yMin, g.yMax, Math.max(40, Math.min(240, g.w / 3)), Math.max(40, Math.min(240, g.h / 3))));
    }
  }
  const data: GraphData = { compiled, curves, pois: null };
  cache.set(g, { key, data });
  return data;
}

const validRange = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && b - a > 1e-9;

/** x-axis ticks: ordinary numbers, or multiples of π when the graph asks for it. */
function xTicks(g: Graph, w: number): { step: number; label: (v: number) => string } {
  if (g.piTicks) {
    const step = piStep(g.xMax - g.xMin, Math.max(2, w / 60));
    return { step, label: (v) => formatPi(v, step) };
  }
  const step = niceStep(g.xMax - g.xMin, Math.max(2, w / 55));
  return { step, label: (v) => formatTick(v, step) };
}

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
    const xt = xTicks(g, w);
    const xStep = xt.step;
    const yStep = niceStep(g.yMax - g.yMin, Math.max(2, h / 45));
    const axisColor = dark ? '#d5d9df' : '#30343b';

    if (g.showGrid) {
      for (const [step, color, lw] of [[g.piTicks ? 1 / 2 : 1 / 5, dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)', 1], [1, dark ? 'rgba(255,255,255,0.13)' : 'rgba(0,0,0,0.13)', 1]] as const) {
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        ctx.beginPath();
        const xs = xStep * step, ys = yStep * (step === 1 ? 1 : 1 / 5);
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
      for (let v = Math.ceil(g.xMin / xStep - 1e-9) * xStep; v <= g.xMax; v += xStep) {
        if (Math.abs(v) < xStep / 1e6) continue;
        const px = fx(v);
        if (px > x + 10 && px < x + w - 10) ctx.fillText(xt.label(v), px, ly);
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
      if (it.kind === 'fn' || it.kind === 'implicit') {
        const paths = data.curves.get(it.id) ?? [];
        if (it.kind === 'fn' && it.rel && it.rel !== '=') {
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
        if (it.mask) {
          // a restricted vertical line ({0 < y < 5}): only the allowed stretches
          const n = 240;
          let on = false;
          for (let k = 0; k <= n; k++) {
            const gy = g.yMin + ((g.yMax - g.yMin) * k) / n;
            const ok = it.mask(it.value, gy);
            if (ok && !on) ctx.moveTo(px, fy(gy)); else if (ok) ctx.lineTo(px, fy(gy));
            on = ok;
          }
        } else { ctx.moveTo(px, y); ctx.lineTo(px, y + h); }
        ctx.stroke();
      } else if (it.kind === 'point' && it.point && (!it.mask || it.mask(it.point[0], it.point[1]))) {
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

// ---------- points of interest (display only) ----------

/** Intercepts, turning points and intersections of the graph's visible curves (cached). */
export function graphPOIs(g: Graph): Poi[] {
  if (!validRange(g.xMin, g.xMax) || !validRange(g.yMin, g.yMax)) return [];
  const d = graphData(g);
  if (!d.pois) d.pois = findPOIs(d.compiled, visibleIds(g), g.xMin, g.xMax, g.yMin, g.yMax);
  return d.pois;
}

/** The point on a visible curve nearest to (gx, gy) in graph units, or null. Tolerances in graph units. */
export function probeGraph(g: Graph, gx: number, gy: number, tolX: number, tolY: number) {
  const d = graphData(g);
  return nearestCurvePoint(d.compiled, visibleIds(g), gx, gy, tolX, tolY, d.curves);
}

/** Graph coordinates ↔ world coordinates for a (possibly rotated) graph object. */
export function graphToWorld(g: Graph, gx: number, gy: number): [number, number] {
  const lx = ((gx - g.xMin) / (g.xMax - g.xMin) - 0.5) * g.w, ly = (0.5 - (gy - g.yMin) / (g.yMax - g.yMin)) * g.h;
  const r = g.rotation || 0, c = Math.cos(r), s = Math.sin(r);
  return [g.x + g.w / 2 + lx * c - ly * s, g.y + g.h / 2 + lx * s + ly * c];
}
export function worldToGraph(g: Graph, wx: number, wy: number): [number, number] {
  const r = -(g.rotation || 0), c = Math.cos(r), s = Math.sin(r);
  const dx = wx - (g.x + g.w / 2), dy = wy - (g.y + g.h / 2);
  const lx = dx * c - dy * s, ly = dx * s + dy * c;
  return [g.xMin + (lx / g.w + 0.5) * (g.xMax - g.xMin), g.yMin + (0.5 - ly / g.h) * (g.yMax - g.yMin)];
}

import { arrowHead, frameOf, LINE_H, type Frame } from '../../../shared/geometry';
import { pencilAlpha, strokeOutline, type InkStyle } from '../../../shared/ink';
import type { Background, BoardObject, Camera, ImageObj, Shape, Stroke, Tape, TextObj } from '../../../shared/types';
import { drawAxes, drawGraph } from './graphRender';

export interface RenderEnv {
  dark: boolean;
  getImage(src: string): CanvasImageSource | null;
  imageState?(src: string): 'loading' | 'ready' | 'error';
}

export const BOARD_BG = { light: '#ffffff', dark: '#1f2125' };
export const INK_COLOR = { light: '#16181d', dark: '#f1f3f5' };
export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** 'ink' is the semantic foreground: black on a light board, white on a dark one. */
export function resolveColor(c: string, dark: boolean): string {
  return c === 'ink' ? (dark ? INK_COLOR.dark : INK_COLOR.light) : c;
}

// ---------- stroke paths ----------
interface CachedPath { path: Path2D; dx: number; dy: number }
const pathCache = new WeakMap<object, CachedPath>();

/** Builds a smooth closed Path2D through a perfect-freehand outline. */
export function outlinePath(pts: number[][]): Path2D {
  const path = new Path2D();
  const n = pts.length;
  if (n === 0) return path;
  if (n < 3) {
    path.arc(pts[0][0], pts[0][1], 0.5, 0, Math.PI * 2);
    return path;
  }
  path.moveTo((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2);
  for (let i = 1; i <= n; i++) {
    const a = pts[i % n], b = pts[(i + 1) % n];
    path.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }
  path.closePath();
  return path;
}

function strokePath(s: Stroke): CachedPath {
  let c = pathCache.get(s);
  if (!c) {
    c = { path: outlinePath(strokeOutline(s, s.points)), dx: 0, dy: 0 };
    pathCache.set(s, c);
  }
  return c;
}

/** When an object is only translated, reuse its outline instead of recomputing it. */
export function carryPath(oldObj: object, newObj: object, dx: number, dy: number) {
  const c = pathCache.get(oldObj);
  if (c) pathCache.set(newObj, { path: c.path, dx: c.dx + dx, dy: c.dy + dy });
}

// ---------- pencil texture ----------
const noiseTiles = new Map<string, HTMLCanvasElement>();
const patterns = new WeakMap<CanvasRenderingContext2D, Map<string, CanvasPattern>>();

function pencilPattern(ctx: CanvasRenderingContext2D, color: string): CanvasPattern | string {
  let per = patterns.get(ctx);
  if (!per) { per = new Map(); patterns.set(ctx, per); }
  let p = per.get(color);
  if (p) return p;
  let tile = noiseTiles.get(color);
  if (!tile) {
    // precomputed graphite grain: the pen colour at pseudo-random alpha
    tile = document.createElement('canvas');
    tile.width = tile.height = 96;
    const tctx = tile.getContext('2d')!;
    tctx.fillStyle = color;
    tctx.fillRect(0, 0, 96, 96);
    const img = tctx.getImageData(0, 0, 96, 96);
    let seed = 1234567;
    for (let i = 3; i < img.data.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const r = seed / 4294967296;
      img.data[i] = r < 0.14 ? 40 : 120 + Math.floor(r * 135);
    }
    tctx.putImageData(img, 0, 0);
    noiseTiles.set(color, tile);
  }
  const made = ctx.createPattern(tile, 'repeat');
  if (!made) return color;
  made.setTransform(new DOMMatrix().scale(0.8));
  per.set(color, made);
  return made;
}

function fillInk(ctx: CanvasRenderingContext2D, style: InkStyle & { color: string; opacity: number }, points: number[], path: Path2D, env: RenderEnv) {
  const color = resolveColor(style.color, env.dark);
  if (style.pen === 'pencil') {
    ctx.globalAlpha = pencilAlpha(style, points);
    ctx.fillStyle = pencilPattern(ctx, color);
  } else {
    ctx.globalAlpha = style.opacity;
    ctx.fillStyle = color;
  }
  ctx.fill(path);
  ctx.globalAlpha = 1;
}

export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, env: RenderEnv) {
  const c = strokePath(s);
  if (c.dx || c.dy) {
    ctx.save();
    ctx.translate(c.dx, c.dy);
    fillInk(ctx, s, s.points, c.path, env);
    ctx.restore();
  } else fillInk(ctx, s, s.points, c.path, env);
}

/** Uncached stroke rendering — used for in-progress (local and remote) ink and replay. */
export function drawLiveStroke(ctx: CanvasRenderingContext2D, style: InkStyle & { color: string; opacity: number }, points: number[], env: RenderEnv) {
  if (points.length < 3) return;
  fillInk(ctx, style, points, outlinePath(strokeOutline(style, points)), env);
}

// ---------- other objects ----------
function withFrame(ctx: CanvasRenderingContext2D, f: Frame, draw: (x: number, y: number, w: number, h: number) => void) {
  if (f.rot) {
    ctx.save();
    ctx.translate(f.cx, f.cy);
    ctx.rotate(f.rot);
    draw(-f.w / 2, -f.h / 2, f.w, f.h);
    ctx.restore();
  } else draw(f.cx - f.w / 2, f.cy - f.h / 2, f.w, f.h);
}

export function drawShape(ctx: CanvasRenderingContext2D, sh: Shape, env: RenderEnv) {
  const p = sh.points;
  const color = resolveColor(sh.color, env.dark);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = sh.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const dash = sh.dashed ? [Math.max(6, sh.size * 3), Math.max(5, sh.size * 2.6)] : [];
  ctx.setLineDash(dash);
  ctx.beginPath();
  let closed = true;
  const f = frameOf(sh);
  if (f) {
    if (f.rot) { ctx.translate(f.cx, f.cy); ctx.rotate(f.rot); ctx.translate(-f.cx, -f.cy); }
    if (sh.kind === 'rect') ctx.rect(f.cx - f.w / 2, f.cy - f.h / 2, f.w, f.h);
    else ctx.ellipse(f.cx, f.cy, f.w / 2, f.h / 2, 0, 0, Math.PI * 2);
  } else if (sh.kind === 'triangle' || sh.kind === 'polygon') {
    ctx.moveTo(p[0], p[1]);
    for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
    ctx.closePath();
  } else {
    closed = false;
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(p[2], p[3]);
  }
  if (closed && sh.fill) {
    ctx.globalAlpha = sh.fillOpacity ?? 0.25;
    ctx.fillStyle = resolveColor(sh.fill, env.dark);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.stroke();
  if (sh.kind === 'arrow' || sh.kind === 'doubleArrow') {
    ctx.setLineDash([]);
    const heads = [arrowHead(p[2], p[3], p[0], p[1], sh.size)];
    if (sh.kind === 'doubleArrow') heads.push(arrowHead(p[0], p[1], p[2], p[3], sh.size));
    ctx.beginPath();
    for (const h of heads) { ctx.moveTo(h[0], h[1]); ctx.lineTo(h[2], h[3]); ctx.lineTo(h[4], h[5]); }
    ctx.stroke();
  }
  ctx.restore();
}

function drawImageObj(ctx: CanvasRenderingContext2D, o: ImageObj, env: RenderEnv) {
  const img = env.getImage(o.src);
  withFrame(ctx, frameOf(o)!, (x, y, w, h) => {
    if (img) {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, x, y, w, h);
      return;
    }
    const failed = env.imageState?.(o.src) === 'error';
    ctx.fillStyle = env.dark ? '#2c2f36' : '#eef0f3';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = env.dark ? '#4a4f59' : '#c9ced6';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = env.dark ? '#9aa1ad' : '#7b8494';
    ctx.font = `${Math.max(10, Math.min(18, h / 6))}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(failed ? 'Image unavailable' : 'Loading image…', x + w / 2, y + h / 2);
    ctx.textAlign = 'left';
  });
}

function drawText(ctx: CanvasRenderingContext2D, o: TextObj, env: RenderEnv) {
  withFrame(ctx, frameOf(o)!, (x, y) => {
    ctx.fillStyle = resolveColor(o.color, env.dark);
    ctx.font = `${o.fontSize}px ${FONT}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const lines = o.text.split('\n');
    const lh = o.fontSize * LINE_H;
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], x, y + i * lh + (lh - o.fontSize) / 2);
  });
}

export function drawTape(ctx: CanvasRenderingContext2D, o: Tape) {
  withFrame(ctx, frameOf(o)!, (x, y, w, h) => {
    const r = Math.min(6, w / 2, h / 2);
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    if (o.revealed) {
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = o.color;
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.setLineDash([7, 5]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = o.color;
      ctx.stroke();
    } else {
      ctx.fillStyle = o.color;
      ctx.fill();
      ctx.clip();
      ctx.globalAlpha = 0.16;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 7;
      ctx.beginPath();
      for (let d = -h; d < w + h; d += 22) { ctx.moveTo(x + d, y + h); ctx.lineTo(x + d + h, y); }
      ctx.stroke();
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      ctx.stroke();
    }
    ctx.restore();
  });
}

/** Draws one board object in world coordinates. Never throws. */
export function drawObject(ctx: CanvasRenderingContext2D, o: BoardObject, env: RenderEnv) {
  try {
    switch (o.type) {
      case 'stroke': drawStroke(ctx, o, env); break;
      case 'shape': drawShape(ctx, o, env); break;
      case 'image': drawImageObj(ctx, o, env); break;
      case 'text': drawText(ctx, o, env); break;
      case 'tape': drawTape(ctx, o); break;
      case 'axes': withFrame(ctx, frameOf(o)!, (x, y, w, h) => drawAxes(ctx, o, x, y, w, h, env)); break;
      case 'graph': withFrame(ctx, frameOf(o)!, (x, y, w, h) => drawGraph(ctx, o, x, y, w, h, env)); break;
    }
  } catch (err) {
    console.error('[render] object failed', o.id, err);
  }
}

// ---------- page background ----------
export function gridUnit(bg: Background): number {
  return bg === 'graph' ? 20 : bg === 'grid' || bg === 'dots' ? 40 : 0;
}

export function drawBackground(ctx: CanvasRenderingContext2D, bg: Background, cam: Camera, w: number, h: number, dark: boolean) {
  ctx.fillStyle = dark ? BOARD_BG.dark : BOARD_BG.light;
  ctx.fillRect(0, 0, w, h);
  if (bg === 'blank') return;
  const z = cam.zoom;
  const minor = dark ? 'rgba(255,255,255,0.07)' : 'rgba(40,70,120,0.11)';
  const major = dark ? 'rgba(255,255,255,0.16)' : 'rgba(40,70,120,0.24)';

  const lines = (step: number, color: string, vertical: boolean, horizontal: boolean) => {
    let s = step;
    while (s * z < 7) s *= 5; // too dense to be useful: thin out
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (vertical) {
      for (let x = Math.floor(cam.x / s) * s; (x - cam.x) * z <= w; x += s) {
        const sx = Math.round((x - cam.x) * z) + 0.5;
        ctx.moveTo(sx, 0); ctx.lineTo(sx, h);
      }
    }
    if (horizontal) {
      for (let y = Math.floor(cam.y / s) * s; (y - cam.y) * z <= h; y += s) {
        const sy = Math.round((y - cam.y) * z) + 0.5;
        ctx.moveTo(0, sy); ctx.lineTo(w, sy);
      }
    }
    ctx.stroke();
  };

  if (bg === 'grid') lines(40, minor, true, true);
  else if (bg === 'graph') {
    if (20 * z >= 7) lines(20, minor, true, true);
    lines(100, major, true, true);
  } else if (bg === 'lined') lines(40, major, false, true);
  else if (bg === 'dots') {
    let s = 40;
    while (s * z < 12) s *= 2;
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.22)' : 'rgba(40,70,120,0.32)';
    const r = Math.max(1, Math.min(2.2, 1.3 * z));
    for (let x = Math.floor(cam.x / s) * s; (x - cam.x) * z <= w; x += s) {
      for (let y = Math.floor(cam.y / s) * s; (y - cam.y) * z <= h; y += s) {
        ctx.fillRect((x - cam.x) * z - r / 2, (y - cam.y) * z - r / 2, r, r);
      }
    }
  }
}

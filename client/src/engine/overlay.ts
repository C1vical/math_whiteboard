import { CM, knobPos, PROT_BASE, PROT_R, RULER_LEN, RULER_W } from '../../../shared/ruler';
import type { RulerState } from '../../../shared/types';
import { FONT } from './render';

const rad = (d: number) => (d * Math.PI) / 180;

/** Readable angle: 0..180, the way a teacher would say it. */
export function displayAngle(deg: number): number {
  let a = ((-deg % 180) + 180) % 180; // screen y is down, so negate for the usual counter-clockwise sense
  if (Math.abs(a - 180) < 0.05) a = 0;
  return Math.round(a * 10) / 10;
}

/**
 * Draws a ruler or protractor in world coordinates (ctx already has the camera
 * transform). `tint` is the owner's colour for remote rulers, null for my own.
 */
export function drawRuler(ctx: CanvasRenderingContext2D, r: RulerState, zoom: number, dark: boolean, tint: string | null, hoverAngle: number | null) {
  const line = dark ? 'rgba(235,240,250,0.85)' : 'rgba(30,40,60,0.8)';
  const body = dark ? 'rgba(120,135,160,0.30)' : 'rgba(190,205,225,0.42)';
  ctx.save();
  ctx.translate(r.x, r.y);
  ctx.rotate(rad(r.angle));
  ctx.lineWidth = 1 / zoom;
  ctx.strokeStyle = tint ?? line;
  ctx.fillStyle = body;
  const px = 1 / zoom; // one screen pixel in world units

  if (r.kind === 'ruler') {
    const L = RULER_LEN, W = RULER_W;
    ctx.beginPath();
    ctx.roundRect(-L / 2, -W / 2, L, W, 6);
    ctx.fill();
    ctx.lineWidth = (tint ? 2 : 1.2) * px;
    ctx.stroke();
    ctx.strokeStyle = line;
    ctx.fillStyle = line;
    ctx.lineWidth = px;
    const mm = CM / 10;
    const showMm = mm * zoom >= 3;
    const showHalf = (CM / 2) * zoom >= 4;
    ctx.beginPath();
    for (const edge of [-1, 1]) {
      const y0 = (edge * W) / 2;
      const count = Math.floor(L / mm);
      for (let i = 0; i <= count; i++) {
        const isCm = i % 10 === 0, isHalf = i % 5 === 0;
        if (!isCm && !(isHalf && showHalf) && !showMm) continue;
        const x = -L / 2 + i * mm;
        const len = isCm ? 16 : isHalf ? 11 : 7;
        ctx.moveTo(x, y0);
        ctx.lineTo(x, y0 - edge * len);
      }
    }
    ctx.stroke();
    if (CM * zoom >= 16) {
      ctx.font = `${11}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const cms = Math.floor(L / CM);
      for (let i = 1; i < cms; i++) ctx.fillText(String(i), -L / 2 + i * CM, -W / 2 + 19);
    }
    // angle readout
    ctx.font = `600 ${15}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${displayAngle(r.angle)}°`, 0, 8);
  } else {
    const R = PROT_R;
    ctx.beginPath();
    ctx.moveTo(-R, 0);
    ctx.arc(0, 0, R, Math.PI, 0);
    ctx.lineTo(R, PROT_BASE);
    ctx.lineTo(-R, PROT_BASE);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = (tint ? 2 : 1.2) * px;
    ctx.stroke();
    ctx.strokeStyle = line;
    ctx.fillStyle = line;
    ctx.lineWidth = px;
    const showOne = (R * rad(1)) * zoom >= 3;
    ctx.beginPath();
    for (let d = 0; d <= 180; d++) {
      const ten = d % 10 === 0, five = d % 5 === 0;
      if (!ten && !five && !showOne) continue;
      const len = ten ? 18 : five ? 12 : 7;
      const c = Math.cos(rad(d)), s = -Math.sin(rad(d));
      ctx.moveTo(c * R, s * R);
      ctx.lineTo(c * (R - len), s * (R - len));
    }
    // base line and centre mark
    ctx.moveTo(-R, 0); ctx.lineTo(R, 0);
    ctx.moveTo(0, -12); ctx.lineTo(0, 6);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, 3.5 * Math.max(1, px), 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `${11}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let d = 0; d <= 180; d += 10) {
      const c = Math.cos(rad(d)), s = -Math.sin(rad(d));
      ctx.save();
      ctx.translate(c * (R - 30), s * (R - 30));
      ctx.rotate(rad(90 - d));
      ctx.fillText(String(d), 0, 0);
      ctx.restore();
    }
    ctx.font = `600 ${14}px ${FONT}`;
    const label = hoverAngle !== null ? `${Math.round(hoverAngle)}°` : `base ${displayAngle(r.angle)}°`;
    ctx.fillText(label, 0, PROT_BASE / 2 + 1);
  }
  ctx.restore();

  if (!tint) {
    // rotate knob (mine only)
    const [kx, ky] = knobPos(r);
    ctx.save();
    ctx.beginPath();
    ctx.arc(kx, ky, 15 * px, 0, Math.PI * 2);
    ctx.fillStyle = dark ? 'rgba(40,44,52,0.9)' : 'rgba(255,255,255,0.92)';
    ctx.fill();
    ctx.lineWidth = 1.5 * px;
    ctx.strokeStyle = '#1971c2';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(kx, ky, 7 * px, -Math.PI * 0.85, Math.PI * 0.5);
    ctx.stroke();
    const tipA = Math.PI * 0.5;
    const tx = kx + 7 * px * Math.cos(tipA), ty = ky + 7 * px * Math.sin(tipA);
    ctx.beginPath();
    ctx.moveTo(tx - 4.5 * px, ty - 3.5 * px); ctx.lineTo(tx - 0.5 * px, ty + 0.5 * px); ctx.lineTo(tx + 3.5 * px, ty - 4 * px);
    ctx.stroke();
    ctx.restore();
  }
}

const TOOL_GLYPH: Record<string, string> = {
  pen: '✎', highlighter: '▍', eraser: '⌫', select: '⬚', shape: '△', laser: '✦', space: '↕', text: 'T', graph: 'ƒ', axes: '∟', tape: '▬',
};

/** Remote cursor: coloured dot + name label + tool glyph (screen coordinates). */
export function drawCursor(ctx: CanvasRenderingContext2D, x: number, y: number, name: string, color: string, tool: string, alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const label = `${TOOL_GLYPH[tool] ?? ''} ${name}`.trim();
  ctx.font = `600 11px ${FONT}`;
  const w = ctx.measureText(label).width + 10;
  ctx.beginPath();
  ctx.roundRect(x + 8, y + 6, w, 18, 5);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(label, x + 13, y + 15.5);
  ctx.restore();
}

export interface LaserPoint { x: number; y: number; t: number }
export const LASER_MS = 1500;

/** Glowing, fading laser trail (or a single dot) in screen coordinates. */
export function drawLaser(ctx: CanvasRenderingContext2D, pts: LaserPoint[], color: string, now: number, mode: 'trail' | 'dot', toScreen: (x: number, y: number) => [number, number]) {
  if (!pts.length) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = color;
  if (mode === 'trail') {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (b.t - a.t > 250) continue; // separate gestures
      const life = 1 - (now - b.t) / LASER_MS;
      if (life <= 0) continue;
      const [ax, ay] = toScreen(a.x, a.y), [bx, by] = toScreen(b.x, b.y);
      ctx.globalAlpha = Math.min(1, life * 1.3);
      ctx.shadowBlur = 12;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2 + 5 * life;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 0.6 + 1.8 * life;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
  }
  const last = pts[pts.length - 1];
  const life = 1 - (now - last.t) / (mode === 'dot' ? 900 : LASER_MS);
  if (life > 0) {
    const [x, y] = toScreen(last.x, last.y);
    ctx.globalAlpha = Math.min(1, life * 1.5);
    ctx.shadowBlur = 18;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, mode === 'dot' ? 8 : 5.5, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath(); ctx.arc(x, y, mode === 'dot' ? 3 : 2.2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

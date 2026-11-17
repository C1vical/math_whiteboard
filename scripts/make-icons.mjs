// Draws the app icon (the MathBoard squiggle) into PNGs for the web app manifest and iOS.
// Pure Node, no dependencies: node scripts/make-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../client/public/icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

// geometry in a 64 x 64 box, the same as the favicon
const cubic = (p0, p1, p2, p3, n = 64) => Array.from({ length: n + 1 }, (_, i) => {
  const t = i / n, u = 1 - t;
  return [u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]];
});
const curve = [...cubic([14, 44], [22, 22], [26, 22], [32, 36]), ...cubic([32, 36], [38, 50], [42, 50], [50, 22]).slice(1)];
const segDist = (px, py, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
};
const inRounded = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), 64 - r), cy = Math.min(Math.max(y, r), 64 - r);
  return Math.hypot(x - cx, y - cy) <= r && x >= 0 && x <= 64 && y >= 0 && y <= 64;
};

/** RGBA pixels: blue background (rounded unless `bleed`), white stroke; `scale` shrinks the drawing (safe zone). */
function render(size, { radius = 14, bleed = false, scale = 1 } = {}) {
  const px = new Uint8Array(size * size * 4);
  const SS = 4;
  const bg = [0x19, 0x71, 0xc2];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let cover = 0, ink = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const u = ((x + (sx + 0.5) / SS) / size) * 64, v = ((y + (sy + 0.5) / SS) / size) * 64;
      if (!(bleed || inRounded(u, v, radius))) continue;
      cover++;
      const lu = 32 + (u - 32) / scale, lv = 32 + (v - 32) / scale;
      let d = Infinity;
      for (let i = 1; i < curve.length && d > 3.1; i++) d = Math.min(d, segDist(lu, lv, curve[i - 1], curve[i]));
      if (d <= 3.1) ink++;
    }
    const a = cover / (SS * SS), k = cover ? ink / cover : 0;
    const o = (y * size + x) * 4;
    for (let c = 0; c < 3; c++) px[o + c] = Math.round(bg[c] * (1 - k) + 255 * k);
    px[o + 3] = Math.round(a * 255);
  }
  return px;
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const write = (name, size, opts) => writeFileSync(new URL(name, OUT), png(size, render(size, opts)));
write('icon-192.png', 192);
write('icon-512.png', 512);
// maskable: full bleed, drawing inside the 80% safe zone
write('icon-maskable-512.png', 512, { bleed: true, scale: 0.78 });
// iOS rounds the corners itself and shows transparency as black: full bleed
write('apple-touch-icon.png', 180, { bleed: true, scale: 0.9 });
write('favicon-32.png', 32);
console.log('icons written');

/**
 * CodeConClave — brand product-icon + lockup generator (dependency-free).
 *
 * Generates the founder's legitimate mark — the symmetrical vertical
 * almond/eye of ~22 thin WHITE lines per side (central vertical gap, curves
 * into a lens, converging lower center) on pure black — and the PRIMARY
 * LOCKUP as a vector master (same eye geometry + gold "CODECONCLAVE" wordmark
 * centered over it).
 *
 * Produces (all derived from the same eye geometry — no alternative artwork):
 *  - logo-icon.svg      symbol-only mark (black canvas + eye/iris)
 *  - favicon.svg        same symbol mark (favicon-clean)
 *  - logo-primary.svg   PRIMARY lockup (vector master): black full canvas +
 *    eye/iris + gold "CODECONCLAVE" wordmark centered over it. Recomposed
 *    from the founder's written spec (2026-09-11) after the original raster
 *    was lost from disk. The wordmark renders with system fonts; a font-based
 *    rasterizer or the founder's original raster is required pre-launch for
 *    the PNG MASTER (2048) / LARGE (1024) / APPLE (180) raster set OF THE
 *    LOCKUP — the symbol mark PNGs below are complete.
 *  - icon-{16,32,48,64,128,256,512,1024,2048}.png  rasterized symbol mark
 *  - icon.ico            Vista-style ICO embedding the PNGs
 *  - frontend/public/brand/apple-touch-icon.png     180px symbol mark
 *  - frontend/public/brand/logo-primary.svg         copy of the lockup master
 *
 * Rasterization is pure math + node:zlib (PNG) — no external binaries.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(OUT, { recursive: true });

const BAR_COLOR = '#ffffff';

/**
 * Eye/iris line geometry — the founder's specified mark (shared by every
 * output so there is a single source of truth):
 *   vertical almond/eye shape, centered, ~60% canvas width, ~40% height;
 *   ~22 thin WHITE lines per side (~44 total), equal spacing bowing outward
 *   in a curved lens/iris effect; a thin central vertical gap between the two
 *   inner lines; all lines converge toward lower center with perfect
 *   left-right symmetry. The gold "CODECONCLAVE" wordmark is overlaid
 *   centered (lockup only); the symbol rasters omit text.
 */
function eyeLines(size) {
  const cx = size / 2;
  const cy = size / 2;
  const rx = size * 0.3;
  const ry = size * 0.22;
  const perSide = 22;
  const alphaMin = 0.012; // central vertical gap (~0.7 of a degree)
  const alphaMax = 1.28;
  const bottomY = cy + ry + size * 0.012;
  const list = [];
  for (const s of [-1, 1]) {
    for (let i = 0; i < perSide; i++) {
      const alpha = alphaMin + (i / (perSide - 1)) * (alphaMax - alphaMin);
      const top = { x: cx + s * rx * Math.sin(alpha), y: cy - ry * Math.cos(alpha) };
      const bot = { x: cx + s * rx * Math.sin(alpha) * 0.05, y: bottomY };
      const c = { x: (top.x + bot.x) / 2 + s * size * 0.14 * Math.sin(alpha), y: (top.y + bot.y) / 2 };
      list.push({ top, bot, c });
    }
  }
  return list;
}

function barSvg(l, w) {
  return `    <path d="M ${l.bot.x.toFixed(2)} ${l.bot.y.toFixed(2)} Q ${l.c.x.toFixed(2)} ${l.c.y.toFixed(2)} ${l.top.x.toFixed(2)} ${l.top.y.toFixed(2)}" fill="none" stroke="${BAR_COLOR}" stroke-width="${w.toFixed(1)}" stroke-linecap="round"/>`;
}

function symbolSvg(size) {
  const bars = eyeLines(size);
  const paths = bars.map((b) => barSvg(b, size * 0.011)).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="CodeConClave">
  <rect x="0" y="0" width="${size}" height="${size}" rx="${Math.round(size * 0.04)}" fill="#000000"/>
  <g id="radial-symbol">
${paths}
  </g>
</svg>
`;
}

/**
 * PRIMARY LOCKUP (vector master, recomposed from the founder's written spec
 * after the original raster was lost from disk, 2026-09-11). Black full-canvas
 * background; the eye/iris (same eyeLines geometry) is centered; the gold
 * (#FFD700) bold "CODECONCLAVE" wordmark is centered ON TOP of the white eye
 * lines, solid fill with no gradients or effects, perfect vertical symmetry.
 * The wordmark renders with the platform's geometric sans-serif and therefore
 * needs a font-based rasterizer (or the founder's original raster) pre-launch
 * for the PNG MASTER/LARGE/APPLE raster set — the symbol rasters are complete.
 */
function lockupSvg() {
  const size = 1200;
  const bars = eyeLines(size);
  const paths = bars.map((b) => barSvg(b, size * 0.011)).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="CodeConClave">
  <!-- PRIMARY LOCKUP (vector master) — recomposed from the founder's written
       specification (2026-09-11) after the original raster was lost from
       disk: pure black (#000000) full canvas; symmetrical vertical almond/eye
       of ~22 thin white (#FFFFFF) lines per side, equal spacing, slight
       central vertical gap, converging toward lower center; gold (#FFD700)
       bold geometric "CODECONCLAVE" centered over the eye, solid fill. -->
  <rect x="0" y="0" width="${size}" height="${size}" fill="#000000"/>
  <g id="eye-symbol">
${paths}
  </g>
  <text x="600" y="640" text-anchor="middle" dominant-baseline="central" font-family="'Arial Black','Arial Nova',Arial,'Segoe UI',sans-serif" font-size="118" font-weight="800" letter-spacing="6" fill="#FFD700">CODECONCLAVE</text>
</svg>
`;
}

// ---------------------------------------------------------------- PNG/ICO

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function quadSamples(b, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push([u * u * b.bot.x + 2 * u * t * b.c.x + t * t * b.top.x, u * u * b.bot.y + 2 * u * t * b.c.y + t * t * b.top.y]);
  }
  return pts;
}

function renderSymbol(size) {
  const lines = eyeLines(size).map((b) => quadSamples(b, 16));
  const half = size * 0.011; // thin consistent stroke
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ny = y + 0.5;
    // Taper toward the lower convergence point so the iris closes naturally.
    const sweep = Math.max(0, Math.min(1, (size * 0.97 - ny) / (size * 0.45)));
    const hw = half * (0.35 + 0.65 * sweep);
    for (let x = 0; x < size; x++) {
      const nx = x + 0.5;
      const idx = (y * size + x) * 4;
      rgba[idx + 3] = 255;
      let white = false;
      for (const pts of lines) {
        let minD = Infinity;
        for (let s = 0; s < pts.length - 1; s++) {
          const d = segDist(nx, ny, pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1]);
          if (d < minD) minD = d;
        }
        if (minD <= hw) {
          white = true;
          break;
        }
      }
      if (white) {
        rgba[idx] = 255;
        rgba[idx + 1] = 255;
        rgba[idx + 2] = 255;
      } else {
        rgba[idx] = 0;
        rgba[idx + 1] = 0;
        rgba[idx + 2] = 0;
      }
    }
  }
  return rgba;
}

function encodeIco(pngs) {
  const dirLen = 6 + pngs.length * 16;
  const head = Buffer.alloc(dirLen + pngs.reduce((a, p) => a + p.image.length, 0));
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = 6;
  let dataOffset = dirLen;
  for (const p of pngs) {
    head.writeUInt8(p.w === 256 ? 0 : p.w, offset);
    head.writeUInt8(p.w === 256 ? 0 : p.w, offset + 1);
    head.writeUInt8(0, offset + 2);
    head.writeUInt8(0, offset + 3);
    head.writeUInt16LE(1, offset + 4);
    head.writeUInt16LE(32, offset + 6);
    head.writeUInt32LE(p.image.length, offset + 8);
    head.writeUInt32LE(dataOffset, offset + 12);
    p.image.copy(head, dataOffset);
    offset += 16;
    dataOffset += p.image.length;
  }
  return head;
}

// ---------------------------------------------------------------- write

writeFileSync(join(OUT, 'logo-icon.svg'), symbolSvg(512));
writeFileSync(join(OUT, 'favicon.svg'), symbolSvg(64));
writeFileSync(join(OUT, 'logo-primary.svg'), lockupSvg());

const PUBLIC_BRAND = resolve(OUT, '../../frontend/public/brand');
mkdirSync(PUBLIC_BRAND, { recursive: true });
writeFileSync(join(PUBLIC_BRAND, 'logo-icon.svg'), symbolSvg(512));
writeFileSync(join(PUBLIC_BRAND, 'favicon.svg'), symbolSvg(64));
writeFileSync(join(PUBLIC_BRAND, 'logo-primary.svg'), lockupSvg());

const DESKTOP_ASSETS = resolve(OUT, '../../desktop/assets');
mkdirSync(DESKTOP_ASSETS, { recursive: true });

const sizes = [16, 32, 48, 64, 128, 256, 512, 1024, 2048];
const icoPngs = [];
for (const size of sizes) {
  const png = encodePng(size, size, renderSymbol(size));
  writeFileSync(join(OUT, `icon-${size}.png`), png);
  if ([16, 32, 48, 256].includes(size)) icoPngs.push({ w: size, image: png });
}
writeFileSync(join(OUT, 'icon.ico'), encodeIco(icoPngs));
writeFileSync(join(PUBLIC_BRAND, 'apple-touch-icon.png'), encodePng(180, 180, renderSymbol(180)));
writeFileSync(join(DESKTOP_ASSETS, 'icon.png'), encodePng(512, 512, renderSymbol(512)));
writeFileSync(join(DESKTOP_ASSETS, 'icon.ico'), encodeIco(icoPngs));

console.log('brand assets written to', OUT);
console.log('public brand assets written to', PUBLIC_BRAND);
console.log('desktop assets written to', DESKTOP_ASSETS);
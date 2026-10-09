// Generates simple PNG icons (funnel glyph on a dark rounded square) with zero dependencies.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
function draw(size) {
  const r = size * 0.22;
  return png(size, (x, y) => {
    const u = x + 0.5, v = y + 0.5;
    // rounded square mask
    const cx = Math.min(Math.max(u, r), size - r), cy = Math.min(Math.max(v, r), size - r);
    const inside = (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
    if (!inside) return [0, 0, 0, 0];
    // funnel: wide top band narrowing to a stem
    const t = v / size;
    let fun = false;
    if (t > 0.22 && t < 0.5) {
      const half = 0.34 - (t - 0.22) * 0.9;
      fun = Math.abs(u / size - 0.5) < half;
    } else if (t >= 0.5 && t < 0.8) {
      fun = Math.abs(u / size - 0.5) < 0.085;
    }
    return fun ? [255, 255, 255, 255] : [15, 20, 25, 255];
  });
}
mkdirSync("public/icons", { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(`public/icons/icon${s}.png`, draw(s));
console.log("icons written");

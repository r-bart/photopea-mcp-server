import { randomFillSync } from "node:crypto";

/** Standard PSD v1 with three-channel raster layers, uncompressed channel data. */
export function layeredPsd(width = 8, height = 8, count = 3, noise = false): Buffer {
  const plane = width * height;
  const records: Buffer[] = [], pixels: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const name = Buffer.from(`Fixture ${i}`), padded = Buffer.alloc(Math.ceil((name.length + 1) / 4) * 4);
    padded[0] = name.length; name.copy(padded, 1);
    const extra = Buffer.concat([Buffer.alloc(8), padded]);
    const record = Buffer.alloc(18 + 18 + 16);
    record.writeInt32BE(height, 8); record.writeInt32BE(width, 12); record.writeUInt16BE(3, 16);
    for (let c = 0; c < 3; c++) { record.writeInt16BE(c, 18 + c * 6); record.writeUInt32BE(plane + 2, 20 + c * 6); }
    record.write('8BIMnorm', 36, 'ascii'); record[44] = 255; record[46] = i === 1 ? 2 : 0; record.writeUInt32BE(extra.length, 48);
    records.push(Buffer.concat([record, extra]));
    for (let c = 0; c < 3; c++) {
      const b = Buffer.alloc(plane + 2); if (noise) randomFillSync(b, 2); else b.fill(30 + i * 20 + c * 40, 2);
      pixels.push(b);
    }
  }
  const n = Buffer.alloc(2); n.writeInt16BE(count);
  let info = Buffer.concat([n, ...records, ...pixels]);
  if (info.length % 2) info = Buffer.concat([info, Buffer.alloc(1)]);
  const infoSize = Buffer.alloc(4); infoSize.writeUInt32BE(info.length);
  const mask = Buffer.concat([infoSize, info, Buffer.alloc(4)]), maskSize = Buffer.alloc(4); maskSize.writeUInt32BE(mask.length);
  const header = Buffer.alloc(26); header.write('8BPS', 'ascii'); header.writeUInt16BE(1, 4); header.writeUInt16BE(3, 12);
  header.writeUInt32BE(height, 14); header.writeUInt32BE(width, 18); header.writeUInt16BE(8, 22); header.writeUInt16BE(3, 24);
  const composite = Buffer.alloc(2 + plane * 3);
  if (noise) randomFillSync(composite, 2); else composite.fill(80, 2);
  return Buffer.concat([header, Buffer.alloc(8), maskSize, mask, composite]);
}

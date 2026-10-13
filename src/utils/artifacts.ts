import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, link, unlink, stat, type FileHandle } from "node:fs/promises";
import { dirname, basename, isAbsolute, join } from "node:path";
import type { BridgeResult } from "../bridge/types.js";

export const MAX_FILE_BYTES = 512 * 1024 * 1024;
export const CHUNK_BYTES = 1024 * 1024;
export type ExportFormat = "psd" | "png" | "jpg" | "webp" | "svg";
type Metadata = { width?: number; height?: number; layerCount?: number };

async function bytes(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const b = Buffer.alloc(length);
  const read = await handle.read(b, 0, length, offset);
  if (read.bytesRead !== length) throw new Error("Truncated artifact");
  return b;
}

export async function validateArtifact(path: string, format: ExportFormat): Promise<Metadata> {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    if (size < 8 || size > MAX_FILE_BYTES) throw new Error("Invalid artifact size");
    const head = await bytes(handle, 0, Math.min(32, size));
    if (format === "psd") {
      if (head.toString("ascii", 0, 4) !== "8BPS" || head.readUInt16BE(4) !== 1 || head.subarray(6, 12).some(x => x !== 0)) throw new Error("Expected PSD v1 header");
      const channels = head.readUInt16BE(12), height = head.readUInt32BE(14), width = head.readUInt32BE(18), depth = head.readUInt16BE(22), mode = head.readUInt16BE(24);
      if (channels < 1 || channels > 56 || width < 1 || height < 1 || width > 30000 || height > 30000 || ![1, 8, 16, 32].includes(depth) || ![0, 1, 2, 3, 4, 7, 8, 9].includes(mode)) throw new Error("Invalid PSD dimensions/mode");
      let offset = 26;
      async function section(): Promise<{ start: number; end: number; length: number }> {
        const length = (await bytes(handle, offset, 4)).readUInt32BE(0);
        const start = offset + 4, end = start + length;
        if (end > size) throw new Error("PSD section exceeds file");
        offset = end;
        return { start, end, length };
      }
      await section(); // Color mode data
      await section(); // Image resources
      const layers = await section();
      let layerCount = 0;
      if (layers.length > 0) {
        if (layers.length < 4) throw new Error("Invalid layer/mask section");
        const infoLength = (await bytes(handle, layers.start, 4)).readUInt32BE(0);
        const infoEnd = layers.start + 4 + infoLength;
        if (infoEnd > layers.end) throw new Error("PSD layer info exceeds section");
        if (infoLength > 0) {
          let cursor = layers.start + 4;
          layerCount = Math.abs((await bytes(handle, cursor, 2)).readInt16BE(0)); cursor += 2;
          if (layerCount > 10000) throw new Error("PSD layer count exceeds validation budget");
          const channelLengths: number[] = [];
          for (let i = 0; i < layerCount; i++) {
            const record = await bytes(handle, cursor, 18); cursor += 18;
            const count = record.readUInt16BE(16);
            if (count > 56) throw new Error("Invalid PSD layer channels");
            for (let j = 0; j < count; j++) {
              const channel = await bytes(handle, cursor, 6); cursor += 6;
              const length = channel.readUInt32BE(2);
              if (length < 2) throw new Error("Truncated PSD channel");
              channelLengths.push(length);
            }
            const tail = await bytes(handle, cursor, 16); cursor += 16;
            if (tail.toString("ascii", 0, 4) !== "8BIM") throw new Error("Invalid PSD layer signature");
            cursor += tail.readUInt32BE(12);
            if (cursor > infoEnd) throw new Error("PSD layer record exceeds section");
          }
          for (const length of channelLengths) {
            if (cursor + length > infoEnd) throw new Error("PSD channel exceeds layer info");
            if ((await bytes(handle, cursor, 2)).readUInt16BE(0) > 3) throw new Error("Invalid PSD channel compression");
            cursor += length;
          }
          if (infoEnd - cursor > 1) throw new Error("Unexpected PSD layer data length");
        }
      }
      const compression = (await bytes(handle, offset, 2)).readUInt16BE(0); offset += 2;
      const rowBytes = Math.ceil(width * depth / 8);
      if (compression === 0) {
        if (size - offset !== rowBytes * height * channels) throw new Error("Truncated PSD composite pixels");
      } else if (compression === 1) {
        const tableLength = channels * height * 2;
        const table = await bytes(handle, offset, tableLength); offset += tableLength;
        let total = 0;
        for (let i = 0; i < table.length; i += 2) total += table.readUInt16BE(i);
        if (total !== size - offset) throw new Error("Truncated PSD RLE composite");
      } else if (![2, 3].includes(compression) || offset >= size) throw new Error("Invalid PSD composite compression");
      // This checks structure, not decompressed pixels, adjustment semantics, or editability.
      return { width, height, layerCount };
    }
    if (format === "png") {
      if (!head.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || head.toString("ascii", 12, 16) !== "IHDR") throw new Error("Expected PNG");
      let offset = 8, hasData = false, ended = false;
      while (offset < size) {
        const h = await bytes(handle, offset, 8), n = h.readUInt32BE(0), type = h.toString("ascii", 4);
        if (offset + n + 12 > size) throw new Error("Truncated PNG chunk");
        if (type === "IDAT") hasData = true;
        offset += n + 12;
        if (type === "IEND") { ended = n === 0 && offset === size; break; }
      }
      if (!hasData || !ended) throw new Error("Incomplete PNG");
      return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    }
    if (format === "jpg") {
      if (head[0] !== 255 || head[1] !== 216 || !(await bytes(handle, size - 2, 2)).equals(Buffer.from([255,217]))) throw new Error("Incomplete JPEG");
    } else if (format === "webp") {
      if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WEBP" || head.readUInt32LE(4) + 8 !== size) throw new Error("Invalid WebP");
    } else {
      if (size > 16 * 1024 * 1024) throw new Error("SVG exceeds validation budget");
      const text = (await bytes(handle, 0, size)).toString("utf8");
      if (!/<svg[\s>]/.test(text) || !/<\/svg>\s*$/.test(text)) throw new Error("Incomplete SVG");
    }
    return {};
  } finally { await handle.close(); }
}

export class ArtifactWriter {
  private handle?: FileHandle;
  private hash = createHash("sha256");
  private offset = 0;
  private published = false;
  private readonly temporary: string;
  private constructor(readonly path: string, readonly format: ExportFormat, readonly byteLength: number, readonly expectedHash: string) {
    this.temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.part`);
  }
  static async create(path: string, format: ExportFormat, byteLength: number, expectedHash: string): Promise<ArtifactWriter> {
    if (!isAbsolute(path)) throw new Error("Output path must be absolute");
    if (!Number.isSafeInteger(byteLength) || byteLength < 8 || byteLength > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("Invalid transfer manifest");
    try { await stat(path); throw new Error("Destination exists; use a new checkpoint path"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await mkdir(dirname(path), { recursive: true });
    const writer = new ArtifactWriter(path, format, byteLength, expectedHash);
    writer.handle = await open(writer.temporary, "wx");
    return writer;
  }
  async append(offset: number, data: Buffer): Promise<void> {
    if (!this.handle || offset !== this.offset || data.length < 1 || data.length > CHUNK_BYTES || offset + data.length > this.byteLength) throw new Error("Invalid transfer offset/length");
    let written = 0;
    while (written < data.length) {
      const result = await this.handle.write(data, written, data.length - written, this.offset + written);
      if (!result.bytesWritten) throw new Error("No write progress");
      written += result.bytesWritten;
    }
    this.hash.update(data); this.offset += data.length;
  }
  async commit(): Promise<NonNullable<BridgeResult["artifact"]>> {
    if (!this.handle || this.offset !== this.byteLength) throw new Error("Incomplete artifact transfer");
    const sha256 = this.hash.digest("hex");
    if (sha256 !== this.expectedHash) throw new Error("Artifact checksum mismatch");
    await this.handle.sync(); await this.handle.close(); this.handle = undefined;
    const metadata = await validateArtifact(this.temporary, this.format);
    // link publishes atomically without replacing a destination created concurrently.
    await link(this.temporary, this.path); this.published = true;
    await unlink(this.temporary).catch(() => {});
    return { path: this.path, byteLength: this.byteLength, sha256, format: this.format, validation: "structure_checked", ...metadata };
  }
  async abort(): Promise<void> {
    await this.handle?.close(); this.handle = undefined;
    if (!this.published) await unlink(this.temporary).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
  }
}

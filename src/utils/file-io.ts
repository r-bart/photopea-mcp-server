import { readFile, writeFile, mkdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import { MAX_FILE_BYTES } from "./artifacts.js";

export async function readLocalFile(filePath: string): Promise<Buffer> {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}. Verify the path exists.`);
  }
  const info = await stat(filePath);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("Local asset exceeds file budget or is not a file");
  return readFile(filePath);
}

export async function writeLocalFile(filePath: string, data: Buffer): Promise<void> {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(filePath, data);
}

export async function fetchUrlToBuffer(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Asset fetch failed: HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (declared > MAX_FILE_BYTES || !response.body) { controller.abort(); throw new Error("Asset exceeds file budget or has no body"); }
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.byteLength;
      if (length > MAX_FILE_BYTES) { controller.abort(); throw new Error("Asset exceeds file budget"); }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, length);
  } finally { clearTimeout(timer); }
}

export function isUrl(source: string): boolean {
  return source.startsWith("http://") || source.startsWith("https://");
}

import { mkdir, readFile, opendir, rename, writeFile, open, unlink, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { validateArtifact } from "../utils/artifacts.js";
import { join } from "node:path";
import type { OperationSnapshot } from "./operation-manager.js";

/** Metadata only. Restarted running jobs are evidence of an unknown outcome, never work to replay. */
export class OperationJournal {
  private writes: Promise<void> = Promise.resolve();
  private failure?: Error;
  private index = new Map<string, { createdAt:number; finishedAt?:number }>();
  constructor(private readonly directory: string, private readonly retention = 256) {}
  async load(): Promise<OperationSnapshot[]> {
    await mkdir(this.directory, { recursive: true });
    const finished: OperationSnapshot[] = [], unknown: OperationSnapshot[] = [];
    const entries = await opendir(this.directory);
    for await (const entry of entries) {
      const name = entry.name;
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      if ((await stat(join(this.directory,name))).size > 64 * 1024) throw new Error("Operation journal record exceeds budget");
      const raw = JSON.parse(await readFile(join(this.directory, name), "utf8")) as OperationSnapshot;
      if (raw.operationId + ".json" !== name || !Number.isFinite(raw.createdAt)) throw new Error("Invalid operation journal record");
      if (raw.finishedAt === undefined) {
        const queued = raw.state === "queued";
        raw.state = queued ? "cancelled" : "indeterminate";
        if (queued) raw.finishedAt = Date.now();
        raw.result = { success: false, data: null, error: "Server restarted; no replay. Inspect artifact/document before retrying", operationId: raw.operationId, state: raw.state };
        if (raw.candidate) {
          try {
            const c = raw.candidate, hash = createHash("sha256");
            let length = 0;
            for await (const chunk of createReadStream(c.path)) { length += chunk.length; if(length > c.byteLength)throw new Error("Candidate size differs"); hash.update(chunk); }
            if (length !== c.byteLength || hash.digest("hex") !== c.sha256) throw new Error("Candidate differs");
            const metadata = await validateArtifact(c.path, c.format);
            raw.state = "completed"; raw.finishedAt = Date.now();
            raw.result = { success:true,data:null,error:null,operationId:raw.operationId,state:"completed",artifact:{...c,validation:"structure_checked",...metadata} };
          } catch { /* Keep unknown outcome; never replay or overwrite. */ }
        }
      }
      this.index.set(raw.operationId, {createdAt:raw.createdAt,finishedAt:raw.finishedAt});
      if (raw.finishedAt === undefined) {
        unknown.push(raw);
        if (unknown.length > 256) throw new Error("Too many unknown operations; inspect journal before starting new work");
      } else {
        finished.push(raw); finished.sort((a,b)=>a.createdAt-b.createdAt);
        if (finished.length > this.retention) {
          const expired = finished.shift()!;
          await unlink(join(this.directory, expired.operationId + ".json")); this.index.delete(expired.operationId);
        }
      }
    }
    return [...finished, ...unknown].sort((a,b)=>a.createdAt-b.createdAt);
  }
  record(snapshot: OperationSnapshot): void {
    // Script/echo output may contain document content. Persist only outcome metadata.
    const safe = { ...snapshot, result: snapshot.result ? { ...snapshot.result, data: null } : undefined };
    const body = JSON.stringify(safe);
    this.writes = this.writes.then(async () => {
      const path = join(this.directory, snapshot.operationId + ".json"), temporary = path + ".tmp";
      await writeFile(temporary, body, { mode: 0o600 });
      const handle = await open(temporary, "r+");
      try { await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
      this.index.set(snapshot.operationId,{createdAt:snapshot.createdAt,finishedAt:snapshot.finishedAt});
      const ended = [...this.index].filter(([,s])=>s.finishedAt!==undefined).sort((a,b)=>a[1].createdAt-b[1].createdAt);
      for (const [id] of ended.slice(0,Math.max(0,ended.length-this.retention))) {
        await unlink(join(this.directory,id+'.json')); this.index.delete(id);
      }
    }).catch(e => { this.failure = e as Error; });
  }
  async flush(): Promise<void> { await this.writes; if (this.failure) throw this.failure; }
}

import { randomUUID } from "node:crypto";
import type { BridgeResult } from "./types.js";

export type OperationState = "queued" | "running" | "transferring" | "persisting" | "indeterminate" | "completed" | "failed" | "cancelled" | "expired";
export interface OperationSnapshot {
  operationId: string;
  state: OperationState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: BridgeResult;
  candidate?: { path: string; byteLength: number; sha256: string; format: "psd" | "png" | "jpg" | "webp" | "svg" };
  kind?: "step" | "command" | "load" | "export" | "workflow";
  parentOperationId?: string;
}
interface Operation extends OperationSnapshot {
  dispatch?: (id: string) => void;
  resolve: (result: BridgeResult) => void;
  promise: Promise<BridgeResult>;
  queueTimer?: ReturnType<typeof setTimeout>;
  executionTimer?: ReturnType<typeof setTimeout>;
  executionMs: number;
}

export class OperationManager {
  private operations = new Map<string, Operation>();
  private queue: Operation[] = [];
  private active?: Operation;
  private stopped = false;
  constructor(private readonly queueMs = 120_000, private readonly maxQueue = 16, private readonly maxRecords = 256, private readonly changed: (snapshot: OperationSnapshot) => void = () => {}) {}
  restore(snapshots: OperationSnapshot[]): void {
    for (const snapshot of snapshots) {
      const promise = Promise.resolve(snapshot.result ?? { success:false,data:null,error:"Recovered unknown outcome" });
      this.operations.set(snapshot.operationId, { ...snapshot, promise, resolve:()=>{}, executionMs:0 });
    }
  }
  private record(op: Operation): void { this.changed(this.snapshot(op.operationId)!); }

  enqueue(dispatch: (id: string) => void, executionMs: number, metadata: Pick<OperationSnapshot, "kind" | "parentOperationId"> = {}): { operationId: string; promise: Promise<BridgeResult> } {
    if (this.stopped) throw new Error("Bridge stopped");
    if (this.queue.length >= this.maxQueue) throw new Error("Operation queue is full");
    // Never evict work with an unknown outcome.
    for (const [id, op] of this.operations) {
      if (this.operations.size < this.maxRecords) break;
      if (op.finishedAt !== undefined) this.operations.delete(id);
    }
    if (this.operations.size >= this.maxRecords) throw new Error("Operation history is full; reconcile outstanding operations");
    const operationId = randomUUID();
    let resolve!: (r: BridgeResult) => void;
    const promise = new Promise<BridgeResult>(r => { resolve = r; });
    const op: Operation = { operationId, state: "queued", createdAt: Date.now(), dispatch, resolve, promise, executionMs, ...metadata };
    op.queueTimer = setTimeout(() => this.finishQueued(op, "expired", "Queue deadline exceeded; not started"), this.queueMs);
    this.operations.set(operationId, op);
    this.queue.push(op);
    this.record(op);
    return { operationId, promise };
  }

  pump(ready: boolean): void {
    if (!ready || this.active || this.stopped) return;
    const op = this.queue.shift();
    if (!op) return;
    clearTimeout(op.queueTimer);
    op.state = "running";
    op.startedAt = Date.now();
    this.active = op;
    this.record(op);
    op.executionTimer = setTimeout(() => this.markIndeterminate("Execution deadline exceeded; editor ownership retained"), op.executionMs);
    const dispatch = op.dispatch!;
    op.dispatch = undefined;
    try { dispatch(op.operationId); }
    catch (error) { this.markIndeterminate(`Dispatch failed: ${(error as Error).message}`); }
  }

  get activeId(): string | undefined { return this.active?.operationId; }
  get queuedCount(): number { return this.queue.length; }
  snapshot(id: string): OperationSnapshot | undefined {
    const op = this.operations.get(id);
    if (!op) return undefined;
    return { operationId: id, state: op.state, createdAt: op.createdAt, startedAt: op.startedAt, finishedAt: op.finishedAt, result: op.result, candidate: op.candidate, kind:op.kind, parentOperationId:op.parentOperationId };
  }
  candidate(id: string, candidate: NonNullable<OperationSnapshot["candidate"]>): void {
    if (id !== this.activeId) throw new Error("Operation does not own editor");
    this.active!.candidate = candidate;
    this.record(this.active!);
  }
  phase(id: string, state: "running" | "transferring" | "persisting", keepExecutionDeadline = false): void {
    if (id !== this.activeId) throw new Error("Operation does not own editor");
    const op = this.active!;
    if (op.state !== "indeterminate") op.state = state;
    if (state === "transferring" && !keepExecutionDeadline) clearTimeout(op.executionTimer);
    this.record(op);
  }
  markIndeterminate(error: string,partial?:BridgeResult): void {
    const op = this.active;
    if (!op) return;
    clearTimeout(op.executionTimer);
    op.state = "indeterminate";
    op.result = { ...partial,success: false, data: partial?.data??null, error: `${error} [operationId=${op.operationId}]`, operationId: op.operationId, state: "indeterminate" };
    this.record(op);
    op.resolve(op.result);
  }
  complete(id: string, result: BridgeResult): boolean {
    if (id !== this.activeId) return false;
    const op = this.active!;
    clearTimeout(op.executionTimer);
    op.state = result.success ? "completed" : "failed";
    op.finishedAt = Date.now();
    op.result = { ...result, operationId: id, state: op.state };
    this.record(op);
    op.resolve(op.result);
    this.active = undefined;
    return true;
  }
  cancel(id: string): string {
    const op = this.operations.get(id);
    if (!op) throw new Error("Unknown operation");
    if (op.state === "queued") {
      this.finishQueued(op, "cancelled", "Cancelled before dispatch; not started");
      return "cancelled_before_dispatch";
    }
    return op.finishedAt !== undefined ? "already_finished" : "execution_not_cancellable";
  }
  private finishQueued(op: Operation, state: "expired" | "cancelled", error: string): void {
    if (op.state !== "queued") return;
    this.queue = this.queue.filter(x => x !== op);
    clearTimeout(op.queueTimer);
    op.state = state;
    op.dispatch = undefined;
    op.finishedAt = Date.now();
    op.result = { success: false, data: null, error, operationId: op.operationId, state };
    this.record(op);
    op.resolve(op.result);
  }
  stop(): void {
    this.stopped = true;
    this.markIndeterminate("Bridge stopped; execution outcome unknown");
    for (const op of [...this.queue]) this.finishQueued(op, "cancelled", "Bridge stopped; not started");
  }
}

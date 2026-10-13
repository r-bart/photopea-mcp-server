import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { randomUUID, createHash } from "node:crypto";
import { Script } from "node:vm";
import { AsyncLocalStorage } from "node:async_hooks";
import { OperationManager, type OperationSnapshot } from "./operation-manager.js";
import { OperationJournal } from "./operation-journal.js";
import { ArtifactWriter, CHUNK_BYTES, MAX_FILE_BYTES, type ExportFormat } from "../utils/artifacts.js";
import type { ActivityMessage, BridgeResult } from "./types.js";
import { launchBrowser } from "../utils/platform.js";
import { VERSION } from "../version.js";

export const PROTOCOL_VERSION = 2;
export interface BridgeOptions { queueMs?: number; scriptMs?: number; exportMs?: number; stallMs?: number; readyMs?: number; autoLaunch?: boolean; journalDirectory?: string }
interface Transfer { writer: ArtifactWriter; offset: number; sequence: number }
interface WorkflowContext { id:string; abandoned?:BridgeResult }

export class PhotopeaBridge {
  readonly httpServer: HttpServer = createServer();
  readonly wss: WebSocketServer;
  readonly operations: OperationManager;
  private readonly workflows: OperationManager;
  private readonly workflowScope = new AsyncLocalStorage<WorkflowContext>();
  private readonly contexts = new Map<string,WorkflowContext>();
  private client: WebSocket | null = null;
  private sessionId?: string;
  private epoch?: string;
  private ready = false;
  private browserLaunched = false;
  private stopped = false;
  private readonly token = randomUUID();
  private readonly options: Required<Omit<BridgeOptions, "journalDirectory">>;
  private readonly journal?: OperationJournal;
  private exports = new Map<string, { path: string; format: ExportFormat }>();
  private transfer?: Transfer;
  private stallTimer?: ReturnType<typeof setTimeout>;
  private incoming: Promise<void> = Promise.resolve();
  private loadAck?: { offset: number; resolve: () => void; reject: (e: Error) => void };
  private reservedLoadBytes = 0;

  constructor(private port: number, options: BridgeOptions = {}) {
    this.options = { queueMs: 120_000, scriptMs: 30_000, exportMs: 180_000, stallMs: 30_000, readyMs: 60_000, autoLaunch: true, ...options };
    if (options.journalDirectory) this.journal = new OperationJournal(options.journalDirectory);
    this.workflows = new OperationManager(this.options.queueMs, 16, 256, snapshot => this.journal?.record(snapshot));
    this.operations = new OperationManager(this.options.queueMs, 16, 256, snapshot => this.recordStep(snapshot));
    this.wss = new WebSocketServer({ server: this.httpServer, maxPayload: CHUNK_BYTES + 8, perMessageDeflate: false });
    this.wss.on("connection", (ws, request) => {
      if (request.headers.host !== `127.0.0.1:${this.port}` || request.url !== "/" || (request.headers.origin && request.headers.origin !== `http://127.0.0.1:${this.port}`)) {
        ws.close(1008, "Invalid bridge origin"); return;
      }
      let authenticated = false;
      const helloTimer = setTimeout(() => ws.close(1008, "Handshake required"), 5000);
      ws.on("message", (raw, binary) => {
        if (!authenticated) {
          if (binary) { ws.close(1008, "Handshake required"); return; }
          let m: Record<string, unknown>;
          try { m = JSON.parse(raw.toString()); } catch { ws.close(1008, "Invalid handshake"); return; }
          if (!m || m.type !== "hello" || m.protocol !== PROTOCOL_VERSION || m.token !== this.token || typeof m.sessionId !== "string" || !/^[a-f0-9-]{36}$/.test(m.sessionId) || typeof m.ready !== "boolean") {
            ws.close(1008, "Invalid handshake"); return;
          }
          if ((this.client && this.client.readyState === WebSocket.OPEN) || (this.sessionId && this.sessionId !== m.sessionId)) {
            ws.close(1008, "Another Photopea session owns this bridge"); return;
          }
          authenticated = true; clearTimeout(helloTimer);
          this.client = ws; this.sessionId = m.sessionId; this.epoch = randomUUID(); this.ready = m.ready;
          this.send({ type: "welcome", protocol: PROTOCOL_VERSION, activeId: this.operations.activeId ?? null });
          this.pump(); return;
        }
        if (this.client !== ws) return;
        this.incoming = this.incoming.then(() => this.handle(raw, binary)).catch(async error => {
          this.operations.markIndeterminate(`Protocol/IO failure: ${(error as Error).message}; editor ownership retained`);
          await this.discardTransfer();
          this.send({ type: "transfer_error", id: this.operations.activeId, error: (error as Error).message });
        });
      });
      ws.on("close", () => {
        clearTimeout(helloTimer);
        if (this.client !== ws) return;
        this.client = null; this.ready = false;
        this.operations.markIndeterminate("Photopea disconnected; editor ownership retained");
        this.loadAck?.reject(new Error("Disconnected during load transfer"));
        this.incoming = this.incoming.then(() => this.discardTransfer());
      });
      ws.on("error", () => {});
    });
  }
  getHttpServer(): HttpServer { return this.httpServer; }
  getPort(): number { return this.port; }
  getLaunchUrl(): string { return `http://127.0.0.1:${this.port}/#token=${this.token}`; }
  isReady(): boolean { return !this.stopped && this.client?.readyState === WebSocket.OPEN && this.ready; }
  getStatus() { return { version: VERSION, protocol: PROTOCOL_VERSION, sessionId: this.sessionId, ready: this.isReady(), activeOperation: this.workflows.activeId ? this.workflows.snapshot(this.workflows.activeId) : null, activeStep: this.operations.activeId ? this.operations.snapshot(this.operations.activeId) : null, queued: this.workflows.queuedCount }; }
  getOperation(id: string) { return this.workflows.snapshot(id) ?? this.operations.snapshot(id); }
  cancelOperation(id: string): string { return this.workflows.snapshot(id) ? this.workflows.cancel(id) : this.operations.cancel(id); }
  private recordStep(snapshot:OperationSnapshot):void {
    this.journal?.record(snapshot);
    const parent=snapshot.parentOperationId;
    if(!parent||this.workflows.activeId!==parent)return;
    if(snapshot.state==='running'||snapshot.state==='transferring'||snapshot.state==='persisting')this.workflows.phase(parent,snapshot.state,true);
    if(snapshot.candidate)this.workflows.candidate(parent,snapshot.candidate);
    if(snapshot.state==='indeterminate')this.workflows.markIndeterminate(snapshot.result?.error??'Child execution unknown');
    const context=this.contexts.get(parent);
    if(snapshot.finishedAt!==undefined&&context?.abandoned){
      const root=this.workflows.snapshot(parent);
      this.workflows.complete(parent,root?.kind==='workflow'?context.abandoned:(snapshot.result??context.abandoned));this.contexts.delete(parent);
    }
  }
  currentWorkflowId():string|undefined{return this.workflowScope.getStore()?.id;}
  canContinueWorkflow():boolean {
    const id=this.currentWorkflowId();
    return !this.stopped && (!id||this.workflows.snapshot(id)?.state!=='indeterminate') && (!this.operations.activeId||this.operations.snapshot(this.operations.activeId)?.state!=='indeterminate');
  }
  private assertWorkflowKnown():void { if(!this.canContinueWorkflow())throw new Error('Execution outcome unknown; inspect operation before another step'); }
  startWorkflow(work:()=>Promise<BridgeResult>,kind:NonNullable<OperationSnapshot['kind']>='workflow'):string {
    const job=this.workflows.enqueue(id=>{
      const context:WorkflowContext={id};this.contexts.set(id,context);
      void this.workflowScope.run(context,async()=>{
        let result:BridgeResult;
        try { result=await work(); }
        catch(error){result={success:false,data:null,error:(error as Error).message};}
        if(this.operations.activeId&&this.operations.snapshot(this.operations.activeId)?.state==='indeterminate'){
          context.abandoned=result;
          this.workflows.markIndeterminate(result.error??'Workflow has an unknown step',result);
        }else{
          this.workflows.complete(id,result);this.contexts.delete(id);this.pump();
        }
      });
    },900_000,{kind});
    this.ensureBrowser();this.pump();return job.operationId;
  }
  async runWorkflow(work:()=>Promise<BridgeResult>,kind:NonNullable<OperationSnapshot['kind']>='workflow'):Promise<BridgeResult>{
    if(this.workflowScope.getStore()){this.assertWorkflowKnown();return work();}
    await this.waitForReady();
    const id=this.startWorkflow(work,kind);
    while(true){const op=this.workflows.snapshot(id)!;if(op.result)return op.result;await new Promise(r=>setTimeout(r,20));}
  }

  async waitForReady(): Promise<void> {
    if (this.stopped) throw new Error("Bridge stopped");
    if (this.isReady()) return;
    this.ensureBrowser();
    const deadline = Date.now() + this.options.readyMs;
    while (!this.isReady()) {
      if (this.stopped) throw new Error("Bridge stopped");
      if (Date.now() >= deadline) throw new Error("Photopea readiness deadline exceeded; operation not started");
      await new Promise(r => setTimeout(r, Math.min(50, this.options.readyMs)));
    }
  }
  private ensureBrowser(): void {
    if (this.browserLaunched || !this.options.autoLaunch) return;
    this.browserLaunched = true;
    launchBrowser(this.getLaunchUrl()).catch(() => console.error("Could not launch Photopea bridge browser"));
  }
  async start(): Promise<void> {
    if (this.journal) {
      const recovered=await this.journal.load();
      this.workflows.restore(recovered.filter(x=>x.kind&&x.kind!=='step'));
      this.operations.restore(recovered.filter(x=>!x.kind||x.kind==='step'));
    }
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.port, "127.0.0.1", () => {
        const addr = this.httpServer.address();
        if (addr && typeof addr !== "string") this.port = addr.port;
        this.httpServer.off("error", reject); resolve();
      });
    });
  }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; this.workflows.stop(); this.operations.stop();
    this.loadAck?.reject(new Error("Bridge stopped"));
    for (const ws of this.wss.clients) ws.terminate();
    this.client = null; this.ready = false;
    try {
      await this.incoming; await this.discardTransfer();
      await this.journal?.flush();
    } finally {
      await new Promise<void>(r => this.wss.close(() => this.httpServer.close(() => r())));
    }
  }
  sendActivity(activity: ActivityMessage): void { this.send(activity); }
  private send(message: object): void {
    if (this.client?.readyState === WebSocket.OPEN) this.client.send(JSON.stringify({ ...message, sessionId: this.sessionId, epoch: this.epoch }));
  }
  private pump(): void { this.operations.pump(this.isReady());this.workflows.pump(this.isReady()); }

  async executeScript(script: string, expectFiles = false): Promise<BridgeResult> {
    if(!this.workflowScope.getStore()){
      try{return await this.runWorkflow(()=>this.executeScript(script,expectFiles),'command');}
      catch(error){return {success:false,data:null,error:(error as Error).message};}
    }
    if (expectFiles) return { success: false, data: null, error: "File exports require exportToFile/startExport with format and destination" };
    try {
      this.assertWorkflowKnown();
      this.validateScript(script);
      await this.waitForReady();
      const op = this.operations.enqueue(id => this.send({ type: "execute", id, script, expectFiles: false }), this.options.scriptMs,{kind:'step',parentOperationId:this.currentWorkflowId()});
      this.pump(); return await op.promise;
    } catch (error) { return { success: false, data: null, error: (error as Error).message }; }
  }
  startExport(script: string, path: string, format: ExportFormat): string {
    if(!this.workflowScope.getStore())return this.startWorkflow(()=>this.exportToFile(script,path,format),'export');
    this.assertWorkflowKnown();
    this.validateScript(script);
    const op = this.operations.enqueue(id => this.send({ type: "execute", id, script, expectFiles: true }), this.options.exportMs,{kind:'step',parentOperationId:this.currentWorkflowId()});
    this.exports.set(op.operationId, { path, format });
    void op.promise.then(result => { if (result.state !== "indeterminate") this.exports.delete(op.operationId); });
    this.ensureBrowser(); this.pump(); return op.operationId;
  }
  private validateScript(script: string): void {
    if (Buffer.byteLength(script) > 128 * 1024) throw new Error("Script exceeds control budget; not started");
    try { new Script(script); }
    catch (error) { throw new Error(`Script syntax invalid; not started: ${(error as Error).message}`); }
  }
  async exportToFile(script: string, path: string, format: ExportFormat): Promise<BridgeResult> {
    if(!this.workflowScope.getStore())return this.runWorkflow(()=>this.exportToFile(script,path,format),'export');
    this.assertWorkflowKnown();
    await this.waitForReady();
    const id = this.startExport(script, path, format);
    while (true) {
      const snapshot = this.operations.snapshot(id)!;
      if (snapshot.result) return snapshot.result;
      await new Promise(r => setTimeout(r, 20));
    }
  }
  async loadFile(data: Buffer, filename: string): Promise<BridgeResult> {
    if(!this.workflowScope.getStore()){
      try{return await this.runWorkflow(()=>this.loadFile(data,filename),'load');}
      catch(error){return {success:false,data:null,error:(error as Error).message};}
    }
    this.assertWorkflowKnown();
    if (data.length > MAX_FILE_BYTES || !data.length) return { success: false, data: null, error: "Load exceeds file budget or is empty" };
    if (this.reservedLoadBytes + data.length > MAX_FILE_BYTES) return { success: false, data: null, error: "Outstanding loads exceed memory budget" };
    const length = data.length;
    this.reservedLoadBytes += length;
    let dispatched = false, released = false;
    const release = () => { if (!released) { this.reservedLoadBytes -= length; released = true; } };
    try {
      await this.waitForReady();
      const op = this.operations.enqueue(id => {
        dispatched = true;
        void this.sendLoad(id, data, filename).catch(e => this.operations.markIndeterminate(`Load transfer: ${(e as Error).message}`)).finally(release);
      }, this.options.exportMs,{kind:'step',parentOperationId:this.currentWorkflowId()});
      this.pump(); const result = await op.promise;
      if (!dispatched) release();
      return result;
    } catch (error) { release(); return { success: false, data: null, error: (error as Error).message }; }
  }
  private async sendLoad(id: string, data: Buffer, filename: string): Promise<void> {
    const waitAck = (offset: number) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.loadAck = undefined; reject(new Error("Load ACK deadline exceeded")); }, this.options.stallMs);
      this.loadAck = { offset, resolve: () => { clearTimeout(timer); this.loadAck = undefined; resolve(); }, reject: e => { clearTimeout(timer); this.loadAck = undefined; reject(e); } };
    });
    let ack = waitAck(0);
    this.send({ type: "load_begin", id, byteLength: data.length, filename, sha256: createHash("sha256").update(data).digest("hex") });
    await ack;
    for (let offset = 0, sequence = 0; offset < data.length; sequence++) {
      const chunk = data.subarray(offset, Math.min(offset + CHUNK_BYTES, data.length));
      const header = Buffer.alloc(8); header.writeUInt32BE(sequence, 0); header.writeUInt32BE(offset, 4);
      ack = waitAck(offset + chunk.length);
      if (!this.isReady()) { this.loadAck!.reject(new Error("Disconnected")); await ack; }
      this.client!.send(Buffer.concat([header, chunk]));
      await ack; offset += chunk.length;
    }
    this.send({ type: "load_end", id });
  }
  private resetStall(): void {
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      this.operations.markIndeterminate("Transfer/persistence deadline exceeded; editor ownership retained");
      this.incoming = this.incoming.then(() => this.discardTransfer());
      this.send({ type: "transfer_error", id: this.operations.activeId, error: "Transfer deadline exceeded" });
    }, this.options.stallMs);
  }
  private async discardTransfer(): Promise<void> {
    clearTimeout(this.stallTimer);
    const transfer = this.transfer; this.transfer = undefined;
    await transfer?.writer.abort();
  }
  private async handle(raw: RawData, binary: boolean): Promise<void> {
    if (binary) {
      const b = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      const t = this.transfer;
      if (!t || b.length <= 8 || b.readUInt32BE(0) !== t.sequence || b.readUInt32BE(4) !== t.offset) throw new Error("Unexpected binary chunk");
      await t.writer.append(t.offset, b.subarray(8));
      t.offset += b.length - 8; t.sequence++;
      this.resetStall(); this.send({ type: "file_ack", id: this.operations.activeId, offset: t.offset }); return;
    }
    if (raw.toString().length > 256 * 1024) throw new Error("Control message exceeds budget");
    const m = JSON.parse(raw.toString());
    if (!m || m.sessionId !== this.sessionId || m.epoch !== this.epoch) return;
    if (m.type === "status") {
      if (typeof m.ready !== "boolean") throw new Error("Invalid readiness message");
      this.ready = m.ready;
      if (!this.ready) this.operations.markIndeterminate("Photopea reports disconnected");
      this.pump(); return;
    }
    if (typeof m.id !== "string" || m.id !== this.operations.activeId) return;
    if (m.type === "load_ack") {
      if (this.loadAck && m.offset === this.loadAck.offset) this.loadAck.resolve();
      return;
    }
    if (m.type === "file_begin") {
      if (this.transfer) throw new Error("Duplicate file_begin within a connected transfer");
      const target = this.exports.get(m.id);
      if (!target || typeof m.byteLength !== "number" || typeof m.sha256 !== "string") throw new Error("Unexpected file manifest");
      await this.discardTransfer();
      this.transfer = { writer: await ArtifactWriter.create(target.path, target.format, m.byteLength, m.sha256), offset: 0, sequence: 0 };
      this.operations.phase(m.id, "transferring"); this.resetStall();
      this.send({ type: "file_ack", id: m.id, offset: 0 }); return;
    }
    if (m.type === "file_end") {
      if (!this.transfer || this.transfer.offset !== this.transfer.writer.byteLength) throw new Error("Incomplete file transfer");
      this.operations.phase(m.id, "persisting"); this.resetStall();
      const writer = this.transfer.writer;
      this.operations.candidate(m.id, { path:writer.path, format:writer.format, byteLength:writer.byteLength, sha256:writer.expectedHash });
      await this.journal?.flush();
      const artifact = await this.transfer.writer.commit();
      await this.discardTransfer(); this.exports.delete(m.id);
      // Clear frontend ownership on the ordered WS before making the lane available.
      // Callers can enqueue/pump immediately when complete resolves their promise.
      this.send({ type: "settled", id: m.id });
      this.operations.complete(m.id, { success: true, data: null, error: null, artifact });
      // Publication is already committed even if journaling fails. Keep that outcome.
      try { await this.journal?.flush(); } catch { console.error("Artifact committed; operation journal write failed"); }
      this.pump(); return;
    }
    if (m.type === "result") {
      if (typeof m.success !== "boolean" || (m.data !== null && typeof m.data !== "string") || (m.error !== null && typeof m.error !== "string")) throw new Error("Invalid result schema");
      if (this.transfer) throw new Error("Text result while transferring file");
      const expectsFile = this.exports.has(m.id);
      const result: BridgeResult = expectsFile && m.success ? { success: false, data: null, error: "Export ended without binary artifact" } : { success: m.success, data: m.data, error: m.error };
      this.exports.delete(m.id); this.send({ type: "settled", id: m.id });
      this.operations.complete(m.id, result); this.pump(); return;
    }
  }
}

// Characterization probes: passing means the documented defect was reproduced.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { PhotopeaBridge } from "../../../src/bridge/websocket-server.js";

function frontend(bridge: PhotopeaBridge) {
  const raw = readFileSync(new URL("../../../src/frontend/index.html", import.meta.url), "utf8");
  const script = raw.match(/<script>([\s\S]*?)<\/script>/)![1];
  const internals = bridge as any;
  const scripts: unknown[] = [];
  const sockets: any[] = [];
  let messageHandler: (event: unknown) => void;
  const iframeWindow = { postMessage(payload: unknown) { scripts.push(payload); } };
  const elements = new Map<string, any>();
  const makeElement = () => ({
    textContent: "", classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, appendChild() {}, parentNode: null,
  });
  class BrowserSocket {
    static OPEN = 1;
    readyState = 1;
    sent: any[] = [];
    constructor() { sockets.push(this); }
    send(raw: string) {
      const message = JSON.parse(raw);
      this.sent.push(message);
      internals.handleClientMessage(message);
    }
  }
  runInNewContext(script, {
    document: {
      getElementById(id: string) {
        if (id === "photopea") return { contentWindow: iframeWindow };
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
      },
      createElement: makeElement,
    },
    window: { addEventListener(type: string, handler: typeof messageHandler) {
      if (type === "message") messageHandler = handler;
    } },
    location: { protocol: "http:", host: "127.0.0.1:4117" },
    WebSocket: BrowserSocket, setTimeout, clearTimeout, ArrayBuffer, Uint8Array,
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
  });
  const receive = (data: unknown) => messageHandler({ source: iframeWindow, data });
  internals.client = {
    readyState: 1,
    send(data: string) { sockets.at(-1).onmessage({ data }); },
  };
  sockets[0].onopen();
  receive("done");
  return { scripts, sockets, receive };
}

describe("queue and iframe behavior at 67057fc", () => {
  let bridge: PhotopeaBridge;
  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new PhotopeaBridge(0);
  });
  afterEach(async () => {
    await bridge.stop();
    vi.useRealTimers();
  });

  it("expires a queued script before sending it while an export still runs", async () => {
    const page = frontend(bridge);
    const exporting = bridge.executeScript("exportPSD", true);
    await vi.advanceTimersByTimeAsync(0);
    const queued = bridge.executeScript("inspectDocument");
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await queued).toMatchObject({ success: false, error: "Script execution timed out after 30s" });
    expect(page.scripts).toEqual(["exportPSD"]);
    page.receive(new ArrayBuffer(1));
    page.receive("done");
    await exporting;
  });

  it("attributes a timed-out operation's late output to the next operation", async () => {
    const page = frontend(bridge);
    const first = bridge.executeScript("moveLogoA");
    await vi.advanceTimersByTimeAsync(10_000);
    const second = bridge.executeScript("moveLogoB");
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await first).toMatchObject({ success: false });
    expect(page.scripts).toEqual(["moveLogoA", "moveLogoB"]);
    page.receive("result actually produced by A");
    page.receive("done");
    expect(await second).toMatchObject({ success: true, data: "result actually produced by A" });
  });

  it("reconnects the socket without reporting readiness for the still-loaded iframe", async () => {
    const page = frontend(bridge);
    expect(page.sockets[0].sent).toContainEqual({ type: "status", status: "ready" });
    page.sockets[0].onclose({ code: 1006, reason: "network interrupted" });
    await vi.advanceTimersByTimeAsync(1000);
    page.sockets[1].onopen();
    expect(page.sockets[1].sent).toEqual([]);
    expect(page.scripts).toEqual([]);
  });

  it("reports readiness on the first text message before Photopea emits done", () => {
    const page = frontend(bridge);
    page.sockets[0].onclose({ code: 1006, reason: "" });
    (bridge as any).ready = false;
    page.sockets[0].onopen();
    page.receive("an intermediate message");
    expect(bridge.isReady()).toBe(true);
  });

  it("does not clear server readiness on a disconnected status message", () => {
    frontend(bridge);
    (bridge as any).handleClientMessage({ type: "status", status: "disconnected" });
    expect(bridge.isReady()).toBe(true);
  });

  it("loses the pending promise when a file message throws after dequeue", async () => {
    frontend(bridge);
    let settled = false;
    bridge.executeScript("exportPSD", true).then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    const internals = bridge as any;
    const id = internals.queue[0].id;
    expect(() => internals.handleClientMessage({
      type: "file", id, success: true, data: { invalid: true },
    })).toThrow();
    // The socket listener catches the exception; queue and timer were already removed.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(internals.queue).toHaveLength(0);
    expect(settled).toBe(false);
  });

  it("resends the active script when a reply names an unsent queued operation", async () => {
    const page = frontend(bridge);
    const first = bridge.executeScript("duplicateLayer");
    const second = bridge.executeScript("inspectLater");
    await vi.advanceTimersByTimeAsync(0);
    const internals = bridge as any;
    internals.handleClientMessage({ type: "result", id: internals.queue[1].id,
      success: true, data: "reply to a request that was never sent", error: null });
    expect(await second).toMatchObject({ success: true });
    expect(page.scripts).toEqual(["duplicateLayer", "duplicateLayer"]);
    page.receive("done");
    await first;
  });
});

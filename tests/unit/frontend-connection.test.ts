import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, it, expect } from "vitest";

function loadFrontend() {
  const html = readFileSync(new URL("../../src/frontend/index.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const elements = new Map<string, any>();
  const element = () => ({
    textContent: "", classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, appendChild() {}, parentNode: null,
  });
  const connections: any[] = [];
  const timers: unknown[] = [];
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    constructor() { connections.push(this); }
    send() {}
  }
  runInNewContext(script, {
    document: {
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      createElement: element,
    },
    window: { addEventListener() {} },
    location: { protocol: "http:", host: "127.0.0.1:4117" },
    WebSocket: FakeWebSocket,
    setTimeout(callback: unknown) { timers.push(callback); return timers.length; },
    clearTimeout() {},
  });
  return { socket: connections[0], timers, elements };
}

describe("frontend connection ownership", () => {
  it("stops reconnecting when another document session owns the bridge", () => {
    const { socket, timers, elements } = loadFrontend();
    socket.onclose({ code: 1008, reason: "Another Photopea session is already connected" });
    expect(timers).toHaveLength(0);
    expect(elements.get("status-text").textContent).toContain("use that tab");
  });

  it("still reconnects after a transient connection failure", () => {
    const { socket, timers } = loadFrontend();
    socket.onclose({ code: 1006, reason: "" });
    expect(timers).toHaveLength(1);
  });
});

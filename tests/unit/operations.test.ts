import { afterEach, describe, it, expect, vi } from "vitest";
import { OperationManager } from "../../src/bridge/operation-manager.js";

afterEach(() => vi.useRealTimers());
describe('operation ownership', () => {
  it('starts execution budget at dispatch, retains ownership after timeout, reconciles late result', async () => {
    vi.useFakeTimers(); const manager = new OperationManager(120000);
    const sent: string[] = [];
    const a = manager.enqueue(id => sent.push(id), 30000); manager.pump(true);
    await vi.advanceTimersByTimeAsync(10000);
    const b = manager.enqueue(id => sent.push(id), 30000); manager.pump(true);
    await vi.advanceTimersByTimeAsync(20001);
    expect(await a.promise).toMatchObject({ state: 'indeterminate', operationId: a.operationId });
    manager.pump(true); expect(sent).toEqual([a.operationId]);
    expect(manager.complete(b.operationId, { success:true,data:'wrong',error:null })).toBe(false);
    await vi.advanceTimersByTimeAsync(15000);
    manager.complete(a.operationId, { success:true,data:'late A',error:null }); manager.pump(true);
    expect(manager.snapshot(a.operationId)?.result?.data).toBe('late A');
    expect(manager.snapshot(b.operationId)?.state).toBe('running');
    manager.complete(b.operationId,{success:true,data:'B',error:null}); expect((await b.promise).data).toBe('B'); manager.stop();
  });
  it('queued expiration/cancel never dispatches, active cancellation is truthful', async () => {
    vi.useFakeTimers(); const m = new OperationManager(100);
    const a = m.enqueue(()=>{},5000); m.pump(true);
    const b = m.enqueue(()=>{throw Error('must not dispatch');},5000);
    expect(m.cancel(a.operationId)).toBe('execution_not_cancellable');
    await vi.advanceTimersByTimeAsync(101); expect((await b.promise).state).toBe('expired');
    const c = m.enqueue(()=>{},5000); expect(m.cancel(c.operationId)).toBe('cancelled_before_dispatch');
    expect((await c.promise).state).toBe('cancelled'); m.stop();
  });
});

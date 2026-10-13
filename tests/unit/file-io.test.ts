import { afterEach, it, expect, vi } from 'vitest';
import { fetchUrlToBuffer } from '../../src/utils/file-io.js';
import { MAX_FILE_BYTES } from '../../src/utils/artifacts.js';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it('rejects oversized HTTP declarations before accumulating bytes',async()=>{
  vi.stubGlobal('fetch',async()=>new Response('small',{headers:{'content-length':String(MAX_FILE_BYTES+1)}}));
  await expect(fetchUrlToBuffer('https://example.invalid/asset')).rejects.toThrow('exceeds');
});
it('applies a deadline to stalled asset retrieval and clears it after a completed fetch',async()=>{
  vi.useFakeTimers();
  vi.stubGlobal('fetch',(_url:string,options:{signal:AbortSignal})=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('aborted')))));
  const pending=expect(fetchUrlToBuffer('https://example.invalid/stalled')).rejects.toThrow('aborted');
  await vi.advanceTimersByTimeAsync(30001);await pending;expect(vi.getTimerCount()).toBe(0);
  vi.stubGlobal('fetch',async()=>new Response(new Uint8Array([1,2,3])));
  expect(await fetchUrlToBuffer('https://example.invalid/asset')).toEqual(Buffer.from([1,2,3]));expect(vi.getTimerCount()).toBe(0);
});

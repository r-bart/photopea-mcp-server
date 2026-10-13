import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';

function frontend(digest: (buffer:ArrayBuffer)=>Promise<ArrayBuffer> = async()=>new Uint8Array(32).buffer){
  const script=readFileSync(new URL('../../src/frontend/client.js',import.meta.url),'utf8');
  const elements=new Map<string,any>(),connections:any[]=[],timers:any[]=[];let listener:(event:any)=>void=()=>{};
  const element=()=>({textContent:'',classList:{add(){},remove(){},toggle(){}},addEventListener(){},append(){},appendChild(){},remove(){},contentWindow:{postMessage:(data:string)=>editorMessages.push(data)}});
  const editorMessages:string[]=[];
  class WS{static OPEN=1;readyState=1;sent:any[]=[];constructor(){connections.push(this);}send(data:string){this.sent.push(JSON.parse(data));}}
  runInNewContext(script,{document:{getElementById(id:string){if(!elements.has(id))elements.set(id,element());return elements.get(id);},createElement:element},window:{addEventListener(_name:string,fn:any){listener=fn;}},location:{hash:'#token=test',host:'127.0.0.1:4117',pathname:'/'},history:{replaceState(){}},crypto:{randomUUID,subtle:{digest:(_algo:string,buffer:ArrayBuffer)=>digest(buffer)}},URLSearchParams,WebSocket:WS,setTimeout(fn:any){timers.push(fn);},ArrayBuffer,Uint8Array,DataView});
  const socket=connections[0];socket.onopen();const hello=socket.sent[0];
  socket.onmessage({data:JSON.stringify({type:'welcome',protocol:2,sessionId:hello.sessionId,epoch:'epoch',activeId:null})});
  const editor=(data:any)=>listener({data,source:elements.get('photopea').contentWindow,origin:'https://www.photopea.com'});
  return{socket,hello,editor,connections,timers,elements,editorMessages};
}
describe('frontend termination/reconnection',()=>{
  it('waits for initial done, retains readiness on reconnect and stops on ownership rejection',async()=>{
    const f=frontend();await Promise.resolve();f.editor('arbitrary echo');expect(f.socket.sent.some((m:any)=>m.type==='status')).toBe(false);
    f.editor('done');expect(f.socket.sent.at(-1)).toMatchObject({type:'status',ready:true});
    f.socket.onclose({code:1006});f.timers[0]();const second=f.connections[1];second.onopen();expect(second.sent[0].ready).toBe(true);
    second.onclose({code:1008,reason:'Another Photopea session owns this bridge'});expect(f.timers).toHaveLength(1);
  });
  it('does not release an execution on an untagged done or replace its pending ID',async()=>{
    const f=frontend();await Promise.resolve();f.editor('done');
    f.socket.onmessage({data:JSON.stringify({type:'execute',id:'A',script:'app.echoToOE("A")',expectFiles:false,sessionId:f.hello.sessionId,epoch:'epoch'})});
    await vi.waitFor(()=>expect(f.editorMessages).toHaveLength(1));f.editor('done');expect(f.socket.sent.some((m:any)=>m.type==='result')).toBe(false);
    f.editor('__mcp_begin:A');f.editor('A');f.editor('__mcp_end:A');f.editor('done');
    expect(f.socket.sent.at(-1)).toMatchObject({type:'result',id:'A',success:true,data:'A'});
  });
  it('ignores done before load submission, including during checksum, then completes actual load',async()=>{
    let complete!:(hash:ArrayBuffer)=>void;
    const f=frontend(()=>new Promise(resolve=>{complete=resolve;}));await Promise.resolve();f.editor('done');
    const envelope={sessionId:f.hello.sessionId,epoch:'epoch',id:'L'};
    f.socket.onmessage({data:JSON.stringify({...envelope,type:'load_begin',byteLength:8,filename:'fixture',sha256:'0'.repeat(64)})});
    await vi.waitFor(()=>expect(f.socket.sent.at(-1).type).toBe('load_ack'));
    f.editor('done');expect(f.socket.sent.some((m:any)=>m.type==='result')).toBe(false);
    const frame=new Uint8Array(16);f.socket.onmessage({data:frame.buffer});
    await vi.waitFor(()=>expect(f.socket.sent.at(-1).offset).toBe(8));f.editor('done');
    f.socket.onmessage({data:JSON.stringify({...envelope,type:'load_end'})});
    await vi.waitFor(()=>expect(complete).toBeTypeOf('function'));f.editor('done');
    expect(f.editorMessages).toHaveLength(0);expect(f.socket.sent.some((m:any)=>m.type==='result')).toBe(false);
    complete(new Uint8Array(32).buffer);await vi.waitFor(()=>expect(f.editorMessages).toHaveLength(1));
    f.editor('done');expect(f.socket.sent.at(-1)).toMatchObject({type:'result',id:'L',success:true});
  });
  it('reports an export once when reconnect occurs during SHA-256',async()=>{
    let complete!:(hash:ArrayBuffer)=>void,digests=0;
    const f=frontend(()=>{digests++;return new Promise(resolve=>{complete=resolve;});});await Promise.resolve();f.editor('done');
    f.socket.onmessage({data:JSON.stringify({type:'execute',id:'E',script:'save()',expectFiles:true,sessionId:f.hello.sessionId,epoch:'epoch'})});
    await vi.waitFor(()=>expect(f.editorMessages).toHaveLength(1));f.editor('__mcp_begin:E');f.editor(new Uint8Array(8).buffer);f.editor('__mcp_end:E');f.editor('done');
    expect(digests).toBe(1);f.socket.onclose({code:1006});f.timers[0]();const second=f.connections[1];second.onopen();
    second.onmessage({data:JSON.stringify({type:'welcome',protocol:2,sessionId:f.hello.sessionId,epoch:'new',activeId:'E'})});
    await Promise.resolve();complete(new Uint8Array(32).buffer);
    await vi.waitFor(()=>expect(second.sent.filter((m:any)=>m.type==='file_begin')).toHaveLength(1));expect(digests).toBe(1);
  });
});

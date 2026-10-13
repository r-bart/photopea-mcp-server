import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PhotopeaBridge } from '../../src/bridge/websocket-server.js';
import { CHUNK_BYTES } from '../../src/utils/artifacts.js';
import { layeredPsd } from '../fixtures/psd.js';

type Message = Record<string, any>;
class Client {
  ws!: WebSocket; epoch = ''; sessionId = randomUUID(); messages: Message[]=[]; events:Message[]=[];
  waiters: Array<{type:string;resolve:(m:Message)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}> = [];
  constructor(readonly bridge:PhotopeaBridge){}
  async connect(){
    this.ws=new WebSocket(`ws://127.0.0.1:${this.bridge.getPort()}`);
    this.ws.on('message',(raw,binary)=>{
      if(binary)return;
      const m=JSON.parse(raw.toString());this.events.push(m);if(m.type==='welcome')this.epoch=m.epoch;
      const i=this.waiters.findIndex(w=>w.type===m.type);
      if(i>=0){const [w]=this.waiters.splice(i,1);clearTimeout(w.timer);w.resolve(m);}else this.messages.push(m);
    });
    await new Promise<void>(r=>this.ws.once('open',r));
    this.ws.send(JSON.stringify({type:'hello',protocol:2,token:new URL(this.bridge.getLaunchUrl()).hash.slice(7),sessionId:this.sessionId,ready:true}));
    await this.next('welcome');
  }
  send(m:Message){this.ws.send(JSON.stringify({...m,sessionId:this.sessionId,epoch:this.epoch}));}
  next(type:string):Promise<Message>{const i=this.messages.findIndex(m=>m.type===type);if(i>=0)return Promise.resolve(this.messages.splice(i,1)[0]);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Missing '+type)),5000);this.waiters.push({type,resolve,reject,timer});});}
  close(){for(const w of this.waiters){clearTimeout(w.timer);w.reject(Error('Test closed'));}this.waiters=[];this.ws.terminate();}
  result(id:string,data='ok'){this.send({type:'result',id,success:true,data,error:null});}
  async file(id:string,data:Buffer,checksum=createHash('sha256').update(data).digest('hex')){
    this.send({type:'file_begin',id,byteLength:data.length,sha256:checksum});await this.next('file_ack');
    for(let offset=0,sequence=0;offset<data.length;sequence++){
      const chunk=data.subarray(offset,offset+CHUNK_BYTES),header=Buffer.alloc(8);header.writeUInt32BE(sequence);header.writeUInt32BE(offset,4);
      this.ws.send(Buffer.concat([header,chunk]));const ack=await this.next('file_ack');offset+=chunk.length;expect(ack.offset).toBe(offset);
    }
    this.send({type:'file_end',id});
  }
}
describe('authenticated operation bridge',()=>{
  let bridge:PhotopeaBridge,c:Client,dir:string;
  beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'bridge-test-'));bridge=new PhotopeaBridge(0,{autoLaunch:false,scriptMs:80,exportMs:10000,queueMs:10000,readyMs:50});await bridge.start();c=new Client(bridge);await c.connect();});
  afterEach(async()=>{c.close();await bridge.stop();await rm(dir,{recursive:true,force:true});});
  it('preserves active ownership after timeout, ignores unsent IDs and reconciles a late result',async()=>{
    const a=bridge.executeScript('A');const sentA=await c.next('execute');
    const b=bridge.executeScript('B');
    expect(await a).toMatchObject({success:false,state:'indeterminate',operationId:sentA.id});
    expect(bridge.getStatus().queued).toBe(1);
    c.result(randomUUID(),'unsent');c.result(sentA.id,'late A');
    const sentB=await c.next('execute');expect(sentB.script).toBe('B');
    c.result(sentB.id,'B');expect((await b).data).toBe('B');expect(bridge.getOperation(sentA.id)?.result?.data).toBe('late A');
  });
  it('rejects a malformed result without losing the operation',async()=>{
    const p=bridge.executeScript('A'),m=await c.next('execute');
    c.send({type:'result',id:m.id,success:true,data:{bad:true},error:null});await c.next('transfer_error');
    expect((await p).state).toBe('indeterminate');
    expect(bridge.operations.activeId).toBe(m.id);c.result(m.id,'valid');await c.next('settled');
    expect(bridge.getOperation(m.id)?.state).toBe('completed');
  });
  it('rejects text posing as a PSD and preserves an existing checkpoint',async()=>{
    const path=join(dir,'master.psd');await writeFile(path,'previous');
    const p=bridge.exportToFile("saveToOE('psd')",path,'psd'),m=await c.next('execute');c.result(m.id,'ok');
    expect(await p).toMatchObject({success:false,error:'Export ended without binary artifact'});
    expect((await readFile(path)).toString()).toBe('previous');
  });
  it('transfers >80 MiB across real WS with hash and layer structure verified',async()=>{
    const data=layeredPsd(3072,3072,3,true),path=join(dir,'checkpoint.psd');
    const p=bridge.exportToFile("saveToOE('psd')",path,'psd'),m=await c.next('execute');await c.file(m.id,data);
    expect(await p).toMatchObject({success:true,artifact:{path,byteLength:data.length,layerCount:3,sha256:createHash('sha256').update(data).digest('hex')}});
    expect(await readdir(dir)).toEqual(['checkpoint.psd']);
  },30000);
  it('checksum failure cleans staging and requires confirmed editor end before releasing',async()=>{
    const p=bridge.exportToFile('save',join(dir,'new.psd'),'psd'),m=await c.next('execute');await c.file(m.id,layeredPsd(),'0'.repeat(64));
    await c.next('transfer_error');expect((await p).state).toBe('indeterminate');expect(bridge.operations.activeId).toBe(m.id);
    c.send({type:'result',id:m.id,success:false,data:null,error:'transfer failed; editor ended'});await c.next('settled');
    expect(await readdir(dir)).toEqual([]);
  });
  it('retains result identity across same-page reconnect without replaying a script',async()=>{
    const p=bridge.executeScript('A'),m=await c.next('execute');
    const closed=new Promise(r=>c.ws.once('close',r));c.ws.close();await closed;
    expect((await p).state).toBe('indeterminate');
    await c.connect();expect(c.messages.filter(x=>x.type==='execute')).toHaveLength(0);
    c.result(m.id,'finished during disconnect');await c.next('settled');expect(bridge.getOperation(m.id)?.state).toBe('completed');
  });
  it('rejects a second session even with valid launch credential',async()=>{
    const second=new WebSocket(`ws://127.0.0.1:${bridge.getPort()}`);const closed=new Promise<number>(r=>second.once('close',code=>r(code)));
    await new Promise<void>(r=>second.once('open',r));second.send(JSON.stringify({type:'hello',protocol:2,token:new URL(bridge.getLaunchUrl()).hash.slice(7),sessionId:randomUUID(),ready:true}));
    expect(await closed).toBe(1008);expect(bridge.isReady()).toBe(true);
  });
  it('does not launch or dispatch on status, and readiness failure returns not started',async()=>{
    const dead=new PhotopeaBridge(0,{autoLaunch:false,readyMs:10});await dead.start();
    try{expect(dead.getStatus().ready).toBe(false);expect(await dead.executeScript('A')).toMatchObject({success:false,error:expect.stringContaining('not started')});}finally{await dead.stop();}
  });
  it('closes servers even when journal flush fails during shutdown',async()=>{
    const dead=new PhotopeaBridge(0,{autoLaunch:false,journalDirectory:join(dir,'journal')});await dead.start();
    const journal=(dead as unknown as {journal:{flush:()=>Promise<void>}}).journal;
    journal.flush=async()=>{throw Error('injected disk failure');};
    await expect(dead.stop()).rejects.toThrow('injected disk failure');
    expect(dead.httpServer.listening).toBe(false);await dead.stop();
  });
  it('sends settled before releasing the lane even when final journaling is slow',async()=>{
    let release!:()=>void,calls=0;
    const flush=()=>++calls===2?new Promise<void>(r=>{release=r;}):Promise.resolve();
    (bridge as unknown as {journal:object}).journal={record(){},flush};
    const p=bridge.exportToFile('save',join(dir,'new.psd'),'psd'),m=await c.next('execute');await c.file(m.id,layeredPsd());
    expect((await p).success).toBe(true);
    const next=bridge.executeScript('next'),sent=await c.next('execute');
    const settledIndex=c.events.findIndex(x=>x.type==='settled'&&x.id===m.id),executeIndex=c.events.findIndex(x=>x.type==='execute'&&x.id===sent.id);
    expect(settledIndex).toBeGreaterThan(-1);expect(settledIndex).toBeLessThan(executeIndex);
    release();c.result(sent.id);expect((await next).success).toBe(true);
  });
});

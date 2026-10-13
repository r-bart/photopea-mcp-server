import { runInNewContext } from 'node:vm';
import { describe,it,expect } from 'vitest';
import { EditorSession } from '../../src/livery/session.js';
import type { PhotopeaBridge } from '../../src/bridge/websocket-server.js';

function fixture(){
  const leaf=(name:string,visible=true)=>({name,visible,typename:'ArtLayer',opacity:100,bounds:[10,20,30,40],translate(x:number,y:number){this.bounds=this.bounds.map((n,i)=>n+(i%2===0?x:y));}});
  const group=(name:string,layers:any[],visible=true)=>({name,layers,visible,typename:'LayerSet',opacity:100,bounds:[0,0,64,64]});
  const a={name:'Twin',source:'file',width:64,height:64,layers:[group('Body',[leaf('Region 0')]),group('Regions',[leaf('Region 0')],false)]};
  const b={name:'Twin',source:'file',width:64,height:64,layers:[leaf('Other')]};
  const app={documents:[a,b],activeDocument:b,echoToOE(_text:string){}};
  let sessionId='session-A';
  const bridge={getStatus:()=>({sessionId}),runWorkflow:async(work:()=>Promise<any>)=>{try{return await work();}catch(e){return {success:false,data:null,error:(e as Error).message};}},executeScript:async(script:string)=>{
    let data:string|null=null;app.echoToOE=(s:string)=>{data=s;};
    try{runInNewContext(script,{app});return {success:true,data,error:null};}catch(e){return {success:false,data:null,error:(e as Error).message};}
  }};
  return {a,b,app,session:new EditorSession(bridge as unknown as PhotopeaBridge),changeSession:()=>{sessionId='session-B';}};
}
describe('checked document/layer references',()=>{
  it('distinguishes equal document names, preserves source/active state and rejects changed roster',async()=>{
    const f=fixture(),docs=await f.session.listDocuments();expect(docs.map(d=>d.active)).toEqual([false,true]);
    expect(f.a.source).toBe('file');expect(f.b.source).toBe('file');
    const layers=await f.session.getLayers(docs[0].documentRef,{depth:3});expect(f.app.activeDocument).toBe(f.b);
    expect(layers.layers.filter(l=>l.name==='Region 0')).toHaveLength(2);
    f.b.name='Different';const failed=await f.session.editLayer(docs[0].documentRef,layers.layers[1].selector,{visible:false});
    expect(failed.success).toBe(false);expect((f.a.layers[0] as any).layers[0].visible).toBe(true);
  });
  it('rejects ambiguous names, scopes a nested selector, and detects stale hierarchy',async()=>{
    const f=fixture(),docs=await f.session.listDocuments(),ref=docs[0].documentRef;
    const q=await f.session.getLayers(ref,{depth:3}),targets=q.layers.filter(l=>l.name==='Region 0');
    expect((await f.session.editLayer(ref,'Region 0',{visible:false})).success).toBe(false);
    expect((await f.session.editLayer(ref,targets[0].selector,{visible:false})).success).toBe(true);
    expect((f.a.layers[0] as any).layers[0].visible).toBe(false);expect((f.a.layers[1] as any).layers[0].visible).toBe(true);
    (f.a.layers[0] as any).layers.unshift({name:'Inserted',typename:'ArtLayer',visible:true,opacity:100,bounds:[0,0,1,1]});
    expect((await f.session.editLayer(ref,targets[1].selector,{visible:false})).success).toBe(false);
  });
  it('returns effective visibility, subtree pages and finite bounds, invalidates other sessions',async()=>{
    const f=fixture(),docs=await f.session.listDocuments(),ref=docs[0].documentRef;
    const roots=await f.session.getLayers(ref,{depth:1,limit:1});expect(roots.hasMore).toBe(true);
    const all=await f.session.getLayers(ref,{depth:3});const hidden=all.layers.find(l=>l.path.join('.')==='1.0')!;
    expect(hidden).toMatchObject({visible:true,effectiveVisible:false,bounds:{x:10,y:20,width:20,height:20}});
    const children=await f.session.getLayers(ref,{parent:roots.layers[0].selector,depth:1});expect(children.layers.map(l=>l.path)).toEqual([[0,0]]);
    f.changeSession();expect((await f.session.editLayer(ref,hidden.selector,{visible:false})).success).toBe(false);
  });
});

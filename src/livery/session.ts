import { randomUUID } from 'node:crypto';
import type { PhotopeaBridge } from '../bridge/websocket-server.js';
import type { BridgeResult } from '../bridge/types.js';

export interface DocumentDescriptor { index:number; name:string; source:string; width:number; height:number; layerSignature:string }
export interface DocumentReference extends DocumentDescriptor { documentRef:string; active:boolean|null; identity:'position_roster_checked' }
export interface LayerSelector { snapshotId:string; path:number[] }
export type LayerTarget=string|number|LayerSelector;
export interface LayerRecord { path:number[]; name:string; type:string; visible:boolean; effectiveVisible:boolean; opacity:number; bounds:{x:number;y:number;width:number;height:number}|null; selector:LayerSelector }
export interface LayerQuery {documentRef:string;snapshotId:string;layers:LayerRecord[];hasMore:boolean;structure:StructureEntry[]}
export interface StructureEntry { path:number[]; name:string; type:string }
interface DocumentBinding {sessionId:string;index:number;roster:ReturnType<typeof core>[]}
interface LayerSnapshot {documentRef:string;structure:StructureEntry[]}
const core=(d:DocumentDescriptor)=>({name:d.name,source:d.source,width:d.width,height:d.height});
export const literal=(value:unknown)=>JSON.stringify(value).replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');

export const DOM_HELPERS=`
function _mcpNumber(v){var n=Number(v);if(!isFinite(n)&&v!=null)n=Number(v.value);return isFinite(n)?n:null;}
function _mcpStructure(ls,p,r){if(p.length>64){_mcpError='Layer nesting exceeds budget';return;}for(var i=0;i<ls.length;i++){var path=p.concat([i]);r.push({path:path,name:String(ls[i].name),type:String(ls[i].typename)});if(r.length>2048){_mcpError='Layer count exceeds budget';return;}if(ls[i].layers)_mcpStructure(ls[i].layers,path,r);}}
function _mcpCore(d){return {name:String(d.name),source:String(d.source),width:_mcpNumber(d.width),height:_mcpNumber(d.height)};}
function _mcpPath(d,p){var ls=d.layers,l=null;for(var i=0;i<p.length;i++){if(p[i]<0||p[i]>=ls.length)return null;l=ls[p[i]];if(i<p.length-1){if(!l.layers)return null;ls=l.layers;}}return l;}
function _mcpBounds(l){var b=l.bounds;if(!b)return null;var x=_mcpNumber(b[0]),y=_mcpNumber(b[1]),r=_mcpNumber(b[2]),t=_mcpNumber(b[3]);if(x===null||y===null||r===null||t===null)return null;return {x:x,y:y,width:r-x,height:t-y};}
function _mcpFind(ls,name,p,r){for(var i=0;i<ls.length;i++){var path=p.concat([i]);if(String(ls[i].name)===name)r.push(path);if(ls[i].layers)_mcpFind(ls[i].layers,name,path,r);}}
`;

/** Photopea returned no native IDs and the same source for binary documents in the live probe.
 * References therefore check the full document roster, never claim an undetectable stable ID. */
export class EditorSession {
  private documents=new Map<string,DocumentBinding>();
  private snapshots=new Map<string,LayerSnapshot>();
  constructor(readonly bridge:PhotopeaBridge){}
  private async json<T>(script:string):Promise<T>{
    const result=await this.bridge.executeScript(script);
    if(!result.success)throw new Error(result.error??'Editor request failed');
    const parsed=JSON.parse(result.data??'null');
    if(!parsed||parsed.error)throw new Error(parsed?.error??'Missing editor response');
    return parsed as T;
  }
  async listDocuments():Promise<DocumentReference[]>{
    const raw=await this.json<{documents:DocumentDescriptor[];activeIndex:number}>(DOM_HELPERS+`
var _mcpError='',_mcpDocs=[],_mcpActiveIndex=-1;
if(app.documents.length>0){var _mcpOldSource=app.activeDocument.source;
if(typeof _mcpOldSource==='string'){var _mcpMarker=${literal('mcp-transient-'+randomUUID())};app.activeDocument.source=_mcpMarker;
for(var i=0;i<app.documents.length;i++)if(app.documents[i].source===_mcpMarker)_mcpActiveIndex=i;
app.activeDocument.source=_mcpOldSource;
if(app.activeDocument.source!==_mcpOldSource)_mcpError='Document source restoration failed';}}
function _mcpMeta(d,index){var q=_mcpCore(d),s=[];_mcpStructure(d.layers,[],s);q.index=index;q.layerSignature=JSON.stringify(s);return q;}
for(var i=0;i<app.documents.length;i++)_mcpDocs.push(_mcpMeta(app.documents[i],i));
app.echoToOE(JSON.stringify(_mcpError?{error:_mcpError}:{documents:_mcpDocs,activeIndex:_mcpActiveIndex}));`);
    const sessionId=this.bridge.getStatus().sessionId;
    if(!sessionId)throw new Error('No authenticated editor session');
    const roster=raw.documents.map(core);
    return raw.documents.map(d=>{
      const binding={sessionId,index:d.index,roster},key=JSON.stringify(binding);
      let ref=[...this.documents].find(([,b])=>JSON.stringify(b)===key)?.[0];
      if(!ref){ref=randomUUID();this.documents.set(ref,binding);if(this.documents.size>256)this.documents.delete(this.documents.keys().next().value!);}
      return {...d,documentRef:ref,active:raw.activeIndex>=0?raw.activeIndex===d.index:null,identity:'position_roster_checked'};
    });
  }
  async activeReference():Promise<string>{
    const documents=await this.listDocuments(),active=documents.filter(d=>d.active===true);
    if(active.length!==1)throw new Error('Active document is ambiguous; choose an explicit documentRef from list_documents');
    return active[0].documentRef;
  }
  binding(ref:string):DocumentBinding{
    const binding=this.documents.get(ref);
    if(!binding||binding.sessionId!==this.bridge.getStatus().sessionId)throw new Error('Document reference expired or belongs to another session');
    return binding;
  }
  guard(ref:string,body:string,restoreActive=true):string{
    const b=this.binding(ref);
    return DOM_HELPERS+`
var _mcpError='',_mcpRoster=[];
for(var i=0;i<app.documents.length;i++)_mcpRoster.push(_mcpCore(app.documents[i]));
var _mcpExpected=${literal(b.roster)};
if(JSON.stringify(_mcpRoster)!==JSON.stringify(_mcpExpected))_mcpError='Document roster changed; refresh references';
if(_mcpError)app.echoToOE(JSON.stringify({error:_mcpError}));
else {var _mcpPrevious=app.activeDocument;var _mcpDocument=app.documents[${b.index}];app.activeDocument=_mcpDocument;
${body}
${restoreActive?'app.activeDocument=_mcpPrevious;':''}
}`;
  }
  async query<T>(ref:string,body:string,restoreActive=true):Promise<T>{return this.json<T>(this.guard(ref,body,restoreActive));}
  snapshot(selector:LayerSelector,ref:string):LayerSnapshot{
    const s=this.snapshots.get(selector.snapshotId);
    if(!s||s.documentRef!==ref)throw new Error('Layer snapshot expired or belongs to another document');
    if(!s.structure.some(l=>JSON.stringify(l.path)===JSON.stringify(selector.path)))throw new Error('Layer path missing in snapshot');
    return s;
  }
  resolveScript(ref:string,target:LayerTarget,variable='_mcpLayer'):string{
    if(typeof target==='object'){
      const snapshot=this.snapshot(target,ref);
      return `var _mcpActual=[];_mcpStructure(_mcpDocument.layers,[],_mcpActual);if(JSON.stringify(_mcpActual)!==${literal(JSON.stringify(snapshot.structure))})_mcpError='Layer structure changed; refresh selectors';var ${variable}=_mcpPath(_mcpDocument,${literal(target.path)});if(!${variable})_mcpError='Layer missing';`;
    }
    if(typeof target==='number')return `var ${variable}=_mcpPath(_mcpDocument,[${target}]);if(!${variable})_mcpError='Root layer index missing';`;
    return `var _mcpMatches=[];_mcpFind(_mcpDocument.layers,${literal(target)},[],_mcpMatches);var ${variable}=null;if(_mcpMatches.length!==1)_mcpError='Layer name missing or ambiguous; use a selector';else ${variable}=_mcpPath(_mcpDocument,_mcpMatches[0]);`;
  }
  async getLayers(ref:string,options:{parent?:LayerSelector;depth?:number;offset?:number;limit?:number}={}):Promise<LayerQuery>{
    const prefix=options.parent?.path??[];
    const resolveParent=options.parent?this.resolveScript(ref,options.parent):'';
    const depth=options.depth??3,offset=options.offset??0,limit=options.limit??128;
    const raw=await this.query<{structure:StructureEntry[];layers:Omit<LayerRecord,'selector'>[];hasMore:boolean}>(ref,`
${resolveParent}
var _mcpS=[];_mcpStructure(_mcpDocument.layers,[],_mcpS);var _mcpSelected=[],_mcpCount=0,_mcpPrefix=${literal(prefix)};
for(var i=0;i<_mcpS.length;i++){var q=_mcpS[i],p=q.path,inside=p.length>_mcpPrefix.length&&p.length<=_mcpPrefix.length+${depth};for(var j=0;j<_mcpPrefix.length;j++)if(p[j]!==_mcpPrefix[j])inside=false;
if(inside){if(_mcpCount>=${offset}&&_mcpSelected.length<${limit}){var l=_mcpPath(_mcpDocument,p),effective=true;for(var j=1;j<=p.length;j++)if(!_mcpPath(_mcpDocument,p.slice(0,j)).visible)effective=false;
_mcpSelected.push({path:p,name:q.name,type:q.type,visible:!!l.visible,effectiveVisible:effective,opacity:_mcpNumber(l.opacity),bounds:_mcpBounds(l)});}_mcpCount++;}}
var _mcpReply={structure:_mcpS,layers:_mcpSelected,hasMore:_mcpCount>${offset}+${limit}};
if(JSON.stringify(_mcpReply).length>110000)_mcpError='Layer response exceeds budget; reduce query depth/limit';
app.echoToOE(JSON.stringify(_mcpError?{error:_mcpError}:_mcpReply));`);
    const snapshotId=randomUUID();this.snapshots.set(snapshotId,{documentRef:ref,structure:raw.structure});
    if(this.snapshots.size>256)this.snapshots.delete(this.snapshots.keys().next().value!);
    return {...raw,documentRef:ref,snapshotId,layers:raw.layers.map(l=>({...l,selector:{snapshotId,path:l.path}}))};
  }
  async allLayers(ref:string):Promise<LayerQuery>{
    let result=await this.getLayers(ref,{depth:64,limit:128}),offset=128;
    while(result.hasMore){const page=await this.getLayers(ref,{depth:64,offset,limit:128});if(JSON.stringify(page.structure)!==JSON.stringify(result.structure))throw new Error('Layer structure changed during inspection');result.layers.push(...page.layers);result.hasMore=page.hasMore;offset+=128;}
    return result;
  }
  targetPath(ref:string,target:LayerTarget,query:LayerQuery):number[]{
    if(typeof target==='object'){const s=this.snapshot(target,ref);if(JSON.stringify(s.structure)!==JSON.stringify(query.structure))throw new Error('Layer snapshot stale');return target.path;}
    if(typeof target==='number'){if(!query.structure.some(l=>l.path.length===1&&l.path[0]===target))throw new Error('Root layer missing');return [target];}
    const matches=query.structure.filter(l=>l.name===target);if(matches.length!==1)throw new Error('Layer name missing or ambiguous');return matches[0].path;
  }
  rebaseAfterAppend(ref:string,before:DocumentReference[],after:DocumentReference[]):string{
    const b=this.binding(ref);
    if(after.length!==before.length+1||JSON.stringify(before.map(core))!==JSON.stringify(after.slice(0,before.length).map(core)))throw new Error('Document collection changed unexpectedly; helper ownership unknown');
    return after[b.index].documentRef;
  }
  async editLayer(ref:string,target:LayerTarget,action:{visible?:boolean;opacity?:number;name?:string;x?:number;y?:number;relativeTo?:LayerTarget;placement?:'before'|'after'}):Promise<BridgeResult>{
    return this.bridge.runWorkflow(async()=>{
      const query=await this.allLayers(ref),a=this.targetPath(ref,target,query);
      let reorder='';
      if(action.relativeTo!==undefined){
        const b=this.targetPath(ref,action.relativeTo,query);
        if(JSON.stringify(a)!==JSON.stringify(b)){
          if(JSON.stringify(a.slice(0,-1))!==JSON.stringify(b.slice(0,-1)))throw new Error('Reordering requires sibling layers');
          const expected=[...a.slice(0,-1),b[b.length-1]-(a[a.length-1]<b[b.length-1]?1:0)+(action.placement==='after'?1:0)];
          const marker='mcp-'+randomUUID();
          reorder=`var _mcpOldName=String(_mcpLayer.name);_mcpLayer.name=${literal(marker)};_mcpLayer.move(_mcpNeighbor,ElementPlacement.${action.placement==='after'?'PLACEAFTER':'PLACEBEFORE'});var _mcpMoved=[];_mcpFind(_mcpDocument.layers,${literal(marker)},[],_mcpMoved);if(_mcpMoved.length!==1||JSON.stringify(_mcpMoved[0])!==${literal(JSON.stringify(expected))})_mcpError='Reorder position postcondition failed; inspect partial result';if(_mcpMoved.length===1){_mcpLayer=_mcpPath(_mcpDocument,_mcpMoved[0]);_mcpLayer.name=_mcpOldName;}`;
        }
      }
      let body=this.resolveScript(ref,target);
      if(action.relativeTo!==undefined)body+=this.resolveScript(ref,action.relativeTo,'_mcpNeighbor');
      if(action.x!==undefined||action.y!==undefined)body+=`var _mcpB=_mcpBounds(_mcpLayer);if(!_mcpB||_mcpB.width<=0||_mcpB.height<=0)_mcpError='Empty/nonfinite bounds';`;
      body+=`if(_mcpError)app.echoToOE(JSON.stringify({error:_mcpError}));else {`;
      if(action.visible!==undefined)body+=`_mcpLayer.visible=${action.visible};`;
      if(action.opacity!==undefined)body+=`_mcpLayer.opacity=${action.opacity};`;
      if(action.name!==undefined)body+=`_mcpLayer.name=${literal(action.name)};`;
      if(action.x!==undefined||action.y!==undefined)body+=`_mcpLayer.translate(${action.x??'_mcpB.x'}-_mcpB.x,${action.y??'_mcpB.y'}-_mcpB.y);var _mcpFinalB=_mcpBounds(_mcpLayer);if(!_mcpFinalB${action.x===undefined?'':`||Math.abs(_mcpFinalB.x-${action.x})>2`}${action.y===undefined?'':`||Math.abs(_mcpFinalB.y-${action.y})>2`})_mcpError='Position postcondition failed';`;
      body+=reorder;
      if(action.visible!==undefined)body+=`if(!!_mcpLayer.visible!==${action.visible})_mcpError='Visibility postcondition failed';`;
      if(action.name!==undefined)body+=`if(String(_mcpLayer.name)!==${literal(action.name)})_mcpError='Name postcondition failed';`;
      if(action.opacity!==undefined)body+=`if(Math.abs(_mcpNumber(_mcpLayer.opacity)-${action.opacity})>0.5)_mcpError='Opacity postcondition failed';`;
      body+=`app.echoToOE(JSON.stringify({error:_mcpError||null,name:String(_mcpLayer.name),visible:!!_mcpLayer.visible,opacity:_mcpNumber(_mcpLayer.opacity),bounds:_mcpBounds(_mcpLayer)}));}`;
      const data=await this.query<unknown>(ref,body);
      return {success:true,data:JSON.stringify(data),error:null};
    });
  }
}

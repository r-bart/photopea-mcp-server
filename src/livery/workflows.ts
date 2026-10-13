import { mkdir, open, rename, readFile } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EditorSession, literal, type LayerTarget, type LayerQuery, type DocumentReference } from './session.js';
import type { BridgeResult } from '../bridge/types.js';
import { readLocalFile, fetchUrlToBuffer, isUrl } from '../utils/file-io.js';

type Artifact=NonNullable<BridgeResult['artifact']>;
export interface ImportParams {source:string;document?:string;origin?:'canvas'|'content_bounds';x?:number;y?:number;width?:number;height?:number;name?:string}
export interface VisibilityRule {target:LayerTarget;visible:boolean}
export interface Variant {name:string;visibility:VisibilityRule[]}
export interface BundleParams {document:string;outputDirectory:string;variants:Variant[]}
export interface BundleManifest {
  schemaVersion:1;operationId:string;status:'complete'|'incomplete';createdAt:string;
  documentRef:string;consistencyMode:'checkpoint_copy_cooperative';checkpoint?:Artifact;
  files:Array<Artifact&{role:string;visibility:Array<{path:number[];name:string;visible:boolean}>}>;
  restoration:{copyVisibility:'pending'|'verified';sourceVisibility:'pending'|'verified';helper:'pending'|'closed';activeDocument:'pending'|'verified'};
  error?:string;helperDocumentRef?:string;
  renderProof?:{source:Artifact;copy:Artifact;match:boolean};
}
export async function manifestFile(path:string,manifest:BundleManifest):Promise<void>{
  const tmp=path+'.'+randomUUID()+'.tmp',handle=await open(tmp,'wx');
  try{await handle.writeFile(JSON.stringify(manifest,null,2));await handle.sync();}finally{await handle.close();}
  await rename(tmp,path);
}
function checked(result:BridgeResult):BridgeResult{
  if(!result.success)throw new Error(result.error??'Editor operation failed');return result;
}
function visibilityKey(query:LayerQuery):string{return JSON.stringify(query.layers.map(l=>({path:l.path,name:l.name,visible:l.visible,opacity:l.opacity})));}
function roster(documents:DocumentReference[]):string{return JSON.stringify(documents.map(({index,name,source,width,height})=>({index,name,source,width,height})));}

export class LiveryWorkflows {
  readonly bridge;
  constructor(readonly session:EditorSession,private readonly writeManifest=manifestFile){this.bridge=session.bridge;}
  async importAsset(params:ImportParams):Promise<BridgeResult>{
    return this.bridge.runWorkflow(async()=>{
      const before=await this.session.listDocuments();
      const original=params.document??await this.session.activeReference();
      this.session.binding(original);
      const source=isUrl(params.source)?await fetchUrlToBuffer(params.source):await readLocalFile(params.source);
      checked(await this.bridge.loadFile(source,'import-asset'));
      const after=await this.session.listDocuments(),destination=this.session.rebaseAfterAppend(original,before,after);
      const helper=after[after.length-1];
      const basis=params.origin??'canvas';
      try{
      const imported=await this.session.query<{bounds:{x:number;y:number;width:number;height:number};sourceCanvas:{width:number;height:number};sourceBounds:unknown;name:string}>(destination,`
var _mcpSource=app.documents[${helper.index}];app.activeDocument=_mcpSource;
app.echoToOE('__mcp_progress:import:inspect_source');
function _mcpVisible(ls,v,r){for(var i=0;i<ls.length;i++){var l=ls[i];if(v&&l.visible){if(l.layers)_mcpVisible(l.layers,true,r);else r.push(l);}}}
var _mcpLeaves=[];_mcpVisible(_mcpSource.layers,true,_mcpLeaves);
if(_mcpLeaves.length===0)_mcpError='Source has no visible content';
else {if(_mcpLeaves.length>1)_mcpSource.mergeVisibleLayers();else _mcpSource.activeLayer=_mcpLeaves[0];}
var _mcpSourceBounds=_mcpError?null:_mcpBounds(_mcpSource.activeLayer),_mcpW=_mcpNumber(_mcpSource.width),_mcpH=_mcpNumber(_mcpSource.height);
if(!_mcpSourceBounds||_mcpSourceBounds.width<=0||_mcpSourceBounds.height<=0||!_mcpW||!_mcpH)_mcpError='Empty/nonfinite source bounds';
if(_mcpError)app.echoToOE(JSON.stringify({error:_mcpError,helperDocumentRef:${literal(helper.documentRef)}}));
else {var _mcpBasisW=${basis==='canvas'?'_mcpW':'_mcpSourceBounds.width'},_mcpBasisH=${basis==='canvas'?'_mcpH':'_mcpSourceBounds.height'};
var _mcpScale=${params.width!==undefined&&params.height!==undefined?`Math.min(${params.width}/_mcpBasisW,${params.height}/_mcpBasisH)`:params.width!==undefined?`${params.width}/_mcpBasisW`:params.height!==undefined?`${params.height}/_mcpBasisH`:'1'};
app.echoToOE('__mcp_progress:import:duplicate');
var _mcpRootCount=_mcpDocument.layers.length;
_mcpSource.activeLayer.duplicate(_mcpDocument,ElementPlacement.PLACEATBEGINNING);app.activeDocument=_mcpDocument;var _mcpNew=_mcpDocument.layers[0];
if(_mcpDocument.layers.length!==_mcpRootCount+1)app.echoToOE(JSON.stringify({error:'Duplicate did not add a root layer; destination retained'}));
else {
_mcpNew.name=${literal(params.name??'Imported asset')};
app.echoToOE('__mcp_progress:import:resize');if(_mcpScale!==1)_mcpNew.resize(_mcpScale*100,_mcpScale*100);
app.echoToOE('__mcp_progress:import:position');
var _mcpPasted=_mcpBounds(_mcpNew),_mcpX=${params.x??0}+${basis==='canvas'?'_mcpSourceBounds.x*_mcpScale':'0'},_mcpY=${params.y??0}+${basis==='canvas'?'_mcpSourceBounds.y*_mcpScale':'0'};
if(!_mcpPasted)_mcpError='Imported bounds unavailable';else _mcpNew.translate(_mcpX-_mcpPasted.x,_mcpY-_mcpPasted.y);
var _mcpFinal=_mcpBounds(_mcpNew);
if(!_mcpFinal||Math.abs(_mcpFinal.x-_mcpX)>2||Math.abs(_mcpFinal.y-_mcpY)>2||Math.abs(_mcpFinal.width-_mcpSourceBounds.width*_mcpScale)>3||Math.abs(_mcpFinal.height-_mcpSourceBounds.height*_mcpScale)>3)_mcpError='Import geometry postcondition failed; inspect partial result';
if(!_mcpError)_mcpSource.close(2);
app.activeDocument=_mcpDocument;
app.echoToOE(JSON.stringify({error:_mcpError||null,name:String(_mcpNew.name),bounds:_mcpFinal,sourceCanvas:{width:_mcpW,height:_mcpH},sourceBounds:_mcpSourceBounds,helperClosed:!_mcpError}));}}`,false);
      return {success:true,data:JSON.stringify({...imported,documentRef:original,origin:basis}),error:null};
      }catch(error){
        let helperClosed=false,cleanupError:string|undefined;
        if(this.bridge.canContinueWorkflow())try{await this.closeHelper(helper.documentRef);helperClosed=true;const docs=await this.session.listDocuments();if(roster(docs)===roster(before))await this.session.query(docs[this.session.binding(original).index].documentRef,`app.echoToOE(JSON.stringify({active:true}));`,false);}catch(e){cleanupError=(e as Error).message;}
        return {success:false,data:JSON.stringify({documentRef:original,helperDocumentRef:helper.documentRef,helperClosed,cleanupError,partialResultPossible:true}),error:(error as Error).message};
      }
    });
  }
  private async applyVisibility(ref:string,baseline:LayerQuery,rules:Array<{path:number[];visible:boolean}>):Promise<void>{
    await this.session.query(ref,`
var _mcpActual=[];_mcpStructure(_mcpDocument.layers,[],_mcpActual);
var _mcpBaseline=${literal(baseline.layers.map(l=>({path:l.path,visible:l.visible})))},_mcpRules=${literal(rules)};
if(JSON.stringify(_mcpActual)!==${literal(JSON.stringify(baseline.structure))})_mcpError='Export copy structure changed';
var _mcpTargets=[];for(var i=0;i<_mcpBaseline.length;i++){var l=_mcpPath(_mcpDocument,_mcpBaseline[i].path);if(!l)_mcpError='Baseline layer missing';_mcpTargets.push(l);}
for(var i=0;i<_mcpRules.length;i++)if(!_mcpPath(_mcpDocument,_mcpRules[i].path))_mcpError='Recipe layer missing';
if(!_mcpError){for(var i=0;i<_mcpBaseline.length;i++)_mcpTargets[i].visible=_mcpBaseline[i].visible;for(var i=0;i<_mcpRules.length;i++)_mcpPath(_mcpDocument,_mcpRules[i].path).visible=_mcpRules[i].visible;}
app.echoToOE(JSON.stringify({error:_mcpError||null,applied:!_mcpError}));`);
    const actual=await this.session.allLayers(ref),expected=new Map(baseline.layers.map(l=>[JSON.stringify(l.path),l.visible]));
    for(const rule of rules)expected.set(JSON.stringify(rule.path),rule.visible);
    if(actual.layers.some(l=>expected.get(JSON.stringify(l.path))!==l.visible))throw new Error('Visibility postcondition failed');
  }
  private async closeHelper(ref:string):Promise<void>{
    await this.session.query(ref,`_mcpDocument.close(2);app.echoToOE(JSON.stringify({closed:true}));`,false);
  }
  async exportBundle(params:BundleParams):Promise<BridgeResult>{
    return this.bridge.runWorkflow(async()=>this.bundle(params));
  }
  startBundle(params:BundleParams):string{return this.bridge.startWorkflow(()=>this.bundle(params));}
  private async bundle(params:BundleParams):Promise<BridgeResult>{
    if(!isAbsolute(params.outputDirectory))throw new Error('Bundle directory must be absolute');
    if(params.variants.length<1||params.variants.length>8)throw new Error('Bundle requires 1–8 variants');
    const names=new Set<string>();for(const variant of params.variants){if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}\.png$/.test(variant.name)||names.has(variant.name.toLowerCase()))throw new Error('Variant filenames must be unique PNG basenames');names.add(variant.name.toLowerCase());}
    const beforeDocuments=await this.session.listDocuments(),source=await this.session.allLayers(params.document);
    const previousActive=beforeDocuments.find(d=>d.active===true);
    if(!previousActive)throw new Error('Cannot capture active document; bundle not started');
    const sourceState=visibilityKey(source);this.session.binding(params.document);
    const recipes=params.variants.map(v=>({name:v.name,rules:v.visibility.map(r=>({path:this.session.targetPath(params.document,r.target,source),visible:r.visible}))}));
    for(const recipe of recipes){const paths=recipe.rules.map(r=>JSON.stringify(r.path));if(new Set(paths).size!==paths.length)throw new Error('Duplicate recipe target');}
    const operationId=this.bridge.currentWorkflowId();if(!operationId)throw new Error('Bundle must own a workflow');
    await mkdir(dirname(params.outputDirectory),{recursive:true});await mkdir(params.outputDirectory);
    const manifestPath=join(params.outputDirectory,'manifest.json');
    const manifest:BundleManifest={schemaVersion:1,operationId,status:'incomplete',createdAt:new Date().toISOString(),documentRef:params.document,consistencyMode:'checkpoint_copy_cooperative',files:[],restoration:{copyVisibility:'pending',sourceVisibility:'pending',helper:'pending',activeDocument:'pending'}};
    await this.writeManifest(manifestPath,manifest);
    let helper:DocumentReference|undefined,baseline:LayerQuery|undefined,reboundSource:string|undefined;
    try{
      const sourceRender=checked(await this.bridge.exportToFile(this.session.guard(params.document,"_mcpDocument.saveToOE('png');"),join(params.outputDirectory,'source-composite.png'),'png'));
      if(!sourceRender.artifact)throw new Error('Source composition missing');
      const saved=checked(await this.bridge.exportToFile(this.session.guard(params.document,"_mcpDocument.saveToOE('psd');"),join(params.outputDirectory,'checkpoint.psd'),'psd'));
      if(!saved.artifact)throw new Error('Checkpoint artifact missing');manifest.checkpoint=saved.artifact;await this.writeManifest(manifestPath,manifest);
      checked(await this.bridge.loadFile(await readFile(saved.artifact.path),'export-checkpoint'));
      const afterDocuments=await this.session.listDocuments();reboundSource=this.session.rebaseAfterAppend(params.document,beforeDocuments,afterDocuments);helper=afterDocuments[afterDocuments.length-1];
      manifest.helperDocumentRef=helper.documentRef;baseline=await this.session.allLayers(helper.documentRef);
      if(JSON.stringify(baseline.structure)!==JSON.stringify(source.structure)||visibilityKey(baseline)!==sourceState)throw new Error('Checkpoint reopened with different layer structure/visibility');
      const copyRender=checked(await this.bridge.exportToFile(this.session.guard(helper.documentRef,"_mcpDocument.saveToOE('png');"),join(params.outputDirectory,'copy-composite.png'),'png'));
      if(!copyRender.artifact)throw new Error('Copy composition missing');
      manifest.renderProof={source:sourceRender.artifact,copy:copyRender.artifact,match:sourceRender.artifact.sha256===copyRender.artifact.sha256};
      if(!manifest.renderProof.match)throw new Error('Checkpoint copy renders differently; inspect fonts/composition');
      for(const recipe of recipes){
        await this.applyVisibility(helper.documentRef,baseline,recipe.rules);
        const output=checked(await this.bridge.exportToFile(this.session.guard(helper.documentRef,"_mcpDocument.saveToOE('png');"),join(params.outputDirectory,recipe.name),'png'));
        if(!output.artifact||output.artifact.width!==manifest.checkpoint.width||output.artifact.height!==manifest.checkpoint.height)throw new Error('Variant dimensions differ from checkpoint');
        manifest.files.push({...output.artifact,role:recipe.name,visibility:recipe.rules.map(r=>({...r,name:source.structure.find(l=>JSON.stringify(l.path)===JSON.stringify(r.path))!.name}))});await this.writeManifest(manifestPath,manifest);
      }
      await this.applyVisibility(helper.documentRef,baseline,[]);manifest.restoration.copyVisibility='verified';
      const original=await this.session.allLayers(reboundSource);if(visibilityKey(original)!==sourceState)throw new Error('Source visibility changed during export');manifest.restoration.sourceVisibility='verified';
      await this.closeHelper(helper.documentRef);manifest.restoration.helper='closed';
      // Select the original by the preserved index after closing only our appended helper.
      const finalDocuments=await this.session.listDocuments();
      if(roster(finalDocuments)!==roster(beforeDocuments))throw new Error('Document roster changed during helper cleanup');
      const finalRef=finalDocuments[previousActive.index].documentRef;
      await this.session.query(finalRef,`app.echoToOE(JSON.stringify({active:true}));`,false);
      if((await this.session.listDocuments()).find(d=>d.active)?.index!==previousActive.index)throw new Error('Active document restoration failed');
      manifest.restoration.activeDocument='verified';
      manifest.status='complete';await this.writeManifest(manifestPath,manifest);
      return {success:true,data:JSON.stringify({manifestPath,...manifest}),error:null,bundle:{manifestPath,status:'complete'}};
    }catch(error){
      manifest.status='incomplete';
      manifest.error=(error as Error).message;
      if(helper&&baseline&&manifest.restoration.helper!=='closed'&&this.bridge.canContinueWorkflow()){
        try{await this.applyVisibility(helper.documentRef,baseline,[]);manifest.restoration.copyVisibility='verified';
          if(reboundSource&&visibilityKey(await this.session.allLayers(reboundSource))===sourceState)manifest.restoration.sourceVisibility='verified';
          await this.closeHelper(helper.documentRef);manifest.restoration.helper='closed';
          const docs=await this.session.listDocuments();if(roster(docs)===roster(beforeDocuments)){await this.session.query(docs[previousActive.index].documentRef,`app.echoToOE(JSON.stringify({active:true}));`,false);if((await this.session.listDocuments()).find(d=>d.active)?.index===previousActive.index)manifest.restoration.activeDocument='verified';}
        }catch(cleanup){manifest.error+='; cleanup: '+(cleanup as Error).message;}
      }
      await this.writeManifest(manifestPath,manifest);
      return {success:false,data:JSON.stringify({manifestPath,...manifest}),error:manifest.error,bundle:{manifestPath,status:'incomplete'}};
    }
  }
}

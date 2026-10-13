import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { PhotopeaBridge } from '../../src/bridge/websocket-server.js';
import { EditorSession } from '../../src/livery/session.js';
import { LiveryWorkflows,manifestFile } from '../../src/livery/workflows.js';
import { buildCreateDocument } from '../../src/bridge/script-builder.js';
import { layeredPsd } from '../fixtures/psd.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
const dir=resolve('output','livery-'+randomUUID());await mkdir(dir,{recursive:true});
const bridge=new PhotopeaBridge(0,{autoLaunch:false,readyMs:300000,journalDirectory:join(dir,'operations')});
const session=new EditorSession(bridge),workflows=new LiveryWorkflows(session);
const html=await readFile('src/frontend/index.html'),client=await readFile('src/frontend/client.js');
bridge.httpServer.on('request',(req,res)=>{res.setHeader('Content-Type',req.url==='/client.js'?'text/javascript':'text/html');res.end(req.url==='/client.js'?client:html);});
await bridge.start();await writeFile(join(dir,'launch.json'),JSON.stringify({url:bridge.getLaunchUrl()}));console.log(JSON.stringify({dir,port:bridge.getPort()}));
const evidence:Record<string,unknown>={started:new Date().toISOString()};
const check=(r:any)=>{if(!r.success)throw Error(JSON.stringify(r));return r;};
try{
  await bridge.waitForReady();
  check(await bridge.executeScript(buildCreateDocument({width:4096,height:4096,name:'Twin'})));
  check(await bridge.executeScript(buildCreateDocument({width:4096,height:4096,name:'Twin'})));
  const documents=await session.listDocuments();evidence.twins=documents;
  if(documents.length!==2||documents.filter(d=>d.active).length!==1)throw Error('Document identity/active capture failed');
  const target=documents[1].documentRef;
  const svg=join(dir,'atlas.svg');await writeFile(svg,'<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1600" viewBox="0 0 1600 1600"><rect x="1000" y="500" width="200" height="100" fill="#ff6600"/></svg>');
  const actualLoad=bridge.loadFile.bind(bridge);
  bridge.loadFile=async(data,name)=>{const r=await actualLoad(data,name);if(name==='import-asset'&&r.success)check(await bridge.executeScript("app.activeDocument=app.documents[0];app.echoToOE('switched');"));return r;};
  console.log('Importing SVG atlas with active-document switch');
  const imported=check(await workflows.importAsset({document:target,source:svg,origin:'canvas',width:4096,height:4096,name:'Atlas decal'}));evidence.import=imported;
  const bounds=JSON.parse(imported.data).bounds;
  if(Math.abs(bounds.x-2560)>2||Math.abs(bounds.y-1280)>2||Math.abs(bounds.width-512)>3||Math.abs(bounds.height-256)>3)throw Error('Atlas origin/scale incorrect');
  const firstLayers=await session.allLayers(documents[0].documentRef),secondLayers=await session.allLayers(target);
  if(firstLayers.layers.some(l=>l.name==='Atlas decal')||!secondLayers.layers.some(l=>l.name==='Atlas decal'))throw Error('Import mutated wrong document');
  const empty=join(dir,'empty.svg');await writeFile(empty,'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>');
  const emptyResult=await workflows.importAsset({document:target,source:empty});
  if(emptyResult.success||!JSON.parse(emptyResult.data!).helperClosed||(await session.listDocuments()).length!==2)throw Error('Empty import cleanup failed');evidence.emptyImport=emptyResult;
  check(await bridge.executeScript("app.activeDocument=app.documents[1];var a=app.activeDocument.artLayers.add();a.name='Order A';var b=app.activeDocument.artLayers.add();b.name='Order B';app.echoToOE('ok');"));
  check(await session.editLayer(target,'Order B',{relativeTo:'Order A',placement:'after',opacity:75}));
  check(await session.editLayer(target,'Order B',{relativeTo:'Order B',visible:false}));
  const ordered=await session.allLayers(target),orderA=ordered.layers.find(l=>l.name==='Order A')!,orderB=ordered.layers.find(l=>l.name==='Order B')!;
  if(orderB.path[0]!==orderA.path[0]+1||Math.abs(orderB.opacity-75)>0.5||orderB.visible)throw Error('Reorder/self-reorder postconditions failed');evidence.reorder={result:'passed',opacity:orderB.opacity};
  console.log('Testing duplicate nested layer names and stale selectors');
  check(await bridge.executeScript("app.activeDocument=app.documents[1];var a=app.activeDocument.artLayers.add();a.name='Region 0';var b=app.activeDocument.artLayers.add();b.name='Region 0';var g=app.activeDocument.layerSets.add();g.name='Nested';b.move(g,ElementPlacement.PLACEATEND);app.echoToOE('ok');"));
  const nested=await session.allLayers(target),regions=nested.layers.filter(l=>l.name==='Region 0');
  if(regions.length!==2||!regions.some(l=>l.path.length>1))throw Error('Nested fixture missing');
  const ambiguous=await session.editLayer(target,'Region 0',{visible:false});if(ambiguous.success)throw Error('Ambiguous name accepted');evidence.ambiguous=ambiguous;
  check(await session.editLayer(target,regions[0].selector,{visible:false}));
  check(await session.editLayer(target,regions[0].selector,{name:'Region unique'}));
  const stale=await session.editLayer(target,regions[1].selector,{visible:false});if(stale.success)throw Error('Stale structure accepted');evidence.stale=stale;
  console.log('Loading material recipe fixture');
  check(await actualLoad(layeredPsd(128,128,3),'material-fixture'));
  const materialDocs=await session.listDocuments(),material=materialDocs[materialDocs.length-1].documentRef;
  check(await bridge.executeScript("app.activeDocument.layers[0].name='Body';app.activeDocument.layers[1].name='Region';app.activeDocument.layers[2].name='Wing region';app.echoToOE('ok');"));
  const baseline=await session.allLayers(material),beforeVisible=baseline.layers.map(l=>[l.path,l.visible]);
  const region=baseline.layers.find(l=>l.name==='Region')!,wing=baseline.layers.find(l=>l.name==='Wing region')!,body=baseline.layers.find(l=>l.name==='Body')!;
  // Export a non-active document; restore the previous twin as active.
  check(await bridge.executeScript('app.activeDocument=app.documents[0];app.echoToOE("ok");'));
  console.log('Exporting coherent bundle from immutable checkpoint');
  const bundle=check(await workflows.exportBundle({document:material,outputDirectory:join(dir,'revision'),variants:[
    {name:'albedo.png',visibility:[{target:body.selector,visible:true},{target:region.selector,visible:false},{target:wing.selector,visible:false}]},
    {name:'regions.png',visibility:[{target:body.selector,visible:false},{target:region.selector,visible:true},{target:wing.selector,visible:true}]}
  ]}));evidence.bundle=bundle;
  const manifest=JSON.parse(bundle.data);if(manifest.status!=='complete'||manifest.files.length!==2)throw Error('Bundle incomplete');
  if(manifest.files[0].sha256===manifest.files[1].sha256)throw Error('Recipes produced identical images');
  for(const file of [manifest.checkpoint,...manifest.files])if(createHash('sha256').update(await readFile(file.path)).digest('hex')!==file.sha256)throw Error('Manifest hash mismatch');
  const finalDocs=await session.listDocuments();if(finalDocs.length!==3||finalDocs.find(d=>d.active)?.index!==0)throw Error('Helper/active state restoration failed');
  const sourceAfter=await session.allLayers(finalDocs[2].documentRef);if(JSON.stringify(sourceAfter.layers.map(l=>[l.path,l.visible]))!==JSON.stringify(beforeVisible))throw Error('Source visibility changed');
  const recipe={document:material,outputDirectory:'',variants:[{name:'albedo.png',visibility:[{target:'Body',visible:true}]},{name:'regions.png',visibility:[{target:'Body',visible:false},{target:'Region',visible:true}]}]};
  const exportFile=bridge.exportToFile.bind(bridge);
  for(const mode of ['second-export','copy-render','manifest-promotion']){
    console.log('Injecting '+mode+' failure');let injected=false;
    bridge.exportToFile=async(script,path,format)=>{
      if(!injected&&mode==='second-export'&&path.endsWith('regions.png')){injected=true;return {success:false,data:null,error:'Injected export failure'};}
      const result=await exportFile(script,path,format);
      if(mode==='copy-render'&&path.endsWith('copy-composite.png')&&result.artifact){injected=true;result.artifact.sha256='0'.repeat(64);}
      return result;
    };
    const writer=new LiveryWorkflows(session,async(path,m)=>{if(!injected&&mode==='manifest-promotion'&&m.status==='complete'){injected=true;throw Error('Injected manifest promotion failure');}await manifestFile(path,m);});
    const failed=await writer.exportBundle({...recipe,outputDirectory:join(dir,mode)});
    if(failed.success||!injected||failed.bundle?.status!=='incomplete')throw Error(mode+' not rejected');
    const disk=JSON.parse(await readFile(failed.bundle.manifestPath,'utf8'));
    if(disk.status!=='incomplete'||Object.values(disk.restoration).some(v=>v!=='verified'&&v!=='closed'))throw Error(mode+' incomplete/restoration guarantee failed');
    const docs=await session.listDocuments();if(docs.length!==3||docs.find(d=>d.active)?.index!==0)throw Error(mode+' changed document roster/active');
    if(JSON.stringify((await session.allLayers(docs[2].documentRef)).layers.map(l=>[l.path,l.visible]))!==JSON.stringify(beforeVisible))throw Error(mode+' changed source visibility');
    evidence[mode]=failed;
  }
  bridge.exportToFile=exportFile;
  console.log('Exporting >80 MiB noise PSD bundle');
  check(await actualLoad(layeredPsd(3072,3072,3,true),'large-material'));
  const largeDocs=await session.listDocuments(),largeRef=largeDocs[3].documentRef;
  check(await bridge.executeScript('app.activeDocument=app.documents[0];app.echoToOE("ok");'));
  const large=check(await workflows.exportBundle({document:largeRef,outputDirectory:join(dir,'large-revision'),variants:[{name:'albedo.png',visibility:[{target:0,visible:true},{target:1,visible:false},{target:2,visible:false}]},{name:'regions.png',visibility:[{target:0,visible:false},{target:1,visible:true},{target:2,visible:true}]}]}));
  const largeManifest=JSON.parse(large.data);if(largeManifest.checkpoint.byteLength<80*1024*1024||!largeManifest.renderProof.match)throw Error('Large checkpoint threshold/render proof failed');
  evidence.largeBundle=large;
  console.log('Testing registered MCP tools through SDK transport');
  const server=createServer(bridge),client=new Client({name:'livery-e2e',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  await server.connect(a);await client.connect(b);
  try{
    const unwrap=(r:any)=>JSON.parse(r.content[0].text);
    const listed=unwrap(await client.callTool({name:'photopea_list_documents',arguments:{}}));check(listed);
    const docs=JSON.parse(listed.data),ref=docs[2].documentRef;
    const layers=unwrap(await client.callTool({name:'photopea_get_layers',arguments:{document:ref,depth:3}}));check(layers);
    const started=unwrap(await client.callTool({name:'photopea_export_bundle',arguments:{document:ref,outputDirectory:join(dir,'sdk-revision'),variants:[{name:'albedo.png',visibility:[]}]}}));
    let op;do{op=unwrap(await client.callTool({name:'photopea_get_operation',arguments:{operationId:started.operationId}}));if(!op.finishedAt)await new Promise(r=>setTimeout(r,50));}while(!op.finishedAt);
    check(op.result);if(op.result.bundle.status!=='complete')throw Error('MCP SDK bundle failed');evidence.sdk='passed';
  }finally{await client.close();await server.close();}
  evidence.result='passed';console.log(JSON.stringify({result:'passed',dir,manifestPath:bundle.bundle.manifestPath}));
}catch(error){evidence.result='failed';evidence.error=(error as Error).message;console.error(evidence.error);process.exitCode=1;}
finally{evidence.finished=new Date().toISOString();await writeFile(join(dir,'evidence.json'),JSON.stringify(evidence,null,2));await bridge.stop();}

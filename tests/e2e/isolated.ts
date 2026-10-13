import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { PhotopeaBridge } from "../../src/bridge/websocket-server.js";
import { layeredPsd } from "../fixtures/psd.js";
import { validateArtifact } from "../../src/utils/artifacts.js";

const dir = resolve('output', 'isolated-' + randomUUID());
await mkdir(dir, {recursive:true});
const bridge = new PhotopeaBridge(0,{autoLaunch:false,readyMs:300000,scriptMs:30000,exportMs:180000,journalDirectory:join(dir,'operations')});
const html = await readFile('src/frontend/index.html','utf8'), client = await readFile('src/frontend/client.js','utf8');
bridge.httpServer.on('request',(req,res)=>{
  if(req.method!=='GET'||!['/','/client.js'].includes(req.url!)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':req.url==='/client.js'?'text/javascript':'text/html','Cache-Control':'no-store'});
  res.end(req.url==='/client.js'?client:html);
});
await bridge.start();
// Launch credential lives only in this ignored test output, never stdout or reports.
await writeFile(join(dir,'launch.json'),JSON.stringify({url:bridge.getLaunchUrl(),port:bridge.getPort()}));
console.log(JSON.stringify({testDirectory:dir,port:bridge.getPort(),phase:'awaiting isolated tab'}));
const evidence: Record<string,unknown> = { started:new Date().toISOString(), port:bridge.getPort() };
async function run(script:string){const r=await bridge.executeScript(script); if(!r.success)throw Error(JSON.stringify(r));return r.data;}
const snapshot = `function walk(ls){var r=[];for(var i=0;i<ls.length;i++){var l=ls[i];var q={name:l.name,visible:l.visible,opacity:l.opacity,type:String(l.typename),kind:String(l.kind)};if(l.kind===LayerKind.TEXT)q.text={font:l.textItem.font,contents:l.textItem.contents};if(l.layers)q.children=walk(l.layers);r.push(q);}return r;}var d=app.activeDocument;app.echoToOE(JSON.stringify({width:Number(d.width),height:Number(d.height),layers:walk(d.layers)}));`;
try {
  await bridge.waitForReady();
  console.log('Isolated editor ready; probing synchronous execution');
  const probe = await bridge.executeScript("app.echoToOE('probe');"); evidence.probe=probe; console.log(JSON.stringify(probe));
  if(!probe.success)throw Error('Synchronous probe failed');
  console.log('Testing script error/queue');
  const syntax=await bridge.executeScript('var = broken;');
  evidence.syntaxError=syntax; console.log(JSON.stringify(syntax));
  if(syntax.success||bridge.operations.activeId)throw Error('Syntax error did not settle safely');
  const replies=await Promise.all([run("app.echoToOE('A');"),run("app.echoToOE('B');")]);
  if(JSON.stringify(replies)!=='["A","B"]')throw Error('Queue correlation failure');
  console.log('Creating independent layered noisy PSD fixture');
  const font=await readFile(process.env.PHOTOPEA_TEST_FONT ?? 'C:/Windows/Fonts/arial.ttf');
  const fontLoad=await bridge.loadFile(font,'arial.ttf'); if(!fontLoad.success)throw Error('Font fixture failed');
  const fixture=layeredPsd(3072,3072,3,true);
  await writeFile(join(dir,'fixture.psd'),fixture);
  const load=await bridge.loadFile(fixture,'fixture.psd'); if(!load.success)throw Error(JSON.stringify(load));
  // Rename and create an adjustment layer/group using the actual interpreter.
  await run("app.activeDocument.layers[0].name='Noise visible';app.activeDocument.layers[1].name='Noise hidden';app.activeDocument.layers[1].visible=false;app.activeDocument.layers[2].name='Noise base';app.echoToOE('ok');");
  const fontName = JSON.stringify(process.env.PHOTOPEA_TEST_FONT_NAME ?? 'ArialMT');
  await run("var fixtureGroup=app.activeDocument.layerSets.add();fixtureGroup.name='Fixture group';app.activeDocument.layers.getByName('Noise base').move(fixtureGroup,ElementPlacement.PLACEATEND);var fixtureText=app.activeDocument.artLayers.add();fixtureText.kind=LayerKind.TEXT;fixtureText.name='Fixture text';fixtureText.textItem.font="+fontName+";fixtureText.textItem.contents='PSD checkpoint';fixtureText.textItem.position=[100,100];fixtureText.textItem.size=48;app.echoToOE('ok');");
  await run("var fixtureMake=new ActionDescriptor();var fixtureRef=new ActionReference();fixtureRef.putClass(stringIDToTypeID('adjustmentLayer'));fixtureMake.putReference(charIDToTypeID('null'),fixtureRef);var fixtureUse=new ActionDescriptor();var fixtureLevels=new ActionDescriptor();fixtureUse.putObject(charIDToTypeID('Type'),charIDToTypeID('Lvls'),fixtureLevels);fixtureMake.putObject(charIDToTypeID('Usng'),charIDToTypeID('AdjL'),fixtureUse);executeAction(charIDToTypeID('Mk  '),fixtureMake,DialogModes.NO);app.activeDocument.activeLayer.name='Fixture Levels';app.echoToOE('ok');");
  const before=JSON.parse((await run(snapshot))!);
  evidence.before=before;
  function flatten(layers:any[]):any[]{return layers.flatMap(l=>[l,...flatten(l.children??[])]);}
  const flat=flatten(before.layers);
  if(!flat.some((l:any)=>l.name==='Fixture group'&&l.children?.length>=1)||!flat.some((l:any)=>l.name==='Fixture Levels')||!flat.some((l:any)=>l.name==='Fixture text'))throw Error('Fixture groups/text/adjustment were not created');
  const psdPath=join(dir,'checkpoint.psd');
  const started=Date.now(); console.log('Exporting layered PSD through binary channel');
  const result=await bridge.exportToFile("app.activeDocument.saveToOE('psd');",psdPath,'psd');
  if(!result.success||!result.artifact||result.artifact.byteLength<=80*1024*1024)throw Error('Large PSD checkpoint failed: '+JSON.stringify(result));
  const bytes=await readFile(psdPath); if(createHash('sha256').update(bytes).digest('hex')!==result.artifact.sha256)throw Error('Persisted hash differs');
  await validateArtifact(psdPath,'psd');
  const pngBefore=await bridge.exportToFile("app.activeDocument.saveToOE('png');",join(dir,'before.png'),'png'); if(!pngBefore.success)throw Error(JSON.stringify(pngBefore));
  await run('app.activeDocument.close(2);app.echoToOE("closed");');
  const reopened=await bridge.loadFile(bytes,'checkpoint.psd'); if(!reopened.success)throw Error(JSON.stringify(reopened));
  const after=JSON.parse((await run(snapshot))!);
  if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Layer roundtrip mismatch');
  const pngAfter=await bridge.exportToFile("app.activeDocument.saveToOE('png');",join(dir,'after.png'),'png'); if(!pngAfter.success)throw Error(JSON.stringify(pngAfter));
  if(pngBefore.artifact?.sha256!==pngAfter.artifact?.sha256)throw Error('Composite PNG changed after PSD reopen');
  console.log('Injecting socket loss during a second PSD transfer');
  let faultInjected=false;
  const interruptedId=bridge.startExport("app.activeDocument.saveToOE('psd');",join(dir,'reconnected.psd'),'psd');
  const faultTimer=setInterval(()=>{
    if(!faultInjected&&bridge.getOperation(interruptedId)?.state==='transferring'){
      faultInjected=true;for(const ws of bridge.wss.clients)ws.terminate();
    }
  },2);
  const recoveryDeadline=Date.now()+60000;
  try{
    while(!bridge.getOperation(interruptedId)?.finishedAt){if(Date.now()>recoveryDeadline)throw Error('Reconnect failed to reconcile transfer');await new Promise(r=>setTimeout(r,50));}
  }finally{clearInterval(faultTimer);}
  const recovered=bridge.getOperation(interruptedId)!;
  if(!faultInjected||!recovered.result?.success||recovered.result.artifact?.layerCount!==result.artifact.layerCount)throw Error('Reconnect artifact mismatch');
  if(createHash('sha256').update(await readFile(psdPath)).digest('hex')!==result.artifact.sha256)throw Error('Previous checkpoint changed');
  evidence.reconnection={faultInjected,operation:recovered};
  evidence.result='passed'; evidence.artifact=result.artifact; evidence.before=before; evidence.after=after;
  evidence.pngHash=pngAfter.artifact?.sha256; evidence.elapsedExportMs=Date.now()-started;
  evidence.nodeMemory=process.memoryUsage(); evidence.syntaxError=syntax; evidence.queueReplies=replies;
  console.log('Testing runtime failure retains editor ownership');
  const runtime=await bridge.executeScript('var fixtureNull=null;app.echoToOE(fixtureNull.foo.bar);'); evidence.runtimeError=runtime;
  if(runtime.success||runtime.state!=='indeterminate'||!bridge.operations.activeId)throw Error('Runtime failure released editor ownership');
  console.log(JSON.stringify({result:'passed',byteLength:result.artifact.byteLength,sha256:result.artifact.sha256,layers:after.layers.length,testDirectory:dir}));
} catch(error){evidence.result='failed';evidence.error=(error as Error).message; console.error((error as Error).message);process.exitCode=1;}
finally{evidence.finished=new Date().toISOString();await writeFile(join(dir,'evidence.json'),JSON.stringify(evidence,null,2));await bridge.stop();}

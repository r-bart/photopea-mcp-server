import { PhotopeaBridge } from '../../src/bridge/websocket-server.js';
import { layeredPsd } from '../fixtures/psd.js';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join,resolve } from 'node:path';
const directory=resolve('output','identity-'+randomUUID());await mkdir(directory,{recursive:true});
const bridge=new PhotopeaBridge(0,{autoLaunch:false,readyMs:300000});
const html=await readFile('src/frontend/index.html'),js=await readFile('src/frontend/client.js');
bridge.httpServer.on('request',(req,res)=>{res.setHeader('Content-Type',req.url==='/client.js'?'text/javascript':'text/html');res.end(req.url==='/client.js'?js:html);});
await bridge.start();await writeFile(join(directory,'launch.json'),JSON.stringify({url:bridge.getLaunchUrl()}));console.log(JSON.stringify({directory,port:bridge.getPort()}));
try{
  await bridge.waitForReady();
  await bridge.loadFile(layeredPsd(),'same.psd');await bridge.loadFile(layeredPsd(),'same.psd');
  const script="var r=[];for(var i=0;i<app.documents.length;i++){var d=app.documents[i];var ls=[];for(var j=0;j<d.layers.length;j++)ls.push({name:d.layers[j].name,id:d.layers[j].id,idType:typeof d.layers[j].id});r.push({name:d.name,id:d.id,idType:typeof d.id,source:d.source,active:d===app.activeDocument,layers:ls});}app.echoToOE(JSON.stringify(r));";
  const before=await bridge.executeScript(script);console.log(before.data);
  await bridge.executeScript("app.activeDocument.layers[0].name='Renamed';app.activeDocument.layers[0].translate(1,2);app.echoToOE('ok');");
  const after=await bridge.executeScript(script);console.log(after.data);
  const marker=await bridge.executeScript("var oldSource=app.activeDocument.source;var oldHistory=app.activeDocument.historyStates.length;app.activeDocument.source='mcp-temporary-probe';var activeIndex=-1;for(var i=0;i<app.documents.length;i++)if(app.documents[i].source==='mcp-temporary-probe')activeIndex=i;app.activeDocument.source=oldSource;app.echoToOE(JSON.stringify({activeIndex:activeIndex,source:app.activeDocument.source,oldSource:oldSource,oldHistory:oldHistory,history:app.activeDocument.historyStates.length}));");console.log(marker.data);
  await writeFile(join(directory,'evidence.json'),JSON.stringify({before,after,marker},null,2));
}finally{await bridge.stop();}

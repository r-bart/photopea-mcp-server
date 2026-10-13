import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Receiver } from 'ws';
import { PhotopeaBridge } from '../../../src/bridge/websocket-server.js';
import { registerExportTools } from '../../../src/tools/export.js';
import vm from 'node:vm';

const results:any[]=[];
const bridge:any = new PhotopeaBridge(0);
bridge.client={readyState:1,send:()=>{}}; bridge.ready=true;
const request = bridge.executeScript("saveToOE('psd')",true);
await Promise.resolve();
const id=bridge.queue[0].id;
bridge.handleClientMessage({type:'result',id,success:true,data:'ok',error:null});
results.push({probe:'expectFiles accepts text result',result:await request});
bridge.client=null;
await bridge.stop();

const handlers:any={};
registerExportTools({registerTool:(name:any,_schema:any,handler:any)=>handlers[name]=handler} as any,{sendActivity:()=>{},executeScript:async()=>({success:true,data:'ok',error:null})} as any);
const outputPath=resolve('thoughts/audit/export-probes/false-success.psd');
const result=await handlers.photopea_export_image({format:'psd',outputPath});
results.push({probe:'text result persisted as PSD',result,bytes:readFileSync(outputPath).length,contents:readFileSync(outputPath,'utf8')});

const html=readFileSync('src/frontend/index.html','utf8');
const done=html.slice(html.indexOf('function handlePhotopea_done()'),html.indexOf('// Utilities',html.indexOf('function handlePhotopea_done()'))).replace(/\/\/\s*-+\s*$/,'');
const messages:any[]=[];
const sandbox:any={photopeaReady:true,pendingId:'export-without-file',fileBuffer:null,echoBuffer:[],sendToWS:(m:any)=>messages.push(m)};
vm.runInNewContext(done+'; handlePhotopea_done();',sandbox);
results.push({probe:'frontend done without binary',messages});

const receiver = new Receiver({maxPayload:100*1024*1024});
const header=Buffer.alloc(10); header[0]=0x81; header[1]=127; header.writeBigUInt64BE(BigInt(100*1024*1024+1),2);
const err:any=await new Promise(resolve=>{receiver.on('error',resolve);receiver.write(header);});
results.push({probe:'ws default-size ceiling via synthetic frame header',message:err.message,code:err.code});

const max=100*1024*1024;
const v17=77303580;
results.push({probe:'size arithmetic',wsMaxBytes:max,v17Bytes:v17,v17Base64Bytes:4*Math.ceil(v17/3),binaryCeilingBeforeEnvelope:3*Math.floor(max/4),estimatedNextPsdBytes:v17+(77303580-74733891),estimatedNextBase64Bytes:4*Math.ceil((v17+(77303580-74733891))/3)});
writeFileSync('thoughts/audit/export-probes/results.json',JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));

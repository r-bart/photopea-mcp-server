import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
const entry=process.argv[2];if(!entry)throw Error('Provide installed dist/index.js');
const transport=new StdioClientTransport({command:process.execPath,args:[entry],env:{...process.env as Record<string,string>,PHOTOPEA_PORT:'4147',PHOTOPEA_STATE_DIR:resolve('output','installed-smoke-state')},stderr:'pipe'});
const client=new Client({name:'installed-livery-check',version:'1'});
try{
  await client.connect(transport);
  const tools=await client.listTools();
  for(const name of ['photopea_list_documents','photopea_get_layers','photopea_edit_layer','photopea_import_asset','photopea_export_bundle','photopea_get_operation'])if(!tools.tools.some(t=>t.name===name))throw Error('Missing '+name);
  const result=await client.callTool({name:'photopea_get_status',arguments:{}}),status=JSON.parse((result.content as Array<{text:string}>)[0].text);
  if(status.version!=='0.3.0'||status.ready||status.activeOperation)throw Error('Installed version/readiness differs');
  console.log(JSON.stringify({result:'passed',version:status.version,toolCount:tools.tools.length,entry,browserLaunched:false}));
}finally{await client.close();await transport.close();}

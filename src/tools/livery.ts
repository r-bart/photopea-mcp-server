import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EditorSession } from '../livery/session.js';
import { LiveryWorkflows } from '../livery/workflows.js';
export const selectorSchema=z.object({snapshotId:z.string().uuid(),path:z.array(z.number().int().min(0).max(2047)).min(1).max(64)});
export const targetSchema=z.union([z.string().min(1).max(512),z.number().int().min(0).max(2047),selectorSchema]);
const result=(value:unknown,isError=false)=>({isError,content:[{type:'text' as const,text:JSON.stringify(value)}]});
export function registerLiveryTools(server:McpServer,session:EditorSession,workflows:LiveryWorkflows):void{
  server.registerTool('photopea_list_documents',{
    description:'List session-bound document references. References check position and the full roster; refresh after opening/closing/renaming documents. No native IDs are assumed. Do not manually reorder indistinguishable documents between reference and use.',
    inputSchema:{},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true},
  },async()=>{
    const r=await session.bridge.runWorkflow(async()=>({success:true,data:JSON.stringify(await session.listDocuments()),error:null}));
    return result(r,!r.success);
  });
  server.registerTool('photopea_edit_layer',{
    description:'Edit a precise layer inside an explicit document. Use a get_layers selector for duplicate/nested names. x/y are absolute visible-bounds coordinates. Reorder only siblings, relativeTo + before/after; postconditions are checked. A structural selector cannot detect replacing an indistinguishable layer manually.',
    inputSchema:{document:z.string().uuid(),target:targetSchema,visible:z.boolean().optional(),opacity:z.number().finite().min(0).max(100).optional(),name:z.string().min(1).max(512).optional(),x:z.number().finite().optional(),y:z.number().finite().optional(),relativeTo:targetSchema.optional(),placement:z.enum(['before','after']).optional()},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false},
  },async p=>{const r=await session.editLayer(p.document,p.target,p);return result(r,!r.success);});
  server.registerTool('photopea_import_asset',{
    description:'Import into an explicit document under one operation owner. canvas preserves transparent margins/origin (use for SVG atlases); content_bounds aligns the visible logo. width/height fit the selected basis preserving aspect ratio. x/y default to 0. Duplicates a composite from a disposable helper at root, verifies bounds, and closes only that helper. Keep document collection unchanged manually during the workflow.',
    inputSchema:{document:z.string().uuid(),source:z.string(),origin:z.enum(['canvas','content_bounds']).default('canvas'),x:z.number().finite().optional(),y:z.number().finite().optional(),width:z.number().finite().positive().optional(),height:z.number().finite().positive().optional(),name:z.string().min(1).max(512).optional()},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
  },async p=>{const r=await workflows.importAsset(p);return result(r,!r.success);});
  server.registerTool('photopea_export_bundle',{
    description:'Start a revision bundle: durable PSD checkpoint, isolated reopened copy, PNG variants with explicit visibility recipes, restoration checks, and manifest. Requires a NEW absolute revision directory. Returns operationId immediately; poll get_operation. Only complete manifests are eligible for conversion/install. No manual edits to the export copy; the original is preserved. A bundle is not 3D validation/publication.',
    inputSchema:{document:z.string().uuid(),outputDirectory:z.string(),variants:z.array(z.object({name:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}\.png$/),visibility:z.array(z.object({target:targetSchema,visible:z.boolean()})).max(256)})).min(1).max(8)},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false},
  },async p=>{try{return result({operationId:workflows.startBundle(p),state:'queued_or_running'});}catch(e){return result({error:(e as Error).message},true);}});
}

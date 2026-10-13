import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { it, expect } from 'vitest';
import { OperationJournal } from '../../src/bridge/operation-journal.js';
import { layeredPsd } from '../fixtures/psd.js';
it('recovers published artifacts after a lost completion record, never replays running jobs',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'journal-'));
  try{
    const journal=new OperationJournal(join(dir,'operations'));await journal.load();
    const id=randomUUID(),bytes=layeredPsd(),path=join(dir,'committed.psd'),sha256=createHash('sha256').update(bytes).digest('hex');
    journal.record({operationId:id,state:'persisting',createdAt:Date.now(),candidate:{path,byteLength:bytes.length,sha256,format:'psd'}});
    const unknown=randomUUID();journal.record({operationId:unknown,state:'running',createdAt:Date.now()});await journal.flush();
    await writeFile(path,bytes);
    const recovered=await new OperationJournal(join(dir,'operations')).load();
    expect(recovered.find(x=>x.operationId===id)).toMatchObject({state:'completed',result:{success:true,artifact:{sha256,layerCount:3}}});
    expect(recovered.find(x=>x.operationId===unknown)).toMatchObject({state:'indeterminate',result:{success:false}});
  }finally{await rm(dir,{recursive:true,force:true});}
});
it('marks restart-cancelled queues terminal and prunes completed history while keeping unknown outcomes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'journal-retention-'));
  try{
    const j=new OperationJournal(dir,2);await j.load();
    const queued=randomUUID(),unknown=randomUUID();j.record({operationId:queued,state:'queued',createdAt:1});j.record({operationId:unknown,state:'running',createdAt:2});
    for(let i=3;i<7;i++)j.record({operationId:randomUUID(),state:'completed',createdAt:i,finishedAt:i,result:{success:true,data:'private echo',error:null}});
    await j.flush();expect((await readdir(dir)).filter(x=>x.endsWith('.json'))).toHaveLength(4);
    const recovered=await new OperationJournal(dir,2).load();
    // Queue cancelled on restart becomes evictable; unknown running job is retained.
    expect(recovered.find(x=>x.operationId===unknown)?.state).toBe('indeterminate');
    expect(recovered.filter(x=>x.finishedAt!==undefined)).toHaveLength(2);
    expect((await readdir(dir)).filter(x=>x.endsWith('.json'))).toHaveLength(3);
  }finally{await rm(dir,{recursive:true,force:true});}
});

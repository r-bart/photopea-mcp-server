import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { ArtifactWriter, validateArtifact, CHUNK_BYTES } from "../../src/utils/artifacts.js";
import { layeredPsd } from "../fixtures/psd.js";
const hash = (b:Buffer) => createHash('sha256').update(b).digest('hex');
describe('checkpoint persistence', () => {
  it('validates a layered PSD and publishes without overwriting previous revision', async () => {
    const dir = await mkdtemp(join(tmpdir(),'psd-test-'));
    try {
      const data=layeredPsd(), p=join(dir,'new.psd'); const w=await ArtifactWriter.create(p,'psd',data.length,hash(data));
      await w.append(0,data); const result=await w.commit();
      expect(result).toMatchObject({layerCount:3,width:8,height:8,sha256:hash(data)});
      await expect(ArtifactWriter.create(p,'psd',data.length,hash(data))).rejects.toThrow('exists');
      expect(await readFile(p)).toEqual(data);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it('rejects wrong format, checksum, truncation, and destination race without replacing data', async () => {
    const dir=await mkdtemp(join(tmpdir(),'psd-test-'));
    try {
      const good=layeredPsd(), p=join(dir,'master.psd');
      const w=await ArtifactWriter.create(p,'psd',good.length,hash(good)); await w.append(0,good);
      await writeFile(p,'previous'); await expect(w.commit()).rejects.toThrow(); await w.abort();
      expect((await readFile(p)).toString()).toBe('previous');
      for(const [name,data,checksum] of [['text',Buffer.from('not PSD!'),hash(Buffer.from('not PSD!'))],['truncated',good.subarray(0,good.length-1),hash(good.subarray(0,good.length-1))],['checksum',good,'0'.repeat(64)]] as const){
        const out=join(dir,name+'.psd'), writer=await ArtifactWriter.create(out,'psd',data.length,checksum);
        await writer.append(0,data); await expect(writer.commit()).rejects.toThrow(); await writer.abort();
      }
      expect(await readdir(dir)).toEqual(['master.psd']);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it('streams a real-format PSD larger than old WS/base64 limit with bounded chunks', async () => {
    const dir=await mkdtemp(join(tmpdir(),'psd-large-'));
    try {
      const data=layeredPsd(3072,3072,3,true); expect(data.length).toBeGreaterThan(80*1024*1024);
      const p=join(dir,'large.psd'), w=await ArtifactWriter.create(p,'psd',data.length,hash(data));
      for(let offset=0;offset<data.length;offset+=CHUNK_BYTES) await w.append(offset,data.subarray(offset,offset+CHUNK_BYTES));
      expect((await w.commit()).sha256).toBe(hash(data)); expect(await validateArtifact(p,'psd')).toMatchObject({layerCount:3,width:3072});
    } finally { await rm(dir,{recursive:true,force:true}); }
  },30000);
  it('leaves previous checkpoint intact on interrupted transfer and injected disk-full write',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'psd-io-'));
    try{
      const previous=join(dir,'previous.psd'),data=layeredPsd();await writeFile(previous,data);
      const interrupted=await ArtifactWriter.create(join(dir,'interrupted.psd'),'psd',data.length,hash(data));
      await interrupted.append(0,data.subarray(0,10));await expect(interrupted.commit()).rejects.toThrow('Incomplete');await interrupted.abort();
      const full=await ArtifactWriter.create(join(dir,'full.psd'),'psd',data.length,hash(data));
      const handle=(full as unknown as {handle:{write:()=>Promise<unknown>}}).handle;
      vi.spyOn(handle,'write').mockRejectedValueOnce(Object.assign(Error('disk full'),{code:'ENOSPC'}));
      await expect(full.append(0,data)).rejects.toThrow('disk full');await full.abort();
      expect(await readdir(dir)).toEqual(['previous.psd']);expect(await readFile(previous)).toEqual(data);
    }finally{await rm(dir,{recursive:true,force:true});}
  });
});

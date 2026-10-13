import { it,expect } from 'vitest';
import { buildApplyAdjustment,buildApplyFilter } from '../../src/bridge/script-builder.js';
it('rejects code and nonfinite values before interpolating numeric settings',()=>{
  for(const value of ['0);app.activeDocument.close(2);//',true,Infinity,NaN]){
    expect(()=>buildApplyFilter({type:'gaussian_blur',settings:{radius:value}})).toThrow();
    expect(()=>buildApplyAdjustment({type:'levels',settings:{gamma:value}})).toThrow();
  }
  expect(()=>buildApplyAdjustment({type:'curves',settings:{points:'[[0,0],[255,255]]'}})).not.toThrow();
  expect(()=>buildApplyAdjustment({type:'curves',settings:{points:'[[255,0],[0,255]]'}})).toThrow();
});

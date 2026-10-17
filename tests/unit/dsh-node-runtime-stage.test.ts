import { link, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { promoteNodeInstallation } from '../../src/main/dsh/node-runtime-stage';
import { inventoryTree, removeManaged } from '../../src/main/dsh/files';
import type { OperationContext } from '../../src/main/dsh/operations';

const operation: OperationContext = { id:'stage',signal:new AbortController().signal,log:async()=>undefined,update:async()=>undefined };
async function fixture() {
  const root=await mkdtemp(path.join(tmpdir(),'worldlinebox-node-stage-'));const staging=path.join(root,'staging');
  const source=path.join(staging,'npm-install');const destination=path.join(staging,'artifact','program','dsh');
  await mkdir(source,{recursive:true});await mkdir(path.dirname(destination),{recursive:true});
  return {root,staging,source,destination};
}
it('moves an exclusively owned installation in place with identical sealed bytes',async()=>{
  const item=await fixture();
  try{
    await writeFile(path.join(item.source,'entry.js'),'fixture module');const seal=await inventoryTree(item.source);
    await promoteNodeInstallation(item.staging,item.source,item.destination,operation);
    await expect(lstat(item.source)).rejects.toMatchObject({code:'ENOENT'});
    expect(await inventoryTree(item.destination)).toEqual(seal);
  }finally{await removeManaged(tmpdir(),item.root);}
});
it('breaks hard-link relationships by copying and refuses to merge an existing destination',async()=>{
  const item=await fixture();
  try{
    const external=path.join(item.root,'other.js');await writeFile(external,'original');
    await link(external,path.join(item.source,'entry.js'));
    await promoteNodeInstallation(item.staging,item.source,item.destination,operation);
    await writeFile(external,'changed');
    expect(await readFile(path.join(item.destination,'entry.js'),'utf8')).toBe('original');
    expect(await readFile(path.join(item.source,'entry.js'),'utf8')).toBe('changed');
    // An ordinary source must not overwrite an already populated destination.
    const ordinary=path.join(item.staging,'ordinary');await mkdir(ordinary);await writeFile(path.join(ordinary,'entry.js'),'new');
    await expect(promoteNodeInstallation(item.staging,ordinary,item.destination,operation)).rejects.toThrow();
    expect(await readFile(path.join(item.destination,'entry.js'),'utf8')).toBe('original');
  }finally{await removeManaged(tmpdir(),item.root);}
});

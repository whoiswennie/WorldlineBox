import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RuntimeService } from '../../src/main/dsh/runtime-service';
import { dshRuntimeSchema } from '../../src/shared/dsh-launcher';
import { createBotNativeHost } from '../fixtures/bot-native-host';
import type { TreeInventoryProgress } from '../../src/main/dsh/files';

async function removeSealFixture(root:string){
  if(path.dirname(root)!==path.resolve(tmpdir())||!path.basename(root).startsWith('wlb-sealed-native-'))throw Error('Invalid owned seal fixture.');
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}

/** Official installed bytes, real production seal verification and real Host.
 * All profiles and advisory indexes belong to this test. No model requests,
 * user credentials, instance changes or writes to the installed program. */
it.runIf(!!process.env.WORLDLINEBOX_DSH_SEALED_ROOT)(
  'starts and closes a private native Host while the real sealed runtime remains byte-identical', async () => {
    const artifact=path.resolve(process.env.WORLDLINEBOX_DSH_SEALED_ROOT!),program=path.join(artifact,'program');
    const records=JSON.parse(await readFile(path.join(artifact,'../../runtimes.json'),'utf8')) as unknown[];
    const runtime=records.map(record=>dshRuntimeSchema.parse(record)).find(record=>record.id===path.basename(artifact));
    if(!runtime)throw Error('Installed runtime identity is missing.');
    const seal=await readFile(path.join(artifact,'seal.json'),'utf8');
    const root=await mkdtemp(path.join(tmpdir(),'wlb-sealed-native-')),progress:TreeInventoryProgress[]=[];
    const output=path.resolve('artifacts/runtime-sealed-native',path.basename(root));await mkdir(output,{recursive:true});
    await mkdir(path.join(root,'runtimes',runtime.id),{recursive:true});await writeFile(path.join(root,'runtimes',runtime.id,'seal.json'),seal);
    const service=new RuntimeService({rootPath:root,onChanged(){}});
    // Verify the genuine record/seal against installed read-only program bytes;
    // only the non-authoritative hash index is redirected to the owned fixture.
    Object.assign(service,{records:[runtime]});service.directory=()=>program;
    let native:Awaited<ReturnType<typeof createBotNativeHost>>|undefined;
    try{
      await service.verify(runtime.id,undefined,true,value=>progress.push(value));
      native=await createBotNativeHost(program,{verifyRuntime:signal=>service.verify(runtime.id,signal,true)});
      const own=await native.instances.createCompanion('sealed-native-partner','校验伙伴',native.instance.runtimeId);
      const client=await native.instances.ensureHost(own.id);expect(client.pid).toBeGreaterThan(0);
      await native.instances.stop(own.id);
      await service.verify(runtime.id,undefined,true,value=>progress.push(value));
      expect(progress.at(-1)).toMatchObject({phase:'complete',fileCount:runtime.fileCount,verifiedFiles:runtime.fileCount,cacheHits:0});
      await writeFile(path.join(output,'receipt.json'),JSON.stringify({passed:true,actualNativeHost:true,actualProductionSealVerification:true,
        sourceRuntimeId:runtime.id,version:runtime.version,sealedContentSha256:runtime.contentSha256,fileCount:runtime.fileCount,
        beforeAndAfterFullByteVerification:true,usesPaidModel:false,userProfilesModified:false},null,2));
    }finally{
      if(native)await native.close(native.instances.list().map(instance=>({id:instance.id,name:instance.name,runtimeId:instance.runtimeId})));
      service.close();
      await removeSealFixture(root);
    }
  },240000);

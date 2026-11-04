import {expect,it} from 'vitest';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {BotMemoryService,type BotMemoryOptions} from '../../src/main/companion-bot/memory-service';
const packageRoot=path.resolve('.tools/bot-memory-release/vcp-memory'),nodePath=path.resolve('.tools/node-v24.15.0-win-x64/node.exe');
it.skipIf(!existsSync(nodePath)||!existsSync(path.join(packageRoot,'lib/client.cjs')))('rejects an actual managed home enabling the standalone model before creating another native worker',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'bot-managed-embedding-')),client=createRequire(path.join(packageRoot,'package.json'))('./lib/client.cjs');let sessions=0;
  const options:BotMemoryOptions={root,runtime:async()=>({nodePath,packageRoot}),
    embedding:async()=>({baseUrl:'http://127.0.0.1:9/document',queryBaseUrl:'http://127.0.0.1:9/query',model:'metadata-only',dimension:64,modelSignature:'metadata-only-v1',apiKey:'unused'}),
    createSession:input=>{sessions++;return client.createSession(input);}};
  const scope={companionId:'managed-owner',conversationId:'direct',securityDomainId:'direct'};let memory=new BotMemoryService(options);
  try{
    await memory.appendHistory(scope,[{id:'source',role:'user',content:'不需要向量模型也能先耐久保存原文。',timestamp:1793610000000}]);expect(sessions).toBe(1);await memory.close();
    const [domain]=await readdir(root),file=path.join(root,domain!,'config.json'),config=JSON.parse(await readFile(file,'utf8'));expect(config.LOCAL_EMBEDDING_ENABLED).toBe(false);
    for(const value of [true,'true']){
      config.LOCAL_EMBEDDING_ENABLED=value;const bytes=JSON.stringify(config);await writeFile(file,bytes);memory=new BotMemoryService(options);
      await expect(memory.appendHistory(scope,[{id:'replay',role:'user',content:'不能静默切换模型。',timestamp:1793610000001}])).rejects.toMatchObject({code:'MEMORY_MANAGED_EMBEDDING_REQUIRED'});
      expect(await readFile(file,'utf8')).toBe(bytes);expect(sessions).toBe(1);expect(existsSync(path.join(root,domain!,'vendor/local-embedding'))).toBe(false);await memory.close();
    }
  }finally{await memory.close();await rm(root,{recursive:true,force:true});}
},15000);

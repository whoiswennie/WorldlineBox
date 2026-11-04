import {expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {BotMemoryService,type BotMemoryOptions} from '../../src/main/companion-bot/memory-service';
const packageRoot=path.resolve('.tools/bot-memory-release/vcp-memory'),nodePath=path.resolve('.tools/node-v24.15.0-win-x64/node.exe');
const enabled=existsSync(nodePath)&&existsSync(path.join(packageRoot,'lib/bot-host.cjs'));
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'bot-source-withdraw-'));let chatRequests=0;
  const server=createServer(async(request,response)=>{let body='';for await(const bytes of request)body+=bytes;
    if(!request.url?.endsWith('/v1/embeddings')){chatRequests++;response.writeHead(503).end();return;}
    const input=JSON.parse(body).input,texts=Array.isArray(input)?input:[input];response.setHeader('content-type','application/json');response.end(JSON.stringify({data:texts.map((_:unknown,index:number)=>({index,embedding:Array.from({length:64},(_,i)=>i?0.01:1)}))}));
  });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('No protocol fixture endpoint');const base=`http://127.0.0.1:${address.port}`;
  const options:BotMemoryOptions={root,runtime:async()=>({nodePath,packageRoot}),embedding:async()=>({baseUrl:base+'/document',queryBaseUrl:base+'/query',model:'fixture64',modelSignature:'source-withdraw-64',dimension:64,apiKey:'local-protocol-only'}),chat:async()=>({baseUrl:base,model:'no-llm',apiKey:'local-deny'}),requestTimeoutMs:60000};
  let memory=new BotMemoryService(options);const scope={companionId:'owner',conversationId:'a',securityDomainId:'a'};
  const home=path.join(root,createHash('sha256').update(JSON.stringify([scope.companionId,scope.securityDomainId])).digest('hex'));
  const messages=[{id:'A',role:'user' as const,content:'A 用户原始文件说明。',timestamp:1793610000000},...Array.from({length:199},(_,i)=>({id:'safe-'+i,role:'user' as const,content:`独立合法原文 SAFEKEEP${i}。`,timestamp:1793610000001+i})),
    {id:'C',role:'assistant' as const,content:'CASCADE47 任务通知中出现原文件的梧桐密文。',timestamp:1793610000300},
    {id:'D',role:'assistant' as const,content:'CASCADE47 自动回复复述梧桐密文。',timestamp:1793610000301}];
  await memory.appendHistory(scope,messages);
  await memory.remember(scope,{sourceEventId:'A-note',sourceRootEventId:'event-A',sourceMessageIds:['A'],content:'最初文件的事实，只属于A。'});
  await memory.remember(scope,{sourceEventId:'D-note',sourceRootEventId:'event-D',sourceMessageIds:['C','D'],content:'CASCADE47 梧桐密文的衍生日记，由任务自动回复产生。'});
  const derived=(await memory.list(scope)).find(note=>note.sourceEventId==='event-D')!;
  expect(JSON.stringify(await memory.tool(scope,'DeepMemo',{keyword:'CASCADE47'}))).toContain('梧桐密文');
  return{scope,home,messages,derived,get memory(){return memory;},replace(){memory=new BotMemoryService(options);return memory;},
    async close(){await memory.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});expect(chatRequests).toBe(0);}};
}
it.skipIf(!enabled)('withdraws already projected task descendants, related notes and every managed retrieval path across a cold restart',async()=>{
  const f=await fixture();try{
    const original=(await f.memory.list(f.scope)).find(note=>note.sourceEventId==='event-A')!;await f.memory.forget(f.scope,{id:original.id});
    const input={sourceEventIds:['event-C','event-D'],sourceMessageIds:['C','D']};const receipt=await f.memory.withdrawSources(f.scope,input);expect(receipt.sourceEventIds).toContain('event-D');expect(receipt.sourceEventIds).toContain('D-note');
    expect((await f.memory.list(f.scope)).find(note=>note.id===f.derived.id)).toBeUndefined();
    // The original no-hit formatter echoes the query. Probe by the code only,
    // so echoing the search term cannot be mistaken for leaked source text.
    expect(JSON.stringify(await f.memory.tool(f.scope,'LightMemo',{query:'CASCADE47'}))).not.toContain('梧桐密文');
    expect(JSON.stringify(await f.memory.tool(f.scope,'DeepMemo',{keyword:'CASCADE47'}))).not.toContain('梧桐密文');
    expect(JSON.stringify(await f.memory.tool(f.scope,'TopicMemo',{topic_id:'episode-00000002'}))).not.toContain('梧桐密文');
    expect(JSON.stringify(await f.memory.tool(f.scope,'DeepMemo',{keyword:'SAFEKEEP99'}))).toContain('SAFEKEEP99');
    const repeated=await f.memory.withdrawSources(f.scope,input);expect(repeated.revision).toBe(receipt.revision);
    await f.memory.close();f.replace();expect(JSON.stringify(await f.memory.tool(f.scope,'DeepMemo',{keyword:'CASCADE47'}))).not.toContain('梧桐密文');
    await f.memory.appendHistory(f.scope,f.messages.slice(-2));expect(await readFile(path.join(f.home,'sessions/agent/id-owner/id-episode-00000002/history.json'),'utf8')).not.toContain('梧桐密文');
    expect(await f.memory.remember(f.scope,{sourceEventId:'D-note',sourceRootEventId:'event-D',sourceMessageIds:['C','D'],content:'CASCADE47 梧桐密文的衍生日记，由任务自动回复产生。'})).toMatchObject({withdrawn:true,indexed:0});
    const other={...f.scope,conversationId:'b',securityDomainId:'b'};await f.memory.appendHistory(other,[{id:'D',role:'user',content:'另一会话合法原文 OTHERDOMAIN47',timestamp:1793610000400}]);
    expect(JSON.stringify(await f.memory.tool(other,'TopicMemo',{topic_id:'episode-00000000'}))).toContain('OTHERDOMAIN47');
  }finally{await f.close();}
},90000);
it.skipIf(!enabled)('commits source tombstones before a real process crash and blocks raw VCP reads until native repair finishes',async()=>{
  const f=await fixture();try{
    await f.memory.close();const crashed=spawnSync(nodePath,['-e',`const host=new(require('./lib/bot-host.cjs').BotHost)(process.argv[1]);host.stageWithdrawal({sourceEventIds:['event-C','event-D'],sourceMessageIds:['C','D']});process.exit(74);`,f.home],{cwd:packageRoot,encoding:'utf8',windowsHide:true});expect(crashed.status,crashed.stderr).toBe(74);
    const raw=createRequire(path.join(packageRoot,'package.json'))('./lib/client.cjs').createSession({home:f.home,nodePath});
    try{for(const [operation,payload] of [['tool',{name:'TopicMemo',args:{maid:'owner',command:'GetTopicContent',topic_id:'episode-00000002'}}],['search',{query:'CASCADE47'}],['preprocess',{messages:[]}],['bot.prepared.get',{id:'old-prepared'}]] as const){
      await expect(raw.request(operation,payload)).rejects.toMatchObject({code:'MEMORY_SOURCE_WITHDRAWAL_PENDING'});
    }}finally{await raw.close();}
    // Before repair, the real raw episode still contains C/D. It was not merely
    // hidden by a host UI filter, and none of the raw retrievals could read it.
    expect(await readFile(path.join(f.home,'sessions/agent/id-owner/id-episode-00000002/history.json'),'utf8')).toContain('梧桐密文');
    f.replace();expect(JSON.stringify(await f.memory.tool(f.scope,'TopicMemo',{topic_id:'episode-00000002'}))).not.toContain('梧桐密文');
    expect(JSON.stringify(await f.memory.tool(f.scope,'DeepMemo',{keyword:'CASCADE47'}))).not.toContain('梧桐密文');expect((await f.memory.list(f.scope)).some(note=>note.id===f.derived.id)).toBe(false);
    expect(await readFile(path.join(f.home,'sessions/agent/id-owner/id-episode-00000002/history.json'),'utf8')).not.toContain('梧桐密文');
  }finally{await f.close();}
},90000);

/** Native-profile plugin used only in a fresh temporary HOME with synthetic data. */
export const COMPATIBILITY_DRIVER = String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';
export const inject=['workspaceRegistry','sessionController','sessionPersistence','sessionQuery','credentials','sessions','agents'];
export async function apply(owner,{sdk,cwd,sessionRoot}) {
const ctx=owner.root;
const exit=ctx.get('appExit');
const load=createRequire(path.join(sdk,'@deepseek-ai/dsh/package.json'));
const imported=async name=>import(pathToFileURL(load.resolve(name)));
  let lease;
  const input=readline.createInterface({input:process.stdin});let turn=Promise.resolve();
  input.on('line',text=>{turn=turn.then(async()=>{
    const request=JSON.parse(text);try {let data;
      if(request.type==='workspace') {
        const workspace=ctx.workspaceRegistry.list().find(value=>value.path===cwd)??await ctx.workspaceRegistry.create(cwd,'WorldlineBox isolated check');data={workspaceId:workspace.id};
      } else if(request.type==='create') {
        data=await ctx.sessionController.create({workspaceId:request.workspaceId});
        await ctx.sessionController.rename({sessionId:data.sessionId,title:request.title});
        await ctx.get('sessions').flush(ctx.get('sessions').get(data.sessionId));
      } else if(request.type==='state') {
        const observation=await ctx.sessionQuery.observeSession(request.sessionId,{projectionMode:'all'});
        try{data={list:await ctx.sessionController.list({}),header:observation.header,
          workspaces:ctx.workspaceRegistry.list().map(x=>({path:x.path,sessionIds:x.sessionIds})),
          agentAvailable:!!ctx.get('agents').get(request.sessionId),sessionAttached:!!ctx.get('sessions').get(request.sessionId)}}
        finally{observation?.[Symbol.dispose]?.()}
      } else if(request.type==='lease') {
        lease=await ctx.sessionPersistence.open(request.sessionId,'write');data={held:true};
      } else if(request.type==='write') {
        let handle;try{handle=await ctx.sessionPersistence.open(request.sessionId,'write');data={refused:false}}
        catch(error){data={refused:true,code:error.code??error.name}}finally{await handle?.close()}
      } else if(request.type==='attachment-save') {
        const {Context}=await imported('@deepseek-ai/cordis');const {default:Local}=await imported('@deepseek-ai/dsh-attachment-local');
        const local=new Context();try{const store=new Local(local,{dshHome:path.dirname(sessionRoot)});
          data={ref:await store.saveFile({name:'compatibility.txt',data:Buffer.from(request.text??'WorldlineBox synthetic attachment')})};}
        finally{await local.fiber.dispose()}
      } else if(request.type==='attachment-read') {
        const {Context}=await imported('@deepseek-ai/cordis');const {default:Local}=await imported('@deepseek-ai/dsh-attachment-local');
        const local=new Context();try{const store=new Local(local,{dshHome:path.dirname(sessionRoot)});const stream=await store.readFileStream(request.ref);
          let bytes='';for await(const chunk of stream)bytes+=Buffer.from(chunk).toString();data={text:bytes};}
        finally{await local.fiber.dispose()}
      } else if(request.type==='credential-host') {
        const credentials=ctx.get('credentials');if(request.write)await credentials.set('DEEPSEEK_API_KEY','worldlinebox-synthetic-api-key');
        data={configured:(await credentials.resolve('DEEPSEEK_API_KEY'))?.value==='worldlinebox-synthetic-api-key'};
      } else if(request.type==='credentials') {
        const {parseCredentialsDocument,renderFlatLayoutMigration}=await imported('@deepseek-ai/dsh-credentials-local');
        const {withFileLock,writeFileAtomic}=await imported('@deepseek-ai/dsh-atomic-write');
        const file=path.join(path.dirname(sessionRoot),'.credentials.yaml');
        const fake='version: 1\nrefs:\n  WORLDLINE_COMPAT_DUMMY: dummy-not-a-real-key\n  DEEPSEEK_API_KEY: worldlinebox-synthetic-api-key\nrecords:\n  deepseek-account/default:\n    kind: grant\n    payload: {version: 1, accessToken: dummy-not-a-real-token}\n';
        await withFileLock(file,async()=>{if(request.write)await writeFileAtomic(file,request.reverse?fake.replace('dummy-not-a-real-key','reverse-dummy-key'):fake,{mode:0o600});
          const text=await readFile(file,'utf8');const value=parseCredentialsDocument(renderFlatLayoutMigration(text)??text,file);
          data={valid:value.refs.has('WORLDLINE_COMPAT_DUMMY')&&value.records.has('deepseek-account/default'),reverse:text.includes('reverse-dummy-key')};});
      } else if(request.type==='close'){await lease?.close();input.close();data={closed:true}}
      console.log('COMPAT_RESULT '+JSON.stringify({id:request.id,data}));if(request.type==='close')exit(0);
    } catch(error){console.log('COMPAT_RESULT '+JSON.stringify({id:request.id,error:{code:error.code??error.name,message:String(error.message).slice(0,1500)}}))}
  })});ctx.effect(()=>()=>input.close());console.log('COMPAT_READY');
}
`;

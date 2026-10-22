import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cliModelOverlaySource } from '../../src/main/dsh/cli-model-overlay';
import { attachProcessJob } from '../../src/main/dsh/windows-job';

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0)){const absolute=path.resolve(root);if(path.dirname(absolute)!==path.resolve(tmpdir())||!path.basename(absolute).startsWith('worldlinebox-cli-model-'))throw new Error('Unexpected CLI model fixture');await rm(absolute,{recursive:true,force:true});}});
async function fixture(){const root=await mkdtemp(path.join(tmpdir(),'worldlinebox-cli-model-'));roots.push(root);const script=path.join(root,'model.mjs');await writeFile(script,cliModelOverlaySource());return{root,script};}
async function run(executable:string,script:string,args:string[],env:NodeJS.ProcessEnv){const child=spawn(executable,['--expose-internals',script,...args],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});const job=attachProcessJob(child);let output='';child.stdout.on('data',chunk=>output+=chunk.toString());child.stderr.on('data',chunk=>output+=chunk.toString());child.stdin.end();try{const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});return{code,output};}finally{job?.close();}}

describe('readonly native CLI model overlay',()=>{
  it.skipIf(!process.env.WORLDLINEBOX_DSH_NODE_PROGRAM)('initializes an absent profile through the official template before its first CLI model overlay',async()=>{
    const program=path.resolve(process.env.WORLDLINEBOX_DSH_NODE_PROGRAM!),{root,script}=await fixture();
    const home=path.join(root,'new-home'),canonical=path.join(root,'canonical.json'),output=path.join(root,'overlay.json');
    await writeFile(canonical,JSON.stringify({version:1,values:{},clients:{}}));
    const env:NodeJS.ProcessEnv={...process.env,DSH_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
    const result=await run(path.join(program,'bin/node.exe'),script,[program,'web',canonical,'fixture','[]',output],env);
    expect(result.code,result.output).toBe(0);expect(JSON.parse(await readFile(output,'utf8'))).toEqual([]);
    expect(JSON.parse(await readFile(path.join(home,'profiles/web/package.json'),'utf8'))).toMatchObject({dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}});
  },30000);
  it('emits valid standalone code and rejects dynamic canonical values without exposing them',async()=>{
    const{root,script}=await fixture();const file=path.join(root,'canonical.json'),output=path.join(root,'overlay.json');await writeFile(file,JSON.stringify({version:1,values:{'llm-pi-ai':{providers:{unsafe:{__jsExpr:'fixture-secret-must-not-print'}}}}}));
    const result=await run(process.execPath,script,[root,'web',file,'fixture','[]',output],process.env);expect(result.code).toBe(1);expect(result.output).toBe('CLI_MODEL_OVERLAY_REFUSED\n');await expect(readFile(output)).rejects.toThrow();
  });
  it.skipIf(!process.env.WORLDLINEBOX_DSH_NODE_PROGRAM)('composes each published runtime full model defaults plus private unknown settings, reads canonical changes, and leaves profiles untouched',async()=>{
    const program=path.resolve(process.env.WORLDLINEBOX_DSH_NODE_PROGRAM!);const executable=path.join(program,'bin','node.exe');const{root,script}=await fixture();const home=path.join(root,'private-home'),profile=path.join(home,'profiles','web');await mkdir(profile,{recursive:true});
    const manifest=path.join(profile,'package.json');await writeFile(manifest,JSON.stringify({name:'worldlinebox-fixture-web',private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}}));
    const patch=path.join(profile,'cordis.patch.yml');const privateRows=[{id:'llm-pi-ai',config:{providers:{privateProvider:{baseURL:'https://private.invalid',models:[{id:'private-model'}]},publicProvider:{baseURL:'https://old.invalid',models:[{id:'old-model'}]}},privateUnknown:{still:'retained'}}},{id:'llm-deepseek',config:{apiKeyEnv:'PRIVATE_FAKE_KEY',maxTokens:12345,privateUnknown:'retained'}}];await writeFile(patch,JSON.stringify(privateRows));
    const homePatch=path.join(home,'cordis.patch.yml');await writeFile(homePatch,JSON.stringify([{id:'llm-pi-ai',config:{providers:privateRows[0]!.config.providers,privateUnknown:{still:'home-retained'}}}]));
    const before=await Promise.all([manifest,patch,homePatch].map(file=>readFile(file,'utf8')));const canonical=path.join(root,'canonical.json');const baseline={'llm-pi-ai':{providers:{publicProvider:{baseURL:'https://old.invalid',models:[{id:'old-model'}]}}},'llm-deepseek':{maxTokens:12345}};
    const store:{version:number;values:Record<string,Record<string,unknown>>;clients:Record<string,unknown>}={version:1,values:{'llm-pi-ai':{providers:{publicProvider:{baseURL:'https://new.invalid',models:[{id:'new-model'}]}}},'llm-deepseek':{maxTokens:54321}},clients:{fixture:baseline}};await writeFile(canonical,JSON.stringify(store));
    const env:NodeJS.ProcessEnv={...process.env,DSH_HOME:home};delete env.ELECTRON_RUN_AS_NODE;const first=path.join(root,'first.json');const initial=await run(executable,script,[program,'web',canonical,'fixture','[]',first],env);expect(initial.code,initial.output).toBe(0);
    const rows=JSON.parse(await readFile(first,'utf8')) as Array<{id:string;config:Record<string,unknown>}>;expect(rows.find(row=>row.id==='llm-pi-ai')?.config).toMatchObject({privateUnknown:{still:'home-retained'},providers:{privateProvider:{baseURL:'https://private.invalid'},publicProvider:{baseURL:'https://new.invalid'}}});expect(rows.find(row=>row.id==='llm-deepseek')?.config).toMatchObject({apiKeyEnv:'PRIVATE_FAKE_KEY',privateUnknown:'retained',maxTokens:54321});
    store.values['llm-pi-ai']!.providers={};await writeFile(canonical,JSON.stringify(store));const second=path.join(root,'second.json');const next=await run(executable,script,[program,'web',canonical,'fixture','[]',second],env);expect(next.code,next.output).toBe(0);const changed=JSON.parse(await readFile(second,'utf8')) as typeof rows;expect(changed.find(row=>row.id==='llm-pi-ai')?.config.providers).toMatchObject({privateProvider:{baseURL:'https://private.invalid'}});expect(changed.find(row=>row.id==='llm-pi-ai')?.config.providers).not.toHaveProperty('publicProvider');
    expect(await Promise.all([manifest,patch,homePatch].map(file=>readFile(file,'utf8')))).toEqual(before);
    const invalid=path.join(root,'invalid.json');await writeFile(canonical,JSON.stringify({...store,version:99}));const refused=await run(executable,script,[program,'web',canonical,'fixture','[]',invalid],env);expect(refused.code).toBe(1);expect(refused.output).toBe('CLI_MODEL_OVERLAY_REFUSED\n');
  },30_000);
});

import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createRequire,builtinModules} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import {build} from 'vite';
import {expect,it} from 'vitest';
import type {CompanionConnection} from '../../src/companions/store';
const require=createRequire(path.join(process.cwd(),'package.json'));
async function cleanup(root:string){if(path.dirname(path.resolve(root))!==path.resolve(tmpdir())||!path.basename(root).startsWith('companion-utility-recovery-'))throw new Error('Unexpected cleanup root');await rm(root,{recursive:true,force:true});}
it('backs up and restores a lost new-protocol ledger through actual Electron UtilityProcesses without opening a GUI or dispatching a model',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'companion-utility-recovery-')),output=path.join(root,'build'),reportPath=path.join(root,'report.json'),configuration=path.join(root,'configuration.json');let child:ReturnType<typeof spawn>|undefined;
  try{
    await mkdir(output);await mkdir(path.join(root,'backups'));await mkdir(path.join(root,'library','.worldlinebox','companions'),{recursive:true});await mkdir(path.join(root,'library','伙伴记忆'));
    const libraryId=randomUUID(),Database=BetterSqlite3 as {new(file:string):CompanionConnection},library=new Database(path.join(root,'library','.worldlinebox','library.db'));library.exec('CREATE TABLE library(library_id TEXT PRIMARY KEY)');library.prepare('INSERT INTO library VALUES(?)').run(libraryId);library.close();
    const external=['electron','better-sqlite3',...builtinModules,...builtinModules.map(name=>'node:'+name)];
    for(const [entry,name] of [['src/companions/worker.ts','companion-worker.cjs'],['tests/fixtures/companion-utility-recovery-main.ts','fixture-main.cjs']] as const)await build({configFile:false,root:process.cwd(),logLevel:'silent',resolve:{conditions:['node']},build:{outDir:output,emptyOutDir:false,minify:false,lib:{entry:path.resolve(entry),formats:['cjs'],fileName:()=>name},rollupOptions:{external,output:{paths:{'better-sqlite3':require.resolve('better-sqlite3').replace(/\\/gu,'/')}}}}});
    await writeFile(configuration,JSON.stringify({root,workerPath:path.join(output,'companion-worker.cjs'),reportPath,libraryId}));const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    child=spawn(require('electron') as string,[path.join(output,'fixture-main.cjs'),configuration],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let diagnostics='';child.stdout?.on('data',bytes=>{diagnostics=(diagnostics+String(bytes)).slice(-20000);});child.stderr?.on('data',bytes=>{diagnostics=(diagnostics+String(bytes)).slice(-20000);});const running=child;
    const code=await new Promise<number|null>((resolve,reject)=>{const timer=setTimeout(()=>{running.kill();reject(new Error('Actual recovery timed out: '+diagnostics));},60000);running.once('error',error=>{clearTimeout(timer);reject(error);});running.once('exit',code=>{clearTimeout(timer);resolve(code);});});child=undefined;
    const report=JSON.parse(await readFile(reportPath,'utf8')) as Record<string,unknown>;expect(code,String(report.error??diagnostics)).toBe(0);expect(report).toMatchObject({ready:true,runAsNode:false,windows:0,backupViaWorker:true,lostLedgerPreviewReadonly:true,databaseRestoreViaDedicatedWorker:true,identityVersionExact:true,eventBytesExact:true,unreviewedOwnerInactive:true,oldJobsParked:true,secondRestartGate:true,stalePackageCannotRollback:true,externalModelCalls:0});
    console.log(JSON.stringify(report));
  }finally{child?.kill();await cleanup(root);}
},120000);

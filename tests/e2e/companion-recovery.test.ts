import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,readdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {_electron as electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import type {WorldlineBoxCompanionsApi} from '../../src/shared/companions';
import type {WorldlineBoxLlmApi} from '../../src/shared/llm';
import type {CompanionRecoveryResult} from '../../src/shared/companion-recovery';
import type {CompanionWorkspaceResponse} from '../../src/shared/companion-workspace';
import {COMPANION_WORKSPACE_CHANNEL} from '../../src/shared/companion-workspace';
import {electronLaunchEnv,ensureCompanionTestWorkspace,removeCompanionTestDirectory,preparePackagedCompanionLaunch,resolveElectronLaunchOptions} from './electron-test-helpers';
import {companionEvidenceEnvironment,companionEvidenceName,developmentCompanionToolHost,type CompanionEvidenceEnvironment} from './companion-evidence-environment';
type Bridge=Window&{worldlinebox:{companions:WorldlineBoxCompanionsApi;llm:WorldlineBoxLlmApi}};
const shots=path.resolve('artifacts/cognition-validation/ui'),hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function appearance(page:Page){await page.getByRole('button',{name:'设置',exact:true}).click();const dialog=page.getByRole('dialog',{name:'通用设置',exact:true});await dialog.getByRole('tab',{name:'外观',exact:true}).click();await dialog.getByRole('radio',{name:'WorldlineBox',exact:true}).click();await dialog.getByRole('radio',{name:'暗色',exact:true}).click();await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);}
async function offlineSnapshot(root:string,selected:NonNullable<CompanionWorkspaceResponse['selected']>,destinationParent:string,build:CompanionEvidenceEnvironment){
  const config=path.join(root,'offline-snapshot.json'),reportPath=path.join(root,'offline-snapshot-result.json');writeFileSync(config,JSON.stringify({root,workerPath:build.companionWorkerPath,sourceAppPath:build.appPath,sourceIsPackaged:build.isPackaged,expectedWorkerHash:build.companionWorkerHash,databasePath:path.join(selected.dataRoot,'messages.sqlite'),selection:{libraryId:selected.libraryId,libraryPath:selected.libraryPath},destinationParent,reportPath}));
  // Tool host only: even packaged acceptance must not launch the installed app
  // with a development script argument. The child worker still comes from the
  // actual captured ASAR path and is fingerprinted before it runs.
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(developmentCompanionToolHost(),[path.resolve('tests/fixtures/companion-recovery-offline-snapshot.mjs'),config],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let diagnostic='';child.stdout.on('data',bytes=>{diagnostic=(diagnostic+String(bytes)).slice(-12000);});child.stderr.on('data',bytes=>{diagnostic=(diagnostic+String(bytes)).slice(-12000);});
  const code=await new Promise<number|null>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Offline actual snapshot timed out. '+diagnostic));},75000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',value=>{clearTimeout(timer);resolve(value);});});const report=JSON.parse(readFileSync(reportPath,'utf8')) as {recovery:CompanionRecoveryResult;windows:number;hostIsPackaged:boolean;workerPath:string;workerHash:string;sourceWorkerFromPackagedASAR:boolean;error?:string};expect(code,report.error??diagnostic).toBe(0);expect(report.windows).toBe(0);expect(report.hostIsPackaged).toBe(false);expect(report.workerPath).toBe(build.companionWorkerPath);expect(report.workerHash).toBe(build.companionWorkerHash);expect(report.sourceWorkerFromPackagedASAR).toBe(build.isPackaged);return{...report.recovery,offlineHost:{isPackaged:report.hostIsPackaged,workerPath:report.workerPath,workerHash:report.workerHash,sourceWorkerFromPackagedASAR:report.sourceWorkerFromPackagedASAR}};
}
function copyShutdownDiagnostic(root:string){const folder=path.join(root,'profile','logs'),latest=readdirSync(folder).filter(name=>name.startsWith('worldlinebox-')&&name.endsWith('.log')).sort().at(-1);if(latest)writeFileSync(path.resolve('artifacts/cognition-validation',companionEvidenceName('recovery-active-shutdown-diagnostic.txt')),readFileSync(path.join(folder,latest)));}
async function packagedRecoveryPicker(application:ElectronApplication,destination:string,packagePath?:string){
  if(!process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE)return;
  await application.evaluate(({dialog},input)=>{const previous=dialog.showOpenDialog;dialog.showOpenDialog=async(...args:unknown[])=>{const options=args.at(-1) as {title?:string};
    if(options.title==='选择伙伴备份的保存位置')return{canceled:false,filePaths:[input.destination]};
    if(options.title==='选择新协议伙伴备份包目录'){if(!input.packagePath)throw new Error('Packaged fixture package not selected');return{canceled:false,filePaths:[input.packagePath]};}
    return Reflect.apply(previous,dialog,args);};},{destination,packagePath});
}
type InspectionReceipt={sequence:number;finished:boolean;ok?:boolean;durationMs?:number;error?:string};
async function observeRecoveryInspection(application:ElectronApplication){
  await application.evaluate(({ipcMain},channel)=>{
    const handlers=Reflect.get(ipcMain,'_invokeHandlers') as Map<string,(event:unknown,command:unknown)=>unknown>,original=handlers.get(channel);
    if(!original)throw new Error('The actual recovery workspace handler is unavailable.');
    const receipts:Array<{sequence:number;finished:boolean;ok?:boolean;durationMs?:number;error?:string}>=[];Reflect.set(globalThis,'__recoveryInspectReceipts',receipts);
    handlers.set(channel,(event,command)=>{
      if(typeof command!=='object'||command===null||!('type'in command)||command.type!=='recovery.package.inspect')return original(event,command);
      const receipt={sequence:receipts.length+1,finished:false} as typeof receipts[number],started=performance.now();receipts.push(receipt);
      return Promise.resolve().then(()=>original(event,command)).then(result=>{
        receipt.ok=typeof result==='object'&&result!==null&&'ok'in result&&result.ok===true;
        if(!receipt.ok&&typeof result==='object'&&result!==null&&'error'in result&&typeof result.error==='string')receipt.error=result.error.slice(0,1000);return result;
      },error=>{receipt.ok=false;receipt.error=error instanceof Error?error.name:'Unknown';throw error;}).finally(()=>{receipt.durationMs=Math.round(performance.now()-started);receipt.finished=true;});
    });
  },COMPANION_WORKSPACE_CHANNEL);
}
async function inspectPackage(application:ElectronApplication,panel:ReturnType<Page['getByRole']>){
  const before=await application.evaluate(()=>Reflect.get(globalThis,'__recoveryInspectReceipts').length as number);
  await panel.getByRole('button',{name:'选择并检查备份包',exact:true}).click();
  // A click does not await the asynchronous worker inspection. Observe the
  // actual request completing before checking its rendered result; a stuck or
  // rejected inspection still fails independently of the DOM assertion.
  await expect.poll(()=>application.evaluate(()=>{
    const receipts=Reflect.get(globalThis,'__recoveryInspectReceipts') as InspectionReceipt[];return receipts.at(-1);
  }).then(receipt=>!!receipt&&receipt.sequence>before&&receipt.finished),{timeout:60000,message:'The actual backup inspection must finish.'}).toBe(true);
  const receipt=await application.evaluate(()=>Reflect.get(globalThis,'__recoveryInspectReceipts').at(-1) as InspectionReceipt);
  console.info('RECOVERY_INSPECTION_RECEIPT '+JSON.stringify(receipt));expect(receipt.ok).toBe(true);
  await expect(panel).toHaveAttribute('aria-busy','false');await expect(panel.locator('[aria-label="备份检查结果"]')).toBeVisible();
}
async function closeFixture(application:ElectronApplication){let timer:ReturnType<typeof setTimeout>|undefined;const stopped=await Promise.race([application.close().then(()=>true,()=>false),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),10000);})]);if(timer)clearTimeout(timer);if(!stopped)application.process().kill('SIGKILL');}
function cleanupFixture(root:string){if(path.dirname(path.resolve(root))!==path.resolve(tmpdir())||!path.basename(root).startsWith('worldlinebox-recovery-ui-'))throw new Error('Unexpected recovery UI cleanup root');removeCompanionTestDirectory(root);}
test('creates a real backup, repairs an exact missing profile through the global UI and keeps lost-ledger stale-package inspection reachable in light/dark narrow/wide views',async()=>{
  test.setTimeout(240000);mkdirSync(shots,{recursive:true});const root=mkdtempSync(path.join(tmpdir(),'worldlinebox-recovery-ui-')),destination=path.join(root,'backups'),profile=path.join(root,'profile');mkdirSync(destination);let application:ElectronApplication|undefined;
  const launch=async(packagePath?:string)=>{application=await electron.launch({...resolveElectronLaunchOptions(),env:electronLaunchEnv({WORLDLINEBOX_E2E:'1',WORLDLINEBOX_E2E_USER_DATA_PATH:profile,WORLDLINEBOX_E2E_RECOVERY_DESTINATION:destination,...(packagePath?{WORLDLINEBOX_E2E_RECOVERY_PACKAGE:packagePath}:{})},{gpu:'software'})});await preparePackagedCompanionLaunch(application,profile);await packagedRecoveryPicker(application,destination,packagePath);const build=await companionEvidenceEnvironment(application,profile);const page=await application.firstWindow(),window=await application.browserWindow(page);await window.evaluate(win=>{win.hide();win.setSize(1600,1050);win.webContents.setBackgroundThrottling(false);});await ensureCompanionTestWorkspace(page);await observeRecoveryInspection(application);await page.locator('[data-application-module="companions"]').click();return{page,window,build};};
  try{
    let current=await launch(),page=current.page;const initialBuild=current.build,config=await page.evaluate(()=>(window as unknown as Bridge).worldlinebox.llm.getConfig());expect(config.ok).toBe(true);if(config.ok)expect(config.value.hasKey).toBe(false);
    const initial=await page.evaluate(()=>(window as unknown as Bridge).worldlinebox.companions.workspace!({type:'status'}));expect(initial.ok,initial.error).toBe(true);const selected=initial.selected!;const relative=path.relative(root,selected.libraryPath);expect(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)).toBeTruthy();
    const created=await page.evaluate(input=>(window as unknown as Bridge).worldlinebox.companions.request(input),{type:'companion.create' as const,operationId:randomUUID(),companionId:randomUUID(),companion:{name:'备份验收角色',description:'隔离的真实界面验收',persona:'从真实依据中学习，不把未完成处理当作已学会。',model:'',avatar:'custom' as const,proactive:false}});expect(created.ok,created.error).toBe(true);const owner=created.companion!;
    const canonical=path.join(selected.memoryRoot,owner.id,'profile.md'),before=hash(readFileSync(canonical));
    await page.getByRole('button',{name:'备份与恢复',exact:true}).click();let panel=page.getByRole('dialog',{name:'伙伴备份与恢复',exact:true});await expect(panel).toBeVisible();await expect(panel.locator('textarea,[contenteditable="true"]')).toHaveCount(0);
    await panel.getByRole('button',{name:'选择备份位置',exact:true}).click();await panel.getByRole('button',{name:'创建完整备份',exact:true}).click();await expect(panel.locator('[aria-label="确认备份或恢复"]')).toContainText('暂停当前资产库');await panel.getByRole('button',{name:'确认暂停并执行',exact:true}).click();await expect(panel).toContainText('备份已获宿主凭据',{timeout:60000});
    const packagePath=path.join(destination,readdirSync(destination).find(name=>name.endsWith('.wlcompanion-backup'))!);expect(packagePath).not.toBe(destination);
    const resumed=await page.evaluate(async ownerId=>{const api=(window as unknown as Bridge).worldlinebox.companions,opened=await api.request({type:'conversation.open',companionId:ownerId});if(!opened.ok||!opened.conversation)return opened;return api.request({type:'message.send',conversationId:opened.conversation.id,clientId:crypto.randomUUID(),delivery:'chat',content:'备份完成后的一条新消息；此环境没有配置模型。'});},owner.id);expect(resumed.ok,resumed.error).toBe(true);expect(resumed.message?.content).toContain('备份完成后');
    const wrongLibrary=await page.evaluate(input=>(window as unknown as Bridge).worldlinebox.companions.workspace!(input),{type:'recovery.backup.create' as const,libraryId:'different-selected-library',operationId:randomUUID(),destinationParent:destination});expect(wrongLibrary.ok).toBe(false);expect(wrongLibrary.error).toContain('资产库已变化');
    await expect(page.locator('.companions-error').filter({hasText:'无法初始化'})).toHaveCount(0);await page.screenshot({path:path.join(shots,companionEvidenceName('recovery-wide-light.png'))});expect(await panel.evaluate(node=>node.scrollWidth-node.clientWidth)).toBeLessThanOrEqual(2);
    await panel.getByRole('button',{name:'关闭备份与恢复',exact:true}).click();unlinkSync(canonical);await application!.evaluate((_,value)=>{process.env.WORLDLINEBOX_E2E_RECOVERY_PACKAGE=value;},packagePath);await packagedRecoveryPicker(application!,destination,packagePath);
    await page.getByRole('button',{name:'备份与恢复',exact:true}).click();panel=page.getByRole('dialog',{name:'伙伴备份与恢复',exact:true});await inspectPackage(application!,panel);await panel.getByRole('button',{name:'仅补回当前缺失正文',exact:true}).click();await panel.getByRole('button',{name:'确认暂停并执行',exact:true}).click();await expect(panel).toContainText('当前缺失正文已核验',{timeout:60000});expect(hash(readFileSync(canonical))).toBe(before);
    await current.window.evaluate(win=>win.setSize(1120,900));await page.screenshot({path:path.join(shots,companionEvidenceName('recovery-compact-light.png'))});expect(await panel.evaluate(node=>node.scrollWidth-node.clientWidth)).toBeLessThanOrEqual(2);
    await panel.getByRole('button',{name:'关闭备份与恢复',exact:true}).click();await appearance(page);await page.getByRole('button',{name:'备份与恢复',exact:true}).click();panel=page.getByRole('dialog',{name:'伙伴备份与恢复',exact:true});await inspectPackage(application!,panel);await page.screenshot({path:path.join(shots,companionEvidenceName('recovery-compact-dark.png'))});expect(await panel.evaluate(node=>node.scrollWidth-node.clientWidth)).toBeLessThanOrEqual(2);
    await expect(panel.getByRole('button',{name:'恢复丢失的账本',exact:true})).toBeDisabled();await application!.close();application=undefined;
    const fresh=await offlineSnapshot(root,selected,destination,initialBuild),ledger=path.join(selected.dataRoot,'messages.sqlite');unlinkSync(ledger);
    current=await launch(fresh.packagePath);page=current.page;await page.getByRole('button',{name:'备份与恢复',exact:true}).click();panel=page.getByRole('dialog',{name:'伙伴备份与恢复',exact:true});await inspectPackage(application!,panel);await expect(panel).toContainText('宿主凭据仍为当前版本');await panel.getByRole('button',{name:'恢复丢失的账本',exact:true}).click();await panel.getByRole('button',{name:'确认暂停并执行',exact:true}).click();
    const frozen=await page.evaluate(id=>localStorage.getItem('companion-recovery-operation-v1/'+id),selected.libraryId);if(frozen){const command=JSON.parse(frozen) as {operationId:string;mode:string};expect(command.operationId).not.toBe(fresh.operationId);expect(command.mode).toBe('database');}
    const diagnosticTimer=setTimeout(()=>copyShutdownDiagnostic(root),20000);try{await expect(panel).toContainText('账本已恢复，伙伴保持休眠',{timeout:60000});}finally{clearTimeout(diagnosticTimer);copyShutdownDiagnostic(root);}const restored=await page.evaluate(()=>(window as unknown as Bridge).worldlinebox.companions.request({type:'state'}));expect(restored.ok,restored.error).toBe(true);expect(restored.state?.companions.find(item=>item.id===owner.id)?.active).toBe(false);
    const jobs=await page.evaluate(ownerId=>(window as unknown as Bridge).worldlinebox.companions.workspace!({type:'jobs.page',kind:'capture',ownerId,limit:50}),owner.id);expect(jobs.ok,jobs.error).toBe(true);expect(jobs.jobPage!.items.length).toBeGreaterThan(0);expect(jobs.jobPage!.items.every(job=>['parked','abandoned','completed','cancelled','stale'].includes(job.state))).toBe(true);expect(hash(readFileSync(canonical))).toBe(before);
    expect(current.build.appAsarHash).toBe(initialBuild.appAsarHash);expect(current.build.companionWorkerHash).toBe(initialBuild.companionWorkerHash);
    writeFileSync(path.resolve('artifacts/cognition-validation',companionEvidenceName('recovery-electron-ui-proof.json')),JSON.stringify({actualElectron:true,build:initialBuild,restoredBuild:current.build,offlineSnapshotHost:fresh.offlineHost,temporaryLibraryOnly:true,backupViaUi:true,foregroundMessageAfterBackup:true,staleUiLibraryIdRefused:true,exactCurrentProfileRepairViaUi:true,profileHashExact:true,lostDatabaseGlobalEntry:true,currentTicketDatabaseRestoreViaUi:true,restoreRequiresInactiveReview:true,oldJobsHeld:true,staleRollbackDisabled:true,overflowMaximum:2,modelsConfigured:false,
      verificationEnvironment:initialBuild.isPackaged?'current_asar_temporary_profile':'development_temporary_profile',
      limitation:'No model was configured. This validates storage/IPC/UI recovery and preserved bytes in the recorded build; it is not an installer/update or long-term personality-learning quality test.'},null,2));
  }finally{if(application)await closeFixture(application);cleanupFixture(root);}
});

// @vitest-environment happy-dom
import {act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import {CompanionRecoveryPanel} from '../../src/renderer/companions/CompanionRecoveryPanel';
import {CompanionWorkspace} from '../../src/renderer/companions/CompanionWorkspace';
import type {WorldlineBoxCompanionsApi} from '../../src/shared/companions';
import type {CompanionRecoveryResult} from '../../src/shared/companion-recovery';
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});let root:Root|undefined,host:HTMLDivElement;
const library={libraryId:'library1',displayName:'隔离资产库',libraryPath:'C:/fixture/library'},packagePath='C:/fixture/backups/approved.wlcompanion-backup',fingerprint='a'.repeat(64),receipt:CompanionRecoveryResult={operationId:'a1d1979e-5a7a-4d59-9f8e-2cd73ae98de1',packagePath,manifestHash:fingerprint,libraryId:library.libraryId,lineageId:'caf47ef7-54c2-4b87-8cb1-2d8567ddf1b4',generation:8,files:42,bytes:1024,mode:'backup',databaseRestoreAvailable:true};
afterEach(async()=>{await act(()=>root?.unmount());root=undefined;host?.remove();vi.unstubAllGlobals();localStorage.clear();vi.restoreAllMocks();});
function api(workspace:NonNullable<WorldlineBoxCompanionsApi['workspace']>):WorldlineBoxCompanionsApi{return{workspace,request:vi.fn(async()=>({ok:false,error:'账本已丢失'})),onChanged:()=>()=>undefined,onReplyStream:()=>()=>undefined};}
async function mount(element:React.ReactNode){host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root!.render(element));}
async function click(text:string){const target=[...host.querySelectorAll('button')].find(button=>button.textContent===text);expect(target,text).toBeDefined();await act(async()=>target!.click());}
it('keeps recovery reachable from the global workspace when there are zero owners or the normal ledger fails',async()=>{
  const workspace=vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async command=>command.type==='status'?{ok:true,selected:{...library,dataRoot:'C:/fixture/data',memoryRoot:'C:/fixture/owners'},libraries:[]}:command.type==='recovery.choose'?{ok:true,cancelled:true}:{ok:false,error:'unexpected'}),connection=api(workspace);
  await mount(<CompanionWorkspace api={connection}><p role="alert">账本已丢失</p></CompanionWorkspace>);await act(async()=>{await new Promise(resolve=>setTimeout(resolve,1));});await click('备份与恢复');
  expect(host.textContent).toContain('伙伴备份与恢复');expect(connection.request).not.toHaveBeenCalled();await click('选择并检查备份包');expect(workspace.mock.calls.some(([command])=>command.type==='recovery.restore')).toBe(false);expect(host.textContent).not.toContain('已恢复');
});
it('freezes the exact operation after a lost reply, restores it when reopened, and retries only on an explicit click',async()=>{
  let count=0;const workspace=vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async command=>{
    if(command.type==='recovery.choose')return{ok:true,recoveryPath:'C:/fixture/backups'};
    if(command.type==='recovery.backup.create'){if(++count===1)throw new Error('回复中断，状态未确认');return{ok:true,recovery:{...receipt,operationId:command.operationId}};}return{ok:false};
  }),connection=api(workspace);
  await mount(<CompanionRecoveryPanel api={connection} library={library} onClose={()=>undefined}/>);await click('选择备份位置');await click('创建完整备份');expect(count).toBe(0);await click('确认暂停并执行');
  const first=workspace.mock.calls.find(([command])=>command.type==='recovery.backup.create')![0];expect(first).toMatchObject({libraryId:library.libraryId,destinationParent:'C:/fixture/backups',operationId:expect.any(String)});expect(host.textContent).toContain('保留原操作等待核对');
  await act(()=>root!.unmount());root=undefined;host.remove();await mount(<CompanionRecoveryPanel api={connection} library={library} onClose={()=>undefined}/>);expect(count).toBe(1);expect(host.textContent).toContain('保留原操作等待核对');await click('重试同一次备份或恢复');
  expect(workspace.mock.calls.filter(([command])=>command.type==='recovery.backup.create').map(([command])=>command)).toEqual([first,first]);expect(host.textContent).toContain('备份已获宿主凭据');expect(localStorage.getItem('companion-recovery-operation-v1/library1')).toBeNull();
});
it('previews stale packages without allowing database rollback and sends only the explicit current-files mode with the exact inspected hash',async()=>{
  const workspace=vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async command=>command.type==='recovery.choose'?{ok:true,recoveryPath:packagePath}:command.type==='recovery.package.inspect'?{ok:true,recovery:{...receipt,databaseRestoreAvailable:false,unavailableReason:'后来已发生撤回'}}:command.type==='recovery.restore'?{ok:true,recovery:{...receipt,operationId:command.operationId,mode:command.mode,restoredFiles:1}}:{ok:false});
  await mount(<CompanionRecoveryPanel api={api(workspace)} library={library} onClose={()=>undefined}/>);await click('选择并检查备份包');expect(host.textContent).toContain('后来已发生撤回');expect([...host.querySelectorAll('button')].find(button=>button.textContent==='恢复丢失的账本')?.disabled).toBe(true);
  await click('仅补回当前缺失正文');expect(workspace.mock.calls.some(([command])=>command.type==='recovery.restore')).toBe(false);await click('确认暂停并执行');expect(workspace).toHaveBeenCalledWith({type:'recovery.restore',libraryId:library.libraryId,mode:'current_files',operationId:expect.any(String),packagePath,expectedManifestHash:fingerprint});expect(host.textContent).toContain('补回 1 个仍获权的准确文件');expect(host.textContent).not.toContain('账本已恢复');
});
it('rejects a different library preview and never arms its restore buttons',async()=>{
  const workspace=vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async command=>command.type==='recovery.choose'?{ok:true,recoveryPath:packagePath}:{ok:true,recovery:{...receipt,libraryId:'other'}});
  await mount(<CompanionRecoveryPanel api={api(workspace)} library={library} onClose={()=>undefined}/>);await click('选择并检查备份包');expect(host.querySelector('[role="alert"]')?.textContent).toContain('不属于当前资产库');expect(host.querySelector('[aria-label="备份检查结果"]')).toBeNull();expect(workspace.mock.calls.some(([command])=>command.type==='recovery.restore')).toBe(false);
});
it('does not claim success for a wrong operation receipt and keeps the same frozen payload',async()=>{
  const workspace=vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async command=>command.type==='recovery.choose'?{ok:true,recoveryPath:'C:/fixture/backups'}:{ok:true,recovery:receipt});
  await mount(<CompanionRecoveryPanel api={api(workspace)} library={library} onClose={()=>undefined}/>);await click('选择备份位置');await click('创建完整备份');await click('确认暂停并执行');expect(host.querySelector('[role="alert"]')?.textContent).toContain('返回凭据与原操作不一致');expect(host.textContent).not.toContain('备份已获宿主凭据');expect(host.textContent).toContain('重试同一次备份或恢复');
});
it('does not dispatch a write if the operation identity cannot be persisted first',async()=>{
  const workspace=vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async()=>({ok:true,recoveryPath:'C:/fixture/backups'}));await mount(<CompanionRecoveryPanel api={api(workspace)} library={library} onClose={()=>undefined}/>);await click('选择备份位置');await click('创建完整备份');vi.stubGlobal('localStorage',{setItem(){throw new Error('无法保存操作标识');}});await click('确认暂停并执行');expect(host.querySelector('[role="alert"]')?.textContent).toContain('无法保存操作标识');expect(workspace.mock.calls.some(([command])=>command.type==='recovery.backup.create')).toBe(false);
});

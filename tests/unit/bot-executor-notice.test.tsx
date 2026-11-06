// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BotExecutorNotice } from '../../src/renderer/companion-bot/BotExecutorNotice';
import type { DshInstance, DshLauncherResponse, DshLauncherState, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';

Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
let root:Root|undefined,host:HTMLDivElement;
afterEach(async()=>{await act(()=>root?.unmount());host?.remove();root=undefined;});
const instance:DshInstance={id:'default',name:'我的 DSH',runtimeId:'runtime',createdAt:'now',updatedAt:'now',profile:'web',status:'stopped',homePath:'home',agentsPath:'agents',workspacePath:'workspace',browserPartition:'default',isDefault:true};
const state=(status:DshInstance['status']='stopped'):DshLauncherState=>({supported:true,rootPath:'fixture',runtimes:[],instances:[{...instance,status}],snapshots:[],packs:[],operations:[]});
function deferred(){let resolve!:(value:DshLauncherResponse)=>void;return{promise:new Promise<DshLauncherResponse>(done=>{resolve=done;}),resolve:(value:DshLauncherResponse)=>resolve(value)};}
async function mount(handler:WorldlineBoxDshLauncherApi['request']){
  let change:(value:DshLauncherState)=>void=()=>undefined;
  const request=vi.fn(handler),open=vi.fn(),unsubscribe=vi.fn();
  const api:WorldlineBoxDshLauncherApi={request,onChanged:listener=>{change=listener;return unsubscribe;}};
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
  await act(async()=>root!.render(<BotExecutorNotice api={api} zh onOpenLauncher={open}/>));
  return{request,open,unsubscribe,change:(value:DshLauncherState)=>act(()=>change(value))};
}
async function click(label:string){const button=[...host.querySelectorAll('button')].find(value=>value.textContent===label||value.getAttribute('aria-label')===label)!;expect(button,label).toBeDefined();await act(async()=>button.click());}
it('shows the stopped default instance with a working start button and accepts the returned running state',async()=>{
  const f=await mount(async request=>({ok:true,state:state(request.type==='instance.start'?'running':'stopped')}));
  expect(host.textContent).toContain('DSH 未启动');await click('前往启动器');expect(f.open).toHaveBeenCalledOnce();
  expect(host.querySelector('.bot-executor-status-label')?.getAttribute('title')).toContain('聊天可照常');
  expect(host.querySelector('small')).toBeNull();
  await click('启动');expect(f.request).toHaveBeenLastCalledWith({type:'instance.start',instanceId:'default'});expect(host.textContent).toBe('');
});
it('shows starting, stopping and execution-readiness failures instead of hiding a running-but-unready executor',async()=>{
  const f=await mount(async()=>({ok:true,state:state('starting')}));
  expect(host.textContent).toContain('正在启动');expect(host.querySelector('.bot-executor-primary')).toBeNull();
  await f.change({...state('running'),executionReadiness:{instanceId:'default',status:'warming',updatedAt:'now'}});expect(host.textContent).toContain('正在准备');expect(host.querySelector('.bot-executor-primary')).toBeNull();
  await f.change({...state('stopped'),executionReadiness:{instanceId:'default',status:'warming',updatedAt:'now'}});expect(host.textContent).toContain('未启动');expect(host.querySelector<HTMLButtonElement>('.bot-executor-primary')?.disabled).toBe(false);
  await f.change(state('stopping'));expect(host.textContent).toContain('正在关闭');expect(host.querySelector('.bot-executor-primary')).toBeNull();
  await f.change({...state('running'),executionReadiness:{instanceId:'default',status:'failed',updatedAt:'now'}});
  expect(host.querySelector('[role=alert]')).not.toBeNull();expect(host.textContent).toContain('启动失败');
  await f.change({...state('running'),executionReadiness:{instanceId:'default',status:'ready',updatedAt:'now'}});expect(host.textContent).toBe('');
});
it('keeps a newer subscription state when the original state request resolves late',async()=>{
  const pending=deferred(),f=await mount(()=>pending.promise);expect(host.textContent).toContain('正在连接');
  await f.change(state('running'));await act(()=>pending.resolve({ok:true,state:state('stopped')}));expect(host.textContent).toBe('');
});
it('shows read and start errors, permits retries and clears stale errors on a recovered subscription',async()=>{
  let reads=0;const f=await mount(async request=>request.type==='state'?++reads===1?{ok:false,error:'IPC 暂时断开'}:{ok:true,state:state()}:{ok:false,error:'端口占用'});
  expect(host.textContent).not.toContain('IPC 暂时断开');await click('详情');expect(host.textContent).toContain('IPC 暂时断开');
  await click('重试');expect(host.textContent).toContain('未启动');
  await click('启动');expect(host.textContent).toContain('端口占用');expect([...host.querySelectorAll('button')].some(value=>value.textContent==='启动')).toBe(true);
  await f.change(state('running'));expect(host.textContent).toBe('');
});
it('makes missing and unsupported defaults explicit and offers navigation without an invalid start action',async()=>{
  const f=await mount(async()=>({ok:true,state:{...state(),instances:[]}}));expect(host.textContent).toContain('尚未配置 DSH');expect(host.querySelectorAll('button')).toHaveLength(1);
  await f.change({...state(),supported:false});expect(host.textContent).toContain('此系统暂不支持');expect(host.querySelectorAll('button')).toHaveLength(1);
});

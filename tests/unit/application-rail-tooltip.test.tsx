// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ApplicationShell } from '../../src/renderer/ApplicationShell';
import { HOVER_TIP_SHOW_DELAY_MS, HoverTipHost } from '../../src/renderer/hover-tip';
import { LocaleProvider } from '../../src/renderer/i18n';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT:boolean }).IS_REACT_ACT_ENVIRONMENT=true;
let root:Root|undefined,container:HTMLDivElement|undefined;
afterEach(async()=>{await act(()=>root?.unmount());container?.remove();vi.restoreAllMocks();vi.useRealTimers();});
async function mount(){
  vi.useFakeTimers();
  const bounds=(x:number,y:number,width:number,height:number)=>({x,y,left:x,top:y,width,height,right:x+width,bottom:y+height,toJSON(){return {};}});
  vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
    if(this.classList.contains('application-navigation'))return bounds(0,0,68,768);
    if(this.dataset.applicationModule==='companions')return bounds(8,104,52,56);
    if(this.dataset.applicationModule==='assets')return bounds(8,168,52,56);
    return bounds(100,300,52,40);
  });
  vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockReturnValue(80);
  vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockReturnValue(24);
  function Fixture(){const [active,select]=useState('assets');return <><HoverTipHost/><ApplicationShell activeModuleId={active} onSelectModule={select} onOpenSettings={()=>undefined} modules={[
    {id:'companions',label:'伙伴',icon:'users',content:<p>伙伴页面</p>},
    {id:'assets',label:'资产管理',icon:'grid',content:<p>资产页面</p>},
  ]}/><button data-hover-tip="普通提示">普通控件</button></>;}
  container=document.createElement('div');document.body.append(container);root=createRoot(container);
  await act(()=>root!.render(<LocaleProvider><Fixture/></LocaleProvider>));
  return container.querySelector<HTMLButtonElement>('[data-application-module="companions"]')!;
}
async function waitForTip(){await act(()=>vi.advanceTimersByTime(HOVER_TIP_SHOW_DELAY_MS+1));return document.querySelector<HTMLElement>('[role="tooltip"]');}
it('places the rail tip outside the rail, level with its button, and preserves ordinary tooltips',async()=>{
  const button=await mount();await act(()=>button.dispatchEvent(new PointerEvent('pointerover',{bubbles:true})));
  const tip=await waitForTip();expect(tip?.textContent).toBe('伙伴');
  expect(Number.parseFloat(tip!.style.left)).toBe(74);expect(Number.parseFloat(tip!.style.top)).toBe(120);
  expect(Number.parseFloat(tip!.style.top)+24).toBeLessThan(168);
  const ordinary=container!.querySelector<HTMLButtonElement>('[data-hover-tip="普通提示"]')!;
  await act(()=>ordinary.dispatchEvent(new PointerEvent('pointerover',{bubbles:true})));
  const ordinaryTip=await waitForTip();expect(ordinaryTip?.textContent).toBe('普通提示');expect(Number.parseFloat(ordinaryTip!.style.top)).toBe(346);
});
it('cancels pointer activation and its focus timer, then permits deliberate re-entry',async()=>{
  const button=await mount();await act(()=>button.dispatchEvent(new PointerEvent('pointerover',{bubbles:true})));await waitForTip();
  await act(()=>{button.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));button.focus();button.click();});
  expect(button.getAttribute('aria-current')).toBe('page');expect(await waitForTip()).toBeNull();
  await act(()=>button.dispatchEvent(new PointerEvent('pointerout',{bubbles:true,relatedTarget:document.body})));
  await act(()=>button.dispatchEvent(new PointerEvent('pointerover',{bubbles:true})));
  expect((await waitForTip())?.textContent).toBe('伙伴');
});
it('dismisses keyboard activation without disabling later keyboard focus tips',async()=>{
  const button=await mount();await act(()=>button.focus());expect((await waitForTip())?.textContent).toBe('伙伴');
  await act(()=>{button.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));button.click();});
  expect(await waitForTip()).toBeNull();
  const assets=container!.querySelector<HTMLButtonElement>('[data-application-module="assets"]')!;
  await act(()=>assets.focus());expect((await waitForTip())?.textContent).toBe('资产管理');
});

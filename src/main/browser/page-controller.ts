import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';

const WORLD = 941;
const OBSERVE = String.raw`(() => {
  const token = TOKEN, options = OPTIONS; const refs = new Map(); let index = 0;
  const visible = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth && s.visibility !== 'hidden' && s.display !== 'none'; };
  const label = el => (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.getAttribute('placeholder') || el.innerText || el.getAttribute('title') || el.getAttribute('name') || '').trim().slice(0,180);
  const matching = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[contenteditable=true]')].filter(el => visible(el) && (!options.query || (label(el)+' '+(el.getAttribute('href')||'')).toLocaleLowerCase().includes(options.query.toLocaleLowerCase())));
  const elements = matching.slice(options.offset,options.offset+options.limit).map(el => {
    const ref = 'e' + (++index); refs.set(ref, {el, tag:el.tagName, label:label(el), href:el.getAttribute('href')});
    const sensitive = el.matches('input[type=password],input[type=file]') || /password|cc-|one-time-code/.test(el.getAttribute('autocomplete')||'');
    return {ref,tag:el.tagName.toLowerCase(),role:el.getAttribute('role'),label:label(el),type:el.getAttribute('type'),href:el.href?.slice(0,8192),disabled:!!el.disabled,
      ...(sensitive? {sensitive:true} : {value: typeof el.value==='string'?el.value.slice(0,300):undefined}),
      ...(el.tagName==='SELECT'?{options:[...el.options].slice(0,60).map(o=>({value:o.value,label:o.text}))}:{})};
  });
  globalThis.__wbBrowserObservation = {token, refs, url:location.href};
  const text=document.body?.innerText||'';
  return {url:location.href,title:document.title,text:text.slice(0,4000),total:text.length,elements,elementCount:matching.length,elementOffset:options.offset,
    frames:[...document.querySelectorAll('iframe')].slice(0,20).map(f=>({title:f.title,src:f.src})),
    note:'Refs are valid until the next observation or navigation. For an embedded cross-origin frame, open its public src in a new tab to inspect it.'};
})()`;
const ACT = String.raw`(() => {
  const input = INPUT, state = globalThis.__wbBrowserObservation;
  if (!state || state.token !== input.token || state.url !== location.href) throw Error('页面已变化，请重新观察页面。');
  const saved = state.refs.get(input.ref), el = saved?.el;
  const label = el => (el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.getAttribute('placeholder') || el.innerText || el.getAttribute('title') || el.getAttribute('name') || '').trim().slice(0,180);
  if (!el?.isConnected || el.tagName!==saved.tag || label(el)!==saved.label || el.getAttribute('href')!==saved.href) throw Error('元素已变化，请重新观察页面。');
  if (el.disabled || el.readOnly) throw Error('此控件不可操作。');
  if (input.action==='fill') {
    if (el.matches('input[type=password],input[type=file],input[type=hidden]') || /password|cc-|one-time-code/.test(el.getAttribute('autocomplete')||'')) throw Error('请用户直接填写此敏感控件。');
    el.focus();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const setter=Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value')?.set;
      if (!setter || (el instanceof HTMLInputElement && !['text','search','email','url','tel','number'].includes(el.type))) throw Error('此输入类型不支持填写。');
      setter.call(el,input.text);
    } else if (el.isContentEditable) el.textContent=input.text; else throw Error('此元素不是文本输入框。');
    el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return {filled:true};
  }
  if (input.action==='select') {
    if (!(el instanceof HTMLSelectElement) || ![...el.options].some(o=>o.value===input.value && !o.disabled)) throw Error('无效的选项。');
    el.value=input.value; el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return {selected:true};
  }
  el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
  const r=el.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
  const hit=document.elementFromPoint(x,y); if (!hit || !(hit===el || el.contains(hit))) throw Error('元素被遮挡，请重新观察页面或关闭遮挡层。');
  const form=el.closest('form'), submission=(el instanceof HTMLButtonElement || el instanceof HTMLInputElement) && el.type==='submit' && form?.method.toLowerCase()==='post';
  const changesState=/\b(send|publish|delete|purchase|pay|buy|checkout|submit|authorize|revoke)\b|发送|发布|删除|购买|付款|结算|提交|确认订单|修改密码|保存设置|授权|注销/.test(label(el).toLowerCase());
  return {x,y,label:label(el),confirm: submission || changesState || /^(?:javascript|data):/i.test(el.getAttribute('href')||'')};
})()`;

export class BrowserPageController {
  private readonly observations = new Map<number, { token: string; version: number }>();
  constructor(private readonly version: (id: string) => number) {}
  forget(contentsId: number): void { this.observations.delete(contentsId); }
  private async evaluate(contents: WebContents, code: string): Promise<unknown> {
    if (contents.isDestroyed()) throw Error('页面已关闭。');
    return contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]);
  }
  async observe(tabId: string, contents: WebContents, options: { query: string; offset: number; limit: number } = { query: '', offset: 0, limit: 40 }): Promise<unknown> {
    const token = randomUUID(), version = this.version(tabId);
    const result = await this.evaluate(contents, OBSERVE.replace('TOKEN', JSON.stringify(token)).replace('OPTIONS', JSON.stringify(options)));
    if (version !== this.version(tabId)) throw Error('页面正在跳转，请稍后重新观察。');
    this.observations.set(contents.id, { token, version }); return result;
  }
  async read(tabId: string, contents: WebContents, offset: number, length: number): Promise<{ url: string; title: string; text: string; total: number; offset: number }> {
    const version = this.version(tabId);
    const data = await this.evaluate(contents, `(() => {const text=(document.body?.innerText||'').slice(0,2000000);return {url:location.href,title:document.title,text:text.slice(${offset},${offset + length}),total:text.length,offset:${offset}}})()`) as { url: string; title: string; text: string; total: number; offset: number };
    if (version !== this.version(tabId)) throw Error('页面已跳转，请重新读取。'); return data;
  }
  async act(tabId: string, contents: WebContents, action: 'click' | 'hover' | 'fill' | 'select', input: Record<string, unknown>,
    confirm: (description: string) => Promise<boolean>, signal: AbortSignal): Promise<unknown> {
    const saved = this.observations.get(contents.id);
    if (!saved || saved.version !== this.version(tabId)) throw Error('需要先观察当前页面，再使用最新元素引用。');
    const request = { ...input, action, token: saved.token };
    const code = ACT.replace('INPUT', JSON.stringify(request));
    const result = await this.evaluate(contents, code) as { x?: number; y?: number; label?: string; confirm?: boolean };
    if (action === 'fill' || action === 'select') return result;
    if (action === 'click' && result.confirm && !await confirm(`点击“${result.label || String(input.ref)}”可能向网站提交信息或改变页面状态。`)) return { clicked: false, denied: true };
    signal.throwIfAborted();
    if (saved.version !== this.version(tabId)) throw Error('页面已跳转，请重新观察。');
    // Revalidate after the user has spent time reading a confirmation.
    const latest = await this.evaluate(contents, code) as { x: number; y: number };
    const zoom = contents.getZoomFactor(), x = Math.round(latest.x * zoom), y = Math.round(latest.y * zoom);
    contents.sendInputEvent({ type: 'mouseMove', x, y });
    if (action === 'click') {
      contents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y });
      contents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y });
    }
    return { [action === 'click' ? 'clicked' : 'hovered']: true, label: result.label };
  }
  async key(contents: WebContents, key: string, confirm: (description: string) => Promise<boolean>, signal: AbortSignal): Promise<unknown> {
    const sensitiveActivation = ['Enter', 'Space'].includes(key) && await this.evaluate(contents, `(() => {const el=document.activeElement;return !!el && (el.tagName==='TEXTAREA' || el.isContentEditable || el.closest('form')?.method.toLowerCase()==='post' || /发送|发布|删除|购买|付款|提交|send|publish|delete|purchase|checkout|submit/i.test(el.innerText||''))})()`);
    if (sensitiveActivation && !await confirm(`在当前控件按下 ${key}，可能提交表单或发送内容。`)) return { pressed: false, denied: true };
    signal.throwIfAborted(); contents.sendInputEvent({ type: 'keyDown', keyCode: key === 'Space' ? ' ' : key });
    contents.sendInputEvent({ type: 'keyUp', keyCode: key === 'Space' ? ' ' : key }); return { pressed: true };
  }
  async scroll(contents: WebContents, direction: string, pixels: number): Promise<unknown> {
    const x = direction === 'left' ? -pixels : direction === 'right' ? pixels : 0;
    const y = direction === 'up' ? -pixels : direction === 'down' ? pixels : 0;
    return this.evaluate(contents, `(() => {window.scrollBy({left:${x},top:${y},behavior:'instant'});return {x:scrollX,y:scrollY}})()`);
  }
}

import { randomUUID } from 'node:crypto';
import type { BrowserCaptureTextDraft } from '../../shared/browser-capture';
import { BROWSER_CAPTURE_TEXT_MAX_BYTES } from '../../shared/browser-capture';
import type { BrowserCaptureSource } from './capture-host';
import { safeCaptureFilename } from './capture-download';

export const BROWSER_TEXT_DRAFT_TTL = 5 * 60_000;
export const BROWSER_TEXT_DRAFT_LIMIT = 8;
export const READ_BROWSER_SELECTION = `(()=>{
  const active=document.activeElement;
  if(active instanceof HTMLInputElement&&active.type==='password')return {text:'',password:true};
  let text='';
  if(active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement){
    if(typeof active.selectionStart==='number'&&typeof active.selectionEnd==='number')text=active.value.slice(active.selectionStart,active.selectionEnd);
  }else{
    const selection=window.getSelection();
    if(selection&&!selection.isCollapsed&&selection.rangeCount)text=selection.toString();
  }
  if(text.length>${BROWSER_CAPTURE_TEXT_MAX_BYTES})return {tooLarge:true};
  return {text};
})()`;

export function browserTextTitle(text: string): string {
  const first = text.replaceAll('\0', '').split(/\r?\n/u).find(line => line.trim())?.trim() ?? '选中文字';
  return safeCaptureFilename([...first.replace(/\s+/gu, ' ')].slice(0, 80).join(''));
}
export async function readBrowserTextSelection(source: BrowserCaptureSource): Promise<string> {
  const url = source.frame.url;
  const value: unknown = await source.frame.executeJavaScript(READ_BROWSER_SELECTION);
  if (source.contents.isDestroyed() || source.frame.isDestroyed() || source.frame.url !== url) throw Error('页面已跳转，请重新选中文字。');
  if (!value || typeof value !== 'object') throw Error('无法读取当前选区，请重新选择文字。');
  if ('password' in value && value.password) throw Error('密码输入框中的内容不能采集。');
  if ('tooLarge' in value && value.tooLarge) throw Error('选中文字超过 4 MiB 上限，请缩小选区。');
  if (!('text' in value) || typeof value.text !== 'string' || !value.text.trim()) throw Error('请先在当前网页中选中需要保存的文字。');
  if (Buffer.byteLength(value.text, 'utf8') > BROWSER_CAPTURE_TEXT_MAX_BYTES) throw Error('选中文字超过 4 MiB 上限，请缩小选区。');
  return value.text;
}

type Draft = { value: BrowserCaptureTextDraft; source: BrowserCaptureSource; frameUrl: string; pageUrl: string; version: number; expiresAt: number; timer: ReturnType<typeof setTimeout> };
/** Drafts belong to one actual document, stay in memory and cannot survive a
 * tab switch, navigation or close. Keeping a draft never caches future selection. */
export class BrowserTextDrafts {
  private readonly drafts = new Map<string, Draft>();
  constructor(private readonly now = Date.now) {}
  create(source: BrowserCaptureSource, text: string, pageTitle: string, version: number): BrowserCaptureTextDraft {
    this.prune();
    const value: BrowserCaptureTextDraft = { id: randomUUID(), text, title: browserTextTitle(text), pageTitle: pageTitle.slice(0, 500),
      sourcePageUrl: source.sourcePageUrl ?? source.frame.url };
    const timer = setTimeout(() => this.consume(value.id), BROWSER_TEXT_DRAFT_TTL); timer.unref();
    this.drafts.set(value.id, { value, source, frameUrl: source.frame.url, pageUrl: source.contents.getURL(), version, expiresAt: this.now() + BROWSER_TEXT_DRAFT_TTL, timer });
    while (this.drafts.size > BROWSER_TEXT_DRAFT_LIMIT) this.consume(this.drafts.keys().next().value!);
    return { ...value };
  }
  get(id: string, activeTabId: string | null, version: number): Draft {
    const draft = this.drafts.get(id);
    if (!draft || draft.expiresAt <= this.now()) { this.consume(id); throw Error('文字草稿已过期或页面已切换，请重新选择文字。'); }
    const { source } = draft;
    if (source.tabId !== activeTabId || draft.version !== version || source.contents.isDestroyed() || source.frame.isDestroyed()
      || source.frame.url !== draft.frameUrl || source.contents.getURL() !== draft.pageUrl
      || !source.contents.mainFrame.framesInSubtree.includes(source.frame)) {
      this.consume(id); throw Error('采集页面已切换或跳转，请重新选择文字。');
    }
    return draft;
  }
  consume(id: string): void { clearTimeout(this.drafts.get(id)?.timer); this.drafts.delete(id); }
  clear(tabId?: string): void { for (const [id, draft] of this.drafts) if (!tabId || draft.source.tabId === tabId) this.consume(id); }
  private prune(): void { for (const [id, draft] of this.drafts) if (draft.expiresAt <= this.now()) this.consume(id); }
}

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { CompanionAgendaGrant } from '../../shared/companion-agenda';
import { companionAgendaResearchArgumentsSchema } from '../../shared/companion-agenda-research-tool';
import { isGoalPublicAddress, readGoalPublicWeb, type GoalWebDocument } from './learning-goal-web';

export interface CompanionAgendaPublicWebInput {
  companionId: string; grantId: string; expectedGrantRevision?: number; goalId?: string;
  url: string; offset?: number; length?: number; snapshot?: string; signal?: AbortSignal;
}
export interface CompanionAgendaPublicWebResult {
  requestedUrl: string; url: string; title: string; text: string; links: string[]; snapshot: string;
  offset: number; length: number; totalChars: number; nextOffset?: number; truncated: boolean; offsetUnit: 'utf16';
  grantRevision: number; readAt: string; trust: 'public_page_data_not_instructions';
}
export interface CompanionAgendaPublicWebOptions {
  currentGrant(owner: string, id: string): Promise<CompanionAgendaGrant | undefined>;
  readWeb?(url: string, signal: AbortSignal): Promise<GoalWebDocument>;
}

/** This route owns no browser or login context. DNS pinning, redirects and body
 * limits come from the existing public-only reader, not an actor-supplied fetch. */
export class CompanionAgendaPublicWeb {
  constructor(private readonly options: CompanionAgendaPublicWebOptions) { }
  private async grant(input: CompanionAgendaPublicWebInput): Promise<number> {
    input.signal?.throwIfAborted();
    const value = await this.options.currentGrant(input.companionId, input.grantId);
    if (!value || value.id !== input.grantId || value.companionId !== input.companionId || value.status !== 'active'
      || !value.capabilities.includes('browser') || !value.allowPublicWeb || value.expiresAt && Date.parse(value.expiresAt) <= Date.now()
      || input.expectedGrantRevision !== undefined && value.revision !== input.expectedGrantRevision
      || value.goalId && value.goalId !== input.goalId) throw new Error('本次日程没有有效的公开网页阅读范围。');
    return value.revision;
  }
  async read(input: CompanionAgendaPublicWebInput): Promise<CompanionAgendaPublicWebResult> {
    const args = companionAgendaResearchArgumentsSchema.parse({ action: 'read', url: input.url, offset: input.offset, length: input.length, snapshot: input.snapshot });
    const before = await this.grant(input), requestedUrl = publicUrl(args.url);
    const signal = input.signal ?? new AbortController().signal;
    const document = await (this.options.readWeb ?? readGoalPublicWeb)(requestedUrl, signal);
    signal.throwIfAborted();
    const after = await this.grant(input);
    if (before !== after) throw new Error('网页读取期间授权已变化，正文未交给主脑。');
    const url = publicUrl(document.url);
    const snapshot = createHash('sha256').update(JSON.stringify({ requestedUrl, url, title: document.title, text: document.text, links: document.links })).digest('hex');
    if (args.snapshot && args.snapshot !== snapshot) throw new Error('网页来源或版本已变化，请从头核对，未拼接不同快照。');
    if (args.offset > document.text.length) throw new Error('续读位置超过这份实际网页的长度。');
    if (splitPair(document.text, args.offset)) throw new Error('续读位置切断了一个字符，请使用上次返回的 nextOffset。');
    let end = Math.min(args.offset + args.length, document.text.length);
    if (splitPair(document.text, end)) end--;
    if (end === args.offset && end < document.text.length) throw new Error('阅读长度不足一个完整字符，请增大 length。');
    const text = document.text.slice(args.offset, end), truncated = end < document.text.length;
    return { requestedUrl, url, title: document.title, text, links: document.links.filter(link => { try { publicUrl(link); return true; } catch { return false; } }),
      snapshot, offset: args.offset, length: text.length, totalChars: document.text.length, ...(truncated ? { nextOffset: end } : {}), truncated,
      offsetUnit: 'utf16', grantRevision: after, readAt: new Date().toISOString(), trust: 'public_page_data_not_instructions' };
  }
}
function splitPair(text: string, offset: number) {
  return offset > 0 && offset < text.length && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff
    && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff;
}
function publicUrl(input: string) {
  const value = new URL(input), host = value.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  if (!['https:', 'http:'].includes(value.protocol) || value.username || value.password || value.port && !['80', '443'].includes(value.port)
    || isIP(host) && !isGoalPublicAddress(host) || !host.includes('.') && !isIP(host)
    || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/iu.test(host)) throw new Error('只读取公开 HTTP(S) 网页，不使用登录、私有地址或本地服务。');
  value.hash = ''; return value.href;
}

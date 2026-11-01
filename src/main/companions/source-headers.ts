import { createHash } from 'node:crypto';
import type { CompanionMessage } from '../../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import { companionSourceHeadersResultSchema, type CompanionAuthorizedSourceHeader, type CompanionSourceHeadersResult } from '../../shared/companion-source-headers';

type Scope = { companionId: string; conversationId: string; beforeSequence?: number };
type Request = (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>;
export function companionSourceHeaderResult(ids: readonly string[], response: CompanionStorageResponse): CompanionSourceHeadersResult | undefined {
  if (!response.ok) return;
  const parsed = companionSourceHeadersResultSchema.safeParse(response.memorySourceHeaders);
  if (!parsed.success) return;
  const wanted = new Set(ids), returned = [...parsed.data.headers.map(header => header.id), ...parsed.data.unsupportedIds];
  if (new Set(returned).size !== returned.length || returned.some(id => !wanted.has(id))) return;
  return parsed.data;
}
export async function readCompanionSourceHeaders(scope: Scope, ids: readonly string[], request: Request): Promise<CompanionSourceHeadersResult> {
  const result: CompanionSourceHeadersResult = { headers: [], unsupportedIds: [] }, unique = [...new Set(ids)];
  for (let offset = 0; offset < unique.length; offset += 1000) {
    const batch = unique.slice(offset, offset + 1000), response = companionSourceHeaderResult(batch, await request({ type: 'memory.sources.headers', ...scope, ids: batch }));
    if (!response) throw new Error('当前来源未返回准确的获权元数据。');
    result.headers.push(...response.headers); result.unsupportedIds.push(...response.unsupportedIds);
  }
  return result;
}
/** Reuse an actually read simple text message, never reconstruct a full DTO
 * from the reduced model-context surface. Exceptional presentations keep the
 * original fresh body adapter and its attachment/observation authority. */
export function companionSourceHeaderMatchesMessage(header: CompanionAuthorizedSourceHeader, message: CompanionMessage): boolean {
  return header.kind === 'text' && header.status === 'sent' && !header.hasAttachments && !header.hasAction
    && !header.memoryEvidenceOnly && !header.hasWorldObservation && message.kind === 'text' && message.status === 'sent'
    && !message.attachments.length && !message.actionId && !message.memoryEvidenceOnly && !message.worldObservation && !message.hostBehavior
    && !message.isReplyDraft && !message.replyDraft && Number.isSafeInteger(message.revision) && message.revision === header.revision
    && message.id === header.id && message.authorId === header.authorId && message.conversationId === header.conversationId
    && message.sequence === header.sequence && message.replyToId === header.replyToId && message.topicId === header.topicId
    && message.createdAt === header.createdAt && message.worldCreatedAt === header.worldCreatedAt && message.worldTimeZone === header.worldTimeZone
    && createHash('sha256').update(message.content).digest('hex') === header.checksum;
}
export async function readCompanionSourceSnapshot(scope: Scope, messages: readonly CompanionMessage[], request: Request): Promise<Map<string, CompanionMessage>> {
  const headers = await readCompanionSourceHeaders(scope, messages.map(message => message.id), request), existing = new Map(messages.map(message => [message.id, message]));
  const result = new Map<string, CompanionMessage>(), fallback = new Set(headers.unsupportedIds);
  for (const header of headers.headers) {
    const message = existing.get(header.id);
    if (message && companionSourceHeaderMatchesMessage(header, message)) result.set(header.id, message);
    else fallback.add(header.id);
  }
  const ids = [...fallback];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const response = await request({ type: 'memory.sources.filter', ...scope, ids: ids.slice(offset, offset + 100) });
    if (!response.ok) throw new Error('当前来源正文暂不可核验。');
    for (const message of response.memorySources ?? []) if (fallback.has(message.id)) result.set(message.id, message);
  }
  return result;
}

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { companionSocialNotificationReceiptSchema, type CompanionSocialNotificationReceipt } from '../../shared/companion-social-notification-receipts';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import { memoCompanionExecutionWitnesses, withCompanionExecutionValidation } from './source-execution-evidence';
import { CompanionValidationUnavailableError } from './validation-unavailable';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
const contextMessage = z.object({ id, authorId: id, conversationId: id, content: z.string(),
  revision: z.number().int().positive().safe().optional(), realCreatedAt: z.string().optional() });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Request = (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>;
export type CompanionReadNotification = { receipt: CompanionSocialNotificationReceipt;
  report: { id: string; conversationId: string; authorId: string; content: string; createdAt?: string } };
export interface CompanionReadNotificationEvidence { readonly notifications: readonly CompanionReadNotification[] }
const evidenceAuthorities = new WeakMap<CompanionReadNotificationEvidence, () => Promise<void>>();
export function companionReadSocialNotifications(evidence: CompanionReadNotificationEvidence): readonly CompanionReadNotification[] {
  if (!evidenceAuthorities.has(evidence)) throw new CompanionValidationUnavailableError('历史来信通知不具备本任务的真实读取凭证。');
  return evidence.notifications;
}
export async function admitCompanionSocialNotificationEvidence(evidence: CompanionReadNotificationEvidence): Promise<void> {
  const admit = evidenceAuthorities.get(evidence);
  if (!admit) throw new CompanionValidationUnavailableError('历史来信通知不具备本任务的真实读取凭证。');
  await admit();
}

/** This bridge grants no new conversation read. Its prose is copied only from
 * the exact same-room rows already sent to the current primary inference. */
export function readCompanionSocialNotificationEvidence(input: { companionId: string; conversationId: string; serializedContext: string;
  identity: object; request: Request; requestFresh: Request }): Promise<CompanionReadNotificationEvidence | undefined> {
  return withCompanionExecutionValidation(async () => {
    const context: unknown = JSON.parse(input.serializedContext);
    if (!context || typeof context !== 'object' || !Array.isArray(Reflect.get(context, 'messages')))
      throw new CompanionValidationUnavailableError('社交核验缺少当前主脑实际已读的消息范围。');
    const messages = new Map<string, z.infer<typeof contextMessage>>();
    for (const value of Reflect.get(context, 'messages') as unknown[]) {
      const parsed = contextMessage.safeParse(value);
      if (!parsed.success || parsed.data.authorId !== input.companionId || parsed.data.conversationId !== input.conversationId) continue;
      const old = messages.get(parsed.data.id);
      if (old && JSON.stringify(old) !== JSON.stringify(parsed.data)) throw new CompanionValidationUnavailableError('同一已读消息存在不同正文。');
      messages.set(parsed.data.id, parsed.data);
    }
    if (!messages.size) return;
    const command = { type: 'social.notifications.receipts' as const, companionId: input.companionId, conversationId: input.conversationId,
      messageIds: [...messages.keys()] };
    if (command.messageIds.length > 256) throw new CompanionValidationUnavailableError('当前社交核验已读消息超过准确有界范围。');
    const parse = (response: CompanionStorageResponse) => {
      if (!response.ok || !response.socialNotificationReceipts) throw new CompanionValidationUnavailableError('历史来信通知的实际宿主关系暂不可核验。');
      const values = new Map<string, CompanionSocialNotificationReceipt>();
      for (const value of response.socialNotificationReceipts) {
        const receipt = companionSocialNotificationReceiptSchema.parse(value), message = messages.get(receipt.messageId);
        if (!message || values.has(receipt.messageId) || receipt.companionId !== input.companionId || receipt.conversationId !== input.conversationId
          || receipt.checksum !== hash(message.content) || message.revision !== undefined && message.revision !== receipt.revision)
          throw new CompanionValidationUnavailableError('历史来信通知与本任务实际已读的正文、版本或入口不一致。');
        values.set(receipt.messageId, receipt);
      }
      return values;
    };
    const receipts = parse(await input.request(command));
    if (!receipts.size) return;
    const key = JSON.stringify(command);
    const register = () => memoCompanionExecutionWitnesses([key], { identity: input.identity, scope: 'read-social-notifications',
      phase: 'sql-authority', revision: () => 0, read: async () => new Map([[key, [...receipts.values()]]]), verify: async entries => {
        const fresh = parse(await input.requestFresh(command));
        for (const entry of entries) for (const receipt of entry.value) if (JSON.stringify(fresh.get(receipt.messageId)) !== JSON.stringify(receipt))
          throw new CompanionValidationUnavailableError('已读来信通知的来源或权限在最终核验时变化。');
      } });
    const admitted = await register();
    const evidence: CompanionReadNotificationEvidence = Object.freeze({ notifications: Object.freeze(admitted.get(key)!.map(receipt => { const message = messages.get(receipt.messageId)!;
      Object.freeze(receipt.notificationIds); receipt.peerReplies.forEach(Object.freeze); Object.freeze(receipt.peerReplies); Object.freeze(receipt);
      return Object.freeze({ receipt, report: Object.freeze({ id: message.id, conversationId: message.conversationId, authorId: message.authorId, content: message.content,
        ...(message.realCreatedAt ? { createdAt: message.realCreatedAt } : {}) }) });
    })) });
    evidenceAuthorities.set(evidence, async () => { await register(); });
    return evidence;
  });
}

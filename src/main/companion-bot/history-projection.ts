import { createHash } from 'node:crypto';
import type { BotStore } from './store';
import type { BotMemoryScope, BotMemoryService } from './memory-service';
import { botMessageEvidence } from '../../shared/bot-message-content';

export interface BotHistoryProjectorOptions { store: BotStore; memory: Pick<BotMemoryService, 'appendHistory'> }
/** Original sent messages are archived independently of model encoding and
 * semantic/CDS indexing. The cursor advances only after a durable VCP receipt.
 * Publication-order journal entries handle replies that finish out of order. */
export class BotHistoryProjector {
  private readonly queues = new Map<string, Promise<void>>();
  constructor(private readonly options: BotHistoryProjectorOptions) {}
  private cursorKey(scope: BotMemoryScope) {
    return 'history-projection:' + createHash('sha256').update(JSON.stringify([scope.companionId, scope.conversationId, scope.securityDomainId])).digest('hex');
  }
  async project(scope: BotMemoryScope, signal?: AbortSignal): Promise<{ through: number; projected: number }> {
    signal?.throwIfAborted();
    const { store, memory } = this.options, conversation = store.getConversation(scope.conversationId);
    if (!conversation || conversation.securityDomainId !== scope.securityDomainId || !conversation.memberIds.includes(scope.companionId)) throw new Error('原文投影范围不属于当前伙伴受众。');
    const key = this.cursorKey(scope), previous = this.queues.get(key) || Promise.resolve();
    const operation = previous.then(async () => {
      signal?.throwIfAborted();
      const target = store.historyProjectionHead(scope.conversationId);
      let cursor = Number(store.getMetadata(key) ?? 0), projected = 0;
      if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > target) throw new Error('原文投影游标无效，拒绝跳过源记录。');
      while (cursor < target) {
        signal?.throwIfAborted();
        const found = store.historyProjectionPage(scope.conversationId, { after: cursor, through: target, limit: 32 });
        if (!found.length) throw new Error('原文投影日志存在未解释缺口。');
        const page = []; let chars = 0;
        for (const row of found) {
          const size = botMessageEvidence(row.message).length;
          if (page.length && chars + size > 64000) break;
          page.push(row); chars += size;
        }
        const withdrawn = store.withdrawnIn(scope.companionId, scope.securityDomainId, page.map(row => row.message.id));
        // Preserve the full publication-order cursor, including pages made
        // entirely of another actor's private task notices. Those rows are
        // intentionally skipped, never copied into this companion's memory.
        const legal = page.filter(row => !withdrawn.has(row.message.id) && store.isMessageVisibleToCompanion(row.message.id, scope.companionId));
        if (legal.length) await memory.appendHistory(scope, legal.map(({ message, timestamp }) => ({
          id: message.id, role: message.senderId === scope.companionId ? 'assistant' : 'user', content: botMessageEvidence(message),
          timestamp, senderId: message.senderId, senderName: message.senderName,
        })), signal);
        signal?.throwIfAborted();
        cursor = page.at(-1)!.projectionSequence;
        store.setMetadata(key, String(cursor)); projected += legal.length;
        // Yield at bounded source pages; no complete lifetime history is loaded.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      return { through: cursor, projected };
    });
    const settled = operation.then(() => undefined, () => undefined); this.queues.set(key, settled);
    void settled.then(() => { if (this.queues.get(key) === settled) this.queues.delete(key); });
    return operation;
  }
}

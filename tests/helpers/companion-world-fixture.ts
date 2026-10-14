import { createHash } from 'node:crypto';
import type { CompanionsStore } from '../../src/companions/store';
import type { CompanionMessage } from '../../src/shared/companions';
/** Explicit semantic classifier fixture; production decisions are made by the notification model. */
export function recordUrgentAttention(store: CompanionsStore, companionId: string, source: CompanionMessage): void {
  store.request({ type: 'world.attention.record', companionId, conversationId: source.conversationId, sourceMessageId: source.id,
    sourceChecksum: createHash('sha256').update(source.content).digest('hex'), urgency: 'urgent', confidence: .98, evidence: [source.content], reason: '测试中的实际用户请求明确需要立即处理。' });
}

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { CompanionWorldStore } from '../../src/companions/world-store';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

it('persists the third full-length atomic failure as terminal without overflowing its display stage or reviving the source', () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-24T10:00:00Z');
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-activity-failure-stage-'));
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), [{ id: 'a', name: 'a', persona: '独立伙伴',
    description: '', avatar: 'sister', model: '', active: true, proactive: false }]);
  // Inject a real failure at the world query port. No model or successful
  // external effect is fabricated; leases/history/transactions are real SQLite.
  const cause = '实际世界查询端口故障：' + '错'.repeat(2000 - '实际世界查询端口故障：'.length);
  const failedPort = vi.spyOn(CompanionWorldStore.prototype, 'queryKnowledge').mockImplementation(() => { throw new Error(cause); });
  try {
    const scope = { companionId: 'a', conversationId: store.openPrivate('a').id };
    const world = store.request({ type: 'world.snapshot' }).world!;
    store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
    const routine = store.request({ type: 'routine.get', ...scope }).routine!;
    store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision,
      patch: { timeZone: 'UTC', meals: [], habits: [], sleepAt: '23:59', wakeAt: '00:01' } });
    const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '核对当前联系人后完成目标。', replyDirective: 'none' });
    const input = { type: 'activity.start' as const, ...scope, sourceMessageId: source.id, clientId: 'actual_port_failure', title: '实际故障验证', goal: source.content };
    const first = store.request(input).activityTask!;
    for (let index = 0; index < 3; index++) {
      vi.setSystemTime(Date.now() + 6000); store.request({ type: 'world.tick' });
      const leased = store.request({ type: 'activity.claim' }).activityTask!;
      expect(leased?.id).toBe(first.id);
      store.request({ type: 'activity.commit', id: leased.id, leaseToken: leased.leaseToken!, decision: { status: 'continue',
        action: { action: 'query', category: 'contacts' }, wait: null, summary: '读取实际联系人资料。' } });
    }
    const task = store.request({ type: 'activity.get', ...scope, id: first.id }).activityTask!;
    expect(task.status).toBe('failed'); expect(task.history).toHaveLength(3);
    expect(task.history.every(item => !item.ok && item.action === 'query' && item.result === cause)).toBe(true);
    expect(task.stage.length).toBeLessThanOrEqual(2000); expect(task.stage).toContain(cause);
    expect(failedPort).toHaveBeenCalledTimes(3);
    vi.setSystemTime(Date.now() + 180000); store.request({ type: 'world.tick' });
    expect(store.request({ type: 'activity.claim' }).activityTask).toBeUndefined();
    expect(store.request(input).activityTask).toMatchObject({ id: first.id, status: 'failed', step: 3 });
    expect(failedPort).toHaveBeenCalledTimes(3);
  } finally { failedPort.mockRestore(); store.close(); removeOwnedDirectorySync(root); vi.useRealTimers(); }
});

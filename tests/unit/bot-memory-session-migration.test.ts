import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotTopics } from '../../src/main/companion-bot/topics';
import { legacyEvidenceRetirementKey } from '../../src/main/companion-bot/memory-session-migration';
import type { BotEvent } from '../../src/main/companion-bot/types';

it.each([21, 22])('retires exactly the affected native bindings from version %i across consecutive restarts', (version) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wlb-legacy-topic-')),
    filename = path.join(dir, 'chat.sqlite');
  let store = new BotStore(filename),
    topics = new BotTopics(store);
  try {
    const a = store.createCompanion({ name: '甲', persona: '伙伴' }),
      b = store.createCompanion({ name: '乙', persona: '伙伴' });
    const room = store.createGroup({ title: '同一群', memberIds: [a.id, b.id], participationMode: 'all' });
    const dirty = topics.create(room.id, 'project-one', '话题原名'),
      clean = topics.create(room.id, 'project-two', '独立话题');
    const send = (content: string, target = dirty, companionIds = [a.id, b.id]) => {
      const group = store.enqueue({
        conversationId: room.id,
        senderId: 'user',
        content,
        sourceMessageId: content,
        recipientIds: companionIds,
      });
      topics.bind(group.events, target);
      return group.events;
    };
    const frozen = (event: BotEvent, items: unknown[], dispatched: boolean) => {
      const value = JSON.stringify({
        system: '旧系统',
        prompt: JSON.stringify({
          message: { content: event.content },
          memoryEvidence: JSON.stringify({ kind: 'passive-memory-evidence', items }),
        }),
      });
      store.setMetadata('native-input:' + event.id, value);
      store.setMetadata('native-dispatch:' + event.id, dispatched ? 'attempted' : 'unsent');
      if (dispatched)
        store.taskTransaction((sql) => sql.prepare("UPDATE bot_inbox SET dsh_event_id=id,status='done' WHERE id=?").run(event.id));
    };
    const old = send('升级前的第一条'),
      one = old.find((e) => e.companionId === a.id)!,
      peer = old.find((e) => e.companionId === b.id)!;
    const body = [{ origin: 'vcp-rag-result', text: '旧独有正文' }];
    frozen(one, body, true);
    frozen(peer, [{ origin: 'vcp-system-fallback', text: '使用日记：[[工作日记本]]' }], true);
    const oldCleanTurn = send('同一旧话题里的纯消息', dirty, [a.id])[0]!;
    frozen(oldCleanTurn, [], true);
    const pending = send('未发送的冻结输入', dirty, [a.id])[0]!;
    frozen(pending, body, false);
    const independent = send('已经是新版本的干净会话', clean, [a.id])[0]!;
    frozen(independent, [], true);
    store.setMetadata('native-input:' + independent.id, JSON.stringify({ system: '已有合法新会话', prompt: 'invalid old envelope' }));
    const onlyUnsent = send('仅有未发送的旧输入', clean, [a.id])[0]!;
    frozen(onlyUnsent, body, false);
    const lazy = store.enqueue({
      conversationId: room.id,
      senderId: 'user',
      recipientIds: [a.id],
      sourceMessageId: 'lazy',
      content: '早期话题的人类原话',
    }).events[0]!;
    frozen(lazy, body, true);
    const oldLane = topics.lane(one),
      peerLane = topics.lane(peer),
      independentLane = topics.lane(independent);
    store.taskTransaction((sql) => sql.prepare('PRAGMA user_version=' + version).run());
    let newLane: string | undefined;
    for (let reopen = 0; reopen < 2; reopen++) {
      store.close();
      store = new BotStore(filename);
      topics = new BotTopics(store);
      expect(store.taskTransaction((sql) => sql.prepare('PRAGMA user_version').get())).toEqual({ user_version: 23 });
      expect(topics.lane(one)).toBe(oldLane);
      expect(topics.lane(oldCleanTurn)).toBe(oldLane);
      expect(() => topics.assertCurrent(oldCleanTurn)).toThrow('退役');
      expect(topics.lane(peer)).toBe(peerLane);
      expect(topics.lane(independent)).toBe(independentLane);
      expect(store.retiredMemoryLanes(b.id)).toEqual([]);
      expect(store.retiredMemoryLanes(a.id).sort()).toEqual([oldLane, 'turn-' + lazy.id].sort());
      expect(topics.lane(onlyUnsent)).toBe(independentLane);
      for (const event of [one, peer, oldCleanTurn, lazy, onlyUnsent, pending]) {
        const envelope = JSON.parse(store.getMetadata('native-input:' + event.id)!);
        expect(JSON.parse(envelope.prompt)).not.toHaveProperty('memoryEvidence');
      }
      const fresh = topics.lane(pending);
      expect(fresh).not.toBe(oldLane);
      if (newLane) expect(fresh).toBe(newLane);
      newLane = fresh;
      expect(topics.select(room.id, dirty.id).title).toBe('话题原名');
      topics.rememberNative([{ laneId: fresh, sessionId: 'wlb-new', exists: false }]);
      expect(topics.list(room.id, '话题原名').items.map((item) => item.id)).toContain(dirty.id);
      expect(store.getMessage(one.sourceMessageRecordId)?.content).toBe(one.content);
      const imported = topics.select(room.id, 'legacy-' + lazy.id);
      expect(topics.contextBinding(imported.id, room.id, a.id)?.laneId).not.toBe('turn-' + lazy.id);
      expect(topics.lane(lazy)).toBe('turn-' + lazy.id);
      if (reopen === 0) {
        // Earlier schema-23 builds rotated this topic but kept the dispatched
        // envelope. A second upgrade must never retire its clean replacement.
        frozen(one, body, true);
        store.taskTransaction(sql => sql.prepare('DELETE FROM bot_metadata WHERE key=?').run(legacyEvidenceRetirementKey));
      }
    }
    expect(store.retiredMemoryLanes(a.id)).not.toContain(independentLane);
    store.rotateDomain(a.id, room.securityDomainId);
    expect(store.retiredMemoryLanes(a.id)).toContain(independentLane);
    expect(store.retiredMemoryLanes(b.id)).toEqual([]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

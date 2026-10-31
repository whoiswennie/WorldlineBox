import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

it.each([
  { zone: 'Asia/Shanghai', day: '2026-11-01', start: '2026-10-31T16:00:00Z', end: '2026-11-01T15:59:59.999Z' },
  { zone: 'UTC', day: '2026-11-01', start: '2026-11-01T00:00:00Z', end: '2026-11-01T23:59:59.999Z' },
  { zone: 'America/New_York', day: '2026-03-08', start: '2026-03-08T05:00:00Z', end: '2026-03-09T03:59:59.999Z' },
  { zone: 'America/New_York', day: '2026-11-01', start: '2026-11-01T04:00:00Z', end: '2026-11-02T04:59:59.999Z' },
])('browses an inclusive $zone civil day through real SQLite without comparing offset strings', async test => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-memory-calendar-'));
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldline-memory-calendar-')) throw new Error('Unsafe calendar fixture cleanup.');
  const store = new CompanionsStore(path.join(root, 'state.sqlite'), [{ id: 'alice', name: 'Alice', description: '', persona: '核对日历边界。', model: '', avatar: 'sister', active: true, proactive: false }]);
  try {
    const conversation = store.openPrivate('alice'), scope = { companionId: 'alice', conversationId: conversation.id };
    const world = store.request({ type: 'world.snapshot' }).world!;
    store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { timeZone: test.zone, mode: 'realtime' } });
    const dates = { start: test.start, end: test.end, before: new Date(Date.parse(test.start) - 1).toISOString(), after: new Date(Date.parse(test.end) + 1).toISOString() };
    const saved = Object.fromEntries(Object.entries(dates).map(([label, occurredAt]) => {
      const source = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: `Actual source for ${label}`, replyDirective: 'none' });
      const note = store.request({ type: 'memory.record', ...scope, candidate: { artifactKind: 'episode_memory' as const, content: source.content, occurredAt, tags: [], sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: source.content }] } }).memories![0]!;
      return [label, note.id];
    }));
    const page = store.request({ type: 'memory.browse', ...scope, from: test.day, to: test.day }).memoryPage!;
    expect(page.items.map(hit => hit.memory.id).sort()).toEqual([saved.start!, saved.end!].sort());
    expect(store.request({ type: 'memory.browse', ...scope, from: test.start, to: test.start }).memoryPage!.items.map(hit => hit.memory.id)).toEqual([saved.start]);
    expect(() => store.request({ type: 'memory.browse', ...scope, from: '2026-02-31' })).toThrow('日期');
    expect(() => store.request({ type: 'memory.browse', ...scope, from: '2026-12-02', to: '2026-12-01' })).toThrow('起始');
  } finally { store.close(); await removeOwnedDirectory(root); }
});

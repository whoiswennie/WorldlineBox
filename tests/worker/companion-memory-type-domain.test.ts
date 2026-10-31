import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { companionMemoryCandidateSchema, type CompanionMemoryCandidate } from '../../src/shared/companion-memory';
import type { CompanionMemory } from '../../src/shared/companions';

const fixtures: Array<{ root: string; store: CompanionsStore }> = [];
afterEach(() => { for (const { root, store } of fixtures.splice(0)) { store.close();
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-type-domain-')) throw new Error('Unsafe fixture cleanup');
  rmSync(root, { recursive: true, force: true });
} });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-type-domain-'));
  const store = new CompanionsStore(path.join(root, 'messages.sqlite'), [{ id: 'alice', name: 'Alice', description: '', persona: '创建起点', model: '', avatar: 'sister', proactive: false, active: true }]);
  fixtures.push({ root, store }); const scope = { companionId: 'alice', conversationId: store.openPrivate('alice').id };
  const add = (artifactKind: CompanionMemory['artifactKind'], text: string, extra: Partial<CompanionMemoryCandidate> = {}) => {
    const source = store.appendMessage({ conversationId: scope.conversationId, authorId: 'alice', content: text });
    const candidate = companionMemoryCandidateSchema.parse({ artifactKind, content: text, tags: ['共同标签'], diaryName: '同名笔记本',
      sourceMessageIds: [source.id], evidence: [{ sourceMessageId: source.id, quote: text }], ...extra });
    const note = store.request({ type: 'memory.record', ...scope, candidate }).memories?.[0];
    if (!note) throw new Error('Fixture failed to create a typed note.'); return { note, source, candidate };
  };
  const index = () => { for (let i = 0; i < 20; i++) { const job = store.request({ type: 'memory.outbox.claim', companionId: scope.companionId }).memoryOutbox;
    if (!job) break; store.request({ type: 'memory.outbox.complete', id: job.id, leaseToken: job.leaseToken, indexed: true }); } };
  return { root, store, scope, add, index };
}

it('T-027/T-028 persists paged growth input debt and refuses stale generation acknowledgements', () => {
  const f = fixture();
  const add = (index: number) => f.add('self_understanding', `我在第${index}种情境先确认未知。`, {
    selfDevelopment: { kind: 'voice', topic: `情境${index}`, statement: `我在第${index}种情境先确认未知。`, basis: 'self_expression' },
  });
  for (let index = 0; index < 17; index++) add(index);
  const initial = f.store.request({ type: 'character.development.scopes.page', ...f.scope, limit: 1 }).characterDevelopmentScopes!.items[0]!;
  expect(initial.generation).toBe(17);
  const first = f.store.request({ type: 'character.development', ...f.scope, limit: 3 }).characterDevelopment!;
  expect(first.items).toHaveLength(3); expect(first.hasMore).toBe(true);
  add(17);
  expect(f.store.request({ type: 'character.development.scopes.ack', ...f.scope, expectedGeneration: initial.generation,
    nextCursor: first.nextCursor }).characterDevelopmentScopeAcknowledged).toBe(false);
  // A fresh process sees the unacknowledged debt; it does not need a new note event.
  const restarted = new CompanionsStore(path.join(f.root, 'messages.sqlite'), []);
  try {
    const seen = new Set<string>();
    for (let batch = 0; batch < 8; batch++) {
      const work = restarted.request({ type: 'character.development.scopes.page', ...f.scope, limit: 1 }).characterDevelopmentScopes!.items[0];
      if (!work) break;
      const page = restarted.request({ type: 'character.development', ...f.scope, limit: 3, ...(work.cursor ? { cursor: work.cursor } : {}) }).characterDevelopment!;
      for (const note of page.items) { expect(seen.has(note.memoryId)).toBe(false); seen.add(note.memoryId); }
      expect(restarted.request({ type: 'character.development.scopes.ack', ...f.scope, expectedGeneration: work.generation,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }).characterDevelopmentScopeAcknowledged).toBe(true);
    }
    expect(seen.size).toBe(18);
    expect(restarted.request({ type: 'character.development.scopes.page', ...f.scope }).characterDevelopmentScopes!.items).toEqual([]);
  } finally { restarted.close(); }
});

it('T-005/T-009/T-024 keeps facts, subjective understanding, navigation and fiction in explicit SQL retrieval domains', () => {
  const f = fixture();
  for (const kind of ['episode_memory', 'knowledge', 'procedure', 'self_understanding', 'navigation', 'dream_fiction'] as const) f.add(kind, `正文-${kind}`);
  f.index();
  const facts = f.store.request({ type: 'memory.snapshot', ...f.scope }).memorySnapshot!;
  expect(facts.notes.map(note => note.artifactKind).sort()).toEqual(['episode_memory', 'knowledge', 'procedure']);
  const self = f.store.request({ type: 'memory.snapshot', ...f.scope, contentKinds: ['self_understanding'] }).memorySnapshot!;
  expect(self.notes.map(note => note.artifactKind)).toEqual(['self_understanding']); expect(self.revision).not.toBe(facts.revision);
  const browse = f.store.request({ type: 'memory.browse', ...f.scope, retrievalScope: 'dream', diaryName: '同名笔记本', limit: 100 }).memoryPage!;
  expect(browse.items.map(hit => hit.memory.artifactKind)).toEqual(['dream_fiction']);
  const state = f.store.request({ type: 'memory.projection.state', ...f.scope, contentKinds: ['self_understanding'] }).memoryProjectionState!;
  const page = f.store.request({ type: 'memory.projection.page', ...f.scope, contentKinds: ['self_understanding'], expected: state, limit: 128 }).memoryProjectionPage!;
  expect(page.notes.map(note => note.artifactKind)).toEqual(['self_understanding']);
});

it('T-008/T-011 rejects cross-type consolidation and factual laundering through a self or dream dependency', () => {
  const f = fixture(), episode = f.add('episode_memory', '我实际完成了第一件事。'), knowledge = f.add('knowledge', '这是一项资料主张，不是亲历。'), self = f.add('self_understanding', '我在特定情况下更倾向先核查。'); f.index();
  const candidate = { artifactKind: 'episode_memory' as const, content: '拟整合正文', tags: ['共同标签'], sourceMessageIds: [episode.source.id, knowledge.source.id],
    evidence: [{ sourceMessageId: episode.source.id, quote: episode.source.content }, { sourceMessageId: knowledge.source.id, quote: knowledge.source.content }], relatedMemoryIds: [] };
  expect(() => f.store.request({ type: 'memory.consolidate', ...f.scope, inputs: [{ id: episode.note.id, version: episode.note.version }, { id: knowledge.note.id, version: knowledge.note.version }], candidate })).toThrow('真实经历');
  expect(() => f.store.request({ type: 'memory.record', ...f.scope, candidate: { ...self.candidate, artifactKind: 'episode_memory', relatedMemoryIds: [self.note.id] } })).toThrow('主观认识');
  expect(() => f.store.request({ type: 'memory.record', ...f.scope, candidate: { ...episode.candidate, metadata: { dream: true } } })).toThrow('虚构联想');
  expect(companionMemoryCandidateSchema.safeParse({ ...episode.candidate, artifactKind: 'unknown' }).success).toBe(false);
});

it('T-020 does not make tag maintenance a new semantic source or change the explicit kind', () => {
  const f = fixture(), episode = f.add('episode_memory', '我实际读完了这份材料。'); f.index();
  const before = f.store.request({ type: 'memory.snapshot', ...f.scope }).memorySnapshot!;
  f.store.request({ type: 'memory.organize', ...f.scope, ids: [episode.note.id], tags: ['新标签'] }); f.index();
  const after = f.store.request({ type: 'memory.snapshot', ...f.scope }).memorySnapshot!;
  expect(after.notes[0]!.artifactKind).toBe('episode_memory'); expect(after.semanticRevision).toBe(before.semanticRevision);
  expect(after.notes[0]!.sources).toEqual(before.notes[0]!.sources); expect(after.notes[0]!.contentRevision).toBe(before.notes[0]!.contentRevision);
});

it('T-013/T-018 preserves independent conditional categories and retires only the same category and topic', () => {
  const f = fixture();
  const kinds = ['preference', 'aversion', 'value', 'voice', 'self_understanding', 'worldview', 'relationship_view', 'habit', 'goal'] as const;
  const originals = kinds.map(kind => { const statement = `我在共同话题的${kind}方面会先说明条件。`;
    return f.add('self_understanding', statement, { selfDevelopment: { kind, topic: '共同话题', statement, basis: 'self_expression' } }); });
  f.index();
  const first = f.store.request({ type: 'character.development', ...f.scope, limit: 24 }).characterDevelopment!;
  expect(first.items.map(item => item.kind).sort()).toEqual([...kinds].sort());
  const statement = '我在共同话题的voice方面现在更愿意先说明未知。';
  const revised = f.add('self_understanding', statement, { selfDevelopment: { kind: 'voice', topic: '共同话题', statement, basis: 'self_expression',
    supersedesMemoryIds: [originals[3]!.note.id] } }); f.index();
  const current = f.store.request({ type: 'character.development', ...f.scope, limit: 24 }).characterDevelopment!;
  expect(current.items).toHaveLength(kinds.length); expect(current.items.find(item => item.kind === 'voice')?.memoryId).toBe(revised.note.id);
  f.store.request({ type: 'memory.forget', ...f.scope, id: revised.note.id });
  const afterForget = f.store.request({ type: 'character.development', ...f.scope, limit: 24 }).characterDevelopment!;
  expect(afterForget.items.some(item => item.memoryId === originals[3]!.note.id)).toBe(false);
  expect(afterForget.items.some(item => item.kind === 'worldview')).toBe(true);
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { CompanionsStore, type CompanionSeed, type CompanionConnection } from '../../src/companions/store';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionMemoryCandidate } from '../../src/shared/companion-memory';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

const seeds: CompanionSeed[] = ['alice', 'bob', 'carol'].map(id => ({ id, name: id, description: '', persona: '有自己的节奏。', model: '', avatar: 'sister', proactive: false, active: true }));
const fixtures: Array<{ root: string; store: CompanionsStore }> = [];
afterEach(() => { for (const { root, store } of fixtures.splice(0)) { store.close(); const resolved = path.resolve(root); if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-development-')) throw new Error('Unexpected development fixture path.'); removeOwnedDirectorySync(resolved); } });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-development-')), store = new CompanionsStore(path.join(root, 'companions.db'), seeds);
  fixtures.push({ root, store }); return { root, store, scope: { companionId: 'alice', conversationId: store.openPrivate('alice').id } };
}
function draft(message: CompanionMessage, patch: Partial<CompanionMemoryCandidate> = {}): CompanionMemoryCandidate {
  return { artifactKind: 'self_understanding' as const, content: message.content, diaryName: '自我认识', tags: ['自我认识'], sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: message.content }],
    selfDevelopment: { kind: 'preference', topic: '饮品', statement: message.content, basis: 'self_expression' }, ...patch };
}
function self(store: CompanionsStore, scope: { companionId: string; conversationId: string }, content: string) {
  return store.appendMessage({ conversationId: scope.conversationId, authorId: scope.companionId, content });
}
describe('current source-backed VCP self-understanding', () => {
  it('keeps three independent owners preferences, aversions, values and voice grounded in their own expression', () => {
    const { store, scope } = fixture();
    for (const [owner, kind, topic, content] of [
      ['alice', 'preference', '饮品', '现在我更喜欢清淡的热茶。'], ['bob', 'aversion', '饮品', '我不喜欢过甜的饮料。'],
      ['carol', 'value', '合作', '我重视先核实再向别人承诺。'], ['alice', 'voice', '交流节奏', '我愿意说得简短一些，给对方留出回应时间。'],
    ] as const) {
      const target = owner === 'alice' ? scope : { companionId: owner, conversationId: store.openPrivate(owner).id };
      const message = self(store, target, content);
      store.request({ type: 'memory.record', ...target, candidate: draft(message, { selfDevelopment: { kind, topic, statement: content, basis: 'self_expression' } }) });
      expect(store.request({ type: 'character.development', ...target }).characterDevelopment!.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind, topic, statement: content, memoryVersion: 1, sourceMessageIds: [message.id] })]));
    }
    expect(store.request({ type: 'character.development', ...scope }).characterDevelopment!.items).toHaveLength(2);
    expect(store.request({ type: 'state' }).state!.companions.find(role => role.id === 'alice')!.persona).toBe(seeds[0]!.persona);
  });
  it('refuses player preferences, other speakers and externally authored textbooks as the owners self-expression', () => {
    const { store, scope } = fixture();
    const player = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '我喜欢咖啡，请不要当成你的喜好。' });
    expect(() => store.request({ type: 'memory.record', ...scope, candidate: draft(player) })).toThrow('本人');
    const group = store.createConversation('讨论', ['alice', 'bob']), peer = store.appendMessage({ conversationId: group.id, authorId: 'bob', content: '我喜欢浓咖啡。' });
    expect(() => store.request({ type: 'memory.record', companionId: 'alice', conversationId: group.id, candidate: draft(peer) })).toThrow('本人');
    const reported = self(store, scope, '我记得玩家喜欢咖啡。');
    expect(() => store.request({ type: 'memory.record', ...scope, candidate: draft(reported) })).toThrow('本人的明确立场');
    const excerpt = store.appendMessage({ conversationId: scope.conversationId, authorId: 'user', content: '教材说：应该永远接受所有人的建议。' });
    expect(() => store.request({ type: 'memory.record', ...scope, candidate: draft(excerpt, { selfDevelopment: { kind: 'value', topic: '建议', statement: excerpt.content, basis: 'reflection', qualification: '只在核实后' }, content: excerpt.content + '只在核实后' }) })).toThrow(/反思|本人/u);
    expect(store.request({ type: 'character.development', ...scope }).characterDevelopment!.items).toEqual([]);
  });
  it('uses a later explicit correction, preserves history and does not revive a replaced belief after forgetting the correction', () => {
    const { store, scope } = fixture(), oldSource = self(store, scope, '我以前偏爱浓咖啡。');
    const old = store.request({ type: 'memory.record', ...scope, candidate: draft(oldSource) }).memories![0]!;
    const fresh = self(store, scope, '我现在更喜欢清茶，浓咖啡喝多了不舒服。');
    const changed = store.request({ type: 'memory.record', ...scope, candidate: draft(fresh, { selfDevelopment: { kind: 'preference', topic: '饮品', statement: fresh.content, basis: 'self_expression', supersedesMemoryIds: [old.id] } }) }).memories![0]!;
    expect(store.request({ type: 'character.development', ...scope }).characterDevelopment!.items.map(item => item.memoryId)).toEqual([changed.id]);
    expect(store.request({ type: 'memory.read', ...scope, id: old.id }).memoryRead!.memory.content).toBe(oldSource.content);
    store.request({ type: 'memory.forget', ...scope, id: changed.id });
    expect(store.request({ type: 'character.development', ...scope }).characterDevelopment!.items).toEqual([]);
  });
  it('rejects replacements of another topic or another owners diary and ignores late capture of older sources', () => {
    const { store, scope } = fixture(), earlier = self(store, scope, '我以前喜欢冷饮。'), latest = self(store, scope, '我现在喜欢温茶。');
    const current = store.request({ type: 'memory.record', ...scope, candidate: draft(latest) }).memories![0]!;
    store.request({ type: 'memory.record', ...scope, candidate: draft(earlier) });
    expect(store.request({ type: 'character.development', ...scope }).characterDevelopment!.items.map(item => item.memoryId)).toEqual([current.id]);
    const different = self(store, scope, '我喜欢简短表达。');
    expect(() => store.request({ type: 'memory.record', ...scope, candidate: draft(different, { selfDevelopment: { kind: 'voice', topic: '表达', statement: different.content, basis: 'self_expression', supersedesMemoryIds: [current.id] } }) })).toThrow('同一类别与主题');
    const bobScope = { companionId: 'bob', conversationId: store.openPrivate('bob').id }, bob = self(store, bobScope, '我喜欢红茶。');
    const bobNote = store.request({ type: 'memory.record', ...bobScope, candidate: draft(bob) }).memories![0]!;
    expect(() => store.request({ type: 'memory.record', ...scope, candidate: draft(different, { selfDevelopment: { kind: 'preference', topic: '饮品', statement: different.content, basis: 'self_expression', supersedesMemoryIds: [bobNote.id] } }) })).toThrow('本人旧认识');
  });
  it('does not revive a late older capture when a newer stance was recorded first and is then forgotten', () => {
    const { store, scope } = fixture(), earlier = self(store, scope, '我以前喜欢冷饮。'), latest = self(store, scope, '我现在喜欢温茶。');
    const current = store.request({ type: 'memory.record', ...scope, candidate: draft(latest) }).memories![0]!;
    const late = store.request({ type: 'memory.record', ...scope, candidate: draft(earlier) }).memories![0]!;
    expect(store.request({ type: 'character.development', ...scope }).characterDevelopment!.items.map(item => item.memoryId)).toEqual([current.id]);
    store.request({ type: 'memory.forget', ...scope, id: current.id });
    expect(store.request({ type: 'memory.read', ...scope, id: late.id }).memoryRead!.memory.content).toContain(earlier.content);
    expect(store.request({ type: 'character.development', ...scope }).characterDevelopment!.items).toEqual([]);
  });
  it('retains only an opaque retirement receipt when a private newer stance is forgotten before an older public capture arrives', () => {
    const { store, scope } = fixture(), group = store.createConversation('公开讨论', ['alice', 'bob']), groupScope = { companionId: 'alice', conversationId: group.id };
    const earlier = self(store, groupScope, '我以前喜欢冷饮。'), latest = self(store, scope, '我现在喜欢温茶，原因只在私聊说。');
    const current = store.request({ type: 'memory.record', ...scope, candidate: draft(latest) }).memories![0]!;
    store.request({ type: 'memory.forget', ...scope, id: current.id });
    store.request({ type: 'memory.record', ...groupScope, candidate: draft(earlier) });
    const privateProjection = store.request({ type: 'character.development', ...scope }).characterDevelopment!;
    const publicProjection = store.request({ type: 'character.development', ...groupScope }).characterDevelopment!;
    expect(privateProjection.items).toEqual([]); expect(publicProjection.items).toEqual([]);
    expect(JSON.stringify(publicProjection)).not.toContain('温茶'); expect(JSON.stringify(publicProjection)).not.toContain(latest.id);
    expect(store.request({ type: 'memory.sources.filter', companionId: 'bob', conversationId: group.id, ids: [latest.id] }).memorySources).toEqual([]);
    const future = self(store, groupScope, '我现在喜欢清淡的姜茶。');
    const currentAgain = store.request({ type: 'memory.record', ...groupScope, candidate: draft(future) }).memories![0]!;
    expect(store.request({ type: 'character.development', ...groupScope }).characterDevelopment!.items.map(item => item.memoryId)).toEqual([currentAgain.id]);
  });
  it('clears the opaque retirement watermark on an actual owner reset', async () => {
    const { store, scope, root } = fixture(), source = self(store, scope, '我现在喜欢温茶。');
    store.request({ type: 'memory.record', ...scope, candidate: draft(source) });
    const Database = BetterSqlite3 as { new(filename: string): CompanionConnection }, db = new Database(path.join(root, 'companions.db'));
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM companion_character_retirement_watermarks WHERE companion_id=?').get('alice') as { n: number }).n).toBe(1);
      const started = store.request({ type: 'companion.retire', id: 'alice', scope: 'all', expectedRevision: store.state().companions.find(companion => companion.id === 'alice')!.revision! }).reset!;
      store.request({ type: 'companion.retire.cleanup', id: 'alice', jobId: started.id });
      for (let step = 0; step < 300 && store.request({ type: 'companion.retire.status', id: 'alice' }).reset?.status !== 'completed'; step++) await store.advanceReset();
      expect(store.request({ type: 'companion.retire.status', id: 'alice' }).reset?.status).toBe('completed');
      expect((db.prepare('SELECT COUNT(*) AS n FROM companion_character_retirement_watermarks WHERE companion_id=?').get('alice') as { n: number }).n).toBe(0);
    } finally { db.close(); }
  });
  it('preserves a qualified reflection, invalidates it with the contributing source, and never projects dreams', () => {
    const { store, scope } = fixture(), source = self(store, scope, '我这次先备份，再实际修好了保存问题。');
    const learned = store.request({ type: 'memory.record', ...scope, candidate: { ...draft(source), artifactKind: 'episode_memory' as const, selfDevelopment: undefined, diaryName: '日记' } }).memories![0]!;
    const statement = '我愿意优先保留可恢复副本。', qualification = '这是本次修复带来的暂定认识，不保证适合所有故障。';
    const reflection = { ...draft(source), content: statement + qualification, relatedMemoryIds: [learned.id], selfDevelopment: { kind: 'value' as const, topic: '可恢复性', statement, basis: 'reflection' as const, qualification } };
    const note = store.request({ type: 'memory.record', ...scope, candidate: reflection }).memories![0]!;
    expect(store.request({ type: 'character.development', ...scope }).characterDevelopment!.items[0]).toMatchObject({ memoryId: note.id, basis: 'reflection', qualification });
    expect(() => store.request({ type: 'memory.record', ...scope, candidate: { ...reflection, metadata: { dream: true } } })).toThrow('虚构');
    store.request({ type: 'memory.forget', ...scope, id: learned.id });
    expect(store.request({ type: 'character.development', ...scope }).characterDevelopment!.items).toEqual([]);
  });
  it('does not leak private self-understanding into a group and obeys historical source cutoffs', () => {
    const { store, scope } = fixture(), privateSource = self(store, scope, '我喜欢安静读书，背后原因只在私聊谈。');
    store.request({ type: 'memory.record', ...scope, candidate: draft(privateSource) });
    const group = store.createConversation('公开讨论', ['alice', 'bob']), groupScope = { companionId: 'alice', conversationId: group.id };
    expect(store.request({ type: 'character.development', ...groupScope }).characterDevelopment!.items).toEqual([]);
    const shared = self(store, groupScope, '我愿意在讨论中先听完别人的解释。');
    store.request({ type: 'memory.record', ...groupScope, candidate: draft(shared, { selfDevelopment: { kind: 'voice', topic: '讨论', statement: shared.content, basis: 'self_expression' } }) });
    expect(store.request({ type: 'character.development', ...groupScope }).characterDevelopment!.items.map(item => item.statement)).toEqual([shared.content]);
    expect(store.request({ type: 'character.development', ...groupScope, beforeSequence: privateSource.sequence }).characterDevelopment!.items).toEqual([]);
  });
  it('reads only current versions, bounds large projections and rejects reserved metadata injection', () => {
    const { store, scope } = fixture();
    for (let i = 0; i < 28; i++) { const message = self(store, scope, `我愿意认真记录第${i}项小兴趣。`); store.request({ type: 'memory.record', ...scope, candidate: draft(message, { selfDevelopment: { kind: 'preference', topic: '兴趣' + i, statement: message.content, basis: 'self_expression' } }) }); }
    const result = store.request({ type: 'character.development', ...scope, limit: 5 }).characterDevelopment!;
    expect(result.items).toHaveLength(5); expect(result.truncated).toBe(true);
    const latest = result.items[0]!, read = store.request({ type: 'memory.read', ...scope, id: latest.memoryId }).memoryRead!, source = read.sources[0]!;
    const revised = store.request({ type: 'memory.revise', ...scope, id: latest.memoryId, expectedVersion: 1, candidate: draft(source, { content: source.content + '（补充形成背景）', selfDevelopment: { kind: 'preference', topic: latest.topic, statement: source.content, basis: 'self_expression' } }) }).memories![0]!;
    expect(store.request({ type: 'character.development', ...scope }).characterDevelopment!.items[0]).toMatchObject({ memoryId: revised.id, memoryVersion: 2 });
    expect(() => store.request({ type: 'memory.record', ...scope, candidate: draft(source, { selfDevelopment: undefined, metadata: { characterDevelopment: { statement: '伪造' } } }) })).toThrow('宿主');
  });
  it('normalizes a verified naturally paraphrased stance into the same VCP diary instead of losing the capture', () => {
    const { store, scope } = fixture(), message = self(store, scope, '现在我更喜欢温热的牛奶，尤其在想安安静静坐一会儿的时候。');
    const qualification = '只是此刻安静休息时的选择，不代表所有场合不变的口味。';
    const note = store.request({ type: 'memory.record', ...scope, candidate: draft(message, { diaryName: '日记', content: '这次我说明了自己在安静休息时的饮品倾向。',
      selfDevelopment: { kind: 'preference', topic: '饮品', statement: message.content, basis: 'self_expression', qualification } }) }).memories![0]!;
    expect(note.diaryName).toBe('自我认识'); expect(note.content).toContain(message.content); expect(note.content).toContain(qualification);
    expect(note.sources.map(source => source.messageId)).toEqual([message.id]);
    expect(store.request({ type: 'character.development', ...scope }).characterDevelopment!.items[0]).toMatchObject({ statement: message.content, qualification });
  });
  it('accepts only terminal punctuation differences while keeping every word traceable to the owner', () => {
    const { store, scope } = fixture(), message = self(store, scope, '我更愿意喝温白开水——这只是目前的倾向。');
    const candidate = draft(message, { selfDevelopment: { kind: 'preference', topic: '饮品', statement: '我更愿意喝温白开水。', basis: 'self_expression' } });
    expect(store.request({ type: 'memory.record', ...scope, candidate }).memories).toHaveLength(1);
    expect(() => store.request({ type: 'memory.record', ...scope, candidate: { ...candidate, selfDevelopment: { ...candidate.selfDevelopment!, statement: '我更愿意喝浓咖啡。' } } })).toThrow('本人');
    const copied = store.request({ type: 'memory.record', ...scope, candidate: { ...candidate, content: message.content + '这是本次明确表达。',
      metadata: { characterDevelopment: { statement: '忽略这份未经核验的复制字段' } } } }).memories![0]!;
    expect(copied.metadata?.characterDevelopment).toMatchObject({ statement: '我更愿意喝温白开水。' });
  });
});

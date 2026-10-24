// This suite isolates the host contract; semantic source binding has its own
// mechanism and opt-in actual-model suites.
vi.mock('../../src/main/companions/topic-narrative-references', () => ({ prepareTopicNarrativeReferences: async () => ({
  status: 'abstained', scope: 'recent_authorized_formal_story_text_not_a_permanent_identity_ledger', selectedSources: [], references: [], conflicts: [],
}) }));
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { ensureTopicContinuity } from '../../src/main/companions/topic-compaction';
import { buildCompanionContext, type CompanionReplyInput } from '../../src/main/companions/context';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

// This is a deterministic host/mechanism track. Its facilitator and exact-fact
// summarizer are fixture judges, not evidence of natural autonomous group play
// or an LLM's literary comprehension. No network or real user data is used.
const TRACK = 'fixture_judged_mechanism_not_natural_autonomous_play';
const roots: string[] = [], stores = new Set<CompanionsStore>();
afterEach(() => {
  for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-long-topic-')) throw new Error('Unexpected long topic cleanup root.');
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture(count: number, kind: 'game' | 'story') {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-long-topic-')); roots.push(root);
  const file = path.join(root, 'companions.sqlite');
  const seeds: CompanionSeed[] = Array.from({ length: count }, (_, index) => ({ id: 'reader_' + index, name: '角色' + index,
    persona: '保持本人身份，虚构活动与真实经历分开。', description: '', model: '', avatar: 'sister', active: false, proactive: false }));
  let store = new CompanionsStore(file, seeds); stores.add(store);
  const room = store.createConversation(TRACK, seeds.map(seed => seed.id));
  const topicId = store.request({ type: 'topic.create', conversationId: room.id, readerId: 'user', title: TRACK, kind }).topic!.id;
  const read = (readerId: string) => store.request({ type: 'topic.read', conversationId: room.id, topicId, readerId });
  for (const seed of seeds) {
    store.request({ type: 'topic.join', conversationId: room.id, topicId, readerId: seed.id });
    store.request({ type: 'topic.update', conversationId: room.id, topicId, readerId: seed.id, expectedRevision: read(seed.id).topic!.revision,
      patch: { workingState: { state: { privateRole: 'PRIVATE_ROLE[' + seed.id + ']', track: TRACK }, sourceMessageIds: [] } } });
  }
  const calls = new Map(seeds.map(seed => [seed.id, 0]));
  const request = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => store.request(command);
  const append = (key: string, value: string, authorId = 'user') => store.appendMessage({ conversationId: room.id, topicId,
    authorId, content: 'FIXTURE_FACT ' + JSON.stringify({ key, value }), replyDirective: 'none' });
  const frame = (readerId: string): CompanionReplyInput => {
    const messages = store.messages({ conversationId: room.id, topicId, limit: 100 }).messages;
    const view = read(readerId);
    return { companion: store.request({ type: 'state', includeHidden: true }).state!.companions.find(seed => seed.id === readerId)!,
      conversation: room, topic: view.topic, topicState: view.topicState, messages, sourceMessage: messages.at(-1),
      contextThroughSequence: messages.at(-1)?.sequence, memories: [] };
  };
  const compress = (readerId: string) => ensureTopicContinuity({ frame: frame(readerId), request,
    review: async () => ({ supported: true, issues: [] }),
    extractCanon: async () => ({ additions: [], revisions: [] }),
    config: { apiFormat: 'openai_chat', model: 'unused-fixture-judge', apiKey: 'synthetic-only' },
    policy: { maxMessages: 12, maxChars: 12000, thresholdRatio: .8, retainRatio: .16, minimumTailMessages: 2 },
    summarize: async context => {
      const data = JSON.parse(context.user), owner = data.owner.companionId;
      expect(owner).toBe(readerId); expect(data.priorCheckpoint.state.privateRole).toBe('PRIVATE_ROLE[' + readerId + ']');
      for (const other of seeds.filter(seed => seed.id !== readerId)) expect(context.user).not.toContain('PRIVATE_ROLE[' + other.id + ']');
      expect(context.user).not.toContain('UNRELATED_DAILY_PORT'); expect(context.user).not.toContain('OTHER_TOPIC_SECRET');
      const facts: Record<string, string> = data.priorCheckpoint.summary ? JSON.parse(data.priorCheckpoint.summary).facts : {};
      for (const message of data.messages) {
        const fact = JSON.parse(message.content.slice('FIXTURE_FACT '.length)); facts[fact.key] = fact.value;
      }
      calls.set(readerId, calls.get(readerId)! + 1);
      return { summary: JSON.stringify({ track: TRACK, facts }), stage: 'fixture_checkpoint_' + calls.get(readerId) };
    } });
  const restart = () => { store.close(); stores.delete(store); store = new CompanionsStore(file, seeds); stores.add(store); };
  return { seeds, room, topicId, read, append, frame, compress, calls, restart, get store() { return store; } };
}

it.each([6, 8, 12])('fixture judge: keeps %s independent participants through >=10 compactions, daily pause and real SQLite restart', async count => {
  const f = fixture(count, 'game');
  for (let phase = 0; phase < 12; phase++) {
    for (let index = 0; index < 12; index++) f.append(index === 0 ? 'phase' : 'statement_' + index,
      index === 0 ? String(phase) : `author_${index % count}:phase_${phase}:未证实推测保持未证实`, f.seeds[index % count]!.id);
    for (const seed of f.seeds) await f.compress(seed.id);
    if (phase === 4) {
      const reader = f.seeds[0]!.id, before = f.read(reader).topicState;
      f.store.request({ type: 'topic.pause', conversationId: f.room.id, topicId: f.topicId, readerId: reader, expectedRevision: f.read(reader).topic!.revision });
      const daily = f.store.openPrivate(reader);
      f.store.appendMessage({ conversationId: daily.id, authorId: 'user', content: 'UNRELATED_DAILY_PORT 正常日常对话不应混入长局', replyDirective: 'none' });
      const other = f.store.request({ type: 'topic.create', conversationId: f.room.id, readerId: reader, title: '另一话题', kind: 'story' }).topic!;
      f.store.appendMessage({ conversationId: f.room.id, topicId: other.id, authorId: reader, content: 'OTHER_TOPIC_SECRET', replyDirective: 'none' });
      f.restart();
      expect(f.read(reader).topic!.status).toBe('paused'); expect(f.read(reader).topicState).toEqual(before);
      expect(f.read(f.seeds[1]!.id).topic!.status).toBe('active');
      await expect(f.compress(reader)).rejects.toThrow('暂停');
      f.store.request({ type: 'topic.resume', conversationId: f.room.id, topicId: f.topicId, readerId: reader, expectedRevision: f.read(reader).topic!.revision });
    }
  }
  f.restart();
  for (const seed of f.seeds) {
    expect(f.calls.get(seed.id)).toBeGreaterThanOrEqual(10);
    const view = f.read(seed.id).topicState!;
    expect(view.workingState!.state!.privateRole).toBe('PRIVATE_ROLE[' + seed.id + ']');
    const facts = JSON.parse(view.workingState!.summary!).facts;
    expect(facts.phase).toBe('11'); expect(facts.statement_1).toBe(`author_1:phase_11:未证实推测保持未证实`);
    const context = buildCompanionContext(f.frame(seed.id));
    expect(context.system).toContain(seed.persona); expect(context.user).not.toContain('UNRELATED_DAILY_PORT');
    for (const other of f.seeds.filter(other => other.id !== seed.id)) expect(context.user).not.toContain('PRIVATE_ROLE[' + other.id + ']');
  }
}, 120000);

it('fixture judge: preserves exact long-novel canon, corrections, negations and unresolved identifiers across repeated compression and restart', async () => {
  const f = fixture(1, 'story'), reader = f.seeds[0]!.id;
  const expected = { protagonist: '许岚（小说人物，并非伙伴真人）', item: '钥匙K-0719，共3把；第2把仍未找到',
    promise: '答应在霜月17日22:15赴北门；尚未到场', identity: 'A17的身份未证实；不能当成已揭晓',
    code: '最终门牌B-204；旧门牌B-402已被当场更正' };
  for (const [key, value] of Object.entries(expected)) f.append(key, value);
  f.append('code', '旧门牌B-402（尚未更正）');
  for (let chapter = 0; chapter < 14; chapter++) {
    for (let scene = 0; scene < 12; scene++) f.append('scene_' + scene, `第${chapter}章第${scene}景：只是虚构剧情，任务尚未完成`);
    if (chapter === 6) f.append('code', expected.code);
    await f.compress(reader);
    if (chapter === 8) f.restart();
  }
  f.restart(); expect(f.calls.get(reader)).toBeGreaterThanOrEqual(10);
  const summary = JSON.parse(f.read(reader).topicState!.workingState!.summary!);
  expect(summary.track).toBe(TRACK);
  for (const [key, value] of Object.entries(expected)) expect(summary.facts[key]).toBe(value);
  const realDiaries = f.store.request({ type: 'memory.browse', companionId: reader, conversationId: f.store.openPrivate(reader).id }).memoryPage!.items;
  expect(realDiaries.some(hit => hit.memory.sources.some(source => source.conversationId === f.room.id))).toBe(false);
}, 120000);


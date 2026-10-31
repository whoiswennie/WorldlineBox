import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { guardCompanionExecutionSources, withCompanionExecutionValidation, type CompanionExecutionSourceProof } from '../../src/main/companions/source-execution-evidence';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionStorageCommand } from '../../src/shared/companion-storage';
import { companionSearchTokens, companionSearchFacet } from '../../src/shared/companion-search';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
let root: string, store: CompanionsStore;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'attested-dag-'));
  store = new CompanionsStore(path.join(root, 'state.sqlite'), ['alice', 'bob'].map(id => ({ id, name: id, description: '', persona: '核对来源', model: '', avatar: 'sister', active: true, proactive: false }))); });
afterEach(() => { store.close(); removeOwnedDirectorySync(root); });

function corpus(count: number, group = false) {
  const conversation = group ? store.createConversation('群范围', ['alice', 'bob']) : store.openPrivate('alice'), scope = { companionId: 'alice', conversationId: conversation.id };
  const source = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: '本次真实输入', replyDirective: 'none' });
  const messages: CompanionMessage[] = [];
  for (let n = 0; n < count; n++) {
    const dependencies = [source, ...messages.slice(-2)];
    const bubble = store.appendMessage({ conversationId: conversation.id, authorId: 'alice', content: '', loopStep: 0 });
    const readset = captureCompanionExecutionReadset(scope, { sources: dependencies.map(message => ({ id: message.id, conversationId: message.conversationId, checksum: hash(message.content) })) });
    store.request({ type: 'loop.save', checkpoint: { ...scope, invocationKey: 'task_' + n, sourceMessageId: source.id, messageId: bubble.id, status: 'done',
      turns: [{ text: '实际答复 ' + n, rawText: '实际答复 ' + n, calls: [] }], supplements: [] }, executionReadset: readset });
    messages.push(store.request({ type: 'message.get', id: bubble.id }).message!);
  }
  const file = path.join(root, 'canonical.txt'); writeFileSync(file, '实际正式正文');
  return { scope, source, messages, file };
}

it('checks each real persisted DAG node once while world.tick repeatedly advances the global mutation generation', async () => {
  const f = corpus(12), identity = {}, validIds = new Set<string>(); let generation = 0, fileReads = 0, ticks = 0;
  const storage = async (command: CompanionStorageCommand) => store.request(command);
  const read = async (id: string) => guardCompanionExecutionSources({ type: 'message.get', id }, store.request({ type: 'message.get', id }), {
    storage, identity, revision: () => generation, valid,
  });
  const valid = async (proof: CompanionExecutionSourceProof, sqlite?: boolean): Promise<boolean> => {
    expect(sqlite).toBe(true); expect(proof.storageValidatedAuthorityEpoch).toBeTypeOf('number');
    if (++fileReads > f.messages.length) throw new Error('A background world write repeatedly expanded an already-attested file DAG');
    expect(validIds.has(proof.id)).toBe(false); validIds.add(proof.id);
    expect(readFileSync(f.file, 'utf8')).toBe('实际正式正文');
    generation++; expect(store.request({ type: 'world.tick', snapshot: false }).ok).toBe(true); generation++; ticks++;
    for (const dependency of proof.executionReadset!.sources.filter(reference => reference.id !== f.source.id)) {
      const checked = await read(dependency.id); if (checked.message?.content !== f.messages.find(message => message.id === dependency.id)?.content) return false;
    }
    return true;
  };
  await withCompanionExecutionValidation(async () => {
    expect((await read(f.messages.at(-1)!.id)).message?.content).toBe(f.messages.at(-1)!.content);
    expect((await read(f.messages.at(-2)!.id)).message?.content).toBe(f.messages.at(-2)!.content);
  });
  expect(fileReads).toBe(12); expect(ticks).toBe(12);
  // The next independent operation still reopens canonical bytes.
  fileReads = 0; validIds.clear();
  await read(f.messages.at(-1)!.id); expect(fileReads).toBe(12);
});

it('does not reuse a healthy cached proof after an actual source forget in the same read operation', async () => {
  const f = corpus(1), id = f.messages[0]!.id; let generation = 0, checks = 0;
  const read = () => guardCompanionExecutionSources({ type: 'message.get', id }, store.request({ type: 'message.get', id }), {
    storage: async command => store.request(command), revision: () => generation,
    valid: async () => { checks++; return (store.request({ type: 'memory.sources.filter', ...f.scope, ids: [f.source.id] }).memorySources?.length ?? 0) === 1; },
  });
  await withCompanionExecutionValidation(async () => {
    expect((await read()).message?.content).toBe(f.messages[0]!.content);
    generation++; store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.source.id] }); generation++;
    expect((await read()).message?.content).not.toBe(f.messages[0]!.content);
  });
  expect(checks).toBeGreaterThan(1);
});

it('rechecks fresh SQL attestations after an external connection rewrites source bytes without a Main mutation event', async () => {
  const f = corpus(1), id = f.messages[0]!.id, external = new (Database as { new(filename: string): CompanionConnection })(path.join(root, 'state.sqlite')); let checks = 0;
  external.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
  external.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  const read = () => guardCompanionExecutionSources({ type: 'message.get', id }, store.request({ type: 'message.get', id }), {
    storage: async command => store.request(command), revision: () => 0,
    valid: async () => { checks++; return store.request({ type: 'memory.sources.filter', ...f.scope, ids: [f.source.id] }).memorySources?.[0]?.content === f.source.content; },
  });
  try {
    await withCompanionExecutionValidation(async () => {
      expect((await read()).message?.content).toBe(f.messages[0]!.content);
      external.prepare('UPDATE messages SET content=? WHERE id=?').run('从独立连接改写的内容', f.source.id);
      expect((await read()).message?.content).not.toBe(f.messages[0]!.content);
    });
    expect(checks).toBeGreaterThan(1);
  } finally { external.close(); }
});

it('does not reuse a cached proof after its owner leaves the actual source conversation', async () => {
  const f = corpus(1, true), id = f.messages[0]!.id; let checks = 0;
  const read = () => guardCompanionExecutionSources({ type: 'message.get', id }, store.request({ type: 'message.get', id }), {
    storage: async command => store.request(command), revision: () => 0,
    valid: async () => { checks++; try { return store.request({ type: 'memory.sources.filter', ...f.scope, ids: [f.source.id] }).memorySources?.[0]?.content === f.source.content; }
      catch { return false; } },
  });
  await withCompanionExecutionValidation(async () => {
    expect((await read()).message?.content).toBe(f.messages[0]!.content);
    store.updateConversation(f.scope.conversationId, { memberIds: ['bob'] });
    expect((await read()).message?.content).not.toBe(f.messages[0]!.content);
  });
  expect(checks).toBeGreaterThan(1);
});

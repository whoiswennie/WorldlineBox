import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';
import { createCompanionExecutionValidationSession, guardCompanionExecutionSources } from '../../src/main/companions/source-execution-evidence';
import { readCompanionSourceSnapshot } from '../../src/main/companions/source-headers';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
function fixture() {
  const f = managedMemoryFiles(); fixtures.push(f);
  const sql = (operation: (db: CompanionConnection) => void) => {
    const db = new (Database as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
    db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens); db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
    try { operation(db); } finally { db.close(); }
  };
  const storage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => f.store.request(command)), identity = {};
  const request = (command: CompanionStorageCommand) => guardCompanionExecutionSources(command, f.store.request(command), { storage, identity, revision: () => 0, valid: async () => true });
  return { f, sql, storage, request };
}

it('reuses over one old DTO batch of actually read text after one authorized header query and keeps a fresh final header fence', async () => {
  const h = fixture(), messages = Array.from({ length: 104 }, (_, index) => h.f.source('准确原文 ' + index));
  const getMessage = vi.spyOn(h.f.store, 'getMessage'), commands: CompanionStorageCommand[] = [], session = createCompanionExecutionValidationSession();
  const request = async (command: CompanionStorageCommand) => { commands.push(command); return h.request(command); };
  try {
    const actual = await session.run(() => readCompanionSourceSnapshot(h.f.scope, messages, request));
    expect([...actual.values()]).toEqual(messages); expect(actual.get(messages[0]!.id)).toBe(messages[0]);
    expect(commands.filter(command => command.type === 'memory.sources.headers')).toHaveLength(1);
    expect(commands.some(command => command.type === 'memory.sources.filter')).toBe(false); expect(getMessage).not.toHaveBeenCalled();
    await session.validate();
    expect(h.storage.mock.calls.some(([command]) => command.type === 'memory.sources.headers')).toBe(true);
  } finally { getMessage.mockRestore(); session.close(); }
});

it('reads fresh full bytes for a changed snapshot and never falls back to a denied or missing source', async () => {
  const h = fixture(), original = h.f.source('旧正文。'), denied = h.f.source('随后忘记。');
  h.sql(db => db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('当前新正文。', original.id));
  h.f.store.request({ type: 'memory.forget', ...h.f.scope, sourceMessageIds: [denied.id] });
  const commands: CompanionStorageCommand[] = [], request = async (command: CompanionStorageCommand) => { commands.push(command); return h.request(command); };
  const actual = await readCompanionSourceSnapshot(h.f.scope, [original, denied], request);
  expect(actual.get(original.id)?.content).toBe('当前新正文。'); expect(actual.has(denied.id)).toBe(false);
  expect(commands.filter(command => command.type === 'memory.sources.filter')).toEqual([{ type: 'memory.sources.filter', ...h.f.scope, ids: [original.id] }]);
});

it.each(['revision', 'body', 'topic', 'membership'] as const)('rejects a fresh %s change after header admission before any downstream publication', async mutation => {
  const h = fixture(), original = h.f.source('已读取的准确原文。'), session = createCompanionExecutionValidationSession();
  try {
    expect((await session.run(() => readCompanionSourceSnapshot(h.f.scope, [original], h.request))).get(original.id)).toBe(original);
    h.sql(db => {
      if (mutation === 'revision') db.prepare('UPDATE messages SET revision=revision+1 WHERE id=?').run(original.id);
      else if (mutation === 'body') db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('外部改写。', original.id);
      else if (mutation === 'membership') db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND companion_id=?').run(original.conversationId, 'alice');
      else db.prepare('DELETE FROM companion_message_topics WHERE message_id=?').run(original.id);
    });
    if (mutation === 'topic' && original.topicId === undefined) {
      // No topic mapping existed: create a different real topic and bind it.
      const topic = h.f.store.request({ type: 'topic.create', conversationId: original.conversationId, readerId: 'alice', kind: 'discussion', title: '新的来源域' }).topic!;
      h.sql(db => db.prepare('INSERT OR REPLACE INTO companion_message_topics(message_id,topic_id) VALUES(?,?)').run(original.id, topic.id));
    }
    await expect(session.validate()).rejects.toThrow();
  } finally { session.close(); }
});

it.each(['kind-only', 'versioned'] as const)('preserves the %s predicate across an ordinary annotation-only version change', async mode => {
  const h = fixture(), source = h.f.source('这条事实不变。'), note = h.f.record('原始记忆正文不变。', [source.id]), session = createCompanionExecutionValidationSession();
  const command: CompanionStorageCommand = { type: 'memory.references.validate', groups: [{ ...h.f.scope, sources: [], memories: [{ id: note.id,
    artifactKinds: ['episode_memory'], ...(mode === 'versioned' ? { version: note.version } : {}) }] }] };
  try {
    expect((await session.run(() => h.request(command))).memoryReferenceValidation?.groups[0]?.valid).toBe(true);
    h.sql(db => db.prepare("UPDATE vcp_memory_notes SET data=json_set(data,'$.version',json_extract(data,'$.version')+1,'$.annotationRevision',2,'$.tags',json('[\"updated\"]')) WHERE id=?").run(note.id));
    if (mode === 'kind-only') await expect(session.validate()).resolves.toBeUndefined();
    else await expect(session.validate()).rejects.toThrow();
  } finally { session.close(); }
});

it('rejects a kind change despite allowing annotation revisions', async () => {
  const h = fixture(), source = h.f.source('现实事实。'), note = h.f.record('不能变成虚构。', [source.id]), session = createCompanionExecutionValidationSession();
  const command: CompanionStorageCommand = { type: 'memory.references.validate', groups: [{ ...h.f.scope, sources: [], memories: [{ id: note.id, artifactKinds: ['episode_memory'] }] }] };
  try {
    expect((await session.run(() => h.request(command))).memoryReferenceValidation?.groups[0]?.valid).toBe(true);
    h.sql(db => db.prepare("UPDATE vcp_memory_notes SET data=json_set(data,'$.artifactKind','dream_fiction') WHERE id=?").run(note.id));
    await expect(session.validate()).rejects.toThrow();
  } finally { session.close(); }
});

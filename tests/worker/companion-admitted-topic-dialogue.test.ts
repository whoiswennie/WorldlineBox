import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionReplyInput } from '../../src/main/companions/context';
import { admitCompanionTopicDialogue, prepareTopicContinuity } from '../../src/main/companions/topic-compaction';
import { createCompanionExecutionValidationSession, guardCompanionExecutionSources } from '../../src/main/companions/source-execution-evidence';
import { companionSourceHeaderMatchesMessage, companionSourceHeaderResult } from '../../src/main/companions/source-headers';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });

function fixture(attachmentCount = 0) {
  const f = managedMemoryFiles(); fixtures.push(f);
  const attached = Array.from({ length: attachmentCount }, (_, index) => {
    const id = `actual-dialogue-attachment-${index}`, content = `实际附件 ${index}。`;
    mkdirSync(path.join(f.root, 'attachments'), { recursive: true }); writeFileSync(path.join(f.root, 'attachments', `${id}.txt`), content);
    f.store.request({ type: 'attachment.register', stored: { attachment: { id, name: `${id}.txt`, mime: 'text/plain', size: Buffer.byteLength(content) },
      relativePath: `attachments/${id}.txt` } });
    return f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'user', content: `原有附件消息 ${index}。`, attachmentIds: [id], replyDirective: 'none' });
  });
  const source = f.source('准确的本轮请求。'), scope = { ...f.scope, beforeSequence: source.sequence };
  const loaded = f.store.request({ type: 'topic.read', conversationId: source.conversationId, topicId: source.topicId!, readerId: 'alice' });
  const state = f.store.request({ type: 'state', includeHidden: true }).state!;
  const frame: CompanionReplyInput = { companion: state.companions.find(owner => owner.id === 'alice')!,
    conversation: state.conversations.find(room => room.id === f.scope.conversationId)!, messages: [...attached, source], sourceMessage: source,
    memories: [], topic: loaded.topic!, topicState: loaded.topicState! };
  const storage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => f.store.request(command));
  const identity = {};
  const request = vi.fn((command: CompanionStorageCommand) => guardCompanionExecutionSources(command, f.store.request(command), {
    storage, identity, revision: () => 0, valid: async () => { throw new Error('A raw user source has no derived proof.'); },
  }));
  const sql = (operation: (db: CompanionConnection) => void) => {
    const db = new (Database as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite'));
    db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
    db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
    try { operation(db); } finally { db.close(); }
  };
  const admit = async (current = frame, beforeSequence = scope.beforeSequence) => {
    const ids = [...new Set([...current.messages, current.sourceMessage!].map(message => message.id))];
    const command = { type: 'memory.sources.headers' as const, ...scope, beforeSequence, ids };
    const response = await request(command), headers = companionSourceHeaderResult(ids, response);
    if (!headers) throw new Error('The real Store did not return source headers.');
    const actual = new Map([...current.messages, current.sourceMessage!].map(message => [message.id, message]));
    const fallbackIds = ids.filter(id => headers.unsupportedIds.includes(id) || !headers.headers.some(header => header.id === id && companionSourceHeaderMatchesMessage(header, actual.get(id)!)));
    const acquiredFallbackMessages = fallbackIds.length ? (await request({ type: 'memory.sources.filter', ...scope, beforeSequence, ids: fallbackIds })).memorySources : undefined;
    return admitCompanionTopicDialogue({ frame: current, scope: { ...scope, beforeSequence }, sourceIds: ids, sourceHeaders: headers,
      acquiredFallbackMessages, identity, requestFresh: storage, taskKey: createHash('sha256').update(source.id).digest('hex') });
  };
  const config = { apiFormat: 'openai_chat' as const, model: 'unused-real-store-test', apiKey: 'unused-fixture-key' };
  return { f, source, scope, frame, attached, storage, request, identity, sql, admit, config };
}

it('reuses a mixed dialogue only after acquiring its three real attachment DTOs and freshly checks only those IDs at final', async () => {
  const h = fixture(3), gate = createCompanionExecutionValidationSession();
  try {
    await gate.run(async () => {
      const token = await h.admit(); expect(token).toBeDefined();
      const before = h.request.mock.calls.length;
      const result = await prepareTopicContinuity({ frame: h.frame, admittedDialogueInput: token, request: h.request, config: h.config });
      expect(result.messages).toEqual(h.frame.messages);
      expect(h.request.mock.calls.slice(before).map(([command]) => command.type)).toEqual(['topic.compaction.enqueue']);
    });
    expect(h.request.mock.calls.filter(([command]) => command.type === 'memory.sources.filter').map(([command]) => command.type === 'memory.sources.filter' && command.ids))
      .toEqual([h.attached.map(message => message.id)]);
    await gate.validate();
    const final = h.storage.mock.calls.flatMap(([command]) => command.type === 'memory.sources.filter' ? [command] : []);
    expect(final).toEqual([{ type: 'memory.sources.filter', ...h.scope, ids: h.attached.map(message => message.id) }]);
    expect(h.storage.mock.calls.filter(([command]) => command.type === 'topic.read')).toHaveLength(1);
  } finally { gate.close(); }
});

it.each(['attachment', 'body', 'membership'] as const)('rejects a real mixed-dialogue %s change after full DTO acquisition', async mutation => {
  const h = fixture(3), gate = createCompanionExecutionValidationSession();
  try {
    await gate.run(async () => {
      const token = await h.admit(); expect(token).toBeDefined();
      await prepareTopicContinuity({ frame: h.frame, admittedDialogueInput: token, request: h.request, config: h.config });
    });
    if (mutation === 'attachment') h.sql(db => db.prepare("UPDATE attachments SET data=json_set(data,'$.name',?) WHERE id=?")
      .run('真实附件已被替换.txt', h.attached[0]!.attachments[0]!.id));
    if (mutation === 'body') h.sql(db => db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('附件消息原文已改。', h.attached[0]!.id));
    if (mutation === 'membership') h.sql(db => db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND companion_id=?').run(h.scope.conversationId, 'alice'));
    await expect(gate.validate()).rejects.toThrow();
  } finally { gate.close(); }
});

it('does not attest an attachment from a header or accept a different audience in the acquired DTO', async () => {
  const h = fixture(3), gate = createCompanionExecutionValidationSession();
  try {
    await gate.run(async () => {
      const ids = [...h.frame.messages.map(message => message.id)];
      const headers = companionSourceHeaderResult(ids, await h.request({ type: 'memory.sources.headers', ...h.scope, ids }))!;
      const input = { frame: h.frame, scope: h.scope, sourceIds: ids, sourceHeaders: headers, identity: h.identity,
        requestFresh: h.storage, taskKey: createHash('sha256').update(h.source.id).digest('hex') };
      expect(await admitCompanionTopicDialogue(input)).toBeUndefined();
      const acquired = (await h.request({ type: 'memory.sources.filter', ...h.scope, ids: h.attached.map(message => message.id) })).memorySources!;
      expect(await admitCompanionTopicDialogue({ ...input, acquiredFallbackMessages: acquired.map((message, i) => i ? message : { ...message, audience: 'agenda' }) })).toBeUndefined();
    });
  } finally { gate.close(); }
});

it('reuses the exact admitted ordinary input and keeps real final source and topic queries', async () => {
  const h = fixture(), gate = createCompanionExecutionValidationSession();
  try {
    const result = await gate.run(async () => {
      const token = await h.admit(); expect(token).toBeDefined();
      const before = h.request.mock.calls.length;
      const result = await prepareTopicContinuity({ frame: h.frame, admittedDialogueInput: token, request: h.request, config: h.config });
      expect(h.request.mock.calls.slice(before).map(([command]) => command.type)).toEqual(['topic.compaction.enqueue']);
      return result;
    });
    expect(result.messages).toEqual(h.frame.messages);
    expect(h.storage.mock.calls.some(([command]) => command.type === 'topic.read')).toBe(false);
    await gate.validate();
    expect(h.storage.mock.calls.filter(([command]) => command.type === 'topic.read')).toHaveLength(1);
    expect(h.storage.mock.calls.filter(([command]) => command.type === 'memory.sources.headers')).toHaveLength(1);
  } finally { gate.close(); }
});

it('retains this task checkpoint when a newer legitimate shared checkpoint is published before the final fence', async () => {
  const h = fixture(), gate = createCompanionExecutionValidationSession();
  h.f.store.request({ type: 'topic.update', conversationId: h.scope.conversationId, topicId: h.frame.topic!.id, readerId: 'user',
    expectedRevision: h.frame.topic!.revision, patch: { shared: { summary: '原已读取阶段。', sourceMessageIds: [h.source.id] } } });
  const loaded = h.f.store.request({ type: 'topic.read', conversationId: h.scope.conversationId, topicId: h.frame.topic!.id, readerId: 'alice' });
  h.frame.topic = loaded.topic!; h.frame.topicState = loaded.topicState!;
  try {
    const result = await gate.run(async () => prepareTopicContinuity({ frame: h.frame, admittedDialogueInput: await h.admit(), request: h.request, config: h.config }));
    h.f.store.request({ type: 'topic.update', conversationId: h.scope.conversationId, topicId: h.frame.topic.id, readerId: 'user',
      expectedRevision: h.frame.topic.revision, patch: { shared: { summary: '后来另行完成的阶段。', sourceMessageIds: [h.source.id] } } });
    await gate.validate();
    expect(result.topicState?.shared?.sourceEventId).toBe(h.frame.topicState.shared?.sourceEventId);
    expect(result.topicState?.shared?.summary).toBe('原已读取阶段。');
  } finally { gate.close(); }
});

it.each(['body', 'forget', 'paused', 'membership'] as const)('rejects actual %s changes before the final fence', async mutation => {
  const h = fixture(), gate = createCompanionExecutionValidationSession();
  try {
    await gate.run(async () => prepareTopicContinuity({ frame: h.frame, admittedDialogueInput: await h.admit(), request: h.request, config: h.config }));
    if (mutation === 'body') h.sql(db => db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('已被外部改写。', h.source.id));
    if (mutation === 'forget') h.f.store.request({ type: 'memory.forget', ...h.f.scope, sourceMessageIds: [h.source.id] });
    if (mutation === 'paused') h.sql(db => db.prepare("UPDATE companion_topics SET data=json_set(data,'$.status','paused') WHERE id=?").run(h.frame.topic!.id));
    if (mutation === 'membership') h.sql(db => db.prepare('DELETE FROM conversation_members WHERE conversation_id=? AND companion_id=?').run(h.scope.conversationId, 'alice'));
    await expect(gate.validate()).rejects.toThrow();
  } finally { gate.close(); }
});

it('does not move a token across finite frames or manufacture it from serialized model JSON', async () => {
  const h = fixture(), first = createCompanionExecutionValidationSession(), second = createCompanionExecutionValidationSession();
  try {
    const token = await first.run(() => h.admit()); expect(token).toBeDefined();
    await second.run(() => prepareTopicContinuity({ frame: h.frame, admittedDialogueInput: token, request: h.request, config: h.config }));
    expect(h.request.mock.calls.some(([command]) => command.type === 'topic.read')).toBe(true);
    h.request.mockClear();
    const forged: unknown = JSON.parse(JSON.stringify(token));
    await second.run(() => Reflect.apply(prepareTopicContinuity, undefined, [{ frame: h.frame, admittedDialogueInput: forged, request: h.request, config: h.config }]));
    expect(h.request.mock.calls.some(([command]) => command.type === 'topic.read')).toBe(true);
    await second.validate();
  } finally { first.close(); second.close(); }
});

it('keeps broader cursor and after-cursor inputs on the original entrance', async () => {
  const h = fixture(), gate = createCompanionExecutionValidationSession();
  try {
    await gate.run(async () => {
      expect(await h.admit(h.frame, h.scope.beforeSequence + 1)).toBeUndefined();
      const later = h.f.source('后续独立请求。');
      const frame = { ...h.frame, messages: [...h.frame.messages, later] };
      expect(await h.admit(frame)).toBeUndefined();
    });
  } finally { gate.close(); }
});

it('does not reuse a lawful same-room source from a different topic', async () => {
  const h = fixture(), gate = createCompanionExecutionValidationSession();
  const other = h.f.store.request({ type: 'topic.create', conversationId: h.scope.conversationId, readerId: 'user', title: '另一话题', kind: 'discussion' }).topic!;
  const source = h.f.store.appendMessage({ conversationId: h.scope.conversationId, topicId: other.id, authorId: 'user', content: '真实另一话题原文。', replyDirective: 'none' });
  try {
    await gate.run(async () => expect(await h.admit({ ...h.frame, messages: [source], sourceMessage: source }, source.sequence)).toBeUndefined());
  } finally { gate.close(); }
});

it('keeps exceptional full-DTO sources on their old read path', async () => {
  const h = fixture(), gate = createCompanionExecutionValidationSession();
  try {
    await gate.run(async () => {
      const response = await h.request({ type: 'memory.sources.headers', ...h.scope, ids: [h.source.id] });
      const headers = companionSourceHeaderResult([h.source.id], response)!;
      expect(await admitCompanionTopicDialogue({ frame: h.frame, scope: h.scope, sourceIds: [h.source.id],
        sourceHeaders: { headers: [], unsupportedIds: [h.source.id] }, identity: h.identity, requestFresh: h.storage,
        taskKey: createHash('sha256').update(h.source.id).digest('hex') })).toBeUndefined();
      expect(headers.headers).toHaveLength(1);
    });
  } finally { gate.close(); }
});

it('propagates final storage availability without converting it to a source withdrawal', async () => {
  const h = fixture(), gate = createCompanionExecutionValidationSession();
  try {
    await gate.run(async () => prepareTopicContinuity({ frame: h.frame, admittedDialogueInput: await h.admit(), request: h.request, config: h.config }));
    const unavailable = Object.assign(new Error('Controlled storage I/O unavailable.'), { code: 'SQLITE_IOERR' });
    h.storage.mockImplementation(async command => {
      if (command.type === 'topic.read') throw unavailable;
      return h.f.store.request(command);
    });
    await expect(gate.validate()).rejects.toBe(unavailable);
    expect(h.storage.mock.calls.some(([command]) => command.type === 'execution.invalidate')).toBe(false);
  } finally { gate.close(); }
});

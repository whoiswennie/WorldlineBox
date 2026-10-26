import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { captureCompanionExecutionReadset, companionExecutionReadsetDigest, companionWorldReadSourceIds, companionWorldReadSources, projectCompanionExecutionReceipt,
  verifyCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionLoopTurn } from '../../src/shared/companion-loop';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const scope = { companionId: 'alice', conversationId: 'private_alice', beforeSequence: 42 };
const cold = () => ({ id: 'cold_learning_' + hash('grant_one:folder/资料 1').slice(0, 48), sourceType: 'learning' as const,
  sourceId: 'grant_one', sourceVersion: '2:asset_revision_one', sourceDigest: 'd'.repeat(64), version: 'a'.repeat(64), text: 'Actual source bytes',
  metadata: { conversationId: 'private_alice', grantId: 'grant_one', grantRevision: 2, assetId: 'folder/资料 1', assetRevisionId: 'asset_revision_one' } });
const receipt = () => ({ ok: true, memoryKnowledge: { engine: 'original-TDBKnowledge', operation: 'read', available: true,
  trust: 'knowledge_source_data_not_instructions', result: cold() } });
const turn = (name = 'memory'): CompanionLoopTurn => ({ text: '', rawText: '', calls: [{ id: 'call_one', name,
  arguments: JSON.stringify({ action: 'knowledge', operation: 'read', id: cold().id }) }], results: [{ callId: 'call_one', content: JSON.stringify(receipt()) }] });

describe('derived DSH content keeps its exact host dependency closure', () => {
  it('distinguishes unavailable storage or cold-file verification from a proven source change', async () => {
    const unavailable = new Error('Verification storage temporarily unavailable');
    const request = vi.fn(async (): Promise<CompanionStorageResponse> => { throw unavailable; });
    const sources = captureCompanionExecutionReadset(scope, { sources: [{ id: 'source_one', conversationId: scope.conversationId, checksum: hash('Actual source') }] });
    await expect(verifyCompanionExecutionReadset(sources, scope, { request })).rejects.toBe(unavailable);
    const knowledge = captureCompanionExecutionReadset(scope, { turns: [turn()] });
    await expect(verifyCompanionExecutionReadset(knowledge, scope, { request })).rejects.toBe(unavailable);
  });
  it('accepts only actual world context and matched native world results for source dependencies', () => {
    const input = { context: { user: JSON.stringify({ world: { events: [{ sourceMessageId: 'context_event' }], visits: [{ sourceMessageId: 'context_visit', responseSourceMessageId: 'context_response' }] },
      metadata: { world: { events: [{ sourceMessageId: 'free_metadata' }] } } }) }, turns: [{ text: '', rawText: '',
      calls: [{ id: 'world_read', name: 'world', arguments: '{"action":"inspect"}' }, { id: 'native_json', name: 'dsh', arguments: '{"action":"tasks"}' }],
      results: [{ callId: 'world_read', content: JSON.stringify({ ok: true, world: { events: [{ sourceMessageId: 'actual_tool_event' }] },
        metadata: { sourceMessageId: 'untrusted_metadata' } }) }, { callId: 'native_json', content: JSON.stringify({ ok: true, world: { events: [{ sourceMessageId: 'untrusted_dsh' }] } }) },
      { callId: 'unmatched', content: JSON.stringify({ ok: true, world: { visits: [{ sourceMessageId: 'unmatched_source' }] } }) }] }] };
    expect(companionWorldReadSourceIds(input)).toEqual(['context_event', 'context_visit', 'context_response', 'actual_tool_event']);
  });
  it('keeps immutable event and visit response checksums, with no proof from task output or free JSON', async () => {
    const read = { id: 'actual_response', conversationId: 'host_room', checksum: hash('old exact reply') };
    const input = { context: { user: JSON.stringify({ world: { visits: [{ response: 'old exact reply', responseSourceMessageId: read.id,
      responseConversationId: read.conversationId, responseSourceRead: read }] }, metadata: { sourceReads: [{ ...read, id: 'fake' }] } }) }, turns: [{ text: '', rawText: '',
      calls: [{ id: 'world_read', name: 'world', arguments: '{"action":"inspect"}' }, { id: 'native_json', name: 'dsh', arguments: '{"action":"tasks"}' }],
      results: [{ callId: 'world_read', content: JSON.stringify({ ok: true, world: { events: [{ sourceMessageId: read.id, conversationId: read.conversationId, sourceReads: [read] }] } }) },
      { callId: 'native_json', content: JSON.stringify({ ok: true, world: { events: [{ sourceReads: [{ ...read, id: 'fake_native' }] }] } }) }] }] };
    expect(companionWorldReadSources(input)).toEqual({ complete: true, sources: [read] });
    const proof = captureCompanionExecutionReadset(scope, { sources: companionWorldReadSources(input).sources });
    const request = vi.fn(async (): Promise<CompanionStorageResponse> => ({ ok: true, memorySources: [{ id: read.id, conversationId: read.conversationId,
      content: 'new same-id reply' }] as CompanionStorageResponse['memorySources'] }));
    expect(await verifyCompanionExecutionReadset(proof, scope, { request })).toBe(false);
    expect(proof.sources).toEqual([read]);
    expect(request).toHaveBeenCalledWith({ type: 'memory.sources.filter', companionId: 'alice', conversationId: 'host_room', ids: [read.id] });
  });
  it('refuses unversioned legacy quotations and mismatched response pointers while keeping physical observations usable', () => {
    const capture = (world: unknown) => companionWorldReadSources({ context: { user: JSON.stringify({ world }) } });
    expect(capture({ events: [{ sourceMessageId: 'legacy', conversationId: 'old_room', text: 'old quote' }] })).toEqual({ complete: false, sources: [] });
    expect(capture({ visits: [{ responseSourceMessageId: 'reply', responseConversationId: 'real_room',
      responseSourceRead: { id: 'reply', conversationId: 'other_room', checksum: hash('old quote') } }] })).toEqual({ complete: false, sources: [] });
    expect(capture({ events: [{ text: '实际走到长椅', kind: 'arrive' }], visits: [{ response: '欢迎' }] })).toEqual({ complete: true, sources: [] });
  });
  it('fills a missing direct dialogue room only from the matching host entrance and marks incomplete actual source rows', () => {
    const message = { id: 'actual_chat', content: 'Real host dialogue' };
    const capture = (data: unknown) => captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify(data) } });
    expect(capture({ conversation: { id: scope.conversationId }, messages: [message] })).toMatchObject({ complete: true,
      sources: [{ id: message.id, conversationId: scope.conversationId, checksum: hash(message.content) }] });
    expect(capture({ invocation: { conversationId: scope.conversationId }, messages: [message] }).complete).toBe(true);
    expect(capture({ messages: [message] }).complete).toBe(false);
    expect(capture({ conversation: { id: 'other_room' }, messages: [message] }).complete).toBe(false);
    expect(capture({ conversation: { id: scope.conversationId }, memorySources: [message] }).complete).toBe(false);
    expect(capture({ conversation: { id: scope.conversationId }, messages: [{ content: 'Missing actual ID' }] }).complete).toBe(false);
    expect(capture({ conversation: { id: scope.conversationId }, messages: [{ id: 'actual_chat' }] }).complete).toBe(false);
    expect(capture({ conversation: { id: scope.conversationId }, messages: [{ ...message, conversationId: 'bad/room' }] }).complete).toBe(false);
  });
  it('captures actual native reads and exact visible message bytes while ignoring candidate ranks and arbitrary executor JSON', () => {
    const readset = captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({
      messages: [{ id: 'original_request', conversationId: 'private_alice', content: 'User task with full retained bytes.' }],
      memoryRecall: { reasons: [{ id: 'candidate_only', version: 9 }], context: { text: 'Focused actual output', revision: 'corpus-one', profileKey: 'profile-one',
        evidence: { beforeSequence: 42, referenceCoverage: 'partial', references: [{ id: 'actual_note', version: 3, role: 'focus_input' }] } } },
    }) }, turns: [turn(), turn('dsh')] });
    expect(readset.complete).toBe(true);
    expect(readset.memories).toEqual([{ id: 'actual_note', version: 3 }]);
    expect(readset.sources).toEqual([{ id: 'original_request', conversationId: 'private_alice', checksum: hash('User task with full retained bytes.') }]);
    expect(readset.contexts).toEqual([{ revision: 'corpus-one', profileKey: 'profile-one', beforeSequence: 42 }]);
    expect(readset.knowledgeReads).toHaveLength(1);
    expect(JSON.stringify(readset)).not.toContain('Actual source bytes');
    expect(JSON.stringify(readset)).not.toContain('User task with full retained bytes.');
  });
  it('captures the exact independent topic publication reference and still withdraws it after a same-id edit', async () => {
    const message = { id: 'late_formal', conversationId: scope.conversationId, topicId: 'story', authorId: 'alice',
      status: 'sent', content: '实际晚发布的正式正文。' };
    const data = { topic: { id: 'story', kind: 'story', conversationId: scope.conversationId, formalPublicationRevision: 8,
      lastPublicationAvailability: 'available', lastPublicationRef: { messageId: message.id, authorId: message.authorId, contentChecksum: hash(message.content) } },
      topicPublicationReference: { formalPublicationRevision: 8, contentChecksum: hash(message.content), message } };
    const readset = captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify(data) } });
    expect(readset).toMatchObject({ complete: true, sources: [{ id: message.id, conversationId: scope.conversationId, checksum: hash(message.content) }] });
    const request = vi.fn(async () => ({ ok: true, memorySources: [{ ...message, content: '同ID已被修改。' }] } as CompanionStorageResponse));
    expect(await verifyCompanionExecutionReadset(readset, scope, { request })).toBe(false);
    expect(readset.sources[0]!.checksum).toBe(hash(message.content));
  });
  it.each(['checksum', 'counter', 'topic', 'room', 'human', 'system', 'draft', 'replyDraft', 'notSent', 'pointer', 'unavailable'] as const)(
    'rejects an invalid independent topic publication reference (%s)', failure => {
      const message = { id: 'late_formal', conversationId: scope.conversationId, topicId: 'story', authorId: 'alice',
        status: 'sent', content: '实际晚发布的正式正文。', isReplyDraft: false, replyDraft: undefined as unknown };
      const reference = { formalPublicationRevision: 8, contentChecksum: hash(message.content), message };
      const pointer = { messageId: message.id, authorId: message.authorId, contentChecksum: hash(message.content) };
      if (failure === 'checksum') reference.contentChecksum = hash('别的正文');
      if (failure === 'counter') reference.formalPublicationRevision = 7;
      if (failure === 'topic') message.topicId = 'other_story';
      if (failure === 'room') message.conversationId = 'other_room';
      if (failure === 'human') message.authorId = 'user';
      if (failure === 'system') message.authorId = 'system';
      if (failure === 'draft') message.isReplyDraft = true;
      if (failure === 'replyDraft') message.replyDraft = { text: '草稿' };
      if (failure === 'notSent') message.status = 'failed';
      if (failure === 'pointer') pointer.messageId = 'other_formal';
      const readset = captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({
        topic: { id: 'story', kind: 'story', conversationId: scope.conversationId, formalPublicationRevision: 8,
          lastPublicationRef: pointer, lastPublicationAvailability: failure === 'unavailable' ? 'unavailable' : 'available' }, topicPublicationReference: reference }) } });
      expect(readset.complete).toBe(false); expect(readset.sources).toEqual([]);
    });
  it.each(['available', 'unavailable', 'legacy_order_unknown', 'future_revision', 'wrong_body'] as const)(
    'captures the independent narrative pointer while a newer human input occupies the global pointer: %s', mode => {
      const message = { id: 'actual_late_narrative', conversationId: scope.conversationId, topicId: 'story', authorId: 'alice',
        status: 'sent', content: '较早创建但较晚发布的真实正文。' };
      const pointer = { messageId: message.id, authorId: message.authorId, contentChecksum: hash(message.content),
        publicationRevision: mode === 'future_revision' ? 9 : 7 };
      const readset = captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({
        topic: { id: 'story', kind: 'story', conversationId: scope.conversationId, formalPublicationRevision: 8,
          lastPublicationAvailability: 'available', lastPublicationRef: { messageId: 'current_human', authorId: 'user', contentChecksum: hash('新的用户来源') },
          lastNarrativePublicationAvailability: ['unavailable', 'legacy_order_unknown'].includes(mode) ? mode : 'available', lastNarrativePublicationRef: pointer },
        topicPublicationReference: { formalPublicationRevision: 8, contentChecksum: mode === 'wrong_body' ? hash('伪造正文') : hash(message.content), message },
      }) } });
      expect(readset.complete).toBe(mode === 'available');
      expect(readset.sources).toEqual(mode === 'available' ? [{ id: message.id, conversationId: scope.conversationId, checksum: hash(message.content) }] : []);
    });
  it('merges prior host readsets transitively with stable digests and rejects another owner or entrance', () => {
    const one = captureCompanionExecutionReadset(scope, { memories: [{ id: 'note_one', version: 1 }] });
    const two = captureCompanionExecutionReadset(scope, { memories: [{ id: 'note_two', version: 2 }], readsets: [one, one] });
    const reversed = captureCompanionExecutionReadset(scope, { memories: [...two.memories].reverse() });
    expect(two.memories).toHaveLength(2); expect(companionExecutionReadsetDigest(two)).toBe(companionExecutionReadsetDigest(reversed));
    expect(captureCompanionExecutionReadset(scope, { readsets: [{ ...one, companionId: 'bob' }] }).complete).toBe(false);
    expect(captureCompanionExecutionReadset(scope, { readsets: [{ ...one, conversationId: 'other_entrance' }] }).complete).toBe(false);
  });
  it('keeps complete physical or observed input dependencies independent of mutable prompt corpus, profile and clock', async () => {
    for (const evidence of [
      { dependencyCoverage: 'complete', dependencies: [{ id: 'real_input', version: 3 }], referenceCoverage: 'partial', references: [] },
      { referenceCoverage: 'observed', references: [{ id: 'real_input', version: 3, role: 'focus_input' }] },
    ]) {
      const readset = captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({ memoryRecall: { context: { text: 'Actually focused memory.',
        revision: 'former-corpus', profileKey: 'former-profile', evidence: { ...evidence, queryClock: { now: '2035-01-01T00:00:00Z', timeZone: 'UTC' } } } } }) } });
      expect(readset.memories).toEqual([{ id: 'real_input', version: 3 }]); expect(readset.contexts).toEqual([]);
      const contextValid = vi.fn(async () => false);
      const request = async (): Promise<CompanionStorageResponse> => ({ ok: true, memories: [{ id: 'real_input', version: 3, companionId: scope.companionId }] } as CompanionStorageResponse);
      expect(await verifyCompanionExecutionReadset(readset, scope, { request, contextValid })).toBe(true); expect(contextValid).not.toHaveBeenCalled();
    }
    const malformed = captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({ memoryRecall: { context: { text: 'Unproven body', revision: 'corpus', profileKey: 'profile',
      evidence: { dependencyCoverage: 'complete', dependencies: [{ id: 'bad', version: 0 }] } } } }) } });
    expect(malformed.complete).toBe(false);
    const unknown = captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({ memoryRecall: { context: { text: 'Legacy unobserved body', revision: 'corpus', profileKey: 'profile',
      evidence: { referenceCoverage: 'observed', references: [] } } } }) } });
    expect(unknown.contexts).toHaveLength(1);
  });
  it('requires current hot versions, corpus/profile and actual cold asset/grant reads before resuming or reusing a result', async () => {
    const sourceText = 'Actual observed source';
    const readset = captureCompanionExecutionReadset(scope, { memories: [{ id: 'note_one', version: 1 }],
      sources: [{ id: 'source_one', conversationId: 'private_alice', checksum: hash(sourceText) }],
      contexts: [{ revision: 'corpus-one', profileKey: 'profile-one', beforeSequence: 42 }], turns: [turn()] });
    let noteVersion = 1, content = sourceText, grantActive = true;
    const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
      if (command.type === 'memory.records.filter') return { ok: true, memories: [{ id: 'note_one', companionId: 'alice', version: noteVersion }] } as CompanionStorageResponse;
      if (command.type === 'memory.sources.filter') return { ok: true, memorySources: [{ id: 'source_one', conversationId: 'private_alice', content }] } as CompanionStorageResponse;
      if (command.type === 'memory.knowledge') return grantActive ? receipt() as CompanionStorageResponse : { ok: false, error: 'Grant withdrawn' };
      throw new Error('Unexpected verification port');
    });
    const contextValid = vi.fn(async () => true), ports = { request, contextValid };
    expect(await verifyCompanionExecutionReadset(readset, scope, ports)).toBe(true);
    expect(request).toHaveBeenCalledWith({ type: 'memory.sources.filter', companionId: 'alice', conversationId: 'private_alice', ids: ['source_one'] });
    noteVersion = 2; expect(await verifyCompanionExecutionReadset(readset, scope, ports)).toBe(false); noteVersion = 1;
    content = 'Updated message'; expect(await verifyCompanionExecutionReadset(readset, scope, ports)).toBe(false); content = sourceText;
    contextValid.mockResolvedValue(false); expect(await verifyCompanionExecutionReadset(readset, scope, ports)).toBe(false); contextValid.mockResolvedValue(true);
    grantActive = false; expect(await verifyCompanionExecutionReadset(readset, scope, ports)).toBe(false);
  });
  it('fails closed for missing legacy proofs and incomplete topic provenance but permits an explicitly empty fresh readset', async () => {
    const request = vi.fn(async (): Promise<CompanionStorageResponse> => ({ ok: true }));
    expect(await verifyCompanionExecutionReadset(undefined, scope, { request })).toBe(false);
    const fresh = captureCompanionExecutionReadset(scope);
    expect(await verifyCompanionExecutionReadset(fresh, scope, { request })).toBe(true); expect(request).not.toHaveBeenCalled();
    const legacy = captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({ topicState: { readerId: 'alice',
      shared: { sourceMessageIds: ['old_source'], summary: 'A summary without its original source checksums' } } }) } });
    expect(legacy.complete).toBe(false); expect(await verifyCompanionExecutionReadset(legacy, scope, { request })).toBe(false);
  });
  it('retains Main context and actual cold-file checks when the current worker already validated the SQLite readset', async () => {
    const readset = captureCompanionExecutionReadset(scope, { memories: [{ id: 'note_one', version: 1 }],
      sources: [{ id: 'source_one', conversationId: 'private_alice', checksum: hash('Actual source') }],
      contexts: [{ revision: 'corpus-one', profileKey: 'profile-one', beforeSequence: 42 }], turns: [turn()] });
    let fileValid = true;
    const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
      if (command.type !== 'memory.knowledge') throw new Error('SQLite source checks must already be proved in this exact request.');
      return fileValid ? receipt() as CompanionStorageResponse : { ok: false, error: 'The actual file changed' };
    });
    const contextValid = vi.fn(async () => true), ports = { request, contextValid, sqliteSourcesValidated: true };
    expect(await verifyCompanionExecutionReadset(readset, scope, ports)).toBe(true);
    expect(contextValid).toHaveBeenCalledOnce(); expect(request.mock.calls.every(([command]) => command.type === 'memory.knowledge')).toBe(true);
    fileValid = false; expect(await verifyCompanionExecutionReadset(readset, scope, ports)).toBe(false); fileValid = true;
    contextValid.mockResolvedValue(false); expect(await verifyCompanionExecutionReadset(readset, scope, ports)).toBe(false);
    expect(await verifyCompanionExecutionReadset({ ...readset, complete: false }, scope, ports)).toBe(false);
    expect(await verifyCompanionExecutionReadset(readset, { ...scope, companionId: 'another_owner' }, ports)).toBe(false);
  });
  it('withholds stale reusable content without changing successful effect history or creating another execution', () => {
    const actual = { id: 'action_one', recordId: 'record_one', status: 'succeeded', title: 'Private source in title', finalReply: 'Private source text',
      structured: { private: 'secret' }, artifacts: [{ path: 'private-file' }], error: 'private error', session: { id: 'session_one' },
      statistics: { turns: 2, steps: 8, toolCalls: 5, durationMs: 100, recordCount: 9, extra: 'private statistics' } };
    expect(projectCompanionExecutionReceipt(actual, true)).toBe(actual);
    const hidden = projectCompanionExecutionReceipt(actual, false);
    expect(hidden).toMatchObject({ id: 'action_one', recordId: 'record_one', status: 'succeeded', statistics: { toolCalls: 5 }, contentAvailable: false, resumeAllowed: false });
    expect(JSON.stringify(hidden)).not.toMatch(/Private|private|secret|session_one/u);
    expect(actual.finalReply).toBe('Private source text');
  });
  it('binds actual progress replies to their typed outbound origins and the direct current-goal context port', () => {
    const message = { id: 'reply_one', conversationId: 'peer_room', authorId: 'bob', content: 'I changed my mind about attending.', sequence: 100,
      kind: 'text', status: 'sent', createdAt: '2026-10-23T00:00:00.000Z', attachments: [] };
    const origin = { messageId: message.id, conversationId: message.conversationId, sourceMessageId: 'actual_outbound', deliveryClientId: 'actual_delivery', chainId: 'actual_chain' };
    const activityTask = { id: 'activity_one', companionId: 'alice', conversationId: scope.conversationId, title: 'Ask the actual goal', goal: 'Check willingness',
      status: 'succeeded', step: 1, attempts: 0, createdAt: message.createdAt, updatedAt: message.createdAt, deadline: message.createdAt, stage: 'Observed reply', history: [] };
    const progress: CompanionLoopTurn = { text: '', rawText: '', calls: [{ id: 'progress_read', name: 'world', arguments: JSON.stringify({ action: 'activity', parameters: { action: 'progress', id: activityTask.id } }) }],
      results: [{ callId: 'progress_read', content: JSON.stringify({ ok: true, activityTask, activityMessages: [message], activityMessageOrigins: [origin] }) }] };
    const expected = [{ id: message.id, conversationId: message.conversationId, checksum: hash(message.content) }];
    expect(captureCompanionExecutionReadset(scope, { turns: [progress] }).sources).toEqual(expected);
    expect(captureCompanionExecutionReadset(scope, { context: { user: JSON.stringify({ currentGoalReplies: [{ taskId: activityTask.id, messages: [message], origins: [origin] }] }) } }).sources).toEqual(expected);
    const wrongRoom = structuredClone(progress);
    wrongRoom.results![0]!.content = JSON.stringify({ ok: true, activityTask, activityMessages: [message], activityMessageOrigins: [{ ...origin, conversationId: 'another_room' }] });
    expect(captureCompanionExecutionReadset(scope, { turns: [wrongRoom] }).sources).toEqual([]);
    expect(captureCompanionExecutionReadset(scope, { turns: [{ ...progress, calls: [{ ...progress.calls[0]!, name: 'dsh' }] }] }).sources).toEqual([]);
  });
});

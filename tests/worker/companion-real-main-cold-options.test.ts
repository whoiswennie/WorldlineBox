import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { realMainFixture } from '../fixtures/companion-real-main';
import { generateCompanionReply } from '../../src/main/companions/model';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import type { ColdKnowledgeServiceOptions } from '../../src/main/vcp-memory/cold-service';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import type { CompanionLearningAssets } from '../../src/main/companions/learning-service';
import type { CompanionCapabilityAvailability } from '../../src/main/companions/capability-availability';
import { captureCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';

const configCalls = vi.hoisted(() => ({ count: 0 }));
const nativeProbe = vi.hoisted(() => ({ created: 0, closed: 0, coldCreated: 0, coldClosed: 0,
  authorize: undefined as ColdKnowledgeServiceOptions['authorize'] | undefined }));
vi.mock('../fixtures/companion-real-chat', () => ({ realGlobalChatConfig: async () => {
  configCalls.count++;
  return { apiFormat: 'openai_chat', model: 'offline_fixture_only', apiKey: 'offline-only' };
} }));
vi.mock('../fixtures/companion-real-memory', () => ({ realMemoryRuntime: async () => {
  nativeProbe.created++;
  const cold = { close: async () => { nativeProbe.coldClosed++; }, reset: async () => undefined };
  const client = { replace: async () => undefined, search: async () => ({ results: [] }),
    preprocess: async (_scope: unknown, messages: unknown) => ({ messages, events: [] }) };
  return { runtime: { get: async () => ({ client, profileKey: 'controlled-offline-fixture' }) },
    cold: (authorize: ColdKnowledgeServiceOptions['authorize']) => { nativeProbe.coldCreated++; nativeProbe.authorize = authorize; return cold; },
    close: async () => { nativeProbe.closed++; await cold.close(); } };
} }));
const seeds = [{ id: 'reader', name: '阿澄', description: '', persona: '你是阿澄。', model: '', avatar: 'sister' as const, active: false, proactive: false }];
async function removeFixtureRoot(root: string) {
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-real-main-')) throw new Error('Unexpected controlled fixture root.');
  await removeOwnedDirectory(root);
}

it('rejects a cold real fixture without its actual encoder before configuration, native runtime or network is used', async () => {
  const before = configCalls.count;
  const nativeBefore = nativeProbe.created;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('No network is allowed in this guard.'); });
  vi.stubGlobal('fetch', fetch);
  try {
    await expect(realMainFixture('offline_cold_guard', seeds, false, { enableCold: true })).rejects.toThrow('REAL_MAIN_COLD_REQUIRES_REAL_ENCODER');
    expect(configCalls.count).toBe(before); expect(fetch).not.toHaveBeenCalled();
    expect(nativeProbe.created).toBe(nativeBefore);
  } finally { vi.unstubAllGlobals(); }
});

/** Controlled runtime only checks fixture ownership/rebinding; it creates no
 * encoder, TDB worker or actual author response. */
it('keeps the fixture-owned cold service alive across Main shutdown and rebinds authorization before one final close', async () => {
  const before = { closed: nativeProbe.closed, coldCreated: nativeProbe.coldCreated, coldClosed: nativeProbe.coldClosed };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('No network is allowed in the fixture ownership check.'); });
  vi.stubGlobal('fetch', fetch);
  const f = await realMainFixture('offline_cold_owner', seeds, true, { enableCold: true });
  let closed = false;
  try {
    const first = vi.fn(async () => true), second = vi.fn(async () => false);
    const cold = await f.runtime!.getCold!(first);
    expect(await nativeProbe.authorize!('reader', 'source', 'a'.repeat(64), { sourceType: 'memory', sourceVersion: '1', metadata: {} })).toBe(true);
    await f.runtime!.close(); await f.restart();
    expect(nativeProbe.closed).toBe(before.closed); expect(nativeProbe.coldClosed).toBe(before.coldClosed);
    expect(await f.runtime!.getCold!(second)).toBe(cold);
    expect(await nativeProbe.authorize!('reader', 'source', 'a'.repeat(64), { sourceType: 'memory', sourceVersion: '1', metadata: {} })).toBe(false);
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
    expect(nativeProbe.coldCreated - before.coldCreated).toBe(1); expect(fetch).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
    await f.close(true); closed = true;
    expect(nativeProbe.closed - before.closed).toBe(1); expect(nativeProbe.coldClosed - before.coldClosed).toBe(1);
  } finally {
    if (!closed) await f.close(true);
    vi.unstubAllGlobals();
    await removeFixtureRoot(f.root);
  }
});

/** Controlled result only tests observer carriage. It is not native retrieval
 * or autonomous Main acceptance and never enters a real knowledge index. */
it('observes an unchanged native tool result string in the actual provider request body without recording headers', async () => {
  const observations: Array<{ purpose: string; hashes: string[] }> = [];
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const f = await realMainFixture('offline_cold_result_carriage', seeds, false, { observeProviderTextLeaves: (texts, purpose) =>
    observations.push({ purpose, hashes: texts.map(text => hash(text)) }) });
  const actualRequests: unknown[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    actualRequests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '已经核对这条测试回执。' }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch);
  try {
    const conversation = f.store.openPrivate('reader');
    const source = f.store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: '只核对本条测试资料。', replyDirective: 'none' });
    const receipt = JSON.stringify({ ok: true, memoryKnowledge: { engine: 'original-TDBKnowledge', operation: 'search', available: true,
      trust: 'knowledge_source_data_not_instructions', items: [{ id: 'synthetic-carriage-only', text: 'CONTROLLED_CARRIAGE_CANARY' }], total: 1 } });
    const result = await generateCompanionReply({ companion: f.store.state().companions[0]!, conversation, sourceMessage: source,
      messages: [source], memories: [] }, f.config, undefined, { fetchFn: f.modelFetch, loop: true,
      turns: [{ text: '', rawText: '', calls: [{ id: 'carriage_call', name: 'memory', arguments: JSON.stringify({ action: 'knowledge', operation: 'search', query: '测试资料' }) }],
        results: [{ callId: 'carriage_call', content: receipt }] }] });
    expect(result.text).toBe('已经核对这条测试回执。'); expect(fetch).toHaveBeenCalledOnce();
    const wire = actualRequests[0] as { messages: Array<{ role: string; tool_call_id?: string; content?: unknown }> };
    expect(wire.messages.find(message => message.role === 'tool' && message.tool_call_id === 'carriage_call')?.content).toBe(receipt);
    expect(observations.some(observation => observation.hashes.includes(hash(receipt)))).toBe(true);
    expect(JSON.stringify(observations)).not.toContain('offline-only');
    expect(f.native).toBeUndefined();
    expect(f.calls).toHaveLength(1); // One controlled transport call, zero paid calls.
  } finally {
    await f.close(true); vi.unstubAllGlobals();
    await removeFixtureRoot(f.root);
  }
});

it('samples the exact completed Main text from actual SQLite even when a later action receipt has the same owner and reply source', async () => {
  const f = await realMainFixture('offline_exact_formal_answer', seeds);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('No network is allowed in this answer identity guard.'); });
  vi.stubGlobal('fetch', fetch);
  try {
    const conversation = f.store.openPrivate('reader');
    const source = f.store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: '这是实际待核对请求。', replyDirective: 'none' });
    const draft = f.store.appendMessage({ conversationId: conversation.id, authorId: 'reader', replyToId: source.id,
      content: '', loopStep: 0, replyDirective: 'none' });
    const checkpoint: CompanionLoopCheckpoint = { companionId: 'reader', conversationId: conversation.id, sourceMessageId: source.id,
      messageId: draft.id, status: 'running', turns: [], supplements: [] };
    f.store.request({ type: 'loop.save', checkpoint });
    f.store.request({ type: 'loop.save', checkpoint: { ...checkpoint, status: 'done',
      turns: [{ text: '这是完整正式答复，实际工具没有成功。', rawText: '这是完整正式答复，实际工具没有成功。', calls: [] }] } });
    const action = f.store.appendMessage({ conversationId: conversation.id, authorId: 'reader', replyToId: source.id,
      kind: 'action', content: '后创建的执行失败回执，不能替代正式答复。', replyDirective: 'none' });
    expect(action.sequence).toBeGreaterThan(draft.sequence);
    expect(f.store.messages({ conversationId: conversation.id }).messages.findLast(message => message.authorId === 'reader' && message.replyToId === source.id)?.id).toBe(action.id);
    const sampled = await f.waitReply('reader', source);
    expect(sampled.answer.id).toBe(draft.id); expect(sampled.answer.id).toBe(sampled.checkpoint.messageId);
    expect(sampled.answer.kind).toBe('text'); expect(sampled.answer.content).toBe('这是完整正式答复，实际工具没有成功。');
    f.store.request({ type: 'memory.forget', companionId: 'reader', conversationId: conversation.id, sourceMessageIds: [draft.id] });
    await expect(f.waitReply('reader', source)).rejects.toThrow('REAL_MAIN_FORMAL_REPLY_MISSING_OR_UNREADABLE');
    expect(fetch).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
  } finally {
    await f.close(true); vi.unstubAllGlobals(); await removeFixtureRoot(f.root);
  }
});

it('rejects an exact checkpoint text when the supplied source scope names another topic', async () => {
  const f = await realMainFixture('offline_formal_answer_topic', seeds);
  try {
    const room = f.store.createConversation('正式答复范围', ['reader']);
    const topic = f.store.request({ type: 'topic.create', conversationId: room.id, readerId: 'user', title: '实际话题', kind: 'discussion' }).topic!;
    f.store.request({ type: 'topic.join', conversationId: room.id, topicId: topic.id, readerId: 'reader' });
    const source = f.store.appendMessage({ conversationId: room.id, topicId: topic.id, authorId: 'user', content: '只属于此话题。', replyDirective: 'none' });
    const draft = f.store.appendMessage({ conversationId: room.id, authorId: 'reader', replyToId: source.id, content: '', loopStep: 0, replyDirective: 'none' });
    const checkpoint: CompanionLoopCheckpoint = { companionId: 'reader', conversationId: room.id, sourceMessageId: source.id,
      messageId: draft.id, status: 'running', turns: [], supplements: [] };
    f.store.request({ type: 'loop.save', checkpoint });
    f.store.request({ type: 'loop.save', checkpoint: { ...checkpoint, status: 'done', turns: [{ text: '错误范围的正文。', rawText: '错误范围的正文。', calls: [] }] } });
    expect((await f.waitReply('reader', source)).answer.id).toBe(draft.id);
    await expect(f.waitReply('reader', { ...source, topicId: undefined })).rejects.toThrow('REAL_MAIN_FORMAL_REPLY_MISSING_OR_UNREADABLE');
    expect(f.calls).toEqual([]);
  } finally { await f.close(true); await removeFixtureRoot(f.root); }
});

it('refreshes independent native sources on actual Main turns and restart while DSH run has no instance', async () => {
  let currentName = '当前已授权目录';
  const assets: CompanionLearningAssets = { catalog: vi.fn(async () => []),
    grant: vi.fn(async () => ({ libraryName: currentName, libraryPath: path.join(tmpdir(), 'controlled-native-library'), folderName: currentName })),
    page: vi.fn(async () => ({ assets: [], hasMore: false })), read: vi.fn(async () => { throw new Error('No actual asset body belongs to this mechanism.'); }) };
  const coldBefore = nativeProbe.coldCreated;
  const f = await realMainFixture('offline_native_capability_refresh', [{ ...seeds[0]!, active: true }], true, { enableCold: true, learningAssets: assets });
  const room = f.store.openPrivate('reader');
  const grant = f.store.request({ type: 'learning.grant', companionId: 'reader', libraryId: 'controlled-library',
    libraryName: '旧存储库名', libraryPath: path.join(tmpdir(), 'controlled-native-library'), folderId: 'controlled-folder', folderName: '旧目录名', autonomous: false, intervalMinutes: 30 }).learning!.grants[0]!;
  const observations: CompanionCapabilityAvailability[] = [];
  const progressReview = vi.fn((data: { purpose: string; proposedText: string; facts: unknown[] }) => {
    expect(data.purpose).toBe('companion_social_progress_review');
    expect(data.proposedText).toBe('只核对了当前授权目录，没有读取或索引资料正文。');
    expect(data.facts).toEqual([]);
    return JSON.stringify({ supported: true, correction: '' });
  });
  let author = 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)), data = JSON.parse(wire.messages.find((item: { role: string }) => item.role === 'user').content);
    let content: string, tool_calls: unknown[] | undefined;
    if (data.purpose === 'world_attention') content = JSON.stringify({ urgency: 'ordinary', confidence: .99, evidence: [data.source.content], reason: '普通测试请求。' });
    else if (data.purpose === 'world_decision') content = JSON.stringify({ action: null, reason: '本机制无世界行为。', appraisals: [] });
    else if (data.purpose === 'companion_social_progress_review') content = progressReview(data);
    else if (data.purpose?.startsWith('vcp_')) content = JSON.stringify({ notes: [] });
    else {
      observations.push(data.capabilityAvailability); author++;
      if (author === 1) currentName = '真实更名后的目录';
      if (author === 2) f.store.request({ type: 'learning.revoke', companionId: 'reader', id: grant.id, expectedRevision: grant.revision });
      if (author === 5) currentName = '独立目标当前更名目录';
      if (author <= 2 || author === 5) { content = ''; tool_calls = [{ id: 'controlled_sources_' + author, type: 'function',
        function: { name: 'memory', arguments: JSON.stringify({ action: 'knowledge', operation: 'sources' }) } }]; }
      else content = '只核对了当前授权目录，没有读取或索引资料正文。';
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: tool_calls ? 'tool_calls' : 'stop' }] }),
      { headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch);
  try {
    const first = await f.send('reader', room.id, '核对我已有资料的当前授权状态。');
    expect(first.answer.id).toBe(first.checkpoint.messageId); expect(first.answer.kind).toBe('text');
    expect(progressReview).toHaveBeenCalledOnce();
    expect(observations).toHaveLength(3);
    expect(observations.map(item => item.nativeKnowledge.authorizedSources.items[0]?.libraryName)).toEqual(['当前已授权目录', '真实更名后的目录', undefined]);
    for (const snapshot of observations) {
      expect(snapshot).toMatchObject({ companionId: 'reader', conversationId: room.id,
        externalExecution: { operation: 'dsh.run', status: 'not_configured' },
        filePerception: { status: 'host_bound_requires_current_source_authorization', requiresSelectedExecutionInstance: false },
        nativeKnowledge: { status: 'bound_not_probed', encoder: 'not_probed', index: 'not_probed' } });
    }
    await f.restart();
    const afterRestart = await f.send('reader', room.id, '继续核对目前授权状态，不沿用旧目录。');
    expect(afterRestart.answer.id).toBe(afterRestart.checkpoint.messageId);
    expect(progressReview).toHaveBeenCalledTimes(2);
    expect(observations.at(-1)!.nativeKnowledge.authorizedSources.items).toEqual([]);
    // Resume a real independent goal with a saved, untrusted old capability
    // snapshot. Its first and subsequent actual inferences must refresh it.
    currentName = '独立目标当前目录';
    const currentGrant = f.store.request({ type: 'learning.grant', companionId: 'reader', libraryId: 'controlled-library',
      libraryName: '已过期名字', libraryPath: path.join(tmpdir(), 'controlled-native-library'), folderId: 'goal-folder',
      folderName: '旧名字', autonomous: false, intervalMinutes: 30 }).learning!.grants.find(item => item.folderId === 'goal-folder')!;
    const source = f.store.appendMessage({ conversationId: room.id, authorId: 'user', content: '独立核对当前已有资料授权，只读目录，不读取正文。', replyDirective: 'none' });
    const goal = '独立核对当前已有资料授权，只读目录，不读取正文。', goalId = 'controlled_current_goal';
    const slot = 'goal_' + createHash('sha256').update('work:' + goalId + ':' + goal).digest('hex');
    const draft = f.store.appendMessage({ conversationId: room.id, authorId: 'reader', replyToId: source.id, content: '', loopStep: 0, replyDirective: 'none' });
    f.store.request({ type: 'loop.save', checkpoint: { companionId: 'reader', conversationId: room.id, sourceMessageId: source.id, invocationKey: slot,
      messageId: draft.id, status: 'running', turns: [], supplements: [], context: { system: '历史快照不是授权。', user: JSON.stringify({
        capabilityAvailability: { companionId: 'reader', conversationId: room.id, nativeKnowledge: { authorizedSources: { items: [{ grantId: 'STALE_CHECKPOINT_GRANT' }] } } } }) } } });
    const runner = f.service as unknown as { runGoal(input: { id: string; kind: 'work'; companionId: string; conversationId: string;
      sourceMessageId: string; authorizationSourceMessageIds: string[]; goal: string }, signal: AbortSignal): Promise<{ status: string; goalSlot?: string }> };
    const result = await runner.runGoal({ id: goalId, kind: 'work', companionId: 'reader', conversationId: room.id, sourceMessageId: source.id,
      authorizationSourceMessageIds: [source.id], goal }, new AbortController().signal);
    expect(result.status).toBe('succeeded'); expect(result.goalSlot).toBe(slot);
    expect(observations.slice(4).map(item => item.nativeKnowledge.authorizedSources.items[0]?.libraryName)).toEqual(['独立目标当前目录', '独立目标当前更名目录']);
    expect(observations.slice(4).every(item => item.nativeKnowledge.authorizedSources.items[0]?.grantId === currentGrant.id)).toBe(true);
    expect(JSON.stringify(observations)).not.toContain('STALE_CHECKPOINT_GRANT');
    expect(f.store.request({ type: 'loop.get', companionId: 'reader', sourceMessageId: source.id, invocationKey: slot }).loop?.status).toBe('done');
    // The two ordinary human turns both passed the real mandatory review.
    // runGoal uses the separate background entry rather than another human reply.
    expect(progressReview).toHaveBeenCalledTimes(2);
    expect(nativeProbe.coldCreated).toBe(coldBefore);
    expect(assets.read).not.toHaveBeenCalled(); expect(assets.page).not.toHaveBeenCalled();
    expect(assets.catalog).not.toHaveBeenCalled();
  } finally { await f.close(true); vi.unstubAllGlobals(); await removeFixtureRoot(f.root); }
});

it('advertises no dispatch tools in the actual non-loop executor feedback provider wire', async () => {
  const f = await realMainFixture('offline_feedback_capability_scope', [{ ...seeds[0]!, active: true }]);
  const observed: unknown[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)), data = JSON.parse(wire.messages.find((item: { role: string }) => item.role === 'user').content);
    expect(wire.tools ?? []).toEqual([]); observed.push(data.capabilityAvailability);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: '实际只读核对已返回，结果是这条真实回执。', memories: [] }) } }] }),
      { headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch);
  try {
    await f.service.handle({ type: 'state' });
    const room = f.store.openPrivate('reader'), source = f.store.appendMessage({ conversationId: room.id, authorId: 'user', content: '请只读核对本次资料。', replyDirective: 'none' });
    const readset = captureCompanionExecutionReadset({ companionId: 'reader', conversationId: room.id }, { context: { user: JSON.stringify({ messages: [source] }) } });
    const action = f.store.request({ type: 'action.create', action: { companionId: 'reader', conversationId: room.id, sourceMessageId: source.id, title: '当前核对', status: 'queued' },
      checkpoint: { prompt: source.content, executionReadset: readset, supplements: [], waitForActionIds: [] } }).action!;
    const done = f.store.request({ type: 'action.update', id: action.id, patch: { status: 'succeeded', result: '本次真实测试回执。' } }).action!;
    await (f.service as unknown as { feedbackAction(action: typeof done, status: 'succeeded', content: string): Promise<void> })
      .feedbackAction(done, 'succeeded', '本次真实测试回执。');
    expect(observed).toEqual([{ companionId: 'reader', conversationId: room.id, boundToolNames: [],
      status: 'only_these_immediate_tools_bound_in_this_entry', otherDomains: 'not_advertised_as_immediate_tools_here',
      finalProposalAuthority: '领域最终提案仅在本次executionContract/outputSchema明确提供时独立可用，须由宿主核验执行；此目录不新增授权。' }]);
    expect(f.store.messages({ conversationId: room.id }).messages.some(message => message.kind === 'text' && message.replyToId === source.id && message.content.includes('真实回执'))).toBe(true);
  } finally { await f.close(true); vi.unstubAllGlobals(); await removeFixtureRoot(f.root); }
});

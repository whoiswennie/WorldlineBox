import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { companionAttestedMemoryFileInputs, verifyCompanionExecutionReadset, type CompanionAttestedMemoryFiles } from '../../src/main/companions/execution-evidence';
import { validateCompanionMemoryFileContext } from '../../src/main/companions/memory-file-context-validation';
import { guardCompanionExecutionSources, withCompanionExecutionValidation } from '../../src/main/companions/source-execution-evidence';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionMessage } from '../../src/shared/companions';
import { CompanionService } from '../../src/main/companions/service';

const fixtures: Array<ReturnType<typeof managedMemoryFiles>> = [];
afterEach(async () => { for (const f of fixtures.splice(0).reverse()) await f.close(); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture(extraNotes = 0) {
  const f = managedMemoryFiles(); fixtures.push(f);
  const note = f.record('正式当前正文，有准确原始来源。'), notes = [note, ...Array.from({ length: extraNotes }, (_, index) => f.record('其他正式正文 ' + index))]; await f.publish();
  const { receipts } = await f.live.materialize('alice', notes);
  const context = { revision: 'actual-corpus', profileKey: 'actual-profile', fileReceiptOnly: true as const, fileReceipts: receipts };
  const initialProof: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', ...f.scope, complete: true,
    sources: [], memories: [], knowledgeReads: [], topics: [], contexts: [context], frozenMemories: notes.map(note => ({ id: note.id, contentRevision: note.contentRevision,
      sources: note.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum })) })) };
  const message = f.store.appendMessage({ conversationId: f.scope.conversationId, authorId: 'alice', content: '这条正式回复使用了该记忆。', executionReadset: initialProof });
  const stored = f.store.request({ type: 'execution.sources', sourceMessageIds: [message.id] }).executionSources!.find(value => value.id === message.id)!;
  expect(stored.storageValidatedReadsetDigest).toBe(hash(JSON.stringify(stored.executionReadset)));
  expect(stored.storageValidatedAuthorityEpoch).toBeTypeOf('number');
  const proof = stored.executionReadset!;
  const rawCommands: CompanionStorageCommand[] = [];
  const raw = async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => { rawCommands.push(command); return f.store.request(command); };
  const full = vi.fn(() => f.live.validate('alice', receipts));
  const physical = vi.spyOn(f.live, 'validateAttested'), requireAssets = vi.fn(async () => undefined);
  const host = Object.assign(Object.create(CompanionService.prototype), { liveFiles: f.live, storage: { request: raw }, requireCurrentAssets: requireAssets }) as {
    memoryFilesAttestedValid(authority: CompanionAttestedMemoryFiles): Promise<boolean | undefined>;
  };
  const fast = vi.fn((authority: CompanionAttestedMemoryFiles) => host.memoryFilesAttestedValid(authority));
  const contextValid: NonNullable<Parameters<typeof verifyCompanionExecutionReadset>[2]['contextValid']> = (scope, value, authority) =>
    validateCompanionMemoryFileContext(scope, value, { identity: f.store, request: raw, validate: full, fallback: full,
      attestedFiles: authority, validateAttested: fast });
  const verify = (value = proof, attested = true, readContext = contextValid) => verifyCompanionExecutionReadset(value, f.scope,
    { request: raw, sqliteSourcesValidated: attested, memoryFileAttestation: { readsetDigest: hash(JSON.stringify(value)), authorityEpoch: stored.storageValidatedAuthorityEpoch! }, contextValid: readContext });
  const gate = (target: CompanionMessage = message) => guardCompanionExecutionSources({ type: 'message.get', id: target.id }, { ok: true, message: target }, {
    storage: raw, identity: f.store, revision: () => 0,
    valid: (current, attested) => verifyCompanionExecutionReadset(current.executionReadset, current,
      { request: raw, sqliteSourcesValidated: attested, memoryFileAttestation: { readsetDigest: current.storageValidatedReadsetDigest!, authorityEpoch: current.storageValidatedAuthorityEpoch! }, contextValid }),
  });
  f.commands.length = 0;
  return { f, note, notes, receipts, context, proof, message, raw, rawCommands, full, fast, physical, requireAssets, contextValid, verify, gate };
}

function publishReadset(t: Awaited<ReturnType<typeof fixture>>, indexes: number[], options: { conversationId?: string; beforeSequence?: number; revision?: string } = {}) {
  const proof = structuredClone(t.proof);
  proof.conversationId = options.conversationId ?? proof.conversationId;
  proof.beforeSequence = options.beforeSequence;
  proof.contexts[0] = { ...proof.contexts[0]!, revision: options.revision ?? 'subset:' + indexes.join(','), beforeSequence: options.beforeSequence,
    fileReceipts: indexes.map(index => t.receipts[index]!) };
  proof.frozenMemories = indexes.map(index => t.proof.frozenMemories![index]!);
  return t.f.store.appendMessage({ conversationId: proof.conversationId, authorId: 'alice', content: '正式读取子集 ' + indexes.join(','), executionReadset: proof });
}

it('uses actual worker-attested current coverage and canonical files without reentering guarded note admission', async () => {
  const t = await fixture();
  const result = await t.gate(); expect(result.message?.content).toBe(t.message.content);
  expect(t.fast).toHaveBeenCalledOnce(); expect(t.full).not.toHaveBeenCalled();
  expect(t.f.commands.filter(command => command.type === 'memory.records.filter')).toHaveLength(0);
  expect(t.rawCommands.filter(command => command.type === 'memory.records.filter').length).toBeGreaterThanOrEqual(4);
  expect(t.f.commands.some(command => command.type === 'cognition.registry.read')).toBe(true);
  expect(t.rawCommands.filter(command => command.type === 'execution.sources')).toHaveLength(2);
});

it('validates only c after independently attested [a,b] and [a,c] contexts in one finite gate', async () => {
  const t = await fixture(2), ab = publishReadset(t, [0, 1]), ac = publishReadset(t, [0, 2]);
  await withCompanionExecutionValidation(async () => {
    expect((await t.gate(ab)).message?.content).toBe(ab.content);
    expect((await t.gate(ac)).message?.content).toBe(ac.content);
  });
  expect(t.physical.mock.calls.map(call => call[2]?.map(receipt => receipt.noteId))).toEqual([
    [t.notes[0]!.id, t.notes[1]!.id], [t.notes[2]!.id],
  ]);
  expect(t.rawCommands.filter(command => command.type === 'execution.sources').at(-1)).toMatchObject({ sourceMessageIds: expect.arrayContaining([ab.id, ac.id]) });
  expect(t.full).not.toHaveBeenCalled();
});

it('shares only the physical file across different lawful entrances and cursors while retaining both outer SQL proofs', async () => {
  const t = await fixture(), room = t.f.store.createConversation('真实独立群入口', ['alice', 'bob']);
  const own = publishReadset(t, [0], { beforeSequence: 1000 }), group = publishReadset(t, [0], { conversationId: room.id, beforeSequence: 1001 });
  await withCompanionExecutionValidation(async () => {
    expect((await t.gate(own)).message?.content).toBe(own.content);
    expect((await t.gate(group)).message?.content).toBe(group.content);
  });
  expect(t.fast).toHaveBeenCalledTimes(2); expect(t.physical).toHaveBeenCalledOnce();
  expect(t.rawCommands.filter(command => command.type === 'execution.sources').at(-1)).toMatchObject({ sourceMessageIds: expect.arrayContaining([own.id, group.id]) });
});

it('does not memoize an inapplicable current-file batch before a later context retries its exact receipt', async () => {
  const t = await fixture(), first = publishReadset(t, [0], { revision: 'first-context' }), next = publishReadset(t, [0], { revision: 'next-context' });
  t.physical.mockResolvedValueOnce(undefined);
  await withCompanionExecutionValidation(async () => {
    expect((await t.gate(first)).message?.content).toBe(first.content);
    expect((await t.gate(next)).message?.content).toBe(next.content);
  });
  expect(t.physical).toHaveBeenCalledTimes(2); expect(t.full).toHaveBeenCalledOnce();
});

it('checks cancellation before a completed file memo and reopens files at the next independent gate', async () => {
  const t = await fixture(), first = publishReadset(t, [0], { revision: 'before-cancel' }), next = publishReadset(t, [0], { revision: 'after-cancel' });
  const controller = new AbortController(), reason = new Error('actual_user_stop');
  await expect(withCompanionExecutionValidation(async () => {
    expect((await t.gate(first)).message?.content).toBe(first.content);
    controller.abort(reason); await t.gate(next);
  }, controller.signal)).rejects.toBe(reason);
  expect(t.physical).toHaveBeenCalledOnce();
  expect((await t.gate(next)).message?.content).toBe(next.content);
  expect(t.physical).toHaveBeenCalledTimes(2);
});

it.each(['noteId', 'path', 'contentHash'] as const)('refuses an added or changed %s when a caller selects an attested token subset', async field => {
  const t = await fixture();
  expect(await withCompanionExecutionValidation(() => t.verify(t.proof, true, async (scope, value, authority) => {
    const invalid = { ...t.receipts[0]!, [field]: field === 'contentHash' ? '0'.repeat(64) : 'uncovered' };
    const before = t.rawCommands.length;
    expect(await t.f.live.validateAttested(authority!, t.raw, [t.receipts[0]!, invalid])).toBe(false);
    expect(t.rawCommands).toHaveLength(before);
    return t.contextValid(scope, value, authority);
  }))).toBe(true);
});

it('does not promote a strong success to the same weak context within one finite gate', async () => {
  const t = await fixture();
  await withCompanionExecutionValidation(async () => { expect(await t.verify()).toBe(true); expect(await t.verify(t.proof, false)).toBe(true); });
  expect(t.fast).toHaveBeenCalledOnce(); expect(t.full).toHaveBeenCalledOnce();
  expect(t.f.commands.some(command => command.type === 'memory.records.filter')).toBe(true);
});

it('admits the ordinary full path independently while an equivalent strong validation is still pending', async () => {
  const t = await fixture(); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  await withCompanionExecutionValidation(async () => {
    const pending = t.verify(t.proof, true, (scope, value, authority) => validateCompanionMemoryFileContext(scope, value,
      { identity: t.f.store, request: t.raw, validate: t.full, fallback: t.full, attestedFiles: authority,
        validateAttested: async token => { entered(); await wait; return t.fast(token); } }));
    await started;
    try { expect(await t.verify(t.proof, false)).toBe(true); expect(t.full).toHaveBeenCalledOnce(); }
    finally { release(); }
    expect(await pending).toBe(true);
  });
});

it('keeps legacy digest-only proofs without a hard authority epoch on the full path', async () => {
  const t = await fixture();
  expect(await withCompanionExecutionValidation(() => verifyCompanionExecutionReadset(t.proof, t.f.scope,
    { request: t.raw, sqliteSourcesValidated: true, contextValid: t.contextValid }))).toBe(true);
  expect(t.fast).not.toHaveBeenCalled(); expect(t.full).toHaveBeenCalledOnce();
});

it('does not reuse a completed strong context with a different captured source set', async () => {
  const t = await fixture(), changed = structuredClone(t.proof); changed.frozenMemories![0]!.sources[0]!.checksum = '0'.repeat(64);
  const keys: string[][] = [];
  const read: typeof t.contextValid = (scope, value, authority) => { keys.push(companionAttestedMemoryFileInputs(authority!)!.keys); return t.contextValid(scope, value, authority); };
  await withCompanionExecutionValidation(async () => { expect(await t.verify(t.proof, true, read)).toBe(true); expect(await t.verify(changed, true, read)).toBe(true); });
  expect(keys[0]).not.toEqual(keys[1]);
  expect(t.fast).toHaveBeenCalledOnce(); expect(t.full).toHaveBeenCalledOnce();
});

it.each(['missing', 'revision', 'owner', 'source', 'extra_source'] as const)('keeps incomplete or differently bound %s coverage on the full path', async changed => {
  const t = await fixture(), proof = structuredClone(t.proof), frozen = proof.frozenMemories![0]!;
  if (changed === 'missing') proof.frozenMemories = [];
  if (changed === 'revision') frozen.contentRevision!++;
  if (changed === 'owner') proof.contexts[0]!.fileReceipts![0]!.companionId = 'bob';
  if (changed === 'source') frozen.sources[0]!.checksum = '0'.repeat(64);
  if (changed === 'extra_source') frozen.sources.push({ ...frozen.sources[0]!, id: 'unread_source' });
  const valid = await withCompanionExecutionValidation(() => t.verify(proof));
  expect(t.fast).not.toHaveBeenCalled();
  if (changed === 'owner') expect(valid).toBe(false);
  else { expect(valid).toBe(true); expect(t.full).toHaveBeenCalledOnce(); }
});

it('expires the internal token when its context callback completes and rejects a fabricated token', async () => {
  const t = await fixture(); let captured: CompanionAttestedMemoryFiles | undefined;
  expect(await withCompanionExecutionValidation(() => t.verify(t.proof, true, async (scope, value, authority) => {
    captured = authority; expect(companionAttestedMemoryFileInputs(authority!)).toBeDefined(); return t.contextValid(scope, value, authority);
  }))).toBe(true);
  expect(captured).toBeDefined(); expect(companionAttestedMemoryFileInputs(captured!)).toBeUndefined();
  expect(await t.f.live.validateAttested(captured!, t.raw)).toBe(false);
  expect(await t.f.live.validateAttested({} as CompanionAttestedMemoryFiles, t.raw)).toBe(false);
});

it.each(['body', 'source'] as const)('reopens actual %s bytes at a new strong gate and refuses same-length tampering', async changed => {
  const t = await fixture(); expect((await t.gate()).message?.content).toBe(t.message.content);
  const target = changed === 'body' ? t.f.noteFile(t.note) : t.f.file(`证据/来源/${t.note.sources[0]!.messageId}.r${t.note.sources[0]!.revision}.md`);
  if (changed === 'body') await writeFile(target, t.note.content.replace('正式', '外部'), 'utf8');
  else {
    const registry = await t.f.artifacts('alice'), source = await registry.get(`source:${t.note.sources[0]!.messageId}:r${t.note.sources[0]!.revision}`);
    expect(source).toBeDefined(); await writeFile(t.f.file(source!.relativePath), '外部改写的原始来源。', 'utf8');
  }
  const result = await t.gate(); expect(result.message?.content).not.toBe(t.message.content);
});

it('withholds a consumed proof when source withdrawal happens after canonical validation but before the fresh final SQL fence', async () => {
  const t = await fixture();
  await expect(withCompanionExecutionValidation(async () => {
    expect(await t.verify()).toBe(true);
    t.f.store.request({ type: 'memory.forget', ...t.f.scope, id: t.note.id });
  })).rejects.toThrow();
});

it.each(['body', 'source'] as const)('keeps the final fresh %s byte fence after the strong token lease expires', async changed => {
  const t = await fixture();
  const source = await (await t.f.artifacts('alice')).get(`source:${t.note.sources[0]!.messageId}:r${t.note.sources[0]!.revision}`);
  await expect(withCompanionExecutionValidation(async () => {
    expect(await t.verify()).toBe(true);
    await writeFile(changed === 'body' ? t.f.noteFile(t.note) : t.f.file(source!.relativePath), 'token过期后的外部改写。', 'utf8');
  })).rejects.toThrow();
});

it('rechecks original source ACL and never makes a withdrawn note visible through the raw authority port', async () => {
  const t = await fixture(); expect((await t.gate()).message?.content).toBe(t.message.content);
  t.f.store.request({ type: 'memory.forget', ...t.f.scope, sourceMessageIds: t.note.sources.map(source => source.messageId) });
  expect((await t.gate()).message?.content).not.toBe(t.message.content);
});

it('uses full historical admission after an ordinary revision, preserving the independently lawful captured body', async () => {
  const t = await fixture();
  const source = t.f.source('后来有了新的独立依据。');
  t.f.store.request({ type: 'memory.revise', ...t.f.scope, id: t.note.id, expectedVersion: t.note.version,
    candidate: t.f.candidate('采用新依据的当前修订。', [source.id]) }); t.f.index(); await t.f.publish();
  const result = await t.gate(); expect(result.message?.content).toBe(t.message.content);
  expect(t.fast).not.toHaveBeenCalled(); expect(t.full).toHaveBeenCalledOnce();
});

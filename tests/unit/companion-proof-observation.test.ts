import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { captureCompanionExecutionReadset, verifyCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { companionPublishedMessageParsedReadset, createCompanionExecutionValidationSession,
  currentCompanionExecutionValidationIdentity, guardCompanionExecutionSources, type CompanionExecutionSourceProof,
  type CompanionPublishedMessageContexts } from '../../src/main/companions/source-execution-evidence';
import { companionExecutionReadsetSchema } from '../../src/shared/companion-execution-evidence';
import { messageSchema } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

afterEach(() => vi.restoreAllMocks());
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const scope = { companionId: 'fish', conversationId: 'room', beforeSequence: 20 };
const message = (id = 'reply') => messageSchema.parse({ id, revision: 1, sequence: 10, authorId: 'fish', conversationId: 'room',
  kind: 'text', content: `Published ${id}`, status: 'sent', createdAt: '2026-10-31T00:00:00.000Z', attachments: [] });
function published(id = 'reply', roots = [id]): CompanionExecutionSourceProof {
  const executionReadset = captureCompanionExecutionReadset(scope, { contexts: [{ revision: 'exact', profileKey: 'canonical', beforeSequence: 20,
    fileReceiptOnly: true, fileReceipts: [{ companionId: 'fish', noteId: 'note', contentRevision: 1,
      contentHash: hash('Fact'), path: '记忆/经历/note.md' }] }] });
  const publicationCandidate = { policyVersion: 1 as const, companionId: 'fish', conversationId: 'room', messageId: id, messageRevision: 1,
    bodySHA: hash(message(id).content), readsetDigest: hash('canonical stored readset'), contextClosureDigest: hash('full historical context') };
  return { kind: 'message', id, companionId: 'fish', conversationId: 'room', sourceMessageIds: roots, executionReadset,
    storageValidatedAuthorityEpoch: 1, storageValidatedReadsetDigest: hash(JSON.stringify(executionReadset)), publicationCandidate,
    publicationCertificate: { ...publicationCandidate, mode: 'revalidated_historical', certifiedAt: '2026-10-31T00:00:00.000Z' },
    publishedDependencyCut: { generation: 1, bindingHash: hash('closed SQL dependency index'), assetOwners: ['fish'], volatileActions: [] } };
}
function fixture(values = [published()]) {
  const session = createCompanionExecutionValidationSession(), identity = {};
  const storage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'execution.sources') return { ok: true, executionSources: values };
    if (command.type === 'execution.invalidate') return { ok: true };
    if (command.type === 'messages') return { ok: true, messages: [] };
    throw new Error(`Unexpected fixture request ${command.type}`);
  });
  const contextValid = vi.fn(async () => false);
  const verify = (proof: CompanionExecutionSourceProof, sqlite?: boolean, token?: CompanionPublishedMessageContexts) =>
    verifyCompanionExecutionReadset(proof.executionReadset, proof, { request: storage, contextValid, sqliteSourcesValidated: sqlite, publishedFileContexts: token });
  const read = (valid = verify, rows = [message()]) => guardCompanionExecutionSources({ type: 'messages', conversationId: 'room' },
    { ok: true, messages: rows }, { identity, storage, revision: () => 0, valid });
  return { session, storage, read, verify, contextValid, values };
}

it('parses a certified exact message once and shares only its private frozen input during the awaited validator', async () => {
  const f = fixture(), original = f.values[0]!, parse = vi.spyOn(companionExecutionReadsetSchema, 'safeParse');
  let captured: CompanionPublishedMessageContexts | undefined, admitted: CompanionExecutionSourceProof | undefined;
  try {
    const result = await f.session.run(() => f.read(async (proof, sqlite, token) => {
      admitted = proof; captured = token;
      expect(proof).not.toBe(original); expect(Object.isFrozen(proof)).toBe(true);
      expect(Object.isFrozen(proof.executionReadset!.contexts[0]!.fileReceipts)).toBe(true);
      expect(companionPublishedMessageParsedReadset(token, proof.executionReadset, scope)).toBe(proof.executionReadset);
      expect(await f.verify(proof, sqlite, token)).toBe(true);
      return f.verify(proof, sqlite, token);
    }));
    expect(result.messages?.[0]?.content).toBe(message().content); expect(parse).toHaveBeenCalledOnce();
    expect(Object.isFrozen(original)).toBe(false); expect(Object.isFrozen(original.executionReadset)).toBe(false);
    expect(companionPublishedMessageParsedReadset(captured, admitted!.executionReadset, scope)).toBeUndefined();
    expect(await f.verify(admitted!, true, captured)).toBe(false); // Retired token must perform the ordinary current-file check.
    expect(f.contextValid).toHaveBeenCalledOnce();
    await f.session.validate();
    expect(f.storage.mock.calls.filter(([command]) => command.type === 'execution.sources')).toHaveLength(2);
  } finally { f.session.close(); }
});

it('does not let a forged, foreign-scope or copied-input token reuse the parsed historical input', async () => {
  const f = fixture();
  try {
    await f.session.run(() => f.read(async (proof, sqlite, token) => {
      expect(companionPublishedMessageParsedReadset({} as CompanionPublishedMessageContexts, proof.executionReadset, scope)).toBeUndefined();
      expect(companionPublishedMessageParsedReadset(token, structuredClone(proof.executionReadset), scope)).toBeUndefined();
      expect(companionPublishedMessageParsedReadset(token, proof.executionReadset, { ...scope, companionId: 'other' })).toBeUndefined();
      expect(companionPublishedMessageParsedReadset(token, proof.executionReadset, { ...scope, beforeSequence: 19 })).toBeUndefined();
      expect(await f.verify(proof, sqlite, {} as CompanionPublishedMessageContexts)).toBe(false);
      expect(await verifyCompanionExecutionReadset(structuredClone(proof.executionReadset), proof, { sqliteSourcesValidated: sqlite,
        publishedFileContexts: token, request: f.storage, contextValid: f.contextValid })).toBe(false);
      return f.verify(proof, sqlite, token);
    }));
    expect(f.contextValid).toHaveBeenCalledTimes(2); await f.session.validate();
  } finally { f.session.close(); }
});

it.each(['incomplete', 'corrupt', 'weak', 'action'] as const)('retains ordinary rejection or full validation for %s proofs', async kind => {
  const raw = published();
  if (kind === 'incomplete') raw.executionReadset!.complete = false;
  if (kind === 'corrupt') Object.defineProperty(raw.executionReadset!, 'schema', { value: 'untrusted-v0', enumerable: true });
  if (kind === 'weak') delete raw.storageValidatedAuthorityEpoch;
  if (kind === 'action') raw.kind = 'action';
  raw.storageValidatedReadsetDigest = hash(JSON.stringify(raw.executionReadset));
  const f = fixture([raw]);
  try {
    const result = await f.session.run(() => f.read(async (proof, sqlite, token) => {
      if (kind === 'weak' || kind === 'action') expect(companionPublishedMessageParsedReadset(token, proof.executionReadset, scope)).toBeUndefined();
      return f.verify(proof, sqlite, token);
    }));
    expect(result.messages?.some(item => item.content === message().content)).toBe(false);
    expect(f.storage.mock.calls.some(([command]) => command.type === 'execution.invalidate')).toBe(true);
    expect(f.contextValid).toHaveBeenCalledTimes(kind === 'weak' || kind === 'action' ? 1 : 0);
  } finally { f.session.close(); }
});

it('does not let a validator mutate its admitted snapshot and never freezes the raw storage packet', async () => {
  const f = fixture();
  try {
    await expect(f.session.run(() => f.read(async proof => {
      proof.executionReadset!.complete = false;
      return true;
    }))).rejects.toThrow(TypeError);
    expect(f.values[0]!.executionReadset!.complete).toBe(true);
    expect(Object.isFrozen(f.values[0]!.executionReadset)).toBe(false);
  } finally { f.session.close(); }
});

it('does not treat an externally shallow-frozen action as a private immutable observation', async () => {
  const raw = published(); raw.kind = 'action';
  delete raw.publicationCandidate; delete raw.publicationCertificate; delete raw.publishedDependencyCut; delete raw.storageValidatedAuthorityEpoch;
  Object.freeze(raw);
  let generation = 0, reads = 0;
  const storage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type !== 'execution.sources') throw new Error('A healthy action must not be invalidated.');
    return { ok: true, executionSources: [++reads === 1 ? raw : Object.freeze({ ...raw,
      storageValidatedReadsetDigest: hash(JSON.stringify(raw.executionReadset)) })] };
  });
  const valid = vi.fn(async () => {
    if (generation === 0) { raw.executionReadset!.contexts[0]!.revision = 'fresh action input'; generation++; }
    return true;
  });
  const session = createCompanionExecutionValidationSession();
  try {
    const result = await session.run(() => guardCompanionExecutionSources({ type: 'messages', conversationId: 'room' },
      { ok: true, messages: [message()] }, { storage, valid, revision: () => generation }));
    expect(result.messages?.[0]?.content).toBe(message().content);
    expect(valid).toHaveBeenCalledTimes(2); expect(reads).toBe(3);
    await session.validate();
  } finally { session.close(); }
});

it.each(['readset', 'candidate', 'certificate', 'root'] as const)('describes a fresh final packet and rejects a changed %s', async field => {
  const f = fixture();
  try {
    await f.session.run(() => f.read());
    const raw = f.values[0]!;
    if (field === 'readset') { raw.executionReadset!.contexts[0]!.revision = 'changed'; raw.storageValidatedReadsetDigest = hash(JSON.stringify(raw.executionReadset)); }
    if (field === 'candidate') raw.publicationCandidate!.bodySHA = hash('other body');
    if (field === 'certificate') delete raw.publicationCertificate;
    if (field === 'root') raw.sourceMessageIds = ['different_root'];
    await expect(f.session.validate()).rejects.toThrow();
    expect(f.storage.mock.calls.filter(([command]) => command.type === 'execution.sources')).toHaveLength(2);
  } finally { f.session.close(); }
});

it('retains all exact root associations when two roots share the same certified historical ancestor', async () => {
  const roots = ['left', 'right'], values = [published('ancestor', roots)], f = fixture(values);
  try {
    const result = await f.session.run(() => f.read(undefined, roots.map(message)));
    expect(result.messages?.map(item => item.id)).toEqual(roots);
    await f.session.validate();
    const final = f.storage.mock.calls.filter(([command]) => command.type === 'execution.sources').at(-1)![0];
    expect(final.type === 'execution.sources' && final.sourceMessageIds).toEqual(roots);
  } finally { f.session.close(); }
});

it('exposes an opaque identity only for the same active unsealed finite frame', async () => {
  const a = createCompanionExecutionValidationSession(), b = createCompanionExecutionValidationSession();
  expect(currentCompanionExecutionValidationIdentity()).toBeUndefined();
  try {
    const identity = await a.run(async () => {
      const value = currentCompanionExecutionValidationIdentity(); expect(Object.isFrozen(value)).toBe(true);
      expect(currentCompanionExecutionValidationIdentity()).toBe(value); return value;
    });
    expect(await b.run(async () => currentCompanionExecutionValidationIdentity())).not.toBe(identity);
    await a.run(async () => { await a.validate(); expect(currentCompanionExecutionValidationIdentity()).toBeUndefined(); });
    await expect(a.run(async () => currentCompanionExecutionValidationIdentity())).rejects.toMatchObject({ name: 'AbortError' });
  } finally { a.close(); b.close(); }
});

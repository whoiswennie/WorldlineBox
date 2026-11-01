import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { captureCompanionExecutionReadset, verifyCompanionExecutionReadset } from '../../src/main/companions/execution-evidence';
import { companionPublishedMessageCertified, createCompanionExecutionValidationSession, guardCompanionExecutionSources,
  memoCompanionExecutionAdmission, memoCompanionExecutionAuthorities, memoCompanionExecutionWitnesses,
  type CompanionExecutionSourceProof, type CompanionPublishedMessageContexts } from '../../src/main/companions/source-execution-evidence';
import { messageSchema } from '../../src/shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';
import type { CompanionMessagePublicationCandidate } from '../../src/shared/companion-message-publication';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const scope = { companionId: 'fish', conversationId: 'room', beforeSequence: 20 };
function message(id: string) { return messageSchema.parse({ id, revision: 1, sequence: 10, authorId: 'fish', conversationId: 'room',
  kind: 'text', content: `Published ${id}`, status: 'sent', createdAt: '2026-10-31T00:00:00.000Z', attachments: [] }); }
function proof(id = 'reply', roots = ['reply']): CompanionExecutionSourceProof {
  const executionReadset = captureCompanionExecutionReadset(scope, { frozenMemories: [{ id: 'note', contentRevision: 1,
    sources: [{ id: 'original', conversationId: 'room', checksum: hash('Original') }] }], contexts: [{ revision: 'exact', profileKey: 'canonical',
    beforeSequence: 20, fileReceiptOnly: true, fileReceipts: [{ companionId: 'fish', noteId: 'note', contentRevision: 1,
      contentHash: hash('Fact'), path: '记忆/经历/note.md' }] }] });
  const publicationCandidate: CompanionMessagePublicationCandidate = { policyVersion: 1, companionId: scope.companionId,
    conversationId: scope.conversationId, messageId: id, messageRevision: 1,
    bodySHA: hash(message(id).content), readsetDigest: hash('Worker canonical typed readset'), contextClosureDigest: hash('Worker exact history closure') };
  // The new certificate digest intentionally differs from the legacy worker
  // SQL digest. Main echoes the issued tuple and never hashes stored JSON.
  return { kind: 'message', id, companionId: scope.companionId, conversationId: scope.conversationId, executionReadset,
    sourceMessageIds: roots, storageValidatedAuthorityEpoch: 1, storageValidatedReadsetDigest: hash(JSON.stringify(executionReadset)), publicationCandidate };
}
function certified(value: CompanionExecutionSourceProof): CompanionExecutionSourceProof {
  if (!value.publicationCandidate) throw new Error('Fixture needs an issued candidate.');
  return { ...value, publicationCertificate: { ...value.publicationCandidate, mode: 'revalidated_historical', certifiedAt: '2026-10-31T00:00:00.000Z' } };
}
function fixture(proofs: CompanionExecutionSourceProof[] = [proof()], failure?: string) {
  const events: string[] = [], controller = new AbortController(), identity = {}, certificates = vi.fn(async () => { events.push('certify'); });
  let reads = 0;
  const storage = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    if (command.type === 'execution.sources') {
      events.push(++reads === 1 ? 'source-initial' : 'source-final');
      if (reads > 1 && failure === 'source') throw new Error('source final failed');
      return { ok: true, executionSources: proofs };
    }
    if (command.type === 'execution.invalidate') return { ok: true };
    if (command.type === 'messages') return { ok: true, messages: proofs.filter(item => item.sourceMessageIds.includes(item.id)).map(item => message(item.id)) };
    throw new Error('Unexpected fixture command.');
  });
  const contextValid = vi.fn(async () => true);
  const valid = vi.fn(async (value: CompanionExecutionSourceProof, sqliteSourcesValidated?: boolean, publishedFileContexts?: CompanionPublishedMessageContexts) =>
    verifyCompanionExecutionReadset(value.executionReadset, value, { sqliteSourcesValidated, publishedFileContexts, contextValid, request: storage }));
  const session = createCompanionExecutionValidationSession(controller.signal);
  const read = (messages = [message('reply')], verifier = valid) => guardCompanionExecutionSources({ type: 'messages', conversationId: 'room' },
    { ok: true, messages }, { identity, revision: () => 0, storage, valid: verifier, certifyPublications: certificates });
  const final = (name: string) => async () => {
    events.push(name);
    if (failure === 'abort' && name === 'asset') controller.abort();
    if (failure === name) throw new Error(`${name} final failed`);
  };
  const fences = async () => {
    await memoCompanionExecutionWitnesses(['file'], { identity, scope: 'file', revision: () => 0,
      read: async () => new Map([['file', true]]), verify: final('file') });
    await memoCompanionExecutionAdmission('asset', { identity, read: async () => true, cacheable: () => true, verify: final('asset') });
    await memoCompanionExecutionWitnesses(['sql'], { identity, scope: 'sql', phase: 'sql-authority', revision: () => 0,
      read: async () => new Map([['sql', true]]), verify: final('sql') });
    let calls = 0;
    await memoCompanionExecutionAuthorities([{ kind: 'action', id: 'action', ...scope, sourceMessageIds: ['reply'] }], async values => {
      if (++calls > 1) await final('authority')();
      return new Map(values.map(value => [value.id, true]));
    }, identity);
  };
  return { proofs, events, controller, identity, certificates, storage, contextValid, valid, session, read, fences };
}

it('certifies only after every final fence, echoing Worker scalars once for repeated consumed history', async () => {
  const f = fixture();
  try {
    await f.session.run(async () => { await f.read(); await f.read(); await f.fences(); });
    expect(f.certificates).not.toHaveBeenCalled();
    await f.session.validate();
    expect(f.events.slice(-6)).toEqual(['file', 'asset', 'sql', 'source-final', 'authority', 'certify']);
    expect(f.certificates).toHaveBeenCalledExactlyOnceWith([{ ...f.proofs[0]!.publicationCandidate, mode: 'revalidated_historical' }]);
  } finally { f.session.close(); }
});

it.each(['file', 'asset', 'sql', 'source', 'authority', 'abort'])('mints no certificate when the %s final fence fails or aborts', async failure => {
  const f = fixture([proof()], failure);
  try {
    await f.session.run(async () => { await f.read(); await f.fences(); });
    await expect(f.session.validate()).rejects.toThrow();
    expect(f.certificates).not.toHaveBeenCalled();
  } finally { f.session.close(); }
});

it('echoes only actual successful action headers after all final gates, and never on a failed final gate', async () => {
  const action = (id: string, roots: string[]): CompanionExecutionSourceProof => ({ ...proof(id, roots), kind: 'action', publicationCandidate: undefined,
    storageActionBinding: { id, companionId: scope.companionId, conversationId: scope.conversationId,
      actionBindingHash: hash(id + ' formal action'), readsetDigest: hash(id + ' typed checkpoint') } });
  for (const failure of [undefined, 'asset']) {
    const expected = action('task', ['reply']), unused = action('unused', ['bad']);
    const f = fixture([proof(), expected, proof('bad', ['bad']), unused], failure);
    try {
      await f.session.run(async () => {
        await f.read([message('reply'), message('bad')], vi.fn(async value => value.id !== 'bad'));
        await f.fences();
      });
      expect(f.certificates).not.toHaveBeenCalled();
      if (failure) { await expect(f.session.validate()).rejects.toThrow(); expect(f.certificates).not.toHaveBeenCalled(); }
      else {
        await f.session.validate();
        expect(f.certificates).toHaveBeenCalledExactlyOnceWith([{ ...f.proofs[0]!.publicationCandidate, mode: 'revalidated_historical' }], [expected.storageActionBinding]);
      }
    } finally { f.session.close(); }
  }
});

it('does not certify a rejected sibling or its otherwise healthy unconsumed ancestors', async () => {
  const f = fixture([proof('reply'), proof('bad', ['bad']), proof('bad_ancestor', ['bad'])]);
  try {
    await f.session.run(async () => {
      const result = await f.read([message('reply'), message('bad')], vi.fn(async value => value.id !== 'bad'));
      expect(result.messages?.find(value => value.id === 'bad')?.content).toBe('');
      expect(result.messages?.find(value => value.id === 'reply')?.content).toBe(message('reply').content);
    });
    await f.session.validate();
    expect(f.certificates).toHaveBeenCalledExactlyOnceWith([{ ...f.proofs[0]!.publicationCandidate, mode: 'revalidated_historical' }]);
  } finally { f.session.close(); }
});

it('uses a current exact certificate only for its awaited historical contexts, retaining direct and action checks', async () => {
  const actual = certified(proof()), f = fixture([actual]);
  let captured: CompanionPublishedMessageContexts | undefined;
  const verifier = vi.fn(async (value: CompanionExecutionSourceProof, sqlite?: boolean, authority?: CompanionPublishedMessageContexts) => {
    captured = authority;
    return verifyCompanionExecutionReadset(value.executionReadset, value, { sqliteSourcesValidated: sqlite, publishedFileContexts: authority,
      contextValid: f.contextValid, request: f.storage });
  });
  try {
    await f.session.run(async () => {
      await f.read(undefined, verifier);
      expect(f.contextValid).not.toHaveBeenCalled();
      expect(await verifyCompanionExecutionReadset(actual.executionReadset, actual, { sqliteSourcesValidated: true,
        publishedFileContexts: captured, contextValid: f.contextValid, request: f.storage })).toBe(true);
      expect(f.contextValid).toHaveBeenCalledOnce(); // The awaited token is already retired.
      const action = { ...actual, kind: 'action' as const };
      expect(companionPublishedMessageCertified(action)).toBe(false);
      expect(await verifyCompanionExecutionReadset(action.executionReadset, action, { sqliteSourcesValidated: true,
        contextValid: f.contextValid, request: f.storage })).toBe(true);
      expect(f.contextValid).toHaveBeenCalledTimes(2);
    });
    await f.session.validate();
    // A current exact certificate still uses the original fresh source and
    // live gates, but a non-applicable index must not reissue it on each read.
    expect(f.certificates).not.toHaveBeenCalled();
    expect(verifier).toHaveBeenCalledOnce();
    expect(f.events).toContain('source-final');
  } finally { f.session.close(); }
});

it.each(['body', 'readset', 'room', 'policy'] as const)('keeps the full file check for a mismatched %s certificate', async field => {
  const actual = certified(proof()), certificate = actual.publicationCertificate!;
  if (field === 'body') certificate.bodySHA = hash('Different');
  if (field === 'readset') certificate.readsetDigest = hash('Different');
  if (field === 'room') certificate.conversationId = 'elsewhere';
  if (field === 'policy') Object.defineProperty(certificate, 'policyVersion', { value: 2 });
  const f = fixture([actual]);
  try { await f.session.run(() => f.read()); await f.session.validate(); expect(f.contextValid).toHaveBeenCalledOnce(); }
  finally { f.session.close(); }
});

it('does not accept a certificate for a stale response body or retain one withdrawn before the final SQL fence', async () => {
  const actual = certified(proof()), f = fixture([actual]);
  try {
    await expect(f.session.run(() => f.read([{ ...message('reply'), content: 'Stale response body' }]))).rejects.toThrow('正文');
    expect(f.certificates).not.toHaveBeenCalled();
  } finally { f.session.close(); }
  const g = fixture([certified(proof())]);
  try {
    await g.session.run(() => g.read());
    delete g.proofs[0]!.publicationCertificate;
    await expect(g.session.validate()).rejects.toThrow();
    expect(g.certificates).not.toHaveBeenCalled();
  } finally { g.session.close(); }
});

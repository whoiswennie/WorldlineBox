import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CompanionConnection } from './store';
import type { CompanionMemoryStore } from './memory-store';
import type { CompanionMemory } from '../shared/companions';
import { companionExecutionReadsetSchema, type CompanionExecutionReadset } from '../shared/companion-execution-evidence';
import { companionMessagePublicationCanonicalJSON, companionMessagePublicationCertificateSchema,
  type CompanionMessagePublicationCandidate, type CompanionMessagePublicationCertificate, type CompanionMessagePublicationMode } from '../shared/companion-message-publication';
import type { CompanionMemoryHistoryDescriptor } from '../shared/companion-memory-history';
import { executionMessageReadsetKey } from './execution-source-access';
import { certifyPublishedDependencyNode, initializePublishedDependencyIndex, observePublishedDependencyCut } from './published-dependency-index';
import { initializePublishedMessageActionPins, recordPublishedMessageActionPins } from './published-message-action-pins';
import { CompanionExecutionSourceStore } from './execution-source-store';
import type { CompanionPublishedActionFrontier } from '../shared/companion-message-publication';

type Descriptor = Omit<CompanionMemoryHistoryDescriptor, 'procedureValidation'>;
const digest = (value: unknown) => createHash('sha256').update(companionMessagePublicationCanonicalJSON(value)).digest('hex');
const bodyHash = (value: string) => createHash('sha256').update(value).digest('hex');
const historyKey = (owner: string, id: string, revision: number) => JSON.stringify([owner, id, revision]);
/** Policy v1 binds the canonical location used when the exact body was admitted.
 * A later classification change cannot silently move this historical proof. */
function memoryPath(note: CompanionMemory): string | undefined {
  const roots: Record<string, string> = { episode_memory: '经历', knowledge: '知识', procedure: '知识', self_understanding: '自我认识', navigation: '导航' };
  if (note.artifactKind === 'dream_fiction') return `演化/联想/${note.id}.md`;
  return roots[note.artifactKind] ? `记忆/${roots[note.artifactKind]}/${encodeURIComponent(note.id)}.md` : undefined;
}

export function initializeCompanionMessagePublications(db: CompanionConnection): void {
  db.exec(`CREATE TABLE IF NOT EXISTS companion_message_publication_certificates(
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    data TEXT NOT NULL
  )`);
  initializePublishedMessageActionPins(db);
  initializePublishedDependencyIndex(db);
}

/** This object lives for one synchronous command/transaction. The certificate
 * records a completed Main fence; it is not a TTL cache or current-file proof.
 * Every observation still checks live SQL authority and exact historical DAGs. */
export class CompanionPublishedMessageCertificates {
  private readonly descriptors = new Map<string, Descriptor>();
  private readonly bodies = new Map<string, CompanionMemory | undefined>();
  constructor(private readonly db: CompanionConnection, private readonly memory: CompanionMemoryStore) {}

  private historicalBody(owner: string, id: string, revision: number): CompanionMemory | undefined {
    const key = historyKey(owner, id, revision);
    if (!this.bodies.has(key)) {
      const row = this.db.prepare("SELECT json_extract(data,'$.memory') AS memory FROM companion_memory_content_revisions WHERE companion_id=? AND note_id=? AND content_revision=?")
        .get(owner, id, revision) as { memory?: string } | undefined;
      this.bodies.set(key, row?.memory ? JSON.parse(row.memory) as CompanionMemory : undefined);
    }
    return this.bodies.get(key);
  }

  private history(owner: string, roots: readonly { id: string; contentRevision: number }[]): Descriptor[] {
    const missing = roots.filter(root => !this.descriptors.has(historyKey(owner, root.id, root.contentRevision)));
    if (missing.length) {
      const scope = this.memory.sources.ownerScope(owner);
      const result = this.memory.execute({ type: 'memory.revisions.describe', ...scope, roots: missing });
      if (!result?.ok || !result.memoryHistoryDescriptors) throw new Error('正式消息的准确历史来源尚不可核验。');
      for (const value of result.memoryHistoryDescriptors) {
        if (value.companionId !== owner) throw new Error('正式消息的历史来源归属不一致。');
        const { procedureValidation: _practice, ...descriptor } = value; void _practice;
        const key = historyKey(owner, descriptor.id, descriptor.contentRevision), previous = this.descriptors.get(key);
        if (previous && !isDeepStrictEqual(previous, descriptor)) throw new Error('正式消息的准确历史来源在读取期间改变。');
        this.descriptors.set(key, descriptor);
      }
    }
    const complete = new Map<string, Descriptor>(), active = new Set<string>();
    const visit = (id: string, revision: number): void => {
      const key = historyKey(owner, id, revision);
      if (active.has(key)) throw new Error('正式消息的历史来源存在循环。');
      if (complete.has(key)) return;
      if (complete.size + active.size >= 10000) throw new Error('正式消息的历史来源超出完整核验范围。');
      const descriptor = this.descriptors.get(key);
      if (!descriptor) throw new Error('正式消息的历史来源缺少准确修订。');
      active.add(key);
      for (const dependency of descriptor.dependencies) visit(dependency.id, dependency.contentRevision);
      active.delete(key); complete.set(key, descriptor);
    };
    for (const root of roots) visit(root.id, root.contentRevision);
    return [...complete].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, descriptor]) => descriptor);
  }

  /** Existing SQL attestation can be reused only inside this same synchronous
   * execution.sources command. It does not certify the async Main file fence. */
  observe(id: string, expected?: CompanionExecutionReadset, sqlDigest?: string): {
    publicationCandidate?: CompanionMessagePublicationCandidate; publicationCertificate?: CompanionMessagePublicationCertificate;
  } {
    try { return this.observeCurrent(id, expected, sqlDigest); }
    catch (error) {
      // Ineligible legacy/pending/withdrawn history keeps the original full
      // Main path. Storage availability errors must remain transport errors.
      if (error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('SQLITE_')) throw error;
      return {};
    }
  }
  private observeCurrent(id: string, expected?: CompanionExecutionReadset, sqlDigest?: string): {
    publicationCandidate?: CompanionMessagePublicationCandidate; publicationCertificate?: CompanionMessagePublicationCertificate;
  } {
    const cut = observePublishedDependencyCut(this.db, id, expected, this.memory.sources.currentExecutionPath());
    if (cut) {
      const { certifiedAt: _at, mode: _mode, ...publicationCandidate } = cut.certificate; void _at; void _mode;
      return { publicationCandidate, publicationCertificate: structuredClone(cut.certificate) };
    }
    const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) as {
      id: string; author_id: string; conversation_id: string; content: string; revision: number; kind: string; status: string; action_id?: string } | undefined;
    if (!row || row.kind !== 'text' || row.status !== 'sent' || row.action_id || !row.content.trim()) return {};
    const stored = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(executionMessageReadsetKey(id)) as { value: string } | undefined;
    if (!stored) return {};
    const parsed = companionExecutionReadsetSchema.safeParse(JSON.parse(stored.value));
    if (!parsed.success || !parsed.data.complete) return {};
    const readset = parsed.data;
    if (row.author_id !== readset.companionId || row.conversation_id !== readset.conversationId
      || expected && digest(expected) !== digest(readset)) return {};
    if (!sqlDigest || sqlDigest !== bodyHash(JSON.stringify(expected ?? readset))) {
      if (!this.memory.sources.validatedMessageReadsetDigest(id, readset)) return {};
    }
    const contexts: unknown[] = [];
    for (const context of readset.contexts) {
      if (!context.fileReceiptOnly || !context.fileReceipts) return {};
      const scope = { companionId: readset.companionId, conversationId: readset.conversationId,
        beforeSequence: context.beforeSequence ?? readset.beforeSequence };
      const roots: Array<{ id: string; contentRevision: number }> = [];
      for (const receipt of context.fileReceipts) {
        if (receipt.companionId !== readset.companionId) return {};
        const captured = [...readset.memoryReads ?? [], ...readset.frozenMemories ?? []]
          .find(memory => memory.id === receipt.noteId && memory.contentRevision === receipt.contentRevision);
        if (!captured || !this.memory.sources.frozenMemoryValid(scope, captured)) return {};
        const note = this.historicalBody(readset.companionId, receipt.noteId, receipt.contentRevision);
        if (!note || note.id !== receipt.noteId || note.companionId !== readset.companionId || note.contentRevision !== receipt.contentRevision
          || bodyHash(note.content) !== receipt.contentHash || memoryPath(note) !== receipt.path
          || context.typeScope && !context.typeScope.contentKinds.includes(note.artifactKind)) return {};
        roots.push({ id: receipt.noteId, contentRevision: receipt.contentRevision });
      }
      contexts.push({ context, descriptors: this.history(readset.companionId, roots) });
    }
    const publicationCandidate: CompanionMessagePublicationCandidate = { policyVersion: 1, companionId: readset.companionId,
      conversationId: readset.conversationId, messageId: row.id, messageRevision: row.revision, bodySHA: bodyHash(row.content),
      readsetDigest: digest(readset), contextClosureDigest: digest(contexts) };
    const found = this.db.prepare('SELECT data FROM companion_message_publication_certificates WHERE message_id=?').get(id) as { data: string } | undefined;
    const certificate = found && companionMessagePublicationCertificateSchema.safeParse(JSON.parse(found.data));
    if (certificate && certificate.success) {
      const { certifiedAt: _at, mode: _mode, ...tuple } = certificate.data; void _at; void _mode;
      if (isDeepStrictEqual(tuple, publicationCandidate)) return { publicationCandidate, publicationCertificate: certificate.data };
    }
    return { publicationCandidate };
  }

  certify(messages: readonly (CompanionMessagePublicationCandidate & { mode: CompanionMessagePublicationMode })[],
    actionBindings: readonly CompanionPublishedActionFrontier[] = []): CompanionMessagePublicationCertificate[] {
    return this.db.transaction(() => this.memory.sources.withValidation(() => {
      const supplied = new Map<string, CompanionPublishedActionFrontier>();
      for (const value of actionBindings) {
        const old = supplied.get(value.id);
        if (old && !isDeepStrictEqual(old, value)) throw new Error('同一真实执行义务携带不一致的Main核验元组。');
        supplied.set(value.id, value);
      }
      const certificates = messages.map(({ mode, ...expected }) => {
        const observed = this.observe(expected.messageId);
        if (!observed.publicationCandidate || !isDeepStrictEqual(observed.publicationCandidate, expected))
          throw new Error('正式消息在完整发布围栏后改变，未签发历史发布凭证。');
        return observed.publicationCertificate ?? { ...expected, mode, certifiedAt: new Date().toISOString() };
      });
      const pins = new Map<string, CompanionPublishedActionFrontier[]>();
      // All candidates share this exact transaction snapshot. Resolve their
      // common ancestry once, retaining each proof's precise root association;
      // an action required by another owner/root is never this root's pin.
      const actions = certificates.length ? new CompanionExecutionSourceStore(this.db, this.memory)
        .resolve(certificates.map(certificate => certificate.messageId)).filter(proof => proof.kind === 'action') : [];
      for (const certificate of certificates) {
        const required: CompanionPublishedActionFrontier[] = [];
        let complete = true;
        for (const action of actions) {
          if (!action.sourceMessageIds.includes(certificate.messageId)) continue;
          const actual = action.storageActionBinding, expected = supplied.get(action.id);
          if (expected && !actual) throw new Error('真实执行义务在Main最终围栏后已不可匹配，未认证新的历史依赖。');
          // Missing pins keep the full-path fallback, but cannot hide another
          // supplied binding's mismatch when the union changes proof order.
          if (!actual || !expected) { complete = false; continue; }
          if (!isDeepStrictEqual(actual, expected)) throw new Error('真实执行义务在Main最终围栏后改变，未认证新的历史依赖。');
          required.push(actual);
        }
        if (complete) pins.set(certificate.messageId, required);
      }
      for (const certificate of certificates) this.db.prepare('INSERT INTO companion_message_publication_certificates(message_id,data) VALUES(?,?) ON CONFLICT(message_id) DO UPDATE SET data=excluded.data')
        .run(certificate.messageId, JSON.stringify(certificate));
      // The index is derived from already certified publication. Failed or
      // unsupported branches retain the old SQL/Main path and gain no authority.
      const buildable = certificates.filter(certificate => {
        const required = pins.get(certificate.messageId);
        return required && recordPublishedMessageActionPins(this.db, certificate, required);
      });
      // A page can arrive newest first. Finish every exact pin in this same
      // transaction before building any root's closed ancestry index.
      for (const certificate of buildable) certifyPublishedDependencyNode(this.db, certificate);
      return certificates;
    })).immediate();
  }
}

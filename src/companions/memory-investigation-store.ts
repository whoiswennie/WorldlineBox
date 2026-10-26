import { createHash, randomUUID } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionExecutionReadset } from '../shared/companion-execution-evidence';
import { companionMemoryInvestigationSchema, type CompanionMemoryInvestigation, type CompanionDreamInvestigationProposal } from '../shared/companion-memory-investigation';

/** Dreams can register questions, not conclusions. This ledger accepts only
 * host-recorded authorized learning receipts and performs a deterministic text
 * observation. It has no model, network, tool or fact-publication permission. */
export class CompanionMemoryInvestigationStore {
  constructor(private readonly db: CompanionConnection, private readonly validReadset: (readset: CompanionExecutionReadset) => boolean) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_memory_investigations(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,dream_job_id TEXT NOT NULL,fingerprint TEXT NOT NULL,data TEXT NOT NULL,next_check_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(companion_id,dream_job_id,fingerprint)); CREATE INDEX IF NOT EXISTS companion_memory_investigations_owner ON companion_memory_investigations(companion_id);`);
  }
  private save(value: CompanionMemoryInvestigation): void {
    const parsed = companionMemoryInvestigationSchema.parse(value);
    this.db.prepare('UPDATE companion_memory_investigations SET data=? WHERE id=?').run(JSON.stringify(parsed), parsed.id);
  }
  private authorized(owner: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM companion_learning_grants WHERE companion_id=? AND enabled=1 AND autonomous=1 LIMIT 1`).get(owner);
  }
  register(input: { companionId: string; sessionId: string; dreamJobId: string; dreamMemoryId: string; dreamContentRevision: number;
    proposals: CompanionDreamInvestigationProposal[]; originReadset: CompanionExecutionReadset }): void {
    if (!input.originReadset.complete || input.originReadset.companionId !== input.companionId || !this.validReadset(input.originReadset))
      throw new Error('待核查问题缺少真实有效的本人来源读集。');
    for (const proposal of input.proposals) {
      const fingerprint = createHash('sha256').update(JSON.stringify(proposal)).digest('hex'), at = new Date().toISOString();
      const value = companionMemoryInvestigationSchema.parse({ id: randomUUID(), companionId: input.companionId, sessionId: input.sessionId,
        dreamJobId: input.dreamJobId, dreamMemoryId: input.dreamMemoryId, dreamContentRevision: input.dreamContentRevision, revision: 1, createdAt: at, updatedAt: at, proposal,
        status: proposal.test && this.authorized(input.companionId) ? 'pending' : 'awaiting_authorization',
        reason: proposal.test ? this.authorized(input.companionId) ? '等待现有授权内的真实阅读回执；不判断假设真值。' : '没有可自动使用的学习授权；梦不构成授权。'
          : '尚无可确定性执行的核查规则；等待明确核查条件与授权。', originReadset: input.originReadset });
      this.db.prepare('INSERT OR IGNORE INTO companion_memory_investigations(id,companion_id,dream_job_id,fingerprint,data) VALUES(?,?,?,?,?)')
        .run(value.id, value.companionId, value.dreamJobId, fingerprint, JSON.stringify(value));
    }
  }
  private current(value: CompanionMemoryInvestigation): CompanionMemoryInvestigation {
    if (value.status === 'invalid') return value;
    let status: CompanionMemoryInvestigation['status'] = value.status;
    const dream = this.db.prepare(`SELECT 1 FROM vcp_memory_notes WHERE id=? AND companion_id=? AND json_extract(data,'$.contentRevision')=?
      AND json_extract(data,'$.status') IN('queued','indexed')`).get(value.dreamMemoryId, value.companionId, value.dreamContentRevision);
    if (!dream || !this.validReadset(value.originReadset)) status = 'invalid';
    else if (value.result) {
      const receipt = this.db.prepare(`SELECT 1 FROM companion_learning_reads r JOIN companion_learning_grants g ON g.id=r.grant_id
        WHERE r.id=? AND r.companion_id=? AND r.status='read' AND g.enabled=1`).get(value.result.receiptId, value.companionId);
      if (!receipt || !this.validReadset(value.result.readset)) status = 'invalid';
    } else status = value.proposal.test && this.authorized(value.companionId) ? 'pending' : 'awaiting_authorization';
    if (status !== value.status) { value = { ...value, status, reason: status === 'invalid' ? '原始依据或实际阅读权限已失效；不继续使用本次观察。'
      : status === 'pending' ? '等待现有授权内的真实阅读回执；不判断假设真值。' : '缺少当前自动学习授权或明确核查规则，等待处理。', revision: value.revision + 1, updatedAt: new Date().toISOString() }; this.save(value); }
    return value;
  }
  list(owner: string, limit: number): CompanionMemoryInvestigation[] {
    return (this.db.prepare('SELECT data FROM companion_memory_investigations WHERE companion_id=? ORDER BY rowid DESC LIMIT ?').all(owner, limit) as { data: string }[])
      .map(row => this.current(companionMemoryInvestigationSchema.parse(JSON.parse(row.data))));
  }
  summary(owner: string): { waiting: number; observed: number; reason?: string } {
    const count = this.db.prepare(`SELECT COALESCE(SUM(json_extract(data,'$.status') IN('pending','awaiting_authorization')),0) AS waiting,
      COALESCE(SUM(json_extract(data,'$.status')='observed'),0) AS observed FROM companion_memory_investigations WHERE companion_id=?`).get(owner) as { waiting: number; observed: number };
    const latest = this.db.prepare(`SELECT json_extract(data,'$.reason') AS reason FROM companion_memory_investigations WHERE companion_id=?
      AND json_extract(data,'$.status') IN('pending','awaiting_authorization') ORDER BY rowid LIMIT 1`).get(owner) as { reason?: string } | undefined;
    return { ...count, ...(latest?.reason ? { reason: latest.reason } : {}) };
  }
  /** Read-only research executor: consume at most four already completed host
   * learning reads. It never starts a new read, model call, tool or network job.
   * A missing grant/read is a durable wait with bounded fair polling. */
  consume(): void {
    const now = Date.now();
    const candidates = this.db.prepare(`SELECT data FROM companion_memory_investigations WHERE next_check_at<=?
      AND json_extract(data,'$.status') IN('pending','awaiting_authorization') ORDER BY next_check_at,rowid LIMIT 4`).all(now) as { data: string }[];
    for (const candidate of candidates) {
      const value = this.current(companionMemoryInvestigationSchema.parse(JSON.parse(candidate.data)));
      this.db.prepare('UPDATE companion_memory_investigations SET next_check_at=? WHERE id=?').run(now + 60_000, value.id);
      if (value.status !== 'pending') continue;
      const receipts = this.db.prepare(`SELECT r.id,r.data,m.id AS source_id,m.content,m.conversation_id FROM companion_learning_reads r
        JOIN companion_learning_grants g ON g.id=r.grant_id JOIN messages m ON m.id=r.source_message_id
        WHERE r.companion_id=? AND r.status='read' AND g.enabled=1 AND g.autonomous=1 AND json_extract(r.data,'$.readAt')>=?
        ORDER BY r.rowid DESC LIMIT 16`).all(value.companionId, value.createdAt) as { id: string; data: string; source_id: string; content: string; conversation_id: string }[];
      const receipt = receipts.find(read => { const name = (JSON.parse(read.data) as { assetName: string }).assetName.replace(/\.[^.]+$/u, '').trim();
        return name.length >= 2 && value.proposal.question.includes(name); });
      if (!receipt) {
        const reason = '已有自主学习授权，等待能对应问题的实际资料阅读；不会借梦扩大范围，也不把无关片段当作否证。';
        if (value.reason !== reason) this.save({ ...value, reason, revision: value.revision + 1, updatedAt: new Date().toISOString() });
        continue;
      }
      const readset: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', companionId: value.companionId,
        conversationId: receipt.conversation_id, complete: true, memories: [], sources: [{ id: receipt.source_id, conversationId: receipt.conversation_id,
          checksum: createHash('sha256').update(receipt.content).digest('hex') }], knowledgeReads: [], contexts: [], topics: [] };
      // A revoked/malformed source cannot stall another owner's physics or
      // maintenance. The original raw receipt remains available for repair.
      try { this.observe({ companionId: value.companionId, id: value.id, expectedRevision: value.revision, receiptId: receipt.id, readset }); }
      catch { /* Retain the bounded wait; no fact, verdict or paid retry. */ }
    }
  }
  observe(input: { companionId: string; id: string; expectedRevision: number; receiptId: string; readset: CompanionExecutionReadset }): CompanionMemoryInvestigation {
    const row = this.db.prepare('SELECT data FROM companion_memory_investigations WHERE id=? AND companion_id=?').get(input.id, input.companionId) as { data: string } | undefined;
    if (!row) throw new Error('待核查问题不属于当前伙伴。');
    const value = this.current(companionMemoryInvestigationSchema.parse(JSON.parse(row.data)));
    if (!this.db.prepare(`SELECT 1 FROM companions c WHERE c.id=? AND c.deleted_at IS NULL AND json_extract(c.data,'$.active')=1
      AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=c.id AND r.status!='completed')`).get(input.companionId))
      throw new Error('伙伴停用或重置期间不能核查问题。');
    if (value.revision !== input.expectedRevision || value.status !== 'pending' || !value.proposal.test) throw new Error('待核查问题状态或授权已经变化。');
    const receipt = this.db.prepare(`SELECT r.*,g.revision AS grant_revision FROM companion_learning_reads r JOIN companion_learning_grants g ON g.id=r.grant_id
      WHERE r.id=? AND r.companion_id=? AND r.status='read' AND g.enabled=1 AND g.autonomous=1`).get(input.receiptId, input.companionId) as
      { source_message_id: string; grant_id: string; data: string } | undefined;
    if (!receipt || !input.readset.complete || input.readset.companionId !== input.companionId || !this.validReadset(input.readset)
      || !input.readset.sources.some(source => source.id === receipt.source_message_id)) throw new Error('验证需要当前授权的真实学习回执与精确执行读集。');
    const source = this.db.prepare('SELECT content FROM messages WHERE id=? AND conversation_id=?').get(receipt.source_message_id, input.readset.conversationId) as { content: string } | undefined;
    if (!source) throw new Error('实际阅读来源已不可访问。');
    const split = source.content.indexOf('\n\n原文片段：\n');
    if (split < 0) throw new Error('学习回执没有实际原文。');
    const text = source.content.slice(split + '\n\n原文片段：\n'.length), matched = text.includes(value.proposal.test.quote);
    const recorded = JSON.parse(receipt.data) as { contentHash?: string; characters?: number };
    if (recorded.contentHash !== createHash('sha256').update(text).digest('hex') || recorded.characters !== text.length)
      throw new Error('学习来源正文与宿主实际阅读回执不一致。');
    const result: CompanionMemoryInvestigation = { ...value, revision: value.revision + 1, status: matched ? 'observed' : 'not_observed',
      reason: matched ? '已确认本次授权阅读的原文包含目标片段；这不证明假设为真。' : '本次实际阅读片段未见目标原文；这不证明假设为假。', updatedAt: new Date().toISOString(),
      result: { kind: 'reading_confirmation', receiptId: input.receiptId, sourceMessageId: receipt.source_message_id, grantId: receipt.grant_id,
        matched, observedQuote: matched ? value.proposal.test.quote : '', verifiedAt: new Date().toISOString(), readset: input.readset } };
    this.save(result); return result;
  }
}

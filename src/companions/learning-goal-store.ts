import { createHash, randomUUID } from 'node:crypto';
import { companionTaskCanClaim } from './task-concurrency-store';
import type { CompanionConnection } from './store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import { companionLearningGoalRoundSchema, companionLearningGoalStorageCommandSchema, type CompanionLearningGoal, type CompanionLearningGoalRound, type CompanionLearningGoalRead } from '../shared/companion-learning-goals';
import { nextCompanionLearningGoalAt } from '../shared/companion-learning-goal-schedule';

type Row = { id: string; companion_id: string; data: string; state: CompanionLearningGoal['state']; revision: number; next_at: number; lease_token: string | null; lease_until: number; round_id: string | null; rounds: number };
/** Private additive tables in the selected companion library; history is retained and read in bounded pages. */
export class CompanionLearningGoalStore {
  constructor(private readonly db: CompanionConnection, private readonly record: (goal: CompanionLearningGoal, round: CompanionLearningGoalRound, read: CompanionLearningGoalRead) => string,
    private readonly integrate: (goal: CompanionLearningGoal, round: CompanionLearningGoalRound, content: string, evidence: Array<{ sourceMessageId: string; quote: string }>,
      claimHash: string, target: { id: string; expectedVersion: number; action: 'reuse' | 'revise' } | undefined, expectedProhibitionRevision: string) => CompanionStorageResponse,
    private readonly sourceVisible: (owner: string, sourceId: string) => boolean,
    private readonly clock: () => number = Date.now,
    private readonly reflect?: (goal: CompanionLearningGoal, round: CompanionLearningGoalRound) => { outcome: 'applied' | 'skipped' | 'not_needed'; detail: string }) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_learning_goals(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,data TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,next_at INTEGER NOT NULL,lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,round_id TEXT,rounds INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS companion_learning_goal_due ON companion_learning_goals(state,next_at);
      CREATE INDEX IF NOT EXISTS companion_learning_goal_owner ON companion_learning_goals(companion_id,id);
      CREATE TABLE IF NOT EXISTS companion_learning_goal_rounds(id TEXT PRIMARY KEY,goal_id TEXT NOT NULL,companion_id TEXT NOT NULL,ordinal INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_learning_goal_history ON companion_learning_goal_rounds(goal_id,ordinal DESC);
      CREATE TABLE IF NOT EXISTS companion_learning_goal_sources(goal_id TEXT NOT NULL,read_id TEXT NOT NULL,grant_id TEXT,source_message_id TEXT NOT NULL,PRIMARY KEY(goal_id,read_id));
      CREATE INDEX IF NOT EXISTS companion_learning_goal_source_grant ON companion_learning_goal_sources(grant_id);`);
    // Sole utility-process owner: old in-flight leases cannot survive its restart.
    this.db.prepare('UPDATE companion_learning_goals SET lease_token=NULL,lease_until=0,next_at=MIN(next_at,?) WHERE lease_token IS NOT NULL').run(this.clock());
  }
  private owner(id: string): void {
    if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(id)) throw new Error('伙伴不存在。');
  }
  private activated(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL AND COALESCE(json_extract(data,'$.active'),1)=1").get(id)
      && !this.db.prepare("SELECT 1 FROM companion_reset_jobs WHERE companion_id=? AND status!='completed'").get(id);
  }
  private load(id: string): Row { const row = this.db.prepare('SELECT * FROM companion_learning_goals WHERE id=?').get(id) as Row | undefined; if (!row) throw new Error('学习目标不存在。'); return row; }
  private round(id: string): CompanionLearningGoalRound | undefined {
    const row = this.db.prepare('SELECT data FROM companion_learning_goal_rounds WHERE id=?').get(id) as { data: string } | undefined;
    if (!row) return;
    const round = companionLearningGoalRoundSchema.parse(JSON.parse(row.data));
    const revoked = round.reads.some(read => read.grantId && !this.db.prepare('SELECT 1 FROM companion_learning_grants WHERE id=? AND companion_id=? AND enabled=1').get(read.grantId, round.companionId)
      || read.sourceMessageId && !this.sourceVisible(round.companionId, read.sourceMessageId));
    return revoked ? { ...round, plan: undefined, summary: undefined, claims: [], memoryIds: [], integration: undefined, selfTest: undefined, stateReflection: undefined, gaps: [], nextPlan: [], readingIssues: [],
      reads: round.reads.map(read => ({ ...read, title: '已撤回的学习资料', uri: '', excerpt: '', sourceMessageId: undefined })), error: '本轮来源已撤回、修订或受禁记限制，旧正文、结论与自测不再提供。' } : round;
  }
  private serializeGoal(goal: CompanionLearningGoal): string { const data = { ...goal }; delete data.lastRound; return JSON.stringify(data); }
  private goal(row: Row, overview = false): CompanionLearningGoal {
    const data = JSON.parse(row.data) as CompanionLearningGoal;
    const full = row.round_id ? this.round(row.round_id) : undefined;
    const last = full && overview ? { ...full, plan: undefined, reads: [], claims: [], selfTest: undefined, stateReflection: undefined, summary: full.summary?.slice(0, 600), gaps: full.gaps.slice(0, 3).map(item => item.slice(0, 200)), nextPlan: full.nextPlan.slice(0, 3).map(item => item.slice(0, 200)) } : full;
    return { ...data, state: row.state, revision: row.revision, nextAt: new Date(row.next_at).toISOString(), totalRounds: row.rounds,
      ...(last ? { lastRound: last, phase: row.lease_token && row.lease_until > this.clock() ? last.phase : data.phase } : {}) };
  }
  private saveRound(round: CompanionLearningGoalRound): void {
    this.db.prepare('INSERT INTO companion_learning_goal_rounds(id,goal_id,companion_id,ordinal,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(round.id, round.goalId, round.companionId, round.ordinal, JSON.stringify(round));
  }
  private expected(owner: string, id: string, revision: number): Row { this.owner(owner); const row = this.load(id); if (row.companion_id !== owner || row.revision !== revision) throw new Error('学习目标已变化，请刷新后重试。'); return row; }
  private leased(id: string, token: string): Row {
    const row = this.load(id); if (row.state !== 'active' || row.lease_token !== token || row.lease_until <= this.clock() || !this.activated(row.companion_id)) throw new Error('学习目标作业已取消、过期或伙伴已休眠。'); return row;
  }
  execute(input: CompanionStorageCommand): CompanionStorageResponse | undefined {
    if (!input.type.startsWith('learning.goals.')) return;
    const command = companionLearningGoalStorageCommandSchema.parse(input);
    return this.db.transaction((): CompanionStorageResponse => {
      const now = this.clock(), stamp = new Date(now).toISOString();
      switch (command.type) {
        case 'learning.goals.list': {
          this.owner(command.companionId);
          const rows = this.db.prepare('SELECT * FROM companion_learning_goals WHERE companion_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?').all(command.companionId, command.limit + 1, command.cursor) as Row[];
          return { ok: true, learningGoals: { items: rows.slice(0, command.limit).map(row => this.goal(row, true)), hasMore: rows.length > command.limit,
            ...(rows.length > command.limit ? { nextCursor: command.cursor + command.limit } : {}) } };
        }
        case 'learning.goals.create': {
          this.owner(command.companionId);
          if ((this.db.prepare('SELECT COUNT(*) AS n FROM companion_learning_goals WHERE companion_id=? AND state!=\'stopped\'').get(command.companionId) as { n: number }).n >= 50) throw new Error('每位伙伴最多保留 50 个未停止的学习目标，请先整理已有目标。');
          const goal: CompanionLearningGoal = { id: randomUUID(), companionId: command.companionId, text: command.text, materials: command.materials, allowWeb: command.allowWeb,
            schedule: command.schedule, state: 'active', revision: 1, createdAt: stamp, updatedAt: stamp, phase: 'idle', totalRounds: 0,
            nextAt: new Date(nextCompanionLearningGoalAt(command.schedule, now)).toISOString() };
          this.db.prepare('INSERT INTO companion_learning_goals(id,companion_id,data,state,revision,next_at) VALUES(?,?,?,\'active\',1,?)')
            .run(goal.id, goal.companionId, this.serializeGoal(goal), Date.parse(goal.nextAt));
          return { ok: true, learningGoal: goal };
        }
        case 'learning.goals.update': {
          const row = this.expected(command.companionId, command.id, command.expectedRevision), goal = this.goal(row);
          const current = row.round_id ? this.round(row.round_id) : undefined;
          if (current?.status === 'running') this.saveRound({ ...current, updatedAt: stamp, endedAt: stamp, status: 'cancelled', error: '用户修改或暂停了目标，本轮未提交的工作已取消。' });
          const next = { ...goal, ...(command.text !== undefined ? { text: command.text } : {}), ...(command.materials !== undefined ? { materials: command.materials } : {}),
            ...(command.schedule ? { schedule: command.schedule } : {}), ...(command.allowWeb !== undefined ? { allowWeb: command.allowWeb } : {}),
            ...(command.state ? { state: command.state } : {}), revision: row.revision + 1, updatedAt: stamp, phase: 'idle' as const, waitReason: undefined };
          const nextAt = nextCompanionLearningGoalAt(next.schedule, now);
          this.db.prepare('UPDATE companion_learning_goals SET data=?,state=?,revision=?,next_at=?,lease_token=NULL,lease_until=0 WHERE id=?')
            .run(this.serializeGoal(next), next.state, next.revision, nextAt, row.id);
          return { ok: true, learningGoal: this.goal(this.load(row.id)) };
        }
        case 'learning.goals.run': {
          const row = this.expected(command.companionId, command.id, command.expectedRevision);
          if (row.state !== 'active') throw new Error('请先恢复这个学习目标。');
          this.db.prepare('UPDATE companion_learning_goals SET next_at=? WHERE id=?').run(nextCompanionLearningGoalAt(this.goal(row).schedule, now), row.id);
          return { ok: true, learningGoal: this.goal(this.load(row.id)) };
        }
        case 'learning.goals.rounds': {
          const row = this.load(command.id); this.owner(command.companionId); if (row.companion_id !== command.companionId) throw new Error('无法读取其他伙伴的学习记录。');
          const rows = this.db.prepare('SELECT data FROM companion_learning_goal_rounds WHERE goal_id=? ORDER BY ordinal DESC LIMIT ? OFFSET ?').all(row.id, command.limit + 1, command.cursor) as Array<{ data: string }>;
          return { ok: true, learningRounds: { items: rows.slice(0, command.limit).map(row => this.round((JSON.parse(row.data) as { id: string }).id)!), hasMore: rows.length > command.limit,
            ...(rows.length > command.limit ? { nextCursor: command.cursor + command.limit } : {}) } };
        }
        case 'learning.goals.claim': {
          if ((this.db.prepare('SELECT COUNT(*) AS n FROM companion_learning_goals WHERE lease_until>?').get(now) as { n: number }).n >= 2) return { ok: true };
          const rows = this.db.prepare(`SELECT g.* FROM companion_learning_goals g JOIN companions c ON c.id=g.companion_id WHERE g.state='active' AND g.next_at<=? AND g.lease_until<=? AND c.deleted_at IS NULL AND COALESCE(json_extract(c.data,'$.active'),1)=1
            AND g.companion_id NOT IN(SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=g.companion_id AND r.status!='completed') ORDER BY g.next_at,g.rowid LIMIT 50`).all(now, now, JSON.stringify(command.excludedOwners)) as Row[];
          for (const row of rows) {
            if (!companionTaskCanClaim(this.db, row.companion_id, { kind: 'learning_goal', id: row.id })) continue;
            const goal = this.goal(row), due = nextCompanionLearningGoalAt(goal.schedule, now);
            if (due > now) { this.db.prepare('UPDATE companion_learning_goals SET next_at=? WHERE id=?').run(due, row.id); continue; }
            const previous = row.round_id ? this.round(row.round_id) : undefined;
            const round: CompanionLearningGoalRound = previous && ['running', 'deferred'].includes(previous.status) ? { ...previous, updatedAt: stamp, endedAt: undefined, error: undefined, status: 'running' } : { id: randomUUID(), goalId: row.id, companionId: row.companion_id,
              ordinal: row.rounds + 1, startedAt: stamp, updatedAt: stamp, status: 'running', phase: 'planning', reads: [], readingIssues: [], claims: [], memoryIds: [], gaps: [], nextPlan: [] };
            const token = randomUUID(); this.saveRound(round);
            this.db.prepare('UPDATE companion_learning_goals SET lease_token=?,lease_until=?,round_id=?,rounds=MAX(rounds,?) WHERE id=?').run(token, now + command.leaseMs, round.id, round.ordinal, row.id);
            const prior = this.db.prepare('SELECT data FROM companion_learning_goal_rounds WHERE goal_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT 1').get(row.id, round.ordinal) as { data: string } | undefined;
            return { ok: true, learningGoalJob: { goal: this.goal(this.load(row.id)), round, ...(prior ? { previousRound: this.round((JSON.parse(prior.data) as { id: string }).id) } : {}), leaseToken: token } };
          }
          return { ok: true };
        }
        case 'learning.goals.heartbeat': {
          const row = this.leased(command.id, command.leaseToken), goal = this.goal(row);
          this.db.prepare('UPDATE companion_learning_goals SET lease_until=?,data=? WHERE id=?').run(now + command.leaseMs, this.serializeGoal({ ...goal, phase: command.phase, updatedAt: stamp }), row.id);
          return { ok: true };
        }
        case 'learning.goals.source': {
          const row = this.leased(command.id, command.leaseToken), goal = this.goal(row), round = this.round(row.round_id!)!;
          const read = command.read;
          if (!read.excerpt.trim() || createHash('sha256').update(read.excerpt).digest('hex') !== read.contentHash || read.characters !== read.excerpt.length) throw new Error('学习读取凭证与实际片段不一致。');
          if (read.grantId && !this.db.prepare('SELECT 1 FROM companion_learning_grants WHERE id=? AND companion_id=? AND enabled=1').get(read.grantId, row.companion_id)) throw new Error('学习来源授权已撤回。');
          const existing = this.db.prepare('SELECT source_message_id FROM companion_learning_goal_sources WHERE goal_id=? AND read_id=?').get(row.id, read.id) as { source_message_id: string } | undefined;
          const sourceMessageId = existing?.source_message_id ?? this.record(goal, round, read);
          if (!existing) this.db.prepare('INSERT INTO companion_learning_goal_sources(goal_id,read_id,grant_id,source_message_id) VALUES(?,?,?,?)').run(row.id, read.id, read.grantId ?? null, sourceMessageId);
          const reads = round.reads.filter(item => item.id !== read.id); reads.push({ ...read, sourceMessageId });
          this.saveRound({ ...round, reads, updatedAt: stamp });
          return { ok: true, learningGoal: this.goal(this.load(row.id)) };
        }
        case 'learning.goals.integrate': {
          const row = this.leased(command.id, command.leaseToken), goal = this.goal(row), round = this.round(row.round_id!)!;
          if (command.evidence.some(item => !round.reads.some(read => read.sourceMessageId === item.sourceMessageId && read.excerpt.includes(item.quote)))) throw new Error('学习记忆引用超出本轮真实读取来源。');
          for (const read of round.reads) if (read.grantId && !this.db.prepare('SELECT 1 FROM companion_learning_grants WHERE id=? AND companion_id=? AND enabled=1').get(read.grantId, row.companion_id)) throw new Error('学习资料授权已撤回，未整合旧结论。');
          const response = this.integrate(goal, round, command.content, command.evidence, command.claimHash, command.target, command.expectedProhibitionRevision);
          if (!response.ok || !response.memories?.length) throw new Error(response.error ?? 'VCP 正式记忆未登记。');
          const note = response.memories[0]!;
          this.saveRound({ ...round, memoryIds: response.memories.map(note => note.id), updatedAt: stamp,
            integration: { action: command.target?.action === 'reuse' ? 'reused' : command.target ? 'revised' : 'recorded', noteId: note.id, version: note.version, reason: command.reason } });
          return { ...response, learningGoal: this.goal(this.load(row.id)) };
        }
        case 'learning.goals.checkpoint': case 'learning.goals.finish': {
          const row = this.leased(command.id, command.leaseToken), goal = this.goal(row), round = command.round;
          if (round.id !== row.round_id || round.goalId !== row.id || round.companionId !== row.companion_id || round.ordinal !== row.rounds) throw new Error('学习轮次归属不匹配。');
          if (command.type === 'learning.goals.checkpoint' && round.status !== 'running' || command.type === 'learning.goals.finish' && round.status === 'running') throw new Error('学习轮次状态无效。');
          if (command.type === 'learning.goals.finish' && round.status === 'completed' && round.stateReflection) {
            const stored = this.round(row.round_id!)!;
            if (!stored.integration || !stored.memoryIds.length || stored.integration.noteId !== round.integration?.noteId || stored.integration.version !== round.integration?.version
              || JSON.stringify([...stored.memoryIds].sort()) !== JSON.stringify([...round.memoryIds].sort())) throw new Error('学习反思缺少本轮真实已保存记忆版本。');
            if (round.stateReflection.evidence.some(item => !stored.reads.some(read => read.id === item.sourceId && read.sourceMessageId && read.excerpt.includes(item.quote)
              && this.sourceVisible(goal.companionId, read.sourceMessageId)))) throw new Error('学习反思引用超出本轮仍获准的实际读取来源。');
            round.stateReflection = { ...round.stateReflection, ...(stored.integration.action === 'reused'
              ? { outcome: 'not_needed' as const, detail: '本轮复用已有知识，不重复改写当前关注或产生情绪奖励。' }
              : this.reflect?.(goal, round) ?? { outcome: 'not_needed' as const, detail: '本次未配置状态整合，不改变当前关注。' }) };
          }
          this.saveRound(round);
          if (command.type === 'learning.goals.finish') {
            const nextAt = nextCompanionLearningGoalAt(goal.schedule, now + (command.retryAfterMs ?? goal.schedule.intervalMinutes * 60000));
            this.db.prepare('UPDATE companion_learning_goals SET data=?,next_at=?,lease_token=NULL,lease_until=0 WHERE id=?')
              .run(this.serializeGoal({ ...goal, phase: round.status === 'completed' ? 'idle' : 'waiting', updatedAt: stamp, waitReason: round.error }), nextAt, row.id);
          }
          return { ok: true, learningGoal: this.goal(this.load(row.id)) };
        }
      }
      throw new Error('未知学习目标命令。');
    }).immediate();
  }
}

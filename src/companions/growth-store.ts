import { createHash, randomUUID } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionMessage } from '../shared/companions';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import { companionGrowthGoalSchema, type CompanionGrowthGoal } from '../shared/companion-cognition';

/** Goals direct practice; they never assert an already acquired personality. */
export class CompanionGrowthStore {
  constructor(private readonly db: CompanionConnection,
    private readonly visibleSources: (owner: string, conversationId: string, ids: string[]) => CompanionMessage[]) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_growth_goals(
      id TEXT PRIMARY KEY,companion_id TEXT NOT NULL REFERENCES companions(id),conversation_id TEXT NOT NULL REFERENCES conversations(id),
      revision INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS companion_growth_goal_scope ON companion_growth_goals(companion_id,conversation_id,id);
      CREATE TABLE IF NOT EXISTS companion_growth_goal_revisions(goal_id TEXT NOT NULL REFERENCES companion_growth_goals(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(goal_id,revision));
      CREATE TABLE IF NOT EXISTS companion_growth_goal_definitions(goal_id TEXT PRIMARY KEY REFERENCES companion_growth_goals(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,sources TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_growth_operations(operation_id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,request_hash TEXT NOT NULL,goal_id TEXT NOT NULL)`);
  }
  invalidateSources(owner: string, sourceIds: readonly string[]): void {
    if (!sourceIds.length) return;
    const revoked = new Set(sourceIds);
    const entries = this.db.prepare('SELECT id,data FROM companion_growth_goals WHERE companion_id=?').all(owner) as Array<{ id: string; data: string }>;
    for (const entry of entries) {
      const history = this.db.prepare('SELECT data FROM companion_growth_goal_revisions WHERE goal_id=?').all(entry.id) as Array<{ data: string }>;
      if ([entry, ...history].some(item => companionGrowthGoalSchema.parse(JSON.parse(item.data)).sources.some(source => revoked.has(source.messageId)))) {
        this.db.prepare('DELETE FROM companion_growth_goal_revisions WHERE goal_id=?').run(entry.id);
        this.db.prepare('DELETE FROM companion_growth_goals WHERE id=?').run(entry.id);
      }
    }
  }
  private scope(owner: string, conversationId: string): void {
    if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(owner)
      || !this.db.prepare('SELECT 1 FROM conversation_members WHERE companion_id=? AND conversation_id=?').get(owner, conversationId))
      throw new Error('成长目标不属于当前伙伴或会话。');
  }
  private valid(goal: CompanionGrowthGoal): boolean {
    const sources = this.visibleSources(goal.companionId, goal.conversationId, goal.sources.map(source => source.messageId));
    return goal.sources.every(reference => {
      const source = sources.find(message => message.id === reference.messageId);
      const revision = this.db.prepare('SELECT revision FROM messages WHERE id=?').get(reference.messageId) as { revision: number } | undefined;
      return source && revision?.revision === reference.revision
        && createHash('sha256').update(source.content).digest('hex') === reference.contentHash;
    });
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    if (command.type !== 'growth.goals.list' && command.type !== 'growth.goal.propose' && command.type !== 'growth.goal.transition') return undefined;
    this.scope(command.companionId, command.conversationId);
    if (command.type === 'growth.goals.list') {
      const rows = this.db.prepare('SELECT data FROM companion_growth_goals WHERE companion_id=? AND conversation_id=? ORDER BY rowid DESC LIMIT ?')
        .all(command.companionId, command.conversationId, command.limit) as Array<{ data: string }>;
      return { ok: true, growthGoals: rows.map(row => companionGrowthGoalSchema.parse(JSON.parse(row.data))).filter(goal => this.valid(goal)) };
    }
    return this.db.transaction(() => {
      const requestHash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
      const operation = this.db.prepare('SELECT companion_id,request_hash,goal_id FROM companion_growth_operations WHERE operation_id=?').get(command.operationId) as
        { companion_id: string; request_hash: string; goal_id: string } | undefined;
      if (operation) {
        if (operation.companion_id !== command.companionId || operation.request_hash !== requestHash) throw new Error('成长提交幂等键已用于不同请求。');
        const saved = this.db.prepare('SELECT data FROM companion_growth_goals WHERE id=?').get(operation.goal_id) as { data: string } | undefined;
        if (!saved) throw new Error('成长提交已经撤回。');
        const goal = companionGrowthGoalSchema.parse(JSON.parse(saved.data));
        if (!this.valid(goal)) throw new Error('成长目标来源已变化或撤回。');
        return { ok: true, growthGoal: goal };
      }
      const messages = this.visibleSources(command.companionId, command.conversationId, command.sourceMessageIds);
      if (new Set(command.sourceMessageIds).size !== command.sourceMessageIds.length || messages.length !== command.sourceMessageIds.length
        || messages.some(source => source.authorId !== 'user' && source.authorId !== command.companionId))
        throw new Error('培养方向必须来自当前会话的真实用户反馈或本人表达。');
      const previousRow = command.goalId ? this.db.prepare('SELECT data FROM companion_growth_goals WHERE id=?').get(command.goalId) as { data: string } | undefined : undefined;
      const previous = previousRow && companionGrowthGoalSchema.parse(JSON.parse(previousRow.data));
      if (command.goalId && (!previous || previous.companionId !== command.companionId || previous.conversationId !== command.conversationId
        || previous.revision !== command.expectedRevision) || !command.goalId && command.expectedRevision !== undefined)
        throw new Error('成长目标版本已变化，未覆盖。');
      if (previous?.status === 'retired' && (command.type === 'growth.goal.propose' || command.status !== 'retired')) throw new Error('这个培养方向已经结束，请提出新的方向；不能改写已结束的目标。');
      const now = new Date().toISOString();
      if (command.type === 'growth.goal.transition') {
        if (!previous || !this.valid(previous)) throw new Error('培养方向或原始定义来源已变化，请重新读取。');
        const definition = this.db.prepare('SELECT sources FROM companion_growth_goal_definitions WHERE goal_id=?').get(previous.id) as { sources: string } | undefined;
        if (!definition) throw new Error('培养方向缺少准确的定义来源，不能变更其状态。');
        const defined = companionGrowthGoalSchema.shape.sources.parse(JSON.parse(definition.sources));
        const feedback = messages.map(message => ({ messageId: message.id,
          revision: (this.db.prepare('SELECT revision FROM messages WHERE id=?').get(message.id) as { revision: number }).revision,
          contentHash: createHash('sha256').update(message.content).digest('hex') }));
        const sources = [...new Map([...defined, ...feedback].map(source => [source.messageId, source])).values()];
        const goal = companionGrowthGoalSchema.parse({ ...previous, revision: previous.revision + 1, status: command.status,
          authorId: messages[0]!.authorId, updatedAt: now, sources });
        if (!this.valid(goal)) throw new Error('培养方向的定义或新反馈来源已失效。');
        this.db.prepare('UPDATE companion_growth_goals SET revision=?,data=? WHERE id=?').run(goal.revision, JSON.stringify(goal), goal.id);
        this.db.prepare('INSERT INTO companion_growth_goal_revisions(goal_id,revision,data) VALUES(?,?,?)').run(goal.id, goal.revision, JSON.stringify(goal));
        this.db.prepare('INSERT INTO companion_growth_operations VALUES(?,?,?,?)').run(command.operationId, command.companionId, requestHash, goal.id);
        return { ok: true, growthGoal: goal };
      }
      const goal = companionGrowthGoalSchema.parse({ ...command.goal, id: previous?.id ?? 'growth_' + randomUUID().replaceAll('-', ''),
        companionId: command.companionId, conversationId: command.conversationId, revision: (previous?.revision ?? 0) + 1,
        status: previous?.status === 'paused' ? 'paused' : 'proposed', authorId: messages[0]!.authorId, createdAt: previous?.createdAt ?? now, updatedAt: now,
        sources: messages.map(message => ({ messageId: message.id, revision: (this.db.prepare('SELECT revision FROM messages WHERE id=?').get(message.id) as { revision: number }).revision,
          contentHash: createHash('sha256').update(message.content).digest('hex') })) });
      this.db.prepare(`INSERT INTO companion_growth_goals(id,companion_id,conversation_id,revision,data) VALUES(?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data`).run(goal.id, goal.companionId, goal.conversationId, goal.revision, JSON.stringify(goal));
      this.db.prepare('INSERT INTO companion_growth_goal_revisions(goal_id,revision,data) VALUES(?,?,?)').run(goal.id, goal.revision, JSON.stringify(goal));
      this.db.prepare('INSERT INTO companion_growth_goal_definitions(goal_id,revision,sources) VALUES(?,?,?) ON CONFLICT(goal_id) DO UPDATE SET revision=excluded.revision,sources=excluded.sources').run(goal.id, goal.revision, JSON.stringify(goal.sources));
      this.db.prepare('INSERT INTO companion_growth_operations VALUES(?,?,?,?)').run(command.operationId, command.companionId, requestHash, goal.id);
      return { ok: true, growthGoal: goal };
    }).immediate();
  }
}

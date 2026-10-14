import { createHash, randomUUID } from 'node:crypto';
import { companionRoutineConfigSchema, companionRoutinePatchSchema, type CompanionRoutine, type CompanionRoutineConfig,
  type CompanionRoutinePatch, type CompanionRoutineRuntime } from '../shared/companion-routine';
import { defaultCompanionRoutineConfig, evaluateCompanionRoutine } from '../shared/companion-routine-time';
import { resolveCompanionScheduleTimeZone } from '../shared/companion-schedule-time';
import type { CompanionMessage } from '../shared/companions';
import type { CompanionConnection } from './store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionWorldOccupancy } from '../shared/companion-world';
import { advanceCompanionWorldEnergy, deriveCompanionWorldHabitProgress } from '../shared/companion-world-engine';

type Scope = { companionId: string; conversationId: string; beforeSequence?: number };
type Row = Record<string, string | number | null>;
interface StoredRoutine { companionId: string; config: CompanionRoutineConfig; revision: number; createdAt: string; updatedAt: string;
  sourceConversationId?: string; sourceMessageId?: string; configurationSources: Array<{ conversationId: string; messageId: string }>;
  habitSince: Record<string, string>; interruptedUntil?: string }
const row = (value: unknown) => value as Row;
const decode = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const iso = (at = Date.now()) => new Date(at).toISOString();

/** A module of the existing utility-process owner. Never opens another database. */
export class CompanionRoutineStore {
  constructor(private readonly db: CompanionConnection,
    private readonly visibleSources: (scope: Scope, ids: string[]) => CompanionMessage[],
    private readonly humanSource: (scope: Scope, content: string) => CompanionMessage,
    private readonly beforeConfigure: (companionId: string) => void,
    private readonly worldClock: { virtualAt: (realAt: number) => number; realAt: (virtualAt: number) => number; ensureThrough: (at: number) => number;
      actual: (id: string, at: number) => Pick<CompanionRoutineRuntime, 'phase' | 'activity' | 'activeHabitId'>; occupancy: (id: string, from: number, to: number) => CompanionWorldOccupancy[]; urgent: (id: string, source: string, now: number) => boolean }) {}

  configuration(companionId: string): CompanionRoutineConfig { return structuredClone(this.load(companionId).config); }
  private virtualTime(at: number | string | Date): number { return this.worldClock.virtualAt(new Date(at).getTime()); }
  private realTime(at: number | string | Date): number { return this.worldClock.realAt(new Date(at).getTime()); }

  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_routines(companion_id TEXT PRIMARY KEY REFERENCES companions(id),data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_routine_interruptions(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL REFERENCES companions(id),
        source_message_id TEXT REFERENCES messages(id),starts_at TEXT NOT NULL,ends_at TEXT NOT NULL,UNIQUE(companion_id,source_message_id));
      CREATE INDEX IF NOT EXISTS companion_routine_interruptions_time ON companion_routine_interruptions(companion_id,ends_at);
      CREATE TABLE IF NOT EXISTS companion_routine_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,companion_id TEXT NOT NULL REFERENCES companions(id),
        at TEXT NOT NULL,phase TEXT NOT NULL,simulation INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS companion_routine_work(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL REFERENCES companions(id),work_id TEXT NOT NULL,
        starts_at TEXT NOT NULL,last_observed_at TEXT NOT NULL,ends_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS companion_routine_work_active ON companion_routine_work(companion_id,work_id) WHERE ends_at IS NULL;
      CREATE INDEX IF NOT EXISTS companion_routine_work_time ON companion_routine_work(companion_id,starts_at);`);
  }
  private requireCompanion(id: string): void {
    if (!this.db.prepare('SELECT 1 FROM companions WHERE id=? AND deleted_at IS NULL').get(id)) throw new Error('伙伴不存在或已移除。');
  }
  private requireScope(scope: Scope): Row {
    this.requireCompanion(scope.companionId);
    const conversation = this.db.prepare('SELECT * FROM conversations WHERE id=? AND dissolved_at IS NULL').get(scope.conversationId);
    if (!conversation || !this.db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id=? AND companion_id=?').get(scope.conversationId, scope.companionId)) throw new Error('作息不属于当前聊天范围。');
    return row(conversation);
  }
  private load(companionId: string): StoredRoutine {
    this.requireCompanion(companionId);
    const saved = this.db.prepare('SELECT data FROM companion_routines WHERE companion_id=?').get(companionId);
    if (saved) {
      const current = decode<StoredRoutine>(row(saved).data);
      let validSource = true;
      for (const provenance of current.configurationSources) try {
        if (!this.visibleSources({ companionId, conversationId: provenance.conversationId }, [provenance.messageId]).some(source => source.authorId === 'user')) validSource = false;
      } catch { validSource = false; }
      if (validSource) return current;
      // Withdraw a forgotten/deleted configuration, without copying its private
      // title or explanation into another audit record or future model input.
      const replacement = this.fresh(companionId); replacement.revision = current.revision + 1;
      this.save(replacement); return replacement;
    }
    const initial = this.fresh(companionId); this.save(initial); return initial;
  }
  private fresh(companionId: string): StoredRoutine {
    const config = defaultCompanionRoutineConfig(companionId); config.timeZone = resolveCompanionScheduleTimeZone(config.timeZone);
    return { companionId, config, revision: 1, createdAt: iso(), updatedAt: iso(), habitSince: {}, configurationSources: [] };
  }
  private save(value: StoredRoutine): void {
    this.db.prepare('INSERT INTO companion_routines(companion_id,data) VALUES(?,?) ON CONFLICT(companion_id) DO UPDATE SET data=excluded.data').run(value.companionId, JSON.stringify(value));
  }
  get(scope: Scope): CompanionRoutine {
    const conversation = this.requireScope(scope), stored = this.load(scope.companionId), observedAt = this.worldClock.ensureThrough(Date.now());
    this.observeWork(scope.companionId);
    const config = structuredClone(stored.config), privateSource = this.mustHideConfiguration(scope, conversation, stored);
    let runtime = this.phase(scope.companionId, observedAt), habitProgress = this.habitProgress(stored, observedAt);
    if (privateSource) {
      if (this.db.prepare('SELECT 1 FROM metadata WHERE key=?').get('world-room/' + scope.conversationId)) {
        const safeId = (id: string) => 'habit_' + createHash('sha256').update(id).digest('hex').slice(0, 16);
        config.habits = config.habits.map(habit => ({ ...habit, id: safeId(habit.id), title: habit.kind === 'study' ? '学习活动' : habit.kind === 'exercise' ? '运动活动' : habit.kind === 'leisure' ? '放松活动' : habit.kind === 'rest' ? '休息活动' : '个人日常活动' }));
        habitProgress = habitProgress.map(progress => ({ ...progress, id: safeId(progress.id) }));
      } else { config.habits = []; habitProgress = []; }
      config.meals = config.meals.map(meal => ({ ...meal, name: '用餐' }));
      runtime = this.publicRuntime(runtime);
    }
    return { companionId: stored.companionId, config, revision: stored.revision, createdAt: stored.createdAt, updatedAt: stored.updatedAt,
      ...(!privateSource && stored.sourceMessageId ? { sourceMessageId: stored.sourceMessageId, sourceConversationId: stored.sourceConversationId } : {}), habitProgress,
      runtime };
  }
  getRuntime(scope: Scope, at = Date.now()): CompanionRoutineRuntime {
    this.observeWork(scope.companionId, at);
    const conversation = this.requireScope(scope), stored = this.load(scope.companionId), runtime = this.phase(scope.companionId, at);
    return this.mustHideConfiguration(scope, conversation, stored) ? this.publicRuntime(runtime) : runtime;
  }
  private mustHideConfiguration(scope: Scope, conversation: Row, stored: StoredRoutine): boolean {
    if (conversation.kind === 'group' && stored.sourceConversationId !== scope.conversationId) return true;
    return scope.beforeSequence !== undefined && stored.configurationSources.some(source =>
      !this.visibleSources(scope, [source.messageId]).length);
  }
  private habitProgress(stored: StoredRoutine, now: number): CompanionRoutine['habitProgress'] {
    const actualNow = this.worldClock.ensureThrough(now);
    return stored.config.habits.flatMap(habit => {
      const from = Date.parse(stored.habitSince[habit.id] ?? stored.createdAt), windows = this.worldClock.occupancy(stored.companionId, from, actualNow);
      return deriveCompanionWorldHabitProgress({ ...stored.config, habits: [habit] }, windows, actualNow, at => this.virtualTime(at), at => this.realTime(at));
    });
  }
  rehomeConversation(oldId: string, newId: string): void {
    for (const found of this.db.prepare('SELECT data FROM companion_routines').all() as Row[]) {
      const value = decode<StoredRoutine>(found.data);
      let changed = false;
      if (value.sourceConversationId === oldId) { value.sourceConversationId = newId; changed = true; }
      for (const source of value.configurationSources) if (source.conversationId === oldId) { source.conversationId = newId; changed = true; }
      if (changed) this.save(value);
    }
  }
  beginWork(companionId: string, workId: string, at = Date.now()): void {
    this.requireCompanion(companionId);
    this.db.prepare('INSERT OR IGNORE INTO companion_routine_work(id,companion_id,work_id,starts_at,last_observed_at) VALUES(?,?,?,?,?)')
      .run(randomUUID(), companionId, workId, iso(at), iso(at));
  }
  observeWork(companionId: string, at = Date.now()): void {
    this.db.prepare('UPDATE companion_routine_work SET last_observed_at=MAX(last_observed_at,?) WHERE companion_id=? AND ends_at IS NULL').run(iso(at), companionId);
  }
  endWork(companionId: string, workId: string, at = Date.now()): void {
    this.db.prepare('UPDATE companion_routine_work SET ends_at=MAX(starts_at,?),last_observed_at=MAX(last_observed_at,?) WHERE companion_id=? AND work_id=? AND ends_at IS NULL')
      .run(iso(at), iso(at), companionId, workId);
  }
  recoverWork(companionId: string, workId: string): void {
    // A crashed process did not work through the offline period. Its last
    // observation is the most evidence we have, never the restart clock.
    this.db.prepare('UPDATE companion_routine_work SET ends_at=last_observed_at WHERE companion_id=? AND work_id=? AND ends_at IS NULL').run(companionId, workId);
  }
  private publicRuntime(runtime: CompanionRoutineRuntime): CompanionRoutineRuntime {
    const { activeHabitId: _activeHabitId, ...publicState } = runtime; void _activeHabitId;
    return { ...publicState, ...(runtime.activity ? { activity: runtime.phase === 'habit' ? '个人习惯活动' : runtime.phase === 'eating' ? '用餐' : runtime.phase === 'resting' ? '休息' : runtime.phase === 'sleeping' ? '睡眠' : '正在回应互动' } : {}) };
  }
  configure(scope: Scope, patch: CompanionRoutinePatch, expectedRevision: number, sourceMessageId?: string): CompanionRoutine {
    return this.db.transaction(() => {
      if (this.requireScope(scope).kind !== 'private') throw new Error('请在伙伴私聊的日程表单中修改作息，群里只显示公开状态。');
      const value = this.load(scope.companionId);
      if (value.revision !== expectedRevision) throw new Error('作息已更新，请重新读取后修改。');
      const changes = companionRoutinePatchSchema.parse(patch), config = companionRoutineConfigSchema.parse({ ...value.config, ...changes });
      config.timeZone = resolveCompanionScheduleTimeZone(config.timeZone);
      let source: CompanionMessage;
      if (sourceMessageId) {
        const candidate = this.visibleSources(scope, [sourceMessageId])[0];
        if (!candidate || candidate.authorId !== 'user' || candidate.conversationId !== scope.conversationId || !routineConfigurationRequested(candidate.content)) throw new Error('作息修改需要当前用户明确的真实要求。');
        source = candidate;
      } else source = this.humanSource(scope, '在伙伴日程的作息表单正式设置伙伴作息与虚拟习惯：\n' + JSON.stringify({ changes, configuration: config }));
      this.beforeConfigure?.(scope.companionId);
      const now = iso(), oldHabits = new Map(value.config.habits.map(habit => [habit.id, JSON.stringify(habit)]));
      value.habitSince = Object.fromEntries(config.habits.map(habit => [habit.id,
        oldHabits.get(habit.id) === JSON.stringify(habit) ? value.habitSince[habit.id] ?? value.createdAt : now]));
      value.config = config; value.revision++; value.updatedAt = now; value.sourceMessageId = source.id; value.sourceConversationId = source.conversationId;
      if (!value.configurationSources.some(provenance => provenance.messageId === source.id)) value.configurationSources.push({ conversationId: source.conversationId, messageId: source.id });
      this.save(value); return this.get(scope);
    }).immediate();
  }
  phase(companionId: string, now = Date.now()): CompanionRoutineRuntime {
    now = this.worldClock.ensureThrough(now);
    const value = this.load(companionId), virtual = evaluateCompanionRoutine(value.config, iso(this.virtualTime(now)), value.interruptedUntil ? iso(this.virtualTime(value.interruptedUntil)) : undefined);
    const actual = this.worldClock.actual(companionId, now);
    const result: CompanionRoutineRuntime = { ...virtual, ...actual, plannedPhase: virtual.phase, nextTransitionAt: iso(this.realTime(virtual.nextTransitionAt)),
      ...(value.interruptedUntil ? { interruptedUntil: value.interruptedUntil } : {}) };
    const previous = this.db.prepare('SELECT phase FROM companion_routine_audit WHERE companion_id=? ORDER BY id DESC LIMIT 1').get(companionId);
    if (!previous || row(previous).phase !== result.phase) {
      this.db.prepare('INSERT INTO companion_routine_audit(companion_id,at,phase) VALUES(?,?,?)').run(companionId, iso(now), result.phase);
      this.db.prepare('DELETE FROM companion_routine_audit WHERE companion_id=? AND id NOT IN (SELECT id FROM companion_routine_audit WHERE companion_id=? ORDER BY id DESC LIMIT 200)').run(companionId, companionId);
    }
    return result;
  }
  nextEnergyCheckAt(companionId: string, now = Date.now()): string { return this.phase(companionId, now).nextTransitionAt; }
  advanceEnergy(companionId: string, from: number | string | Date, to: number | string | Date, energy: number): number {
    const start = new Date(from).getTime(), end = this.worldClock.ensureThrough(new Date(to).getTime());
    return advanceCompanionWorldEnergy(this.worldClock.occupancy(companionId, start, end), start, end, energy, at => this.virtualTime(at));
  }
  allowWork(companionId: string, sourceMessageId: string, now = Date.now(), proactive = false): boolean {
    // A wake window belongs to a specific urgent interaction, not the owner's
    // entire backlog. Fixed commitments also must not release old queued chat.
    if (evaluateCompanionRoutine(this.load(companionId).config, iso(this.virtualTime(now))).canRespond) return true;
    if (proactive) return false;
    const message = this.db.prepare('SELECT conversation_id FROM messages WHERE id=?').get(sourceMessageId);
    if (!message) return false;
    const scope = { companionId, conversationId: String(row(message).conversation_id) };
    const source = this.visibleSources(scope, [sourceMessageId])[0];
    if (!source || source.authorId !== 'user') return false;
    if (this.worldClock.urgent(companionId, sourceMessageId, now)) return this.interrupt(scope, sourceMessageId, now).canRespond;
    const active = this.db.prepare('SELECT source_message_id FROM companion_routine_interruptions WHERE companion_id=? AND starts_at<=? AND ends_at>? AND source_message_id IS NOT NULL').all(companionId, iso(now), iso(now)) as Row[];
    return active.some(window => {
      const original = this.visibleSources(scope, [String(window.source_message_id)])[0];
      return original?.authorId === 'user' && original.conversationId === source.conversationId
        && source.sequence >= original.sequence && this.worldClock.urgent(companionId, original.id, now);
    });
  }
  interrupt(scope: Scope, sourceMessageId: string, now = Date.now()): CompanionRoutineRuntime {
    this.requireScope(scope); const source = this.visibleSources(scope, [sourceMessageId])[0];
    if (!source || source.authorId !== 'user' || !this.worldClock.urgent(scope.companionId, source.id, now)) throw new Error('临时唤醒需要已核验的真实紧急通知。');
    this.recordInterruption(scope.companionId, sourceMessageId, now); return this.phase(scope.companionId, now);
  }
  wakeForCommitment(companionId: string, _reason = 'fixed_commitment', now = Date.now()): CompanionRoutineRuntime {
    void _reason;
    this.requireCompanion(companionId); this.recordInterruption(companionId, undefined, now); return this.phase(companionId, now);
  }
  private recordInterruption(companionId: string, sourceMessageId: string | undefined, now: number): void {
    const value = this.load(companionId), until = iso(now + 30 * 60_000);
    if (sourceMessageId && this.db.prepare('SELECT 1 FROM companion_routine_interruptions WHERE companion_id=? AND source_message_id=?').get(companionId, sourceMessageId)) return;
    value.interruptedUntil = !value.interruptedUntil || value.interruptedUntil < until ? until : value.interruptedUntil;
    this.db.prepare('INSERT INTO companion_routine_interruptions(id,companion_id,source_message_id,starts_at,ends_at) VALUES(?,?,?,?,?)')
      .run(randomUUID(), companionId, sourceMessageId ?? null, iso(now), until); this.save(value);
  }
  completeInterrupt(companionId: string): void {
    const value = this.load(companionId); value.interruptedUntil = undefined; this.save(value);
    this.db.prepare('UPDATE companion_routine_interruptions SET ends_at=? WHERE companion_id=? AND ends_at>?').run(iso(), companionId, iso());
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    switch (command.type) {
      case 'routine.get': return { ok: true, routine: this.get(command) };
      case 'routine.configure': return { ok: true, routine: this.configure(command, command.patch, command.expectedRevision, command.sourceMessageId) };
      case 'routine.interrupt': this.interrupt(command, command.sourceMessageId); return { ok: true, routine: this.get(command) };
      case 'routine.complete-interrupt': this.completeInterrupt(command.companionId); return { ok: true };
      default: return undefined;
    }
  }
}

export function routineConfigurationRequested(content: string): boolean {
  if (/(?:引用|台词|例子|他说|她说|原话|假如|假设|如果).*(?:作息|习惯|睡|起床|吃饭|休息)|(?:不要|不用|别|取消).{0,12}(?:修改|设置|作息|习惯)|\b(?:hypothetical|for example|someone said|do not|don't)\b/iu.test(content)) return false;
  if (!/作息|习惯|睡|起床|吃饭|休息|散步|读书|学习|运动|听歌|看海|routine|bedtime|wake|meal|habit/iu.test(content)) return false;
  return /(?:设置|调整|修改|改成|改为|改一下|安排|希望你|以后你|从今你|养成|培养|请你|麻烦你).*(?:作息|习惯|睡|起床|吃饭|休息|散步|读书|学习|运动|听歌|看海)|(?:作息|习惯).*(?:设置|调整|修改|改成|改为|培养)|(?:把|将).*(?:睡|起床|吃饭|休息|习惯|作息).*(?:改到|改成|改为|调到)|^(?:(?:以后|从今|请|麻烦你|你)[，,\s]*)?(?:每天|每周|每晚).*(?:睡|起床|吃饭|休息|散步|读书|学习|运动|听歌|看海)|\b(?:set|change|adjust|configure|please|from\s+now)\b/iu.test(content.trim());
}

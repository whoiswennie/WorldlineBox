import { randomUUID } from 'node:crypto';
import { companionRoutineConfigSchema, companionRoutinePatchSchema, type CompanionRoutine, type CompanionRoutineConfig,
  type CompanionRoutinePatch, type CompanionRoutineRuntime } from '../shared/companion-routine';
import { advanceCompanionRoutineEnergy, defaultCompanionRoutineConfig, deriveCompanionHabitProgress, evaluateCompanionRoutine,
  type CompanionRoutineInterruption } from '../shared/companion-routine-time';
import { resolveCompanionScheduleTimeZone } from '../shared/companion-schedule-time';
import type { CompanionMessage } from '../shared/companions';
import type { CompanionConnection } from './store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';

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
    private readonly beforeConfigure?: (companionId: string) => void) {}

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
    const conversation = this.requireScope(scope), stored = this.load(scope.companionId), now = iso();
    this.observeWork(scope.companionId, Date.parse(now));
    const config = structuredClone(stored.config), privateSource = this.mustHideConfiguration(scope, conversation, stored);
    let runtime = this.phase(scope.companionId), habitProgress = config.habits.flatMap(habit =>
      deriveCompanionHabitProgress(config, stored.habitSince[habit.id] ?? stored.createdAt, now,
        this.interruptions(scope.companionId, stored.habitSince[habit.id] ?? stored.createdAt, now)).filter(progress => progress.id === habit.id));
    if (privateSource) {
      config.habits = []; config.meals = config.meals.map(meal => ({ ...meal, name: '用餐' })); habitProgress = [];
      runtime = this.publicRuntime(runtime);
    }
    return { companionId: stored.companionId, config, revision: stored.revision, createdAt: stored.createdAt, updatedAt: stored.updatedAt,
      ...(!privateSource && stored.sourceMessageId ? { sourceMessageId: stored.sourceMessageId, sourceConversationId: stored.sourceConversationId } : {}), habitProgress,
      runtime: this.projectActualWork(scope.companionId, runtime) };
  }
  getRuntime(scope: Scope, at = Date.now()): CompanionRoutineRuntime {
    this.observeWork(scope.companionId, at);
    const conversation = this.requireScope(scope), stored = this.load(scope.companionId), runtime = this.phase(scope.companionId, at);
    return this.projectActualWork(scope.companionId, this.mustHideConfiguration(scope, conversation, stored) ? this.publicRuntime(runtime) : runtime);
  }
  private mustHideConfiguration(scope: Scope, conversation: Row, stored: StoredRoutine): boolean {
    if (conversation.kind === 'group' && stored.sourceConversationId !== scope.conversationId) return true;
    return scope.beforeSequence !== undefined && stored.configurationSources.some(source =>
      !this.visibleSources(scope, [source.messageId]).length);
  }
  private projectActualWork(companionId: string, runtime: CompanionRoutineRuntime): CompanionRoutineRuntime {
    if (!this.db.prepare("SELECT 1 FROM actions WHERE companion_id=? AND status='running' UNION ALL SELECT 1 FROM companion_work_queue WHERE companion_id=? AND status='running' LIMIT 1").get(companionId, companionId)) return runtime;
    const { activeHabitId: _activeHabitId, ...awake } = runtime; void _activeHabitId;
    return { ...awake, phase: 'awake', canRespond: true, activity: '正在处理已答应的事，作息暂延' };
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
    const value = this.load(companionId), result = evaluateCompanionRoutine(value.config, iso(now), value.interruptedUntil);
    const previous = this.db.prepare('SELECT phase FROM companion_routine_audit WHERE companion_id=? ORDER BY id DESC LIMIT 1').get(companionId);
    if (!previous || row(previous).phase !== result.phase) {
      this.db.prepare('INSERT INTO companion_routine_audit(companion_id,at,phase) VALUES(?,?,?)').run(companionId, iso(now), result.phase);
      this.db.prepare('DELETE FROM companion_routine_audit WHERE companion_id=? AND id NOT IN (SELECT id FROM companion_routine_audit WHERE companion_id=? ORDER BY id DESC LIMIT 200)').run(companionId, companionId);
    }
    return result;
  }
  nextEnergyCheckAt(companionId: string, now = Date.now()): string { return this.phase(companionId, now).nextTransitionAt; }
  advanceEnergy(companionId: string, from: number | string | Date, to: number | string | Date, energy: number): number {
    const value = this.load(companionId), start = typeof from === 'number' ? iso(from) : from, end = typeof to === 'number' ? iso(to) : to;
    let current = new Date(start).getTime(), result = energy;
    for (const window of this.interruptions(companionId, new Date(start).toISOString(), new Date(end).toISOString())) {
      const left = Math.max(current, Date.parse(window.start)), right = Math.min(new Date(end).getTime(), Date.parse(window.end));
      if (left > current) result = advanceCompanionRoutineEnergy(value.config, iso(current), iso(left), result);
      if (right > left) result = advanceCompanionRoutineEnergy(value.config, iso(left), iso(right), result, iso(right));
      current = Math.max(current, right);
    }
    return advanceCompanionRoutineEnergy(value.config, iso(current), end, result);
  }
  private interruptions(companionId: string, from: string, to: string): CompanionRoutineInterruption[] {
    return (this.db.prepare(`SELECT starts_at,ends_at FROM companion_routine_interruptions WHERE companion_id=? AND ends_at>? AND starts_at<?
      UNION ALL SELECT starts_at,COALESCE(ends_at,last_observed_at) AS ends_at FROM companion_routine_work
      WHERE companion_id=? AND COALESCE(ends_at,last_observed_at)>? AND starts_at<? ORDER BY starts_at`).all(companionId, from, to, companionId, from, to) as Row[])
      .map(value => ({ start: String(value.starts_at), end: String(value.ends_at) }));
  }
  allowWork(companionId: string, sourceMessageId: string, now = Date.now(), proactive = false): boolean {
    // A wake window belongs to a specific urgent interaction, not the owner's
    // entire backlog. Fixed commitments also must not release old queued chat.
    if (evaluateCompanionRoutine(this.load(companionId).config, iso(now)).canRespond) return true;
    if (proactive) return false;
    const message = this.db.prepare('SELECT conversation_id FROM messages WHERE id=?').get(sourceMessageId);
    if (!message) return false;
    const scope = { companionId, conversationId: String(row(message).conversation_id) };
    const source = this.visibleSources(scope, [sourceMessageId])[0];
    if (!source || source.authorId !== 'user') return false;
    if (urgentRoutineRequest(source.content)) return this.interrupt(scope, sourceMessageId, now).canRespond;
    const active = this.db.prepare('SELECT source_message_id FROM companion_routine_interruptions WHERE companion_id=? AND starts_at<=? AND ends_at>? AND source_message_id IS NOT NULL').all(companionId, iso(now), iso(now)) as Row[];
    return active.some(window => {
      const original = this.visibleSources(scope, [String(window.source_message_id)])[0];
      return original?.authorId === 'user' && original.conversationId === source.conversationId
        && source.sequence >= original.sequence && urgentRoutineRequest(original.content);
    });
  }
  interrupt(scope: Scope, sourceMessageId: string, now = Date.now()): CompanionRoutineRuntime {
    this.requireScope(scope); const source = this.visibleSources(scope, [sourceMessageId])[0];
    if (!source || source.authorId !== 'user' || !urgentRoutineRequest(source.content)) throw new Error('临时唤醒需要真实的紧急用户要求。');
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
export function urgentRoutineRequest(content: string): boolean {
  if (/^[\s“”"'‘’「」『』]*[“"'‘「『][\s\S]*[”"'’」』][\s。.!！?？]*$/u.test(content.trim())) return false;
  if (/(?:不是|没有|不算|并不|不太|不)\s*(?:紧急|急事|急用|急需)|(?:假如|假设|如果|故事|小说|台词|引用|例子|他说|她说).*(?:紧急|急事|醒醒|叫醒)|(?:不要|不用|别).{0,8}(?:醒|打断)|\b(?:hypothetical|for example|someone said|not urgent|no emergency)\b/iu.test(content)) return false;
  return /紧急|急事|急用|急需|醒醒|叫醒|立刻.{0,12}(?:帮|处理|回复)|马上.{0,12}(?:帮|处理|回复)|\b(?:urgent|emergency|wake up|right now)\b/iu.test(content);
}

import { createHash } from 'node:crypto';
import type { CompanionAgendaAuthority, CompanionAgendaGoal, CompanionAgendaGrant, CompanionAgendaRule } from '../../shared/companion-agenda';
import { companionAgendaGoalSchema } from '../../shared/companion-agenda';
import type { CompanionLearningGoal, CompanionLearningGoalMaterial } from '../../shared/companion-learning-goals';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionLearningGoalService } from './learning-goal-service';
import { companionAgendaLearningIntent } from '../../companions/agenda-goal-definition';

export interface CompanionAgendaGoalMaterialValidation {
  companionId: string; goalId: string; authority: CompanionAgendaAuthority; materials: readonly CompanionLearningGoalMaterial[];
  allowWeb: boolean; grant?: CompanionAgendaGrant;
}
export interface CompanionAgendaGoalBridgeOptions {
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  learningGoalsService: Pick<CompanionLearningGoalService, 'handle' | 'useAgendaScheduling' | 'cancelTask'>;
  /** The host resolves actual attachment ownership and canonical file roots.
   * A globally existing attachment ID alone never establishes permission. */
  validateMaterials?(input: CompanionAgendaGoalMaterialValidation): Promise<void>;
  now?(): Date;
}
export type CompanionAgendaGoalBridgeResult = { handled: false; reason: string }
  | { handled: true; learningGoalId: string; ruleId: string; learningGoal: CompanionLearningGoal; rule: CompanionAgendaRule };

const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bridges = new WeakMap<object, Map<string, Promise<CompanionAgendaGoalBridgeResult>>>();
const assertOk = <T extends { ok: boolean; error?: string }>(value: T): T => {
  if (!value.ok) throw new Error(value.error ?? '长期方向的学习接入尚未提交。'); return value;
};

async function authorizeMaterials(goal: CompanionAgendaGoal, authority: CompanionAgendaAuthority, options: CompanionAgendaGoalBridgeOptions): Promise<CompanionAgendaGrant | undefined> {
  const autonomous = authority.kind === 'self' || authority.kind === 'system' && goal.origin === 'self';
  let grant: CompanionAgendaGrant | undefined;
  if (goal.grantId) {
    const response = assertOk(await options.request({ type: 'agenda.grants.read', companionId: goal.companionId }));
    grant = response.agendaGrants?.find(value => value.id === goal.grantId && value.companionId === goal.companionId);
    if (!grant || grant.status !== 'active' || grant.goalId && grant.goalId !== goal.id
      || grant.expiresAt && Date.parse(grant.expiresAt) <= (options.now?.() ?? new Date()).getTime()
      || !grant.capabilities.includes('learning')) throw new Error('此长期方向的持续学习授权不可用。');
    if (authority.kind === 'self' && authority.grantId !== grant.id) throw new Error('本次主脑调用不属于该长期方向的持续授权。');
  }
  if (autonomous && !grant) throw new Error('主脑安排持续材料学习需要先有此方向的持续授权。');
  if (autonomous && (goal.allowWeb || goal.materials.some(value => value.kind === 'web')) && !grant?.allowPublicWeb)
    throw new Error('持续学习授权尚未允许探索公开网页，不能由主脑自行扩大网络范围。');
  const libraryMaterials = goal.materials.filter(material => material.kind === 'library' || material.kind === 'asset');
  if (libraryMaterials.length) {
    const sources = assertOk(await options.request({ type: 'learning.status', companionId: goal.companionId })).learning?.grants;
    if (!sources) throw new Error('当前伙伴的真实学习来源授权尚未核实。');
    for (const material of libraryMaterials) {
      const source = sources.find(value => value.id === material.grantId && value.companionId === goal.companionId && value.enabled);
      if (!source || autonomous && !source.autonomous) throw new Error('资料不属于此伙伴当前有效的' + (autonomous ? '自主' : '') + '学习范围。');
    }
  }
  if (goal.materials.some(value => value.kind === 'file') && !options.validateMaterials)
    throw new Error('文件学习需要宿主核验附件的真实归属和当前读取范围，不能仅凭附件标识启动。');
  await options.validateMaterials?.({ companionId: goal.companionId, goalId: goal.id, authority, materials: goal.materials, allowWeb: goal.allowWeb, grant });
  return grant;
}

/** A mutation-time bridge. It starts no model work and is never called just
 * because the user opened a calendar. The agenda remains the timing owner. */
export async function ensureAgendaLearningGoal(input: CompanionAgendaGoal, authority: CompanionAgendaAuthority,
  options: CompanionAgendaGoalBridgeOptions): Promise<CompanionAgendaGoalBridgeResult> {
  let owners = bridges.get(options.learningGoalsService);
  if (!owners) { owners = new Map(); bridges.set(options.learningGoalsService, owners); }
  const key = input.companionId + '/' + input.id, previous = owners.get(key);
  const task = (previous ?? Promise.resolve()).catch(() => undefined).then(() => bridge(input, authority, options));
  owners.set(key, task);
  try { return await task; } finally { if (owners.get(key) === task) owners.delete(key); }
}

async function assertCurrentGoal(goal: CompanionAgendaGoal, options: CompanionAgendaGoalBridgeOptions): Promise<void> {
  const found = assertOk(await options.request({ type: 'agenda.goal.read', companionId: goal.companionId, id: goal.id })).agendaGoal;
  if (!found || found.companionId !== goal.companionId || found.revision !== goal.revision)
    throw new Error('AGENDA_CONFLICT: 长期方向已有更新，本次旧修订未改写真实学习。');
}

async function bridge(input: CompanionAgendaGoal, authority: CompanionAgendaAuthority,
  options: CompanionAgendaGoalBridgeOptions): Promise<CompanionAgendaGoalBridgeResult> {
  const goal = companionAgendaGoalSchema.parse(input);
  if (!['knowledge', 'procedure'].includes(goal.domain)) return { handled: false, reason: '此方向不属于资料阅读与知识学习。' };
  if (goal.status === 'completed' || goal.status === 'retired') return { handled: false, reason: '方向已经结束，不创建新的学习执行。' };
  const text = companionAgendaLearningIntent(goal);
  await assertCurrentGoal(goal, options);
  await authorizeMaterials(goal, authority, options);
  options.learningGoalsService.useAgendaScheduling();

  // Human-authored timing remains authoritative. The bridge only establishes
  // a missing processor reference; it never replaces an existing rhythm.
  let linkedRule: CompanionAgendaRule | undefined, afterId: string | undefined;
  const cursors = new Set<string>();
  while (!linkedRule) {
    const response = assertOk(await options.request({ type: 'agenda.read', companionId: goal.companionId, ...(afterId ? { afterId } : {}), limit: 100 }));
    const page = response.agenda;
    if (!page || page.companionId !== goal.companionId) throw new Error('长期方向的本人日程尚未核实。');
    linkedRule = page.rules.find(rule => rule.goalId === goal.id && rule.executor === 'learning' && !!rule.referenceId);
    if (linkedRule || !page.hasMore) break;
    if (!page.nextId || cursors.has(page.nextId)) throw new Error('日程分页没有继续前进，未建立重复学习安排。');
    cursors.add(page.nextId); afterId = page.nextId;
  }

  let learningGoal: CompanionLearningGoal;
  if (linkedRule) {
    const response = assertOk(await options.request({ type: 'learning.goals.read', companionId: goal.companionId, id: linkedRule.referenceId! }));
    if (!response.learningGoal || response.learningGoal.companionId !== goal.companionId) throw new Error('已关联学习目标不属于当前伙伴。');
    learningGoal = response.learningGoal;
  } else {
    // This inert definition is deliberately independent of mutable goal text.
    // If creation committed before a crash, a later changed revision can still
    // recover the same ID before CAS-updating its actual instructions/materials.
    const created = assertOk(await options.learningGoalsService.handle({ type: 'memory.learning.goals.create', companionId: goal.companionId,
      clientId: 'agenda_' + hash(goal.id), text: '统一长期方向 ' + goal.id, materials: [], allowWeb: false,
      schedule: { intervalMinutes: 60, windows: [], timeZone: 'UTC' } }));
    if (!created.learningGoal || created.learningGoal.companionId !== goal.companionId) throw new Error('真实学习目标创建没有返回本人凭证。');
    learningGoal = created.learningGoal;
  }
  const expected = { text, materials: goal.materials, allowWeb: goal.allowWeb };
  if (learningGoal.text !== text || !equal(learningGoal.materials, goal.materials) || learningGoal.allowWeb !== goal.allowWeb) {
    await assertCurrentGoal(goal, options);
    // Passing the actual revision protects a simultaneous edit or cancellation.
    // The processor cancels any in-flight obsolete definition through handle().
    const updated = assertOk(await options.request({ type: 'learning.goals.update', companionId: goal.companionId,
      id: learningGoal.id, expectedRevision: learningGoal.revision, ...expected, sourceAgendaGoal: { id: goal.id, revision: goal.revision } }));
    if (!updated.learningGoal || updated.learningGoal.id !== learningGoal.id || updated.learningGoal.companionId !== goal.companionId)
      throw new Error('真实学习目标修改没有返回同一目标的凭证。');
    learningGoal = updated.learningGoal;
    options.learningGoalsService.cancelTask(goal.companionId, learningGoal.id);
  } else {
    // A new generic revision may contain only progress. Rebind its identical
    // actual definition without cancelling a valid in-flight learning round.
    assertOk(await options.request({ type: 'learning.goals.bind', companionId: goal.companionId, id: learningGoal.id,
      expectedRevision: learningGoal.revision, sourceAgendaGoal: { id: goal.id, revision: goal.revision } }));
  }

  // A link written by another same-goal operation is idempotent at the store.
  // The stable operation key also prevents duplicate rules after lost replies.
  if (!linkedRule) {
    await assertCurrentGoal(goal, options);
    const anchorAt = new Date(Date.parse(goal.createdAt) + 60 * 60000).toISOString();
    const ruleDraft = { title: goal.title, intent: text, kind: 'learning' as const, executor: 'learning' as const,
      trigger: { kind: 'interval' as const, anchorAt, everyMinutes: 60, timeZone: 'UTC' },
      conditions: [{ key: 'active', equals: true, label: '等待伙伴生活继续' }, { key: 'model.available', equals: true, label: '等待学习模型连接' }],
      flexible: true, protected: false, overlapPolicy: 'wait' as const, resourceKeys: ['learning:' + learningGoal.id],
      reason: '把长期方向安排成可持续接续的真实阅读与练习；安排本身不表示已经掌握。', goalId: goal.id,
      ...(goal.grantId ? { grantId: goal.grantId } : {}), ...(goal.conversationId ? { conversationId: goal.conversationId } : {}), referenceId: learningGoal.id };
    const created = assertOk(await options.request({ type: 'agenda.rule.create', companionId: goal.companionId,
      operationId: 'agenda_learning_' + hash(goal.id), authority, rule: ruleDraft }));
    if (!created.agendaRule || created.agendaRule.companionId !== goal.companionId || created.agendaRule.referenceId !== learningGoal.id)
      throw new Error('学习安排没有返回同一真实学习目标的凭证。');
    linkedRule = created.agendaRule;
  }
  return { handled: true, learningGoalId: learningGoal.id, ruleId: linkedRule.id, learningGoal, rule: linkedRule };
}

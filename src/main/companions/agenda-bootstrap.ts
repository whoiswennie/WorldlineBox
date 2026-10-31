import { createHash } from 'node:crypto';
import { companionAgendaRuleDraftSchema, type CompanionAgendaCommand, type CompanionAgendaResponse, type CompanionAgendaRule, type CompanionAgendaRuleDraft } from '../../shared/companion-agenda';
import type { CompanionRoutine } from '../../shared/companion-routine';
import { companionAgendaRoutineRuleDrafts } from '../../shared/companion-agenda-routine';

export const COMPANION_AGENDA_SELF_WAKE_REFERENCE = 'system_self_wake_v1';
export const COMPANION_AGENDA_MEMORY_REFERENCE = 'system_memory_capture_v1';
export const COMPANION_AGENDA_GROWTH_REFERENCE = 'system_growth_review_v1';
export interface CompanionAgendaBootstrapOptions {
  companion: { id: string; createdAt: string };
  routine: Pick<CompanionRoutine['config'], 'timeZone'>;
  routineConfig?: CompanionRoutine['config'];
  adoptRoutine?(ruleIds: string[]): Promise<void>;
  request(command: CompanionAgendaCommand): Promise<CompanionAgendaResponse>;
  now?: Date;
}

/** Explicit startup/creation initialization only. It is not a calendar read,
 * model inference or physical-world simulation. Paused/retired rules count as
 * present and are never restored merely because the application reopened. */
export async function initializeCompanionAgenda(options: CompanionAgendaBootstrapOptions): Promise<{ rules: CompanionAgendaRule[]; created: number }> {
  const owner = options.companion.id;
  const request = async (command: CompanionAgendaCommand) => {
    const response = await options.request(command);
    if (!response.ok) throw new Error(response.error ?? '伙伴初始日程尚未登记。');
    return response;
  };
  const existing: CompanionAgendaRule[] = [], seen = new Set<string>();
  let afterId: string | undefined;
  do {
    const response = await request({ type: 'agenda.read', companionId: owner, limit: 100, ...(afterId ? { afterId } : {}) });
    if (!response.agenda || response.agenda.companionId !== owner) throw new Error('初始日程读取没有返回当前伙伴的目录。');
    existing.push(...response.agenda.rules);
    if (!response.agenda.hasMore) break;
    const next = response.agenda.nextId;
    if (!next || seen.has(next)) throw new Error('初始日程的目录分页凭据无效，未重新创建规则。');
    seen.add(next); afterId = next;
  } while (afterId !== undefined);
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('初始日程需要真实有效的当前时点。');
  const nextWake = new Date(now.getTime() + 60 * 60000).toISOString();
  const seeds: CompanionAgendaRuleDraft[] = [
    { title: '回看自己的安排', intent: '核对本人当前日程、持续方向与尚未解决的问题，根据真实变化决定维持、调整弹性安排或继续获准范围内的探索。可以保持安静；不能把计划或思考当成已经发生的行动。',
      kind: 'self', executor: 'brain', trigger: { kind: 'interval', anchorAt: nextWake, everyMinutes: 60, timeZone: options.routine.timeZone },
      conditions: [{ key: 'active', equals: true, label: '伙伴生活已启用' }, { key: 'awake', equals: true, label: '本人当前清醒' },
        { key: 'model.available', equals: true, label: '主脑模型连接已配置' }], flexible: true, protected: false, overlapPolicy: 'merge', resourceKeys: [],
      reason: '初始自主回看节奏；本人可结合实际生活修订未来的弹性安排，不要求每轮发言。', referenceId: COMPANION_AGENDA_SELF_WAKE_REFERENCE },
    { title: '梳理值得留下的经历', intent: '核对本人新增的合法聊天、阅读与世界经历，判断是否值得记入正式记忆。同一经历优先延续或修订；没有新增、重复或资料不足时保留事实，不要求强行写日记。正文、来源、索引、标签及必要的格式修复属于同一过程。',
      kind: 'memory', executor: 'memory', trigger: { kind: 'event', topic: 'experience.changed', quietSeconds: 60 },
      conditions: [{ key: 'active', equals: true, label: '伙伴生活已启用' }], flexible: true, protected: true,
      overlapPolicy: 'merge', resourceKeys: ['memory_capture'],
      reason: '真实来源触发的后台整理；睡眠不阻止来源保存与整理，允许无变化，来源撤回与完整性校验不可关闭。', referenceId: COMPANION_AGENDA_MEMORY_REFERENCE },
    { title: '回顾认识与表达的变化', intent: '基于本人新增的真实经历、有效培养方向与已核验资料，审视表达、认知和自我理解。保留适用条件和矛盾，不把一次交流或学习任务直接写成稳定性格；可以保持当前人格。通过既有正式人格发布器提交有据的局部变化。',
      kind: 'growth', executor: 'growth', trigger: { kind: 'event', topic: 'growth.pending', quietSeconds: 120 },
      conditions: [{ key: 'active', equals: true, label: '伙伴生活已启用' }, { key: 'model.available', equals: true, label: '主脑模型连接已配置' }],
      flexible: true, protected: false, overlapPolicy: 'merge', resourceKeys: ['persona_publication'],
      reason: '有真实来源变化后回顾人格；每次保留具体依据、旧版及发布回执，不强制发生变化。', referenceId: COMPANION_AGENDA_GROWTH_REFERENCE },
    { title: '留意世界中的新情况', intent: '核对本人实际收到的消息、现场事件和已有世界待办，使用本人真实权限回应；没有新事情时保持原生活。',
      kind: 'world', executor: 'world', trigger: { kind: 'interval', anchorAt: new Date(now.getTime() + 60000).toISOString(), everyMinutes: 1, timeZone: options.routine.timeZone },
      conditions: [{ key: 'active', equals: true, label: '伙伴生活已启用' }], flexible: true, protected: false, overlapPolicy: 'merge', resourceKeys: [],
      reason: '世界身体时钟持续推进；此处只接续真正待处理的交流、邀请与现场事件，无新输入不调用模型。', referenceId: 'system_world_v1' },
    { title: '睡眠中的回顾与联想', intent: '在本人实际睡眠期间，依据已有正式记忆形成明确标注的梦境联想或保持安静。梦境不是事实、不是人格变化发布，也不是知识验证。',
      kind: 'reflection', executor: 'reflection', trigger: { kind: 'interval', anchorAt: new Date(now.getTime() + 15 * 60000).toISOString(), everyMinutes: 60, timeZone: options.routine.timeZone },
      conditions: [{ key: 'active', equals: true, label: '伙伴生活已启用' }, { key: 'awake', equals: false, label: '本人实际处于睡眠' }],
      flexible: true, protected: false, overlapPolicy: 'merge', resourceKeys: ['dream_reflection'],
      reason: '梦境属于独立标注的联想材料；没有合法输入或实际睡眠条件时不虚构经历。', referenceId: 'system_dream_v1' },
    ...(options.routineConfig ? companionAgendaRoutineRuleDrafts(options.routineConfig) : []),
  ];
  const rules: CompanionAgendaRule[] = [];
  let created = 0;
  for (const draft of seeds) {
    const seed = companionAgendaRuleDraftSchema.parse(draft);
    const prior = existing.find(rule => rule.companionId === owner && rule.referenceId === seed.referenceId);
    if (prior) { rules.push(prior); continue; }
    const operationId = 'agenda_bootstrap_' + createHash('sha256').update(JSON.stringify([owner, seed.referenceId])).digest('hex');
    const response = await request({ type: 'agenda.rule.create', companionId: owner, operationId, rule: seed,
      authority: { kind: 'system' } });
    if (!response.agendaRule || response.agendaRule.companionId !== owner || response.agendaRule.referenceId !== seed.referenceId)
      throw new Error('初始日程创建未返回可核对的规则，未补造成功结果。');
    rules.push(response.agendaRule); created++;
  }
  if (options.routineConfig && options.adoptRoutine) await options.adoptRoutine(rules.filter(rule => rule.executor === 'routine').map(rule => rule.id));
  return { rules, created };
}

import { z } from 'zod';
import type { Companion } from '../../shared/companions';
import { COMPANION_AGENDA_TOOL, companionAgendaToolArgumentsSchema, companionAgendaToolCommand } from '../../shared/companion-agenda-tool';
import type { CompanionAgendaClaim, CompanionAgendaPublicCommand, CompanionAgendaResponse } from '../../shared/companion-agenda';
import { COMPANION_WORLD_TOOL } from '../../shared/companion-world-tool';
import { COMPANION_MEMORY_CAPABILITY_TOOL } from '../../shared/companion-capability-tools';
import type { CompanionLoopCall, CompanionLoopTurn } from '../../shared/companion-loop';
import type { ToolVisualInput } from '../../shared/companion-file-tool';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import type { CompanionModelConfig, CompanionModelOptions } from './model';
import type { CompanionAgendaExecutionContext, CompanionAgendaExecutionResult } from './agenda-service';
import { runCompanionStructuredAgent, companionTaskConversation, companionTaskInvocation } from './structured-agent';
import { companionAgentJournal } from './agent-journal';
import { companionBehaviorSystem } from './asset-behavior-defaults';
import { companionBoundCapabilityContext } from './capability-availability';
import { filterCompanionTools, type CompanionToolPolicy } from '../../shared/companion-tool-policy';

const final = z.strictObject({ decision: z.enum(['complete', 'silent', 'wait']), summary: z.string().trim().min(1).max(6000),
  nextAt: z.iso.datetime({ offset: true }).optional(), waitFor: z.string().trim().min(1).max(1000).optional(),
  messageToUser: z.string().trim().min(1).max(4000).optional() });
export interface CompanionAgendaBrainOptions {
  toolPolicy?: CompanionToolPolicy;
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
  configFor(owner: Companion): Promise<CompanionModelConfig>;
  agenda(command: CompanionAgendaPublicCommand, source: { kind: 'self'; grantId?: string }): Promise<CompanionAgendaResponse>;
  execute(call: CompanionLoopCall, scope: { companionId: string; conversationId: string }, effectId: string, signal: AbortSignal): Promise<unknown>;
  fetchFn?: typeof fetch;
  additionalTools?: NonNullable<CompanionModelOptions['tools']>;
  validate?(): Promise<void>;
  toolImages?(turns: readonly CompanionLoopTurn[]): Promise<ToolVisualInput[]>;
  notifyUser?(content: string): Promise<{ messageId: string }>;
  trace?<T>(call: CompanionLoopCall, signal: AbortSignal, execute: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

/** A self wake is a genuine independent brain invocation. It never attaches a
 * historical human message as a fabricated current request or borrows the UI's
 * selected conversation. Native receipts persist in the existing agent journal. */
export async function executeCompanionAgendaBrain(claim: CompanionAgendaClaim, context: CompanionAgendaExecutionContext,
  signal: AbortSignal, options: CompanionAgendaBrainOptions): Promise<CompanionAgendaExecutionResult> {
  const { rule, occurrence, run } = claim;
  const state = (await options.request({ type: 'state', companionId: rule.companionId, includeConversations: false })).state;
  const companion = state?.companions.find(value => value.id === rule.companionId);
  if (!companion || companion.active === false) return { outcome: 'waiting', stage: '伙伴生活已暂停。', nextCondition: 'companion.active', notBefore: new Date(Date.now() + 60000).toISOString() };
  const scope = { companionId: companion.id, conversationId: 'world_' + companion.id };
  const agenda = await options.agenda({ type: 'agenda.read', companionId: companion.id, limit: 30, category: 'task', compactRecurring: true }, { kind: 'self', grantId: rule.grantId });
  if (!agenda.ok || !agenda.agenda) throw new Error(agenda.error ?? '无法核对本人的日程。');
  const world = (await options.request({ type: 'world.observe', ...scope })).world;
  const runtimeState = (await options.request({ type: 'state.get', ...scope })).runtimeState;
  const availableTools = [COMPANION_AGENDA_TOOL, COMPANION_MEMORY_CAPABILITY_TOOL, COMPANION_WORLD_TOOL, ...(options.additionalTools ?? [])];
  const tools = options.toolPolicy ? filterCompanionTools(availableTools, options.toolPolicy) : availableTools;
  const config = await options.configFor(companion);
  const journal = companionAgentJournal(options.request);
  const output = final.parse(await runCompanionStructuredAgent({ responseSchema: final, journal,
    validateOutput: value => {
      const result = final.parse(value);
      if (result.messageToUser && (!companion.proactive || !options.notifyUser)) throw new Error('当前伙伴未开启主动联系，不发送主动消息。');
      if (result.decision === 'wait' && (!result.waitFor || !result.nextAt || Date.parse(result.nextAt) <= Date.now()))
        throw new Error('自主等待需要真实条件和未来检查时间。');
      return result;
    },
    frame: { companion, conversation: companionTaskConversation(scope.conversationId, companion.id, run.createdAt), messages: [], memories: [],
      proactive: true, world, runtimeState, invocation: companionTaskInvocation({ companion, conversationId: scope.conversationId, id: run.id,
        kind: 'self', goal: rule.intent, createdAt: run.createdAt }),
      capabilityAvailability: companionBoundCapabilityContext(companion.id, scope.conversationId, tools.map(tool => tool.name)) },
    refresh: async () => {
      await options.validate?.();
      return { companion, conversation: companionTaskConversation(scope.conversationId, companion.id, run.createdAt), messages: [], memories: [],
        proactive: true, world: (await options.request({ type: 'world.observe', ...scope })).world,
        runtimeState: (await options.request({ type: 'state.get', ...scope })).runtimeState,
        invocation: companionTaskInvocation({ companion, conversationId: scope.conversationId, id: run.id, kind: 'self', goal: rule.intent, createdAt: run.createdAt }),
        capabilityAvailability: companionBoundCapabilityContext(companion.id, scope.conversationId, tools.map(tool => tool.name)) };
    },
    capabilities: { tools, journal, replaySafe: true, continuityRequest: options.request, toolImages: options.toolImages,
      execute: async (call, callSignal) => {
        const effectiveSignal = callSignal ? AbortSignal.any([signal, callSignal]) : signal;
        const execute = async (effectiveSignal: AbortSignal) => {
        effectiveSignal.throwIfAborted();
        if (call.name === 'agenda') {
          const input = companionAgendaToolArgumentsSchema.parse(JSON.parse(call.arguments));
          const command = companionAgendaToolCommand(input, companion.id, context.effectId('agenda:' + call.id));
          return options.agenda(command, { kind: 'self', grantId: rule.grantId });
        }
        return options.execute(call, scope, context.effectId('native:' + call.id), effectiveSignal);
        };
        return options.trace ? options.trace(call, effectiveSignal, execute) : execute(effectiveSignal);
      } },
    context: { system: companionBehaviorSystem(config, 'companion_agenda_self',
      '本次是本人日程中的真实自主事件，不是沿旧聊天重做用户任务。依据当前人格、实际目标和本次已核验资料选择行动；可回忆、查询本人日程、维护弹性安排、参与真实虚拟世界。固定用户约定不擅改，系统完整性规则不关闭。只调用当前工具；未提供的电脑、文件和屏幕能力均不可用。计划不是经历，虚拟study不是已经读过资料。没有新情况可以保持安静，不必发言或写日记。mayContactUser=true时，可以在最终messageToUser中表达本次真实想告诉当前用户的话，由宿主可靠投递；不是发给其他伙伴，不转述虚构观察。长期方向不因安排过练习就算掌握。依据真实结果返回最终decision/summary；wait需waitFor和未来nextAt，等待本身不证明目标完成。'),
      user: JSON.stringify({ purpose: 'companion_agenda_self', event: { ruleId: rule.id, ruleRevision: rule.revision, runId: run.id,
        title: rule.title, intent: rule.intent, trigger: rule.trigger, reason: rule.reason, input: occurrence.input },
        agenda: { observedAt: agenda.agenda.observedAt, rules: agenda.agenda.rules.map(item => ({ id: item.id, revision: item.revision, title: item.title,
          status: item.status, nextAt: item.nextAt, flexible: item.flexible, origin: item.origin })), goals: agenda.agenda.goals,
          current: agenda.agenda.runs.filter(item => ['running', 'waiting'].includes(item.status)).map(item => ({ id: item.id, ruleId: item.ruleId, status: item.status, stage: item.stage })) },
        mayContactUser: companion.proactive && !!options.notifyUser, outputSchema: z.toJSONSchema(final) }) } }, config, signal, { fetchFn: options.fetchFn }));
  if (output.messageToUser) await options.notifyUser!(output.messageToUser);
  await context.checkpoint('本次自主回顾已保存。', output);
  if (output.decision === 'wait') {
    if (!output.waitFor || !output.nextAt || Date.parse(output.nextAt) <= Date.now()) throw new Error('自主等待需要真实条件和未来检查时间。');
    return { outcome: 'waiting', result: output.summary, nextCondition: output.waitFor, notBefore: output.nextAt, stage: '等待：' + output.waitFor };
  }
  return { outcome: output.decision === 'silent' ? 'silent' : 'completed', result: output.summary, stage: output.decision === 'silent' ? '这次保持原计划，暂不打扰。' : '已根据实际结果结束本次事件。' };
}

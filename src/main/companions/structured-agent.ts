import { setTimeout as waitFor } from 'node:timers/promises';
import { COMPANION_WAIT_TOOL, companionWaitArgumentsSchema } from '../../shared/companion-wait';
import type { Companion, CompanionConversation, CompanionMessage } from '../../shared/companions';
import type { CompanionLoopCall, CompanionLoopCheckpoint, CompanionLoopTurn } from '../../shared/companion-loop';
import { companionFinalValidationFailures, type CompanionAgentRun, type CompanionHostObservationChange } from '../../shared/companion-agent-run';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import { buildCompanionContext, type CompanionReplyInput } from './context';
import { assembleCompanionInvocation, type CompanionInvocationContext } from './invocation-context';
import { CompanionModelError, generateCompanionReply, repairCompanionStructured, type CompanionModelConfig, type CompanionModelOptions } from './model';
import { companionStructuredRepairConservation, parseCompanionStructured, type CompanionStructuredModelOptions, type CompanionStructuredResponseSchema } from './structured-repair';
import { companionContextFrameSchema } from '../../shared/companion-cognition';
import { runCompanionAgentKernel, CompanionAgentFinalValidationError } from './agent-kernel';
import { companionAgentJournal, captureCompanionAgentMemories, type CompanionAgentJournal } from './agent-journal';
import { ensureCompanionLoopContinuity } from './loop-continuity';
import { prepareCompanionAgentDialogue } from './agent-dialogue';
import type { CompanionExecutionReadset } from '../../shared/companion-execution-evidence';
import { captureCompanionExecutionReadset } from './execution-evidence';
import { createCompanionExecutionValidationSession } from './source-execution-evidence';
import { companionBoundCapabilityContext } from './capability-availability';
import { companionToolImageReferenceSchema, type ToolVisualInput } from '../../shared/companion-file-tool';
import { COMPANION_SUBMIT_RESULT_TOOL, companionFinalProposalBytes, companionFinalProposalReceipt, isCompanionFinalTurn,
  companionFinalProposalReceiptSchema, companionFinalProposalJsonText } from '../../shared/companion-final-proposal';

type RoleOptions = Pick<CompanionModelOptions, 'fetchFn' | 'timeoutMs' | 'visualInputs' | 'beforeNetworkDispatch'>;
type ResolvedModelContext = Awaited<ReturnType<NonNullable<CompanionModelConfig['resolveAssetContext']>>>;
class StructuredRepairRequired extends Error {}
class StructuredRepairFailed extends CompanionModelError {
  constructor(message: string, options?: ErrorOptions) {
    const cause = options?.cause instanceof CompanionModelError ? options.cause : undefined;
    super(cause?.code ?? 'INVALID_RESPONSE', message, cause?.diagnostic, cause?.admission);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}
type Scope = { companionId: string; conversationId: string; beforeSequence?: number };
export interface CompanionStructuredAgentCapabilities {
  tools: NonNullable<CompanionModelOptions['tools']>;
  /** Host-declared meaning of the bound DSH schema, never inferred from its name. */
  dshContext?: 'thought' | 'execution';
  execute(call: CompanionLoopCall, signal?: AbortSignal): Promise<unknown>;
  toolImages?(turns: readonly CompanionLoopTurn[]): Promise<ToolVisualInput[]>;
  journal?: CompanionAgentJournal;
  /** Only read operations or effects backed by a stable host receipt may replay. */
  replaySafe?: boolean;
  /** Host-only storage port, used for authorized topic continuity maintenance. */
  continuityRequest?: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>;
}

/** Domain planners share the chat provider/Agent loop, identity, window and memory assembly.
 * Their final JSON contract and authority remain specific to the actual invocation. */
export interface CompanionStructuredAgentInput {
  context: { system: string; user: string };
  frame: CompanionReplyInput;
  capabilities?: CompanionStructuredAgentCapabilities;
  /** Refresh host facts and source visibility before every model inference. */
  refresh?: () => Promise<CompanionReplyInput>;
  /** The caller validates proposed output before any domain effect commits. */
  validateOutput?: (value: unknown, evidence: Readonly<{ turns: readonly CompanionLoopTurn[] }>) => unknown;
  /** Trusted syntax/shape contract. Repair never grants tools or bypasses the
   * independent domain validator below. */
  responseSchema?: CompanionStructuredResponseSchema;
  repairPreserveCollections?: CompanionStructuredModelOptions['repairPreserveCollections'];
  repairPreserveValues?: CompanionStructuredModelOptions['repairPreserveValues'];
  /** Trusted caller's existing output contract. Never read from model/context JSON. */
  finalSchema?: Record<string, unknown>;
  /** Host-only live-domain observation. A changed input supersedes only a saved,
   * uncommitted final through reviseFinal; confirmed native turns stay intact. */
  finalObservationFingerprint?: string;
  /** Host-only live-domain proof. Default callers never reopen a saved final. */
  reviseFinal?: (input: { runId: string; expectedRevision: number; step: number; proposalChecksum: string; reason: string;
    hostObservation?: CompanionHostObservationChange }) => Promise<CompanionAgentRun | undefined>;
  /** Exact host context and confirmed native receipts, before any next effect. */
  observeReadset?: (readset: CompanionExecutionReadset) => void | Promise<void>;
  /** Actual host query horizon. {} means current explicit reads; ownership
   * stays fixed to frame. Omission preserves the ordinary source window. */
  evidenceScope?: { beforeSequence?: number };
  journal?: CompanionAgentJournal;
}

export function companionTaskConversation(id: string, companionId: string, updatedAt: string, memberIds: readonly string[] = [companionId]): CompanionConversation {
  return { id, kind: 'group', title: '独立任务', memberIds: [...new Set([companionId, ...memberIds])], pinned: false,
    muted: false, unread: 0, lastMessage: '', updatedAt };
}

export function companionTaskInvocation(input: { companion: Pick<Companion, 'id'>; conversationId: string; id: string;
  kind: CompanionInvocationContext['kind']; goal: string; createdAt: string; source?: CompanionMessage;
  messageIds?: readonly string[]; participants?: readonly string[] }): CompanionInvocationContext {
  return { id: input.id, kind: input.kind, companionId: input.companion.id, conversationId: input.conversationId,
    sourceMessageId: input.source?.conversationId === input.conversationId ? input.source.id : undefined,
    goal: input.goal, status: 'running', createdAt: input.createdAt, participants: input.participants,
    messagePort: { kind: 'invocation', messageIds: input.messageIds ?? [] },
    authorization: { kind: input.kind === 'peer' ? 'peer' : 'self', sourceMessageIds: input.source ? [input.source.id] : [], externalActions: false } };
}

export function assembleCompanionRoleContext(frame: CompanionReplyInput, domain: { system: string; user: string }) {
  const scopedFrame = assembleCompanionInvocation(frame);
  const base = buildCompanionContext({ ...frame, agentLoop: true, dshContext: frame.dshContext ?? 'unavailable' });
  const common = JSON.parse(base.user) as Record<string, unknown>;
  const data: unknown = JSON.parse(domain.user);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('伙伴领域上下文必须为宿主对象。');
  const payload = data as Record<string, unknown>;
  // A domain can supply narrowly projected world facts and its own output codec,
  // never a second short-term message window or an alternative acting identity.
  const { messages: _messages, source: _source, identity: domainIdentity, memories: _memories, invocation: _invocation,
    characterDevelopment: _characterDevelopment, gameCommunication: _gameCommunication, resourceBounds: _resourceBounds,
    capabilityAvailability: _capabilityAvailability, ...facts } = payload;
  void _messages; void _source; void _memories; void _invocation; void _characterDevelopment; void _gameCommunication; void _resourceBounds; void _capabilityAvailability;
  if (domainIdentity && typeof domainIdentity === 'object') {
    const self = (domainIdentity as { self?: { id?: string } }).self;
    if (self?.id && self.id !== frame.companion.id) throw new Error('领域上下文试图替换伙伴身份。');
  }
  const identity = common.identity as Record<string, unknown> | undefined;
  // Origin is a host-validated sharing record, not a different message author.
  const origin = payload.origin;
  const originSource = payload.source && typeof payload.source === 'object' ? payload.source as { id?: string } : undefined;
  const source = scopedFrame.source
    ? { id: scopedFrame.source.id, conversationId: scopedFrame.source.conversationId, authorId: scopedFrame.source.authorId,
      sequence: scopedFrame.source.sequence, content: scopedFrame.source.content, createdAt: scopedFrame.source.createdAt }
    : originSource?.id && frame.invocation?.authorization.sourceMessageIds.includes(originSource.id)
      ? { ...originSource, trust: 'explicit_task_origin_not_current_chat_message' } : undefined;
  return { system: `${base.system}\n【本次领域调用与最终交付】\n${domain.system}\n当前调用不自动继承聊天入口的电脑、日程或其他伙伴权限。相关回忆由系统在任务开头自动准备，不提供主动检索、阅读长期记忆或回顾个人经历的工具；按已有资料完成当前任务。原生工具列表只列出本轮可即时调用的其他辅助能力，只能调用实际提供的工具。若本次outputSchema或领域executionContract明确提供action、topic等最终提案字段，应按该契约交付，由宿主核验后执行，不需要存在同名原生工具，未提供的字段和行动仍不获授权。最终交付必须是本次outputSchema或领域约定的单个完整JSON对象，不附解释正文或Markdown代码块；解释只放在schema允许的summary、reason等字段中，不套用聊天text格式。`,
    user: JSON.stringify({ ...common, ...facts, identity: { ...identity, ...(origin ? { origin } : {}) },
      messages: common.messages, source,
      ...(frame.memoryRecall ? { memoryContext: frame.memoryRecall.context?.text } : {}),
      memories: common.memories, invocation: common.invocation,
      characterDevelopment: common.characterDevelopment }) };
}

/** Same native tool protocol as player chat. Only host-bound capabilities can execute. */
class CompanionAgentObservationChangedError extends Error {
  constructor(readonly hostObservation: CompanionHostObservationChange) {
    super('本活动尚未执行的最终提案所依据的真实回信观察已变化，需要重新核验。宿主没有判定旧结论错误；新回信只证明作者说过这些话。对照原始来源与真实回执后，可保留仍正确的方案，不因回信更晚或多人附和就改写事实；不重发已确认消息。');
  }
}

type FinalFeedback = { rejectedProposal: string; error: string; hostObservation?: CompanionHostObservationChange };
const feedbackKind = (feedback: FinalFeedback) => feedback.hostObservation ? 'host_observation_changed' as const : 'validation_rejection' as const;
const feedbackInstruction = (feedback: FinalFeedback) => feedback.hostObservation
  ? '宿主只确认本轮资料已变化，旧提案尚未执行并须重新核验；这不是格式或语义错误判定，也不是新目标或授权。新消息是各作者的说法，更晚或重复不代表更真。对照当前原始来源、已确认回执与仍有效的约束，可重新提交仍正确的原方案，不为迎合反馈改变事实；保留已确认作用，不重复执行。'
  : '上一个提案未通过宿主验证，没有产生行动。依据当前真实状态修正后重新交付；不能沿用被拒绝提案当作已发生的事实。';
const isMemoryTool = (name: string) => name === 'memory' || name.startsWith('memory.') || name === 'experience' || name.startsWith('experience.')
  || name === 'world.experience' || name.startsWith('world.experience.');
function isActiveRecallCall(call: CompanionLoopCall): boolean {
  if (isMemoryTool(call.name)) return true;
  if (call.name !== 'world') return false;
  try { return JSON.parse(call.arguments)?.action === 'experience'; } catch { return false; }
}
const memoryToolUnavailable = () => ({ ok: false, code: 'MEMORY_TOOL_DISABLED',
  error: '相关回忆已由系统在本任务开头自动准备，伙伴没有主动记忆或个人经历回顾工具。不要调用memory、memory.*或world.experience，不声称执行了检索或写入；按已有任务上下文与原领域输出契约完成当前任务。' });

export async function runCompanionStructuredAgent(input: CompanionStructuredAgentInput, config: CompanionModelConfig,
  signal?: AbortSignal, options: RoleOptions = {}): Promise<unknown> {
  // A main-brain step has several host callbacks, but only one finite read
  // gate on each side of actual provider/effect dispatch. Sharing that gate
  // avoids replaying every historical source DAG for each journal callback.
  let hostGate: ReturnType<typeof createCompanionExecutionValidationSession> | undefined;
  const inHostGate = <T>(operation: () => Promise<T>): Promise<T> => {
    hostGate ??= createCompanionExecutionValidationSession(signal);
    return hostGate.run(operation);
  };
  const closeHostGate = () => { const previous = hostGate; hostGate = undefined; previous?.close(); };
  const sealHostGate = async () => {
    const previous = hostGate;
    if (!previous) return;
    try { await previous.validate(); }
    finally { if (hostGate === previous) hostGate = undefined; previous.close(); }
  };
  // The transport awaits this after its own admission and before invoking
  // fetch or recording dispatch. A denied fence produces no sent receipt.
  const dispatchOptions = { ...options, beforeNetworkDispatch: async () => {
    await options.beforeNetworkDispatch?.();
    await sealHostGate();
  } };
  try {
  const finalSchema = input.finalSchema ? JSON.parse(JSON.stringify(input.finalSchema)) as Record<string, unknown> : undefined;
  if (finalSchema && !input.validateOutput) throw new Error('宿主最终提案通道必须绑定原领域的实际输出校验器。');
  if (finalSchema) delete finalSchema.$schema;
  const finalSchemaDigest = finalSchema ? createHash('sha256').update(JSON.stringify(finalSchema)).digest('hex') : undefined;
  if (input.capabilities?.tools.some(tool => tool.name === COMPANION_SUBMIT_RESULT_TOOL))
    throw new Error('领域能力不能注册宿主保留的最终提案工具。');
  const finalTool = finalSchema ? { name: COMPANION_SUBMIT_RESULT_TOOL,
    description: '向宿主提交本轮最终提案，参数直接使用本工具的原领域schema。单独调用一次，不与任何辅助工具同轮调用。不执行领域行动，也不授予权限；通过原格式、语义、来源核验后才交回原领域提交。',
    parameters: finalSchema } : undefined;
  const journal = input.journal ?? (input.frame.invocation ? input.capabilities?.journal : undefined);
  const projected = assembleCompanionInvocation(input.frame);
  const run: CompanionAgentRun = journal ? await inHostGate(() => journal.load({ ...input.frame, messages: projected.messages,
    sourceMessage: projected.source ?? input.frame.sourceMessage }, input.context)) : {
    id: randomUUID(), companionId: input.frame.companion.id, conversationId: input.frame.conversation.id,
    invocationId: input.frame.invocation?.id ?? 'processor', topicId: input.frame.invocation?.topicId,
    requestDigest: '0'.repeat(64), revision: 0, status: 'running', turns: [], sources: [], memories: [], effects: [],
  };
  const turns = run.turns;
  const withTaskPassiveRecall = (frame: CompanionReplyInput): CompanionReplyInput => run.passiveRecall
    ? { ...frame, memories: [], memorySources: [], memoryRecall: { reasons: [], pending: false, degraded: false,
      ...(run.passiveRecall.context ? { context: run.passiveRecall.context } : {}) } }
    : frame;
  let evidenceContext: { system: string; user: string } | undefined;
  let evidenceReadset: CompanionExecutionReadset | undefined;
  const captureEvidence = (actualTurns: readonly CompanionLoopTurn[] = turns) => inHostGate(async () => {
    if (!evidenceContext) return;
    const readset = captureCompanionExecutionReadset({ companionId: run.companionId, conversationId: run.conversationId,
      beforeSequence: input.evidenceScope ? input.evidenceScope.beforeSequence : input.frame.contextThroughSequence ?? input.frame.sourceMessage?.sequence }, { context: evidenceContext,
      turns: actualTurns, readsets: evidenceReadset ? [evidenceReadset] : [], sources: run.sources,
      memories: run.memories, frozenMemories: run.frozenMemories, knowledgeReads: run.knowledgeReads, topics: run.topics });
    const append = <T>(current: T[], values: readonly T[]) => { for (const value of values) if (!current.some(item => JSON.stringify(item) === JSON.stringify(value))) current.push(value); };
    append(run.sources, readset.sources); append(run.memories, readset.memories);
    if (readset.frozenMemories) append(run.frozenMemories ??= [], readset.frozenMemories);
    append(run.knowledgeReads ??= [], readset.knowledgeReads); append(run.topics ??= [], readset.topics);
    evidenceReadset = readset;
    await input.observeReadset?.(readset);
  });
  let refreshedFrame = input.frame;
  const save = () => inHostGate(async () => { if (journal) await journal.save(run); });
  if (journal && !run.revision) await save();
  const previousRejection = run.rejectedFinals?.findLast(item => item.step === turns.length - 1);
  const nativeRejection = (turn: CompanionLoopTurn) => {
    if (!turn.finalProposal || !turn.results?.length) return;
    try {
      const receipt = companionFinalProposalReceiptSchema.safeParse(JSON.parse(turn.results[0]!.content));
      return receipt.success && receipt.data.status === 'rejected_before_execution' ? receipt.data : undefined;
    } catch { return; }
  };
  const priorNativeRejection = turns.at(-1) ? nativeRejection(turns.at(-1)!) : undefined;
  let outputCorrection: FinalFeedback | undefined = previousRejection
    ? { rejectedProposal: companionFinalProposalBytes(turns[previousRejection.step]!), error: previousRejection.reason,
      ...(previousRejection.hostObservation ? { hostObservation: previousRejection.hostObservation } : {}) }
    : priorNativeRejection ? { rejectedProposal: companionFinalProposalBytes(turns.at(-1)!), error: priorNativeRejection.reason! } : undefined;
  let invalidOutputs = companionFinalValidationFailures(run), observationChanges = 0;
  let identityCorrection: string | undefined, identityAttempts = 0;
  let capacityFeedback = false, capacityAttempts = 0;
  let nativeResponseFailures = 0;
  // Initial host recall is not an autonomous tool. A composed adapter cannot
  // reintroduce its retired namespace; other world operations stay available.
  const availableAuxiliaryTools = () => [...(input.capabilities?.tools ?? []).filter(tool => !isMemoryTool(tool.name)), COMPANION_WAIT_TOOL];
  const acceptedOutputs = new WeakMap<CompanionLoopTurn, unknown>();
  const originalContexts = new WeakMap<CompanionLoopTurn, ResolvedModelContext>();
  const progressFingerprint = () => JSON.stringify({ companionId: refreshedFrame.companion.id, conversationId: refreshedFrame.conversation.id,
    capabilityTools: availableAuxiliaryTools().map(tool => tool.name),
    invocationId: refreshedFrame.invocation?.id, sourceId: refreshedFrame.sourceMessage?.id,
    messages: refreshedFrame.messages.map(message => [message.id, message.sequence, message.content]),
    topic: refreshedFrame.topic ? { id: refreshedFrame.topic.id, status: refreshedFrame.topic.status,
      participantIds: refreshedFrame.topic.participantIds, sharedSource: refreshedFrame.topicState?.shared?.sourceEventId } : undefined,
    gameCommunication: refreshedFrame.gameCommunication ? { port: refreshedFrame.gameCommunication.gamePort,
      revision: refreshedFrame.gameCommunication.topic.revision, shared: refreshedFrame.gameCommunication.topicState.shared?.sourceEventId,
      own: refreshedFrame.gameCommunication.topicState.workingState?.sourceEventId } : undefined,
    ...(input.finalObservationFingerprint !== undefined ? { finalObservation: input.finalObservationFingerprint } : {}) });
  const parseOutput = async (turn: CompanionLoopTurn, allowRepair = true) => {
    if (acceptedOutputs.has(turn)) return acceptedOutputs.get(turn);
    if (input.finalObservationFingerprint !== undefined && turns.includes(turn)) {
      const currentKey = createHash('sha256').update(progressFingerprint()).digest('hex');
      if (turn.hostProgressKey && turn.hostProgressKey !== currentKey)
        throw new CompanionAgentObservationChangedError({ kind: 'host_observation_changed', previousKey: turn.hostProgressKey, currentKey });
      if (!turn.hostProgressKey) throw new Error('本活动尚未执行的最终提案缺少旧观察凭证。请读取本轮 recentPeerMessages 的实际最新回信，依据当前事实重新选择下一步；不重发已确认消息。');
    }
    let value: unknown;
    if (turn.finalProposal && (!finalSchemaDigest || turn.finalProposal.schemaDigest !== finalSchemaDigest))
      throw new Error('最终提案与本轮宿主注册的领域契约不一致，未执行。');
    const json = turn.finalProposal ? companionFinalProposalJsonText(turn) : turn.rawText;
    const originalHash = createHash('sha256').update(json).digest('hex');
    const assertRootVersion = async (root: NonNullable<NonNullable<CompanionLoopTurn['structuredRepair']>['rootContext']>) => {
      if (!config.resolveAssetContext) return;
      try {
        const current = await config.resolveAssetContext(input.context, 'structured');
        if (!current.frame || current.frame.profileRevision !== root.frame.profileRevision
          || current.frame.promptRevision !== root.frame.promptRevision || current.frame.revocationEpoch !== root.frame.revocationEpoch)
          throw new CompanionModelError('CANCELLED', '原请求的人格、指导或来源撤销版本已变化，旧修复已取消。');
      } catch (cause) { throw new StructuredRepairFailed('原请求版本无法继续核验，旧修复未生效。', { cause }); }
    };
    const rootContext = turn.structuredRepair?.rootContext;
    if (rootContext) {
      if (rootContext.frame.companionId !== run.companionId
        || rootContext.hash !== createHash('sha256').update(JSON.stringify([rootContext.system, rootContext.user, rootContext.frame])).digest('hex'))
        throw new StructuredRepairFailed('原请求修复凭证归属或实际字节已变化，未继续。');
      // A restored result is tied to the original owner revision and epoch.
      // Current context is only a revocation check, never replacement evidence.
      await assertRootVersion(rootContext);
    }
    let needsRepair = false;
    if (turn.structuredRepair?.content !== undefined) {
      const receipt = turn.structuredRepair;
      if (receipt.originalHash !== originalHash || receipt.contentHash !== createHash('sha256').update(receipt.content!).digest('hex'))
        throw new StructuredRepairFailed('已保存的格式修复与原始提案或实际修复字节不一致，未继续。');
      const checked = parseCompanionStructured(receipt.content!, input.responseSchema);
      if (!checked.success) throw new StructuredRepairFailed('已保存的修复不符合当前JSON输出契约，未自动重修或执行。');
      if (companionStructuredRepairConservation(json, checked.value, input.repairPreserveCollections, input.repairPreserveValues))
        throw new StructuredRepairFailed('已保存的修复没有保留原提案的记录、正文或来源，未执行。');
      value = checked.value;
    } else {
      if (turn.structuredRepair && turn.structuredRepair.originalHash !== originalHash)
        throw new StructuredRepairFailed('格式修复次数凭证与本次原始提案不一致，未继续。');
      const checked = parseCompanionStructured(json, input.responseSchema);
      if (checked.success) value = checked.value; else needsRepair = true;
      if (needsRepair) {
        if (!allowRepair) throw new StructuredRepairRequired();
        const actual = rootContext ?? originalContexts.get(turn);
        if (config.resolveAssetContext && !actual?.frame)
          throw new StructuredRepairFailed('待修复提案缺少实际已发送的原始上下文凭证；请基于当前材料明确重试，不复用新版本修旧结果。');
        const normalizedFrame = actual?.frame ? companionContextFrameSchema.parse(actual.frame) : undefined;
        const known = actual && normalizedFrame ? { system: actual.system, user: actual.user, frame: normalizedFrame,
          hash: createHash('sha256').update(JSON.stringify([actual.system, actual.user, normalizedFrame])).digest('hex') } : undefined;
        if (known && Buffer.byteLength(JSON.stringify(known), 'utf8') > 512 * 1024)
          throw new StructuredRepairFailed('原请求修复凭证超过有界容量，未额外付费或复制更多资料。');
        try {
          value = await repairCompanionStructured({ context: actual ?? evidenceContext ?? input.context, ...(actual ? { resolvedContext: actual } : {}),
            raw: json, config, signal, options: { ...dispatchOptions, responseSchema: input.responseSchema,
              repairPreserveCollections: input.repairPreserveCollections,
              repairPreserveValues: input.repairPreserveValues,
              initialRepairAttempts: turn.structuredRepair?.attempts === 2 ? 2 : turn.structuredRepair?.attempts === 1 ? 1 : 0,
              onRepairAttempt: async receipt => {
                if (receipt.originalHash !== originalHash || receipt.attempt !== (turn.structuredRepair?.attempts ?? 0) + 1)
                  throw new Error('格式修复次数或原提案凭证不连续。');
                turn.structuredRepair = { originalHash, attempts: receipt.attempt, ...(known ? { rootContext: known } : {}) };
                await save();
              }, onRepairResult: async receipt => {
                if (receipt.originalHash !== originalHash || receipt.attempt !== turn.structuredRepair?.attempts
                  || receipt.contentHash !== createHash('sha256').update(receipt.content).digest('hex'))
                  throw new Error('格式修复成功回执与实际尝试或字节不匹配。');
                turn.structuredRepair = { originalHash, attempts: receipt.attempt, content: receipt.content, contentHash: receipt.contentHash,
                  ...(known ? { rootContext: known } : {}) };
                await save();
              } } });
          if (known) await assertRootVersion(known);
        } catch (error) {
          if (signal?.aborted) throw error;
          throw new StructuredRepairFailed('本次格式修复未能完成，已保存尝试次数；未执行提案。', { cause: error });
        }
      }
    }
    const accepted = input.validateOutput ? await input.validateOutput(value, { turns }) : value;
    acceptedOutputs.set(turn, accepted); return accepted;
  };
  const rejectFinal = async (turn: CompanionLoopTurn, step: number, error: unknown, persisted: boolean): Promise<boolean> => {
    if (!isCompanionFinalTurn(turn) || !input.reviseFinal && !turn.finalProposal) return false;
    if (companionFinalValidationFailures(run) >= 3) throw new CompanionAgentFinalValidationError(outputCorrection?.error ?? '最终提案已达到三次校验失败上限。');
    const hostObservation = error instanceof CompanionAgentObservationChangedError ? error.hostObservation : undefined;
    // One new host snapshot per scheduling entry; further changes yield to the
    // existing activity retry/deadline rather than creating a busy repair loop.
    if (hostObservation && observationChanges++ >= 1) throw error;
    if (!persisted) { turns.push(turn); await save(); }
    const reason = (error instanceof Error ? error.message : '最终提案未通过当前契约核验。').slice(0, 2000);
    const proposalChecksum = createHash('sha256').update(companionFinalProposalBytes(turn)).digest('hex');
    if (!input.reviseFinal) {
      if (run.status === 'done' || turn.results && !nativeRejection(turn)) throw error;
      if (hostObservation) throw error;
      turn.results = companionFinalProposalReceipt(turn, 'rejected_before_execution', proposalChecksum, reason);
      await save();
      outputCorrection = { rejectedProposal: companionFinalProposalBytes(turn), error: reason };
      invalidOutputs = companionFinalValidationFailures(run);
      if (invalidOutputs >= 3) throw new CompanionAgentFinalValidationError(reason);
      return true;
    }
    const revised = await input.reviseFinal({ runId: run.id, expectedRevision: run.revision, step, proposalChecksum, reason,
      ...(hostObservation ? { hostObservation } : {}) });
    if (!revised) return false;
    const rejection = revised.rejectedFinals?.at(-1);
    if (revised.id !== run.id || revised.companionId !== run.companionId || revised.conversationId !== run.conversationId
      || revised.invocationId !== run.invocationId || revised.revision !== run.revision + 1 || revised.status !== 'running'
      || rejection?.step !== step || rejection.proposalChecksum !== proposalChecksum
      || JSON.stringify(rejection.hostObservation) !== JSON.stringify(hostObservation)) throw new Error('宿主未返回当前原任务最终提案的准确拒绝凭证。');
    const revisedTurn = revised.turns[step];
    if (!revisedTurn || JSON.stringify({ ...turn, results: undefined }) !== JSON.stringify({ ...revisedTurn, results: undefined }))
      throw new Error('宿主改写了已提交最终提案的原始调用，停止恢复。');
    turn.results = revisedTurn.results;
    run.revision = revised.revision; run.status = revised.status; run.rejectedFinals = revised.rejectedFinals;
    outputCorrection = { rejectedProposal: companionFinalProposalBytes(turn), error: reason, ...(hostObservation ? { hostObservation } : {}) };
    invalidOutputs = companionFinalValidationFailures(run);
    if (invalidOutputs >= 3) throw new CompanionAgentFinalValidationError(reason);
    return true;
  };
  const retryInference = Symbol('retry structured inference');
  return await runCompanionAgentKernel({ state: run, signal, save,
    recoverFinal: (turn, step, error) => error instanceof StructuredRepairFailed ? Promise.resolve(false) : rejectFinal(turn, step, error, true),
    finalWasRejected: turn => !!nativeRejection(turn),
  afterStep: async succeeded => { if (succeeded) await sealHostGate(); else closeHostGate(); },
  beforeStep: () => inHostGate(async () => {
      if (companionFinalValidationFailures(run) >= 3) throw new CompanionAgentFinalValidationError(outputCorrection?.error ?? '最终提案已达到三次校验失败上限。');
      if (journal && !await journal.valid(run)) throw new Error('本轮推理来源或检查点已变化，不能继续发布。');
      refreshedFrame = withTaskPassiveRecall(input.refresh ? await input.refresh() : input.frame);
      refreshedFrame = { ...refreshedFrame, dshContext: input.capabilities?.dshContext ?? 'unavailable', capabilityAvailability: companionBoundCapabilityContext(refreshedFrame.companion.id,
        refreshedFrame.conversation.id, availableAuxiliaryTools().map(tool => tool.name)) };
      if (input.capabilities?.continuityRequest) refreshedFrame = await prepareCompanionAgentDialogue({ frame: refreshedFrame,
      request: input.capabilities.continuityRequest, config, signal, fetchFn: options.fetchFn });
      evidenceContext = assembleCompanionRoleContext(refreshedFrame, input.context);
      await captureEvidence();
    }),
    progressFingerprint,
  infer: async step => { for (;;) { const inferred = await inHostGate(async () => {
    signal?.throwIfAborted();
    let frame = withTaskPassiveRecall(capacityFeedback && input.refresh ? await input.refresh() : refreshedFrame);
    const effectiveTools = [...availableAuxiliaryTools(), ...(finalTool ? [finalTool] : [])];
    frame = { ...frame, dshContext: input.capabilities?.dshContext ?? 'unavailable', capabilityAvailability: companionBoundCapabilityContext(frame.companion.id, frame.conversation.id,
      effectiveTools.map(tool => tool.name)) };
    const capacityBefore = capacityFeedback ? JSON.stringify({ messages: frame.messages, topicState: frame.topicState }).length : 0;
    if (capacityFeedback && input.capabilities?.continuityRequest) frame = await prepareCompanionAgentDialogue({ frame,
      request: input.capabilities.continuityRequest, config, signal, fetchFn: options.fetchFn, capacityFeedback: true });
    const topicCapacityReduced = capacityFeedback && JSON.stringify({ messages: frame.messages, topicState: frame.topicState }).length < capacityBefore;
    const context = outputCorrection ? { ...input.context, user: JSON.stringify({ ...JSON.parse(input.context.user),
      outputCorrection: { ...outputCorrection, kind: feedbackKind(outputCorrection), instruction: feedbackInstruction(outputCorrection) } }) } : input.context;
    const assembled = assembleCompanionRoleContext(frame, context);
    if (finalTool) assembled.system += `\n【宿主最终提案通道】\n本次已注册 ${COMPANION_SUBMIT_RESULT_TOOL}。完成必要的辅助查询后，优先单独调用它并直接以原领域outputSchema作为参数，不输出正文或再次包裹JSON字符串；不能与其他工具同轮调用。提交仅接受原提案，原领域仍校验来源、语义与权限后才执行；回执中的accepted_for_domain_commit不代表行动已经完成。若服务返回文本最终JSON，仍使用原严格校验，不能以口头声称完成代替提案。`;
    evidenceContext = assembled;
    await captureEvidence();
    const continuity: CompanionLoopCheckpoint = { companionId: run.companionId, conversationId: run.conversationId,
      sourceMessageId: run.sources[0]?.id ?? run.id, invocationKey: run.id, status: run.status,
      turns, supplements: [], workingState: run.workingState };
    const inference = await ensureCompanionLoopContinuity({ checkpoint: continuity, turns, context: assembled, config, signal,
      fetchFn: options.fetchFn, beforeNetworkDispatch: dispatchOptions.beforeNetworkDispatch, save: async () => { run.workingState = continuity.workingState; await save(); },
      valid: journal ? () => journal.valid(run) : undefined, capacityFeedback: capacityFeedback && !topicCapacityReduced });
    if (capacityFeedback && !topicCapacityReduced && !inference.capacityReduced) throw new CompanionModelError('CONTEXT_CAPACITY',
      '当前完整来源块或消息端口超过模型服务的实际容量，且没有可安全压缩的旧步骤；请按需读取原文或缩小当前端口，不能原样重复请求。');
    capacityFeedback = false;
    let result: Awaited<ReturnType<typeof generateCompanionReply>>;
    let resolved: ResolvedModelContext | undefined;
    const originalResolver = config.resolveAssetContext;
    const observedConfig = originalResolver ? { ...config, resolveAssetContext: async (...args: Parameters<typeof originalResolver>) => {
      const value = await inHostGate(() => originalResolver(...args)); resolved = structuredClone(value); return value;
    } } : config;
    try {
      result = await generateCompanionReply(frame, observedConfig, signal, { ...dispatchOptions, loop: true, identityCorrection,
      context: inference.context, tools: effectiveTools, turns: inference.turns,
      toolImages: await input.capabilities?.toolImages?.(inference.turns),
      ...(outputCorrection ? { hostValidationFeedback: {
        rejectedProposalChecksum: createHash('sha256').update(outputCorrection.rejectedProposal).digest('hex'), error: outputCorrection.error,
        kind: feedbackKind(outputCorrection), ...(outputCorrection.hostObservation ? { hostObservation: outputCorrection.hostObservation } : {}),
        instruction: feedbackInstruction(outputCorrection) } } : {}),
      // Domain facts were just read and narrowed by that entry's host. Applying
      // the generic historical world replay projection again loses current
      // observations and can restore fields deliberately excluded for peers.
      projectContext: current => {
        const refreshed = JSON.parse(current.user), domain = JSON.parse(assembled.user);
        for (const key of ['world', 'worldClock', 'runtimeState', 'runtimeBehavior', 'characterDevelopment', 'source', 'gameCommunication', 'resourceBounds', 'capabilityAvailability']) {
          if (key in domain) refreshed[key] = domain[key]; else delete refreshed[key];
        }
        if (domain.identity?.origin) refreshed.identity.origin = domain.identity.origin;
        return { system: current.system, user: JSON.stringify(refreshed) };
      } });
      identityCorrection = undefined; identityAttempts = 0;
      capacityAttempts = 0;
    } catch (error) {
      // No native turn has been committed and no effects were dispatched for
      // this inference slot. Retry an incomplete/malformed provider envelope,
      // retaining every earlier confirmed tool receipt without executing it.
      if (!signal?.aborted && error instanceof CompanionModelError && error.code === 'INVALID_RESPONSE' && nativeResponseFailures++ < 2) return retryInference;
      if (!signal?.aborted && error instanceof CompanionModelError && error.code === 'CONTEXT_CAPACITY' && capacityAttempts++ < 3) {
        capacityFeedback = true; return retryInference;
      }
      // A rejected identity/topic admission is a correctable proposal, just as
      // malformed final JSON is. Keep it inside this same independent loop;
      // do not fail the whole social job and wait for the outbox retry timer.
      if (!signal?.aborted && error instanceof CompanionModelError && error.code === 'IDENTITY' && identityAttempts++ < 2) {
        identityCorrection = error.message;
        return retryInference;
      }
      throw error;
    }
    return inHostGate(async () => {
    const turn = result.turn;
    if (!turn) throw new CompanionModelError('INVALID_RESPONSE', '伙伴领域调用缺少原生循环结果。');
    if (resolved) originalContexts.set(turn, resolved);
    const submission = finalTool && turn.calls.find(call => call.name === COMPANION_SUBMIT_RESULT_TOOL);
    if (submission) turn.finalProposal = { callId: submission.id, schemaDigest: finalSchemaDigest! };
    if (!turn.calls.length) {
      await captureEvidence();
      try {
        await parseOutput(turn, false);
      }
      catch (error) {
        // A repair may be paid only after this original decision has reached
        // the kernel's durable turn boundary. It never runs native effects.
        if (error instanceof StructuredRepairRequired) return turn;
        if (error instanceof StructuredRepairFailed) throw error;
        if (input.reviseFinal) {
          if (await rejectFinal(turn, step, error, false)) return undefined;
          throw error;
        }
        if (++invalidOutputs >= 3) throw error;
        outputCorrection = { rejectedProposal: turn.rawText, error: error instanceof Error ? error.message : '输出未通过本次契约校验。' };
        return retryInference;
      }
    }
    nativeResponseFailures = 0;
    return turn;
    });
  }); if (inferred !== retryInference) return inferred; } },
  execute: (turn, step) => inHostGate(async () => {
    const results: NonNullable<CompanionLoopTurn['results']> = [];
    const receipt = (call: CompanionLoopCall, content: string) => {
      let images;
      if (call.name === 'browser') {
        try { images = z.object({ images: z.array(companionToolImageReferenceSchema).max(4).optional() }).parse(JSON.parse(content)).images; } catch { /* An ordinary error has no pixels. */ }
      }
      return { callId: call.id, content, ...(images ? { images } : {}) };
    };
    const allowed = new Set(availableAuxiliaryTools().map(tool => tool.name));
    for (const [slot, call] of turn.calls.entries()) {
      signal?.throwIfAborted();
      await captureEvidence();
      let effect = run.effects.find(item => item.step === step && item.callId === call.id);
      if (effect?.state === 'confirmed') { results.push(receipt(call, effect.result!)); continue; }
      if (effect && !input.capabilities?.replaySafe) throw new Error('能力执行结果尚未确认，须核对实际作用，不能盲目重放。');
      if (!effect) { effect = { step, callId: call.id, state: 'dispatched' }; run.effects.push(effect); await save(); }
      // Fence failure is task control, not an ordinary tool error receipt.
      // Do not execute or tell the model to repair withdrawn host authority.
      await sealHostGate();
      let content: string;
      try {
        if (isActiveRecallCall(call)) {
          content = JSON.stringify(memoryToolUnavailable());
          effect.state = 'confirmed'; effect.result = content; await save(); results.push(receipt(call, content)); continue;
        }
        if (call.name === 'wait') {
          if (turn.calls.length !== 1) throw new Error('wait 应单独调用，等待后重新观察真实状态。');
          const args = companionWaitArgumentsSchema.parse(JSON.parse(call.arguments));
          await waitFor(args.ms, undefined, { signal });
          content = JSON.stringify({ ok: true, waitedMs: args.ms, reason: args.reason, instruction: '等待结束，请重新观察操作结果。' });
          effect.state = 'confirmed'; effect.result = content; await save(); results.push(receipt(call, content)); continue;
        }
        if (!input.capabilities || !allowed.has(call.name)) throw new Error('当前调用未提供此能力。');
        const effectId = createHash('sha256').update(JSON.stringify([run.id, step, slot])).digest('hex');
        // Persisted intent and its complete prior readset are freshly fenced
        // before an external effect. Its returned sources get a new gate.
        const value = await inHostGate(() => input.capabilities!.execute({ ...call, id: effectId }, signal));
        captureCompanionAgentMemories(run, value);
        content = JSON.stringify(value) ?? 'null';
      } catch (error) {
        if (signal?.aborted) throw error;
        content = JSON.stringify({ ok: false, error: error instanceof Error ? error.message : '能力执行失败。' });
      }
      effect.state = 'confirmed'; effect.result = content; await save();
      results.push(receipt(call, content));
      await captureEvidence([...turns.slice(0, -1), { ...turn, results: [...results] }]);
    }
    return results;
  }), finish: turn => inHostGate(async () => {
    await captureEvidence();
    const output = await parseOutput(turn);
    if (turn.finalProposal) turn.results = companionFinalProposalReceipt(turn, 'accepted_for_domain_commit',
      createHash('sha256').update(companionFinalProposalBytes(turn)).digest('hex'));
    return output;
  }) });
  } catch (error) {
    if (signal?.aborted && !(error instanceof CompanionModelError)) throw new CompanionModelError('CANCELLED', '本次伙伴任务已停止，保留已确认步骤。');
    throw error;
  } finally { closeHostGate(); }
}

/** Retain durable host bindings without exposing any autonomous long-term
 * recall. Internal memory/capture/learning and the memory UI use other ports. */
export function companionRecallCapabilities(request: (command: CompanionStorageCommand) => Promise<CompanionStorageResponse>, scope: Scope) {
  void scope;
  return { journal: companionAgentJournal(request), replaySafe: true, continuityRequest: request,
    tools: [] as NonNullable<CompanionModelOptions['tools']>,
    execute: async (call: CompanionLoopCall) => {
      if (isActiveRecallCall(call)) return memoryToolUnavailable();
      throw new Error('本次即时工具调用不支持该操作，未执行。可即时调用的操作以当前工具schema为准；领域最终提案仍按executionContract/outputSchema交付，由宿主另行核验执行。');
    } };
}

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BotBrain } from './brain-router';
import { BotDshOutputLimitError, BotDshTurnFailedError, type BotDshCallback, type BotDshModel } from './dsh-brain';
import type { BotMemoryScope, BotMemoryService, BotMaintenanceWorkBatch } from './memory-service';
import { fitsNativeModelEnvelope } from './native-model-budget';
import { resolveBotModelLimits } from './model-limits';
import memoMaster from '../../../resources/vcp-memory/upstream/toolbox/Agent/MemoMaster.txt?raw';
import type { MaintenanceBrief, MemoMasterMode } from '../../shared/companion-bot-maintenance';

export type BotMemoryMaintenanceKind = 'organize' | 'dream';
export type BotMemoryMaintenancePhase = 'scanning' | 'reading' | 'recalling' | 'planning' | 'continuing' | 'pending_review' | 'applying';
export interface BotMemoryMaintenanceSource {
  id: string; checksum: string; content: string; tags: string[]; createdAt: string;
  diaryDate?: string;
  role?: 'seed' | 'context';
  sourceEventId?: string; sourceMessageIds: string[];
}
export interface BotMemoryMaintenanceScan {
  cursor?: string; nextCursor?: string; examined: number; selected: number;
  incremental?: boolean;
  context?: number;
  deferred: Array<{ id: string; reason: string; retryable?: boolean; code?: 'capacity' | 'unavailable' | 'pending' | 'invalid_candidate' }>;
}
export interface BotMemoryMaintenanceSnapshot {
  format: 'worldlinebox-memory-maintenance-snapshot-v2'; operationId: string; scope: BotMemoryScope;
  kind: BotMemoryMaintenanceKind; mode?: MemoMasterMode; contextEpoch: number; sourceRevision: string; createdAt: string;
  brief?: MaintenanceBrief;
  dreamer?: { name: string; persona: string };
  scan: BotMemoryMaintenanceScan; sources: BotMemoryMaintenanceSource[];
  retrieval: { engine: 'DreamWaveEngine' | 'DailyNoteManager.Associate'; result: unknown };
}
export interface BotMemoryMaintenanceCandidate {
  id: string; type: 'organize' | 'update' | 'insight' | 'archive'; sourceIds: string[];
  content: string; tags: string[]; reason: string; uncertainties: string[];
  quotes: Array<{ sourceId: string; text: string }>;
  crystal?: { content: string; tags: string[] };
  eventState?: 'in_progress' | 'completed' | 'superseded' | 'conflict';
}
export interface BotMemoryMaintenancePlan extends Omit<BotMemoryMaintenanceSnapshot, 'format'> {
  format: 'worldlinebox-memory-maintenance-v2'; id: string;
  narrative: string; candidates: BotMemoryMaintenanceCandidate[];
  exemptions?: Array<{ id: string; reason: string }>;
  validationIssues?: Array<{ candidateIndex: number; sourceIds: string[]; reason: string }>;
}
export interface BotMemoryMaintenanceProgress { phase: BotMemoryMaintenancePhase; completed?: number; total?: number }
export interface BotMemoryMaintenancePrepareInput {
  scope: BotMemoryScope; kind: BotMemoryMaintenanceKind; mode?: MemoMasterMode; operationId: string; contextEpoch: number;
  brief?: MaintenanceBrief;
  cursor?: string; sourceIds?: string[]; snapshot?: BotMemoryMaintenanceSnapshot;
  selectBatch?(): Promise<BotMaintenanceWorkBatch>;
  associate?(retrieval: unknown): Promise<Array<{ id: string; checksum: string }>>;
  admissionAttempt?: number;
  continuation?: BotMaintenanceContinuation;
  onContinuation?(checkpoint: BotMaintenanceContinuation): Promise<void>;
  /** Persist the frozen source envelope before admitting the durable model turn. */
  onSnapshot(snapshot: BotMemoryMaintenanceSnapshot): Promise<void>;
  onProgress?(progress: BotMemoryMaintenanceProgress): void | Promise<void>;
  onDiagnostic?(phase: string, value: unknown): Promise<void>;
  signal?: AbortSignal;
}
export interface BotMaintenanceContinuation { eventId: string; checkpoint: number; text: string }
export interface BotMemoryMaintenanceApplyInput {
  scope: BotMemoryScope; plan: BotMemoryMaintenancePlan; candidateId: string;
  contextEpoch: number; approval: 'review';
  onProgress?(progress: BotMemoryMaintenanceProgress): void | Promise<void>;
  onDiagnostic?(phase: string, value: unknown): Promise<void>;
  signal?: AbortSignal;
  inspectOnly?: boolean;
}
export interface BotMemoryMaintenanceApplyResult {
  actionId: string; operationId: string;
  status: 'indexed' | 'archived' | 'pending' | 'partial' | 'unknown' | 'conflict' | 'withdrawn' | 'not_started';
  receipt?: Record<string, unknown>; error?: { code: string; message: string };
}
export interface BotMemoryMaintenanceOptions {
  brain: Pick<BotBrain, 'run' | 'archive'>;
  memory: Pick<BotMemoryService, 'catalog' | 'readNote' | 'withdrawnSources' | 'associateDiaries' | 'dreamRecall' | 'maintenanceInsight' | 'maintenanceArchive' | 'update' | 'organize' | 'operationReceipt'>;
  cwd(scope: BotMemoryScope, operationId: string): string;
  callback(): Promise<BotDshCallback>;
  model(): BotDshModel;
  dreamer?(scope: BotMemoryScope): { name: string; persona: string } | undefined;
}

export const maintenanceDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

const sourceId = z.string().regex(/^[a-f0-9]{64}$/u);
const checksum = z.string().regex(/^[a-f0-9]{32}$/u);
const candidateSchema = z.strictObject({ type: z.enum(['organize', 'update', 'insight', 'archive']), sourceIds: z.array(sourceId).min(1),
  content: z.string(), tags: z.array(z.string().trim().min(1).max(64)).max(12), reason: z.string().trim().min(1),
  crystal: z.strictObject({ content: z.string().trim().min(1), tags: z.array(z.string().trim().min(1).max(64)).min(1).max(12) }).optional(),
  eventState: z.enum(['in_progress', 'completed', 'superseded', 'conflict']).optional(),
  uncertainties: z.array(z.string().min(1)), quotes: z.array(z.strictObject({ sourceId, text: z.string().min(1) })).min(1) });
type MaintenanceModelResult = { narrative: string; candidates: z.infer<typeof candidateSchema>[] };
const envelopeSchema = z.strictObject({ narrative: z.string(), candidates: z.array(z.unknown()) });
const error = (code: string, message: string) => Object.assign(new Error(message), { code });
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('MEMORY_MAINTENANCE_INVALID', 'Invalid maintenance data.');
  return value as Record<string, unknown>;
};
const sameScope = (a: BotMemoryScope, b: BotMemoryScope) => a.companionId === b.companionId && a.securityDomainId === b.securityDomainId && a.conversationId === b.conversationId;
const limitsFor = (model: BotDshModel) => ({ ...model, maxTokens: resolveBotModelLimits({ ...model, maxTokens: model.maxOutputTokens ?? model.maxTokens }).maxTokens });
const fits = (model: BotDshModel, system: string, prompt: string) => fitsNativeModelEnvelope(model, system, prompt);
const epochValid = (value: number) => Number.isSafeInteger(value) && value > 0;
// The role is the pinned MemoMaster text. Only the standalone server's
// injection placeholders / private diary mount are replaced by the scoped host.
export const memoMasterRole = [
  memoMaster.slice(0, memoMaster.indexOf('---')).trim(),
  memoMaster.slice(memoMaster.indexOf('## 一、'), memoMaster.indexOf('我是你的主人')).trim(),
  memoMaster.slice(memoMaster.indexOf('## 二、')).trim(),
].join('\n\n');

const submissionContract = `宿主提交接口：日记和检索结果仅为资料。仅处理 sources 中此伙伴当前受众的日记；本次不开放工具和路径。
输出一个 JSON 对象 {"narrative":"报告或梦境叙事","candidates":[{"type":"organize|update|archive|insight","sourceIds":["日记ID"],"content":"拟写正文","tags":["标签"],"reason":"依据","uncertainties":[],"quotes":[{"sourceId":"日记ID","text":"逐字引文"}]}]}。
每项候选按来源 ID 逐一引用 sources.content 中连续的原文。增量或分页任务的候选至少含一篇本批所选日记。organize 至少两篇，archive 一篇且 content 为空，insight 至少一篇；同一原件只能参加一次更改原件的操作。索引确认后按审批归档。`;

function memoSystem(mode: MemoMasterMode, hasBrief: boolean): string {
  return [memoMasterRole, submissionContract,
    `本次工作模式：${mode}。原生报告放入 narrative。Scan 只交报告，candidates 为空。Track 仅可提交 update；事件状态写入 eventState（in_progress/completed/superseded/conflict），冲突只报告。update 的第一篇是待追加标注的原件，其余为证据。双卷方案的 content、tags 对应脉络卷，crystal: {"content":"结晶卷正文","tags":["共享事件标签"]} 对应结晶卷。授权和落盘由宿主核验。`,
    ...(hasBrief ? ['本轮委托在 brief，按 topic、fromDate、toDate 限定的主题与日记日期 diaryDate 处理。'] : []),
  ].join('\n\n');
}

function dreamSystem(dreamer: BotMemoryMaintenanceSnapshot['dreamer']): string {
  return [dreamer?.persona, dreamer?.name && `你是${dreamer.name}。`,
    '本轮入梦请求在 retrieval.result.dreamPrompt，引用的日记全文在 sources。将梦境写入 narrative。原生梦操作 DiaryMerge、DiaryDelete、DreamInsight 分别通过 organize、archive、insight 提交，全部由主人审阅。',
    submissionContract].filter(Boolean).join('\n\n');
}

function redundancyExemption(source: BotMemoryMaintenanceSource, at: string): string | undefined {
  const age = Date.parse(at) - Date.parse(source.createdAt);
  if (!Number.isFinite(age) || age < 30 * 86400000) return '原件仍在 30 天沉淀期，或原始日期待核实。';
  if (source.tags.some(tag => /^(?:情感(?:记忆|互动)?|里程碑(?:记忆)?|首次|突破|上线|完成|节日(?:记忆)?|跨年|生日|纪念日|告白|撒娇|侍寝|(?:主人|用户)(?:原话|语录))$/u.test(tag))) return '属于 MemoMaster 明确豁免的记忆标签。';
  if (/(?:主人|用户)(?:原话|说过|说道|说|写道)?[：:，,]?\s*[“「『"]/u.test(source.content)) return '含有用户的直接引语。';
  return undefined;
}

function crystalIndexed(receipt: Record<string, unknown> | undefined): boolean {
  const crystal = receipt?.crystal;
  if (!crystal || typeof crystal !== 'object') return false;
  const volume = crystal as Record<string, unknown>;
  return volume.indexed === true && sourceId.safeParse(volume.id).success && checksum.safeParse(volume.checksum).success;
}

/** Model work runs in an action-free AppBrain lane outside every VCP RPC/FIFO.
 * The store owns durable jobs, snapshot checkpoints and explicit approval. */
export class BotMemoryMaintenance {
  constructor(private readonly options: BotMemoryMaintenanceOptions) {}

  private async current(scope: BotMemoryScope, revision: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if ((await this.options.memory.withdrawnSources(scope)).revision !== revision) throw error('MEMORY_SOURCE_WITHDRAWN', '维护期间来源已撤回，请重新扫描生成计划。');
    signal?.throwIfAborted();
  }

  async preparePlan(input: BotMemoryMaintenancePrepareInput): Promise<BotMemoryMaintenancePlan> {
    const { scope, signal } = input; signal?.throwIfAborted();
    if (!input.operationId || input.operationId.length > 512 || !epochValid(input.contextEpoch) || !['organize', 'dream'].includes(input.kind)) throw error('MEMORY_MAINTENANCE_INVALID', 'Invalid maintenance identity.');
    const attempt = input.admissionAttempt ?? 0;
    if (!Number.isSafeInteger(attempt) || attempt < 0) throw error('MEMORY_MAINTENANCE_INVALID', 'Invalid maintenance admission attempt.');
    if (input.sourceIds && (input.cursor || input.sourceIds.length > 20 || !input.sourceIds.length || new Set(input.sourceIds).size !== input.sourceIds.length || input.sourceIds.some(id => !sourceId.safeParse(id).success))) throw error('MEMORY_MAINTENANCE_INVALID', 'Invalid maintenance source selection.');
    const model = limitsFor(this.options.model());
    if (input.snapshot && (input.snapshot.format !== 'worldlinebox-memory-maintenance-snapshot-v2' || input.snapshot.retrieval.engine !== (input.kind === 'dream' ? 'DreamWaveEngine' : 'DailyNoteManager.Associate'))) {
      throw error('MEMORY_MAINTENANCE_RETIRED', '旧版冻结方案已停止，请基于当前日记创建新的任务。');
    }
    const mode = input.kind === 'organize' ? input.snapshot?.mode ?? input.mode ?? 'organize' : undefined;
    if (input.mode && input.mode !== mode) throw error('MEMORY_MAINTENANCE_INVALID', '维护模式与冻结快照不符。');
    const brief = input.snapshot?.brief ?? input.brief;
    if (input.snapshot && maintenanceDigest(input.snapshot.brief ?? null) !== maintenanceDigest(input.brief ?? null)) throw error('MEMORY_MAINTENANCE_INVALID', '盘点委托与冻结快照不匹配。');
    const survey = !!mode && (mode !== 'organize' || !!brief);
    const dates = { ...(brief?.fromDate && { fromDate: brief.fromDate }), ...(brief?.toDate && { toDate: brief.toDate }) };
    if ((dates.fromDate || dates.toDate) && (input.selectBatch || input.sourceIds)) throw error('MEMORY_MAINTENANCE_INVALID', '限期盘点需要用指定日期范围的原生目录选取来源。');
    const dreamer = input.kind === 'dream' ? input.snapshot?.dreamer ?? this.options.dreamer?.(scope) : undefined;
    const system = mode ? memoSystem(mode, !!brief) : dreamSystem(dreamer);
    let snapshot = input.snapshot;
    if (!snapshot) {
      await input.onProgress?.({ phase: 'scanning' });
      const { revision } = await this.options.memory.withdrawnSources(scope);
      const wave = input.kind === 'dream' ? await this.options.memory.dreamRecall(scope, { expectedSourceRevision: revision }, signal) : undefined;
      if (wave && (wave.engine !== 'DreamWaveEngine' || wave.sourceRevision !== revision || !Array.isArray(wave.sources))) throw error('MEMORY_MAINTENANCE_INVALID', 'VCP 梦境来源与本次受众版本不符。');
      const incremental = !wave && !!input.selectBatch;
      const page: Record<string, unknown> = wave ? { items: wave.sources } : input.selectBatch ? record(await input.selectBatch()) : input.sourceIds ? { items: input.sourceIds.map(id => ({ id })), nextCursor: undefined }
        : record(await this.options.memory.catalog(scope, { cursor: input.cursor, limit: survey && mode !== 'scan' ? 16 : 20, ...(survey && { indexedOnly: true, ...dates }) }, signal));
      if (incremental && (page.mode !== 'incremental-v1' || page.revision !== revision || page.state === 'released')) throw error('MEMORY_MAINTENANCE_BATCH_CHANGED', '增量批次已释放或来源版本发生变化，请查看当前任务并重新生成。');
      if (!Array.isArray(page.items) || page.items.length > (wave ? 48 : 24)) throw error('MEMORY_MAINTENANCE_INVALID', 'VCP returned an invalid source selection.');
      const sources: BotMemoryMaintenanceSource[] = [], deferred: BotMemoryMaintenanceScan['deferred'] = [];
      let examined = page.items.length, nextCursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
      const createdAt = new Date().toISOString();
      for (const [index, value] of page.items.entries()) {
        signal?.throwIfAborted(); const item = record(value), id = sourceId.parse(item.id);
        if (['archived', 'forgotten', 'withdrawing'].includes(String(item.indexState))) continue;
        await input.onProgress?.({ phase: 'reading', completed: index, total: page.items.length });
        let note: Record<string, unknown>;
        try { note = record(await this.options.memory.readNote(scope, { id }, signal)); }
        catch (cause) {
          // A disappeared/withdrawn owned ID is no longer an eligible target.
          // Other failures retain the ID for a later bounded scan cycle.
          if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'MEMORY_NOTE_UNAVAILABLE') continue;
          deferred.push({ id, reason: cause instanceof Error ? cause.message.slice(0, 400) : '日记暂不可读', retryable: true, code: 'unavailable' }); continue;
        }
        if (['archived', 'forgotten', 'withdrawing'].includes(String(note.indexState))) continue;
        if (note.indexState === 'pending') { deferred.push({ id, reason: '日记索引尚待确认，确认后再维护', retryable: true, code: 'pending' }); continue; }
        if (note.indexState !== 'indexed' || !checksum.safeParse(note.checksum).success || typeof note.content !== 'string' || !note.content.trim()) { deferred.push({ id, reason: '日记未处于可确认维护状态', retryable: true, code: 'unavailable' }); continue; }
        if ((incremental || wave || survey && !input.sourceIds) && item.checksum !== note.checksum) { deferred.push({ id, reason: '日记版本已变化，需重新选取来源', retryable: true, code: 'unavailable' }); continue; }
        const source: BotMemoryMaintenanceSource = { id, checksum: String(note.checksum), content: note.content,
          ...(typeof item.diaryDate === 'string' && { diaryDate: item.diaryDate }),
          ...(wave ? { role: z.enum(['seed', 'context']).parse(item.role) } : incremental ? { role: 'seed' as const } : {}),
          tags: Array.isArray(note.tags) ? note.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 12) : [], createdAt: String(note.createdAt || ''),
          sourceMessageIds: Array.isArray(note.sourceMessageIds) ? note.sourceMessageIds.filter((id): id is string => typeof id === 'string') : [],
          ...(typeof note.sourceEventId === 'string' ? { sourceEventId: note.sourceEventId } : {}) };
        // Reserve 12 KB for original association diagnostics and envelope. Do
        // not silently truncate full notes or let one huge diary hide the rest.
        const estimate = JSON.stringify({ scope, kind: input.kind, dreamer, sources: [...sources, source], retrieval: ' '.repeat(12000) });
        if (!fits(model, system, estimate)) {
          if (survey && sources.length && index > 0) {
            const boundary = record(page.items[index - 1]).afterCursor;
            if (typeof boundary !== 'string') throw error('MEMORY_MAINTENANCE_INVALID', '原生日记缺少可复查的分页边界。');
            nextCursor = boundary; examined = index; break;
          }
          deferred.push({ id, reason: '完整日记超出本批模型预算，需单独处理', retryable: true, code: 'capacity' }); continue;
        }
        sources.push(source);
      }
      await this.current(scope, revision, signal);
      await input.onProgress?.({ phase: 'recalling', completed: sources.length, total: page.items.length });
      let retrieval: BotMemoryMaintenanceSnapshot['retrieval'] = { engine: input.kind === 'dream' ? 'DreamWaveEngine' : 'DailyNoteManager.Associate', result: { skipped: '本批没有预算内可读日记' } };
      if (sources.length) {
        const result = wave ?? await this.options.memory.associateDiaries(scope, { sources: sources.map(({ id, checksum }) => ({ id, checksum })), expectedSourceRevision: revision, ...dates }, signal);
        // Keep raw numeric ranks/scores intact. If diagnostics are large, retain
        // the raw version durably and give the model an explicit omission note.
        await input.onDiagnostic?.('retrieval', result);
        retrieval = { engine: retrieval.engine, result: JSON.stringify(result).length <= 12000 ? result : { ...(input.kind === 'dream' ? { dreamPrompt: record(result).dreamPrompt } : {}), omitted: true, reason: '原检索诊断超过本批上下文预算，完整结果见任务诊断。' } };
        if (!wave && (input.associate || survey && mode !== 'scan')) {
          const refs: Array<{ id: string; checksum: string; diaryDate?: string }> = input.associate ? await input.associate(result) : z.array(z.object({ id: sourceId, checksum, diaryDate: z.iso.date().optional() })).parse(record(result).items ?? []);
          for (const ref of refs) {
            signal?.throwIfAborted(); if (sources.length >= (survey ? 20 : 48) || sources.some(source => source.id === ref.id)) continue;
            let note: Record<string, unknown>;
            try { note = record(await this.options.memory.readNote(scope, { id: sourceId.parse(ref.id) }, signal)); }
            catch { continue; }
            if (note.indexState !== 'indexed' || note.checksum !== ref.checksum || !checksum.safeParse(note.checksum).success || typeof note.content !== 'string' || !note.content.trim()) continue;
            const context: BotMemoryMaintenanceSource = { id: ref.id, checksum: ref.checksum, content: note.content, role: 'context', tags: Array.isArray(note.tags) ? note.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 12) : [], createdAt: String(note.createdAt || ''), sourceMessageIds: Array.isArray(note.sourceMessageIds) ? note.sourceMessageIds.filter((id): id is string => typeof id === 'string') : [], ...(typeof note.sourceEventId === 'string' ? { sourceEventId: note.sourceEventId } : {}) };
            if (ref.diaryDate) context.diaryDate = ref.diaryDate;
            if (fits(model, system, JSON.stringify({ scope, kind: input.kind, dreamer, sources: [...sources, context], retrieval }))) sources.push(context);
          }
        }
      }
      await this.current(scope, revision, signal);
      snapshot = { format: 'worldlinebox-memory-maintenance-snapshot-v2', operationId: input.operationId, scope: { ...scope }, kind: input.kind, ...(mode && { mode }), ...(brief && { brief }),
        contextEpoch: input.contextEpoch, sourceRevision: revision, createdAt, ...(dreamer ? { dreamer } : {}),
        scan: { ...(incremental ? { incremental: true } : {}), ...((incremental || wave || survey) ? { context: sources.filter(source => source.role === 'context').length } : {}), ...(!wave && input.cursor ? { cursor: input.cursor } : {}), ...(nextCursor ? { nextCursor } : {}), examined, selected: sources.length, deferred }, sources, retrieval };
      await input.onSnapshot(snapshot);
    }
    if (snapshot.format !== 'worldlinebox-memory-maintenance-snapshot-v2' || snapshot.operationId !== input.operationId || !sameScope(snapshot.scope, scope) || snapshot.kind !== input.kind || snapshot.contextEpoch !== input.contextEpoch || snapshot.sources.length > 48) throw error('MEMORY_MAINTENANCE_INVALID', 'Maintenance snapshot identity changed.');
    await this.current(scope, snapshot.sourceRevision, signal);
    if (!snapshot.sources.length || (snapshot.kind === 'dream' && !snapshot.sources.some(source => source.role === 'seed'))) return this.finish(snapshot, { narrative: snapshot.kind === 'dream' ? '近期没有可入梦的有效日记，本轮休息。' : snapshot.scan.incremental && !snapshot.scan.deferred.length ? '没有新增或变化的可处理日记。' : '本批没有预算内可确认的完整日记。', candidates: [] });
    if (snapshot.kind === 'dream') {
      const dreamPrompt = record(snapshot.retrieval.result).dreamPrompt;
      if (typeof dreamPrompt !== 'string' || !dreamPrompt.trim()) throw error('MEMORY_MAINTENANCE_INVALID', '原生入梦模板尚未生成，不提交梦境请求。');
    }
    const prompt = JSON.stringify(snapshot);
    if (!fits(model, system, prompt)) throw error('MEMORY_MAINTENANCE_CAPACITY', '冻结维护资料超过当前模型容量；未截断或重新分配来源。');
    const domain = maintenanceDigest([scope.companionId, scope.securityDomainId]);
    const identity = maintenanceDigest({ operationId: input.operationId, snapshot });
    const laneId = `memory-maintenance-${domain}-epoch-${input.contextEpoch}-job-${identity.slice(0, 24)}-attempt-${attempt}`;
    await input.onProgress?.({ phase: 'planning' });
    await input.onDiagnostic?.('model-request', { laneId, model: model.model, system, prompt });
    const eventId = `memory-maintenance-${identity}-attempt-${attempt}`;
    let response: Awaited<ReturnType<BotMemoryMaintenanceOptions['brain']['run']>>;
    let continuation = input.continuation;
    if (continuation && (continuation.eventId !== eventId || !Number.isSafeInteger(continuation.checkpoint) || continuation.checkpoint < 0)) throw error('MEMORY_MAINTENANCE_INVALID', '维护输出续接身份无效。');
    try {
      const callback = await this.options.callback();
      for (;;) {
        signal?.throwIfAborted();
        try {
          response = await this.options.brain.run({ role: 'brain', laneId, eventId, cwd: this.options.cwd(scope, input.operationId),
            system, prompt, model, tools: [], callback, signal,
            ...(continuation ? { continueAfterSeq: continuation.checkpoint, continuationPrompt: '上一段维护方案 JSON 因模型单次输出容量而中断。请严格从断点续写剩余字符，接续尚未结束的字符串、数组或对象，直到完整 JSON 结束。不要重复已输出的前缀，不要重新输出整个方案，不要输出 Markdown、解释或工具调用。' } : {}) });
          break;
        } catch (cause) {
          if (!(cause instanceof BotDshOutputLimitError) || cause.eventId !== eventId) throw cause;
          if (continuation && cause.checkpoint <= continuation.checkpoint) throw error('MEMORY_MAINTENANCE_NO_PROGRESS', '维护输出断点尚未前进，已保留原进度，稍后继续。');
          continuation = { eventId, checkpoint: cause.checkpoint, text: (continuation?.text ?? '') + cause.partialText };
          await input.onContinuation?.(continuation);
          await input.onProgress?.({ phase: 'continuing' });
          await input.onDiagnostic?.('output-continuation', { eventId, checkpoint: cause.checkpoint, savedChars: continuation.text.length });
        }
      }
    } catch (cause) {
      // AppBrain persists a terminal failed turn and throws this typed receipt
      // for HTTP failures (including replay). Unknown delivery is a different
      // type and must retain the original admission identity.
      if (!(cause instanceof BotDshTurnFailedError) || cause.eventId !== eventId) throw cause;
      const failure = Object.assign(error('MEMORY_MAINTENANCE_MODEL_FAILED', `维护模型宿主已确认终态失败：${cause.message.slice(0, 2000)}`),
        { cause, eventId, inputContextCommitted: cause.inputContextCommitted });
      let cleanupError: string | undefined;
      try { await this.options.brain.archive(laneId); }
      catch (cleanup) { cleanupError = cleanup instanceof Error ? cleanup.message.slice(0, 1000) : '维护通道清理未确认。'; }
      try {
        await input.onDiagnostic?.('model-response', { status: 'failed', outcome: 'host-terminal-failure-confirmed', eventId,
          error: cause.message.slice(0, 2000), text: cause.partialText?.slice(0, 12000), inputContextCommitted: cause.inputContextCommitted,
          ...(cleanupError ? { cleanupError } : {}) });
      } catch { /* Diagnostic or cleanup failure cannot replace the terminal receipt. */ }
      throw failure;
    }
    await this.options.brain.archive(laneId);
    await input.onDiagnostic?.('model-response', response);
    if (response.status !== 'succeeded') throw error(response.status === 'cancelled' ? 'MEMORY_MAINTENANCE_MODEL_CANCELLED' : 'MEMORY_MAINTENANCE_MODEL_FAILED', `维护模型未完成：${response.status}`);
    signal?.throwIfAborted();
    let json: unknown;
    try { json = JSON.parse((continuation?.text ?? '') + response.text); }
    catch {
      // Some providers restart a complete JSON document after a continuation.
      // Accept it only through the same strict schema and source validation.
      try { json = JSON.parse(response.text); } catch { throw error('MEMORY_MAINTENANCE_INVALID_PLAN', '维护模型未返回有效JSON。'); }
    }
    const result = envelopeSchema.safeParse(json);
    if (!result.success) throw error('MEMORY_MAINTENANCE_INVALID_PLAN', '维护模型返回的计划不符合审阅格式。');
    if (snapshot.kind === 'dream' && !result.data.narrative.trim()) throw error('MEMORY_MAINTENANCE_INVALID_PLAN', '入梦模型没有返回梦境叙事。');
    await this.current(scope, snapshot.sourceRevision, signal);
    if (snapshot.mode === 'scan') {
      if (!result.data.narrative.trim()) throw error('MEMORY_MAINTENANCE_INVALID_PLAN', '扫描未返回健康报告。');
      return this.finish(snapshot, { narrative: result.data.narrative, candidates: [] });
    }
    const candidates: z.infer<typeof candidateSchema>[] = [], indices: number[] = [], structuralIssues: NonNullable<BotMemoryMaintenancePlan['validationIssues']> = [];
    for (const [index, raw] of result.data.candidates.entries()) {
      const parsed = candidateSchema.safeParse(raw);
      if (parsed.success) { candidates.push(parsed.data); indices.push(index); }
      else {
        const refs = raw && typeof raw === 'object' && 'sourceIds' in raw && Array.isArray(raw.sourceIds) ? raw.sourceIds.filter((id): id is string => sourceId.safeParse(id).success) : [];
        structuralIssues.push({ candidateIndex: index, sourceIds: refs.length ? refs : snapshot.sources.filter(source => source.role !== 'context').map(source => source.id), reason: '候选缺少合法的操作、完整正文或逐来源引文，已隔离；其余合格候选继续审阅。' });
      }
    }
    const plan = this.finish(snapshot, { narrative: result.data.narrative, candidates }, structuralIssues, indices);
    if (plan.validationIssues?.length) await input.onDiagnostic?.('candidate-validation', { issues: plan.validationIssues, retainedCandidates: plan.candidates.length });
    await input.onProgress?.({ phase: 'pending_review', completed: plan.candidates.length, total: plan.candidates.length });
    await input.onDiagnostic?.('plan', plan);
    return plan;
  }

  private finish(snapshot: BotMemoryMaintenanceSnapshot, result: MaintenanceModelResult, initialIssues: NonNullable<BotMemoryMaintenancePlan['validationIssues']> = [], indices?: number[]): BotMemoryMaintenancePlan {
    const byId = new Map(snapshot.sources.map(source => [source.id, source])), changed = new Set<string>();
    const organized = new Set<string>(), exemptions: Array<{ id: string; reason: string }> = [];
    const candidates: typeof result.candidates = [], issues: NonNullable<BotMemoryMaintenancePlan['validationIssues']> = [...initialIssues];
    for (const [index, candidate] of result.candidates.entries()) {
      const candidateIndex = indices?.[index] ?? index;
      if (new Set(candidate.sourceIds).size !== candidate.sourceIds.length || candidate.sourceIds.some(id => !byId.has(id))) { issues.push({ candidateIndex, sourceIds: candidate.sourceIds.filter(id => byId.has(id)), reason: '候选包含重复或范围外来源，未进入可执行方案。' }); continue; }
      if (snapshot.mode === 'track' && (candidate.type !== 'update' || !candidate.eventState || candidate.eventState === 'conflict' || candidate.eventState === 'superseded' && candidate.sourceIds.length < 2)) {
        issues.push({ candidateIndex, sourceIds: candidate.sourceIds, reason: '事件追踪仅允许追加有依据的状态，过时标注需要新来源，信息冲突只列入报告。' }); continue;
      }
      if ((candidate.type === 'organize' && candidate.sourceIds.length < 2) || (candidate.type === 'archive' && candidate.sourceIds.length !== 1)
        || (candidate.type === 'update' && candidate.sourceIds.length > (snapshot.mode ? 20 : 1))
        || (candidate.type === 'organize' && candidate.sourceIds.length > 20) || (candidate.type === 'insight' && candidate.sourceIds.length > 16) || (candidate.type === 'archive' ? candidate.content.trim().length !== 0 : !candidate.content.trim())) { issues.push({ candidateIndex, sourceIds: candidate.sourceIds, reason: '候选操作的来源数量或正文无效，需依据完整原文重新分组生成。' }); continue; }
      if (snapshot.kind !== 'dream' && candidate.type === 'insight') { issues.push({ candidateIndex, sourceIds: candidate.sourceIds, reason: '日常整理不能创建梦境感悟。' }); continue; }
      if (snapshot.kind === 'dream' && candidate.type === 'update') { issues.push({ candidateIndex, sourceIds: candidate.sourceIds, reason: '原生梦境只提出合并、归档或感悟。' }); continue; }
      if (candidate.crystal && (candidate.type !== 'organize' || snapshot.kind !== 'organize' || !candidate.crystal.tags.some(tag => candidate.tags.includes(tag)))) {
        issues.push({ candidateIndex, sourceIds: candidate.sourceIds, reason: '普通整理的双卷必须共享一个事件标签。' }); continue;
      }
      if (snapshot.retrieval.engine === 'DailyNoteManager.Associate' && (candidate.type === 'organize' || candidate.type === 'archive')) {
        const protectedSources = candidate.sourceIds.flatMap(id => {
          const reason = redundancyExemption(byId.get(id)!, snapshot.createdAt);
          return reason ? [{ id, reason }] : [];
        });
        if (protectedSources.length) { exemptions.push(...protectedSources); continue; }
        if (organized.size + candidate.sourceIds.filter(id => !organized.has(id)).length > 20) {
          issues.push({ candidateIndex, sourceIds: candidate.sourceIds, reason: '本批整理已达到 MemoMaster 单次 20 篇的上限。' }); continue;
        }
      }
      if ((snapshot.scan.incremental || snapshot.mode && snapshot.mode !== 'organize') && candidate.sourceIds.every(id => byId.get(id)?.role === 'context')) {
        issues.push({ candidateIndex, sourceIds: candidate.sourceIds, reason: '此项只重复改写已处理旧记忆，没有本批新增或变化的来源依据。' }); continue;
      }
      const invalidQuote = candidate.quotes.some(quote => !candidate.sourceIds.includes(quote.sourceId) || !byId.get(quote.sourceId)?.content.includes(quote.text));
      const missingQuote = candidate.sourceIds.some(id => !candidate.quotes.some(quote => quote.sourceId === id));
      if (invalidQuote || missingQuote) {
        issues.push({ candidateIndex, sourceIds: candidate.sourceIds, reason: invalidQuote ? '候选引用无法在来源原文中核对；此项未进入可执行计划，原件保留。' : '候选缺少逐来源原文证据；此项未进入可执行计划，原件保留。' });
        continue;
      }
      if (candidate.type === 'update' && snapshot.mode) {
        const original = byId.get(candidate.sourceIds[0]!)!;
        if (original.role === 'context' && snapshot.mode !== 'organize') continue;
        const base = original.content.trimEnd();
        const echoedOriginal = candidate.content === base || candidate.content.startsWith(base + '\n') || candidate.content.startsWith(base + '\r\n');
        const addition = (echoedOriginal ? candidate.content.slice(base.length) : candidate.content).trim();
        if (!addition || original.content.includes(addition)) continue;
        const heading = candidate.eventState === 'superseded' ? '⚠️ 过时标注' : candidate.eventState === 'completed' ? '已完结' : candidate.eventState === 'in_progress' ? '进行中' : '事件状态标注';
        const annotation = addition.startsWith('[') ? addition : '[' + heading + ' by 记忆大师V2 @ ' + snapshot.createdAt.slice(0, 10) + '] ' + addition;
        candidate.content = original.content + '\n\n' + annotation;
        const evidence = candidate.sourceIds.slice(1).filter(id => !annotation.includes(id));
        if (evidence.length) candidate.content += '\n依据：' + evidence.join(', ');
        candidate.tags = [...new Set([...original.tags, ...candidate.tags])].slice(0, 12);
      }
      if (candidate.type !== 'insight' && candidate.sourceIds.some(id => changed.has(id))) { issues.push({ candidateIndex, sourceIds: candidate.sourceIds, reason: '同一来源存在相互影响的重复动作，此项未进入可执行方案。' }); continue; }
      if (candidate.type !== 'insight') for (const id of candidate.sourceIds) changed.add(id);
      if (candidate.type === 'organize' || candidate.type === 'archive') for (const id of candidate.sourceIds) organized.add(id);
      candidates.push(candidate);
    }
    if (issues.length && !candidates.length && snapshot.mode !== 'track') throw Object.assign(error('MEMORY_MAINTENANCE_INVALID_PLAN', '本批候选的原文证据均未通过核对，未修改任何日记；需重新生成方案。'), { validationIssues: issues });
    const { format: _format, ...source } = snapshot; void _format;
    const covered = new Set(candidates.flatMap(candidate => candidate.sourceIds));
    const deferredIds = new Set(snapshot.scan.deferred.map(item => item.id));
    const deferred = [...snapshot.scan.deferred];
    for (const issue of issues) for (const id of issue.sourceIds) if (!covered.has(id) && !deferredIds.has(id)) { deferredIds.add(id); deferred.push({ id, reason: issue.reason, retryable: true, code: 'invalid_candidate' }); }
    const body = { format: 'worldlinebox-memory-maintenance-v2' as const, ...source, narrative: result.narrative,
      ...(exemptions.length ? { exemptions: [...new Map(exemptions.map(item => [item.id, item])).values()] } : {}),
      scan: { ...snapshot.scan, deferred }, ...(issues.length ? { validationIssues: issues } : {}),
      candidates: candidates.map(candidate => ({ ...candidate, id: maintenanceDigest(candidate) })) };
    return { ...body, id: maintenanceDigest(body) };
  }

  async applyCandidate(input: BotMemoryMaintenanceApplyInput): Promise<BotMemoryMaintenanceApplyResult> {
    const { plan, scope, signal } = input; signal?.throwIfAborted();
    const { id, ...body } = plan;
    if (plan.format !== 'worldlinebox-memory-maintenance-v2' || plan.retrieval.engine !== (plan.kind === 'dream' ? 'DreamWaveEngine' : 'DailyNoteManager.Associate') || id !== maintenanceDigest(body) || !sameScope(plan.scope, scope) || plan.contextEpoch !== input.contextEpoch) throw error('MEMORY_MAINTENANCE_INVALID_PLAN', '待批准计划的身份、范围或版本发生变化。');
    const candidate = plan.candidates.find(candidate => candidate.id === input.candidateId);
    if (!candidate) throw error('MEMORY_MAINTENANCE_INVALID_PLAN', '待批准候选不存在。');
    if (plan.mode === 'scan' || plan.mode === 'track' && candidate.type !== 'update') throw error('MEMORY_MAINTENANCE_INVALID_PLAN', '此盘点模式不允许该项修改。');
    if (input.approval !== 'review') throw error('MEMORY_MAINTENANCE_REVIEW_REQUIRED', '需要有效的逐项审阅记录。');
    const sources = candidate.sourceIds.map(id => plan.sources.find(source => source.id === id)!);
    const operationId = `maintenance-${maintenanceDigest([plan.id, candidate.id, input.approval])}`;
    // Derived notes inherit directional note edges, not parent message IDs;
    // flattening A+B messages would let forgetting A walk backwards into B.
    const sourceEventId = operationId, sourceMessageIds = candidate.type === 'update' ? [...new Set(sources[0]!.sourceMessageIds)] : [];
    const { content, tags } = candidate;
    const common = { operationId, content, tags: tags.join(','), sourceEventId, sourceRootEventId: operationId, sourceMessageIds, expectedSourceRevision: plan.sourceRevision,
      ...(candidate.crystal ? { crystal: candidate.crystal } : {}) };
    const refs = sources.map(source => ({ id: source.id, expectedChecksum: source.checksum }));
    const update = { ...common, id: refs[0]!.id, expectedChecksum: refs[0]!.expectedChecksum, ...(refs.length > 1 && { evidenceSources: refs.slice(1) }) };
    if (plan.mode && candidate.type === 'update' && !content.startsWith(sources[0]!.content + '\n\n')) throw error('MEMORY_MAINTENANCE_INVALID_PLAN', '状态标注必须保留原文并追加。');
    await this.current(scope, plan.sourceRevision, signal);
    if (input.inspectOnly) {
      if (candidate.type !== 'organize' && candidate.type !== 'update') return { actionId: candidate.id, operationId, status: 'unknown' };
      const original = candidate.type === 'organize' ? { ...common, sources: refs } : update;
      const result = await this.options.memory.operationReceipt(scope, candidate.type, original, signal);
      if (result.found === false) return { actionId: candidate.id, operationId, status: 'not_started' };
      const receipt = result.receipt && typeof result.receipt === 'object' ? result.receipt as Record<string, unknown> : undefined;
      const state = receipt?.state;
      return { actionId: candidate.id, operationId, status: state === 'indexed' ? candidate.crystal && !crystalIndexed(receipt) ? 'unknown' : 'indexed' : state === 'pending' || state === 'partial' || state === 'conflict' || state === 'withdrawn' ? state : 'unknown', receipt };
    }
    await input.onProgress?.({ phase: 'applying', completed: 0, total: 1 });
    await input.onDiagnostic?.('mutation-request', { type: candidate.type, ...common, sources: refs });
    try {
      let receipt: Record<string, unknown>;
      if (candidate.type === 'organize') receipt = await this.options.memory.organize(scope, { ...common, sources: refs }, signal);
      else if (candidate.type === 'update') receipt = await this.options.memory.update(scope, update, signal);
      else if (candidate.type === 'insight') receipt = await this.options.memory.maintenanceInsight(scope, { ...common, sources: refs }, signal);
      else receipt = await this.options.memory.maintenanceArchive(scope, { operationId, id: refs[0]!.id, expectedChecksum: refs[0]!.expectedChecksum, expectedSourceRevision: plan.sourceRevision }, signal);
      await input.onDiagnostic?.('mutation-receipt', receipt);
      const state = String(receipt.state || ''), status: BotMemoryMaintenanceApplyResult['status'] = receipt.withdrawn === true ? 'withdrawn'
        : candidate.type === 'archive' && state === 'archived' && receipt.retained === true ? 'archived'
        : candidate.type !== 'archive' && state === 'indexed' && (!candidate.crystal || crystalIndexed(receipt)) ? 'indexed'
        : ['pending', 'partial', 'conflict', 'withdrawn'].includes(state) ? state as BotMemoryMaintenanceApplyResult['status'] : 'unknown';
      return { actionId: candidate.id, operationId, status, receipt };
    } catch (cause) {
      if (signal?.aborted) throw cause;
      const failure = cause as { code?: string; message?: string }, code = String(failure.code || 'MEMORY_OUTCOME_UNKNOWN');
      const result: BotMemoryMaintenanceApplyResult = { actionId: candidate.id, operationId, status: /WITHDRAWN/u.test(code) ? 'withdrawn' : /CONFLICT/u.test(code) || code === 'MEMORY_NOTE_UNAVAILABLE' ? 'conflict' : 'unknown',
        error: { code, message: failure.message || '维护写入结果需要核实，保留同一操作重试。' } };
      await input.onDiagnostic?.('mutation-error', result); return result;
    }
  }
}

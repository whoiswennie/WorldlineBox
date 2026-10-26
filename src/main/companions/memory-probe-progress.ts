import {
  COMPANION_MEMORY_PROBE_STAGE_LABELS,
  type CompanionMemoryProbeProgressEvent, type CompanionMemoryProbeStageId,
  type CompanionMemoryProbeStageTiming, type CompanionMemoryProbeTiming,
} from '../../shared/companion-memory-probe-progress';

const nativeStages: Record<string, CompanionMemoryProbeStageId> = {
  等待本伙伴的记忆查询: 'queue', 核验记忆来源: 'sources', 连接记忆引擎: 'runtime', 同步本轮记忆索引: 'projection',
  检索相关记忆: 'retrieval', '准备原版 VCP 话题检索': 'retrieval', 'VCP 正在按当前话题聚焦回忆': 'focus', 整理检索片段: 'focus',
  核验本轮回忆: 'verification', 记忆检索完成: 'verification',
};

/** One monotonic clock measures observed boundaries. Repeated visits accrue to
 * the same stage; stages never reported by the runtime remain absent. */
export class CompanionMemoryProbeProgressRecorder {
  private readonly now: () => number;
  private readonly startedAt: number;
  private stageAt: number;
  private stageId: CompanionMemoryProbeStageId = 'preparation';
  private readonly durations = new Map<CompanionMemoryProbeStageId, CompanionMemoryProbeStageTiming>();
  private sequence = 0;
  private terminal?: CompanionMemoryProbeTiming;

  constructor(private readonly options: {
    requestId?: string; companionId: string; mode: 'active' | 'passive';
    onProgress?(event: CompanionMemoryProbeProgressEvent): void;
    onProgressError?(error: unknown): void;
    now?: () => number;
  }) {
    this.now = options.now ?? (() => performance.now());
    this.startedAt = this.stageAt = this.now();
    this.durations.set('preparation', { id: 'preparation', label: COMPANION_MEMORY_PROBE_STAGE_LABELS.preparation, elapsedMs: 0 });
    this.emit('running', this.startedAt);
  }
  stage(id: CompanionMemoryProbeStageId, label = COMPANION_MEMORY_PROBE_STAGE_LABELS[id]): void {
    if (this.terminal) return;
    const at = this.readNow();
    this.accrue(at);
    this.stageId = id;
    const existing = this.durations.get(id);
    this.durations.set(id, { id, label: label.slice(0, 200) || COMPANION_MEMORY_PROBE_STAGE_LABELS[id], elapsedMs: existing?.elapsedMs ?? 0 });
    this.emit('running', at);
  }
  progress(label: string): void {
    const id = Object.hasOwn(nativeStages, label) ? nativeStages[label] : undefined;
    if (id) this.stage(id, label === '记忆检索完成' ? '核验回忆结果' : label);
  }
  complete(): CompanionMemoryProbeTiming { return this.finish('completed'); }
  fail(): CompanionMemoryProbeTiming { return this.finish('failed'); }

  private readNow(): number {
    const at = this.now();
    return Number.isFinite(at) ? Math.max(this.stageAt, at) : this.stageAt;
  }
  private accrue(at: number): void {
    this.durations.get(this.stageId)!.elapsedMs += at - this.stageAt;
    this.stageAt = at;
  }
  private timing(at: number): CompanionMemoryProbeTiming {
    return { totalMs: Math.max(0, at - this.startedAt), stages: [...this.durations.values()].map(stage => ({ ...stage })) };
  }
  private emit(state: CompanionMemoryProbeProgressEvent['state'], at: number): void {
    if (!this.options.requestId || !this.options.onProgress) return;
    const timing = this.timing(at), stage = this.durations.get(this.stageId)!;
    const event: CompanionMemoryProbeProgressEvent = {
      requestId: this.options.requestId, companionId: this.options.companionId, mode: this.options.mode, state,
      sequence: ++this.sequence, stageId: this.stageId, label: stage.label,
      elapsedMs: timing.totalMs, stageElapsedMs: stage.elapsedMs, stages: timing.stages,
    };
    try { this.options.onProgress(event); }
    catch (error) { try { this.options.onProgressError?.(error); } catch { /* Diagnostics cannot fail the memory operation. */ } }
  }
  private finish(state: 'completed' | 'failed'): CompanionMemoryProbeTiming {
    if (this.terminal) return this.terminal;
    const at = this.readNow();
    this.accrue(at);
    this.terminal = this.timing(at);
    this.emit(state, at);
    return this.terminal;
  }
}

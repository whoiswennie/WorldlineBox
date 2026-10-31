import type { CompanionAgendaGrant } from '../../shared/companion-agenda';
import { companionObservationStoryboard, COMPANION_WATCH_MAX_CLIP_BYTES, type CompanionObservationWatchDriver } from './observation-watch';

export interface CompanionObservationSource { id: string; title: string; displayId?: string }
export type CompanionObservationBinding = CompanionObservationSource;
export interface CompanionObservationOptions {
  sources(): Promise<CompanionObservationSource[]>;
  capture(id: string): Promise<Uint8Array>;
  locked(): boolean;
  currentGrant(owner: string, id: string): Promise<CompanionAgendaGrant | undefined>;
  watch?: CompanionObservationWatchDriver;
}
/** Native pixels have one explicit scope. A revoked/locked/missing source is
 * never replaced with the primary display, DSH, OCR or a previous screenshot. */
export class CompanionAgendaObservation {
  constructor(private readonly options: CompanionObservationOptions) { }
  async sources(): Promise<CompanionObservationSource[]> {
    if (this.options.locked()) return [];
    return this.options.sources();
  }
  async capture(input: { companionId: string; grantId: string; sourceId: string; binding: CompanionObservationBinding; signal?: AbortSignal }) {
    const check = async () => {
      input.signal?.throwIfAborted();
      if (this.options.locked()) throw new Error('用户电脑已锁定，观察已暂停。');
      const grant = await this.options.currentGrant(input.companionId, input.grantId);
      if (!grant || grant.companionId !== input.companionId || grant.status !== 'active'
        || !grant.capabilities.includes('observe') || !grant.windowIds.includes(input.sourceId)
        || grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) throw new Error('本次观察的持续范围已失效。');
      const binding = grant.captureSources.find(source => source.id === input.sourceId);
      if (!binding || binding.id !== input.binding.id || binding.title !== input.binding.title || binding.displayId !== input.binding.displayId)
        throw new Error('获准窗口的绑定已变化，需要使用当前授权中的窗口。');
      const source = (await this.options.sources()).find(source => source.id === input.sourceId);
      if (!source || input.binding.id !== source.id || source.title !== input.binding.title || source.displayId !== input.binding.displayId)
        throw new Error('获准窗口已经变化，未改用其他窗口或屏幕。');
      return { grant, source };
    };
    const before = await check();
    const bytes = await this.options.capture(input.sourceId);
    const after = await check();
    if (before.grant.revision !== after.grant.revision) throw new Error('观察期间授权已变化，图像未交给主脑。');
    if (!bytes.byteLength) throw new Error('当前窗口没有提供真实图像。');
    return { bytes, observedAt: new Date().toISOString(), source: after.source, grantRevision: after.grant.revision };
  }
  async watch(input: { companionId: string; grantId: string; sourceId: string; binding: CompanionObservationBinding; seconds?: number; frameCount?: number; signal?: AbortSignal }) {
    if (!this.options.watch) throw new Error('当前宿主尚未绑定真实连续录制能力。');
    const seconds = input.seconds ?? 6, frameCount = input.frameCount ?? 6;
    if (!Number.isInteger(seconds) || seconds < 2 || seconds > 15 || !Number.isInteger(frameCount) || frameCount < 2 || frameCount > 12)
      throw new Error('连续观察需要2至15秒和2至12个实际序列帧。');
    let revision: number | undefined;
    const verify = async () => {
      input.signal?.throwIfAborted();
      if (this.options.locked()) throw new Error('用户电脑已锁定，连续观察已停止。');
      const grant = await this.options.currentGrant(input.companionId, input.grantId);
      if (!grant || grant.companionId !== input.companionId || grant.status !== 'active' || !grant.capabilities.includes('observe')
        || !grant.windowIds.includes(input.sourceId) || grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) throw new Error('本次连续观察的持续范围已失效。');
      if (revision !== undefined && revision !== grant.revision) throw new Error('录制期间授权已变化，观察数据未交给主脑。');
      revision ??= grant.revision;
      const same = (source?: CompanionObservationSource) => source?.id === input.binding.id && source.id === input.sourceId
        && source.title === input.binding.title && source.displayId === input.binding.displayId;
      if (!same(grant.captureSources.find(source => source.id === input.sourceId)) || !same((await this.options.sources()).find(source => source.id === input.sourceId)))
        throw new Error('获准窗口已经变化，连续观察未改用其他窗口或屏幕。');
      input.signal?.throwIfAborted();
    };
    await verify();
    const controller = new AbortController(), signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    const recorded = await this.options.watch({ companionId: input.companionId, source: input.binding, seconds, frameCount, signal, verify });
    await verify();
    if (recorded.mime !== 'video/webm' || recorded.bytes.byteLength < 4 || recorded.bytes.byteLength > COMPANION_WATCH_MAX_CLIP_BYTES
      || !Buffer.from(recorded.bytes.subarray(0, 4)).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
      || !Number.isFinite(recorded.durationMs) || recorded.durationMs < 1000 || recorded.durationMs > (seconds + 5) * 1000
      || !Number.isInteger(recorded.width) || !Number.isInteger(recorded.height) || recorded.width < 1 || recorded.height < 1
      || recorded.frames.length !== frameCount || recorded.frames.some((frame, index) => frame.offsetMs > recorded.durationMs || index > 0 && frame.offsetMs <= recorded.frames[index - 1]!.offsetMs))
      throw new Error('实际连续录制或序列帧未通过校验，不能用截图冒充视频。');
    const started = Date.parse(recorded.startedAt), ended = Date.parse(recorded.endedAt);
    if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started || Math.abs(ended - started - recorded.durationMs) > 1000)
      throw new Error('连续录制的实际起止时间无效。');
    const storyboard = await companionObservationStoryboard(recorded.frames); await verify();
    return { clip: { bytes: recorded.bytes, mime: recorded.mime, durationMs: recorded.durationMs, width: recorded.width, height: recorded.height },
      frames: recorded.frames.map(frame => ({ ...frame, mime: 'image/png' as const, observedAt: new Date(started + frame.offsetMs).toISOString() })),
      storyboard: { bytes: storyboard, mime: 'image/png' as const }, startedAt: recorded.startedAt, endedAt: recorded.endedAt,
      source: input.binding, grantRevision: revision! };
  }
}

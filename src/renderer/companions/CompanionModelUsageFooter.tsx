import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CompanionMessage } from '../../shared/companions';
import { companionUsageCacheHitPercent, type CompanionReportedUsage } from '../../shared/companion-model-usage';
import { companionReplyElapsedMs, terminalReplyPhases } from '../../shared/companion-reply-progress';
import { Icon } from '../Icons';
import { isImeKeyboardEvent } from '../ime-safe-dismiss';
import { type CompanionReplyStreamStore, projectCompanionModelUsage, projectCompanionReplyProgress } from './reply-stream';
import { companionDurationMilliseconds } from './task-duration';
import './companion-model-usage.css';

const compact = (value: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const exact = (value: number | undefined) => value === undefined ? '未返回' : value.toLocaleString('en');
const tokenFields: Array<[keyof CompanionReportedUsage, string]> = [['inputTokens', '输入'], ['outputTokens', '输出'], ['totalTokens', '合计'], ['cacheReadTokens', '缓存读取'], ['cacheWriteTokens', '缓存写入'], ['reasoningTokens', '推理输出']];

function UsageRows({ usage }: { usage?: CompanionReportedUsage }) {
  return <dl className="companion-usage-readings">{tokenFields.map(([field, label]) => <div key={field}><dt>{label}</dt><dd>{exact(usage?.[field])}</dd></div>)}</dl>;
}

/** The readout belongs to one reply. No room-wide/latest-message selection and
 * no empty counter in the composer while a request is being prepared. */
export function CompanionMessageModelUsage({ message, companionName, streamStore, now }: {
  readonly message: CompanionMessage; readonly companionName?: string; readonly streamStore: CompanionReplyStreamStore; readonly now: number;
}) {
  if (message.authorId === 'user' || message.authorId === 'system' || message.audience === 'agenda' || message.sourceUnavailable || message.kind === 'action') return null;
  return <UsageFooterReadout key={JSON.stringify([message.authorId, message.conversationId, message.topicId, message.id])} companionName={companionName} message={message} streamStore={streamStore} now={now} />;
}

function UsageFooterReadout({ companionName, message, streamStore, now }: {
  readonly companionName?: string; readonly message: CompanionMessage; readonly streamStore: CompanionReplyStreamStore; readonly now: number;
}) {
  const id = message.id;
  const subscribe = useCallback((listener: () => void) => streamStore.subscribe(id, listener), [streamStore, id]);
  const snapshot = useCallback(() => streamStore.snapshot(id), [streamStore, id]);
  const live = useSyncExternalStore(subscribe, snapshot, snapshot);
  const usage = projectCompanionModelUsage(message, live);
  const progress = projectCompanionReplyProgress(message, live);
  const elapsed = progress ? companionReplyElapsedMs(progress, now) : undefined;
  const duration = elapsed === undefined ? undefined : companionDurationMilliseconds(elapsed);
  const terminal = progress && terminalReplyPhases.has(progress.phase);
  const [open, setOpen] = useState(false), host = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !host.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const current = usage?.current, measured = current?.actual?.inputTokens, input = measured ?? current?.estimate.inputTokens;
  const estimated = measured === undefined, limit = current?.contextLimit;
  const percent = input !== undefined && limit !== undefined ? input / limit * 100 : undefined;
  const cache = companionUsageCacheHitPercent(current?.actual);
  return <div className="companion-model-usage" data-message-model-usage={message.id} ref={host} onKeyDown={event => {
    if (event.key === 'Escape' && !isImeKeyboardEvent(event.nativeEvent)) { event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }}>
    <div className="companion-usage-footer-row">{usage && current && input !== undefined && <button ref={trigger} type="button" className="companion-usage-trigger" aria-label="查看这条回复的上下文用量" title="这条回复的上下文与 token 用量" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon name="layers" /><span>上下文{estimated ? '约 ' : ' '}{compact(input)}{limit !== undefined && ` / ${compact(limit)}`}</span>{percent !== undefined && <span>{estimated && '约 '}{percent.toFixed(1)}%</span>}{current.actual?.outputTokens !== undefined && <span>输出 {compact(current.actual.outputTokens)}</span>}
    </button>}
    {duration !== undefined ? <time className="companion-reply-total-duration" aria-label="本条回复总处理时长" dateTime={`PT${Math.floor(elapsed! / 1000)}S`} data-duration-ms={Math.floor(elapsed!)} data-duration-state={terminal ? 'fixed' : 'live'} title="累计实际处理时间，包含上下文、回忆、工具与生成；不含排队、暂停和离线时间。长时长按30天/月、365天/年换算。"><Icon name="clock" />总用时 {duration}</time>
      : <span className="companion-reply-total-duration is-unknown" title="这条回复未保存可靠的处理计时，未根据消息时间推算。">耗时未记录</span>}
    </div>
    {open && usage && current && input !== undefined && <section role="dialog" aria-label="主脑用量详情" className="companion-usage-popover">
      <header><div><strong>{companionName ?? '伙伴'} · 这条回复的用量</strong><small>{current.model || '模型未提供'} · {current.providerFormat}</small></div><button type="button" aria-label="关闭主脑用量详情" onClick={() => { setOpen(false); trigger.current?.focus(); }}><Icon name="close" /></button></header>
      <div className="companion-usage-context"><div><span>本条回复当前请求的上下文输入</span><strong>{exact(input)} <small>{estimated ? '估算 token' : '实测 token'}</small></strong></div><small>{limit === undefined ? '模型未提供上下文上限' : `上限 ${exact(limit)} token · ${estimated ? '估算占用' : '输入占用'} ${percent!.toFixed(1)}%`}</small></div>
      <p className="companion-usage-note">每条回复独立组织上下文，这里只统计这条回复；生成中的输出未并入上下文占用。{current.estimate.hasUnmeteredImages && '图片未计入本地估算。'}</p>
      <h3>本条回复当前请求 <span>{current.phase === 'prepared' ? '待发出' : current.phase === 'dispatched' ? '已发出' : current.phase === 'streaming' ? '接收中' : '已结束'}</span></h3>
      <UsageRows usage={current.actual} />
      {cache !== undefined && <p className="companion-usage-note">输入缓存命中 {cache.toFixed(1)}% · 缓存读取 / 实测输入</p>}
      <h3>这条回复的调用累计 <span>{usage.totals.requests} 次请求</span></h3>
      <UsageRows usage={usage.totals} />
      <p className="companion-usage-note">{usage.totals.complete ? '已返回的各次请求均包含输入与输出用量。' : `已有 ${usage.totals.reportedRequests} / ${usage.totals.requests} 次请求返回用量；缺失项不补为零。`}仅包含这条回复的主脑调用，DSH 与辅助模型另计。</p>
      <details><summary>本地输入估算的组成</summary><dl className="companion-usage-readings">{([['system', '身份与指引'], ['dialogue', '聊天内容'], ['toolDefinitions', '能力定义'], ['toolHistory', '能力过程'], ['other', '其他输入']] as const).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{exact(current.estimate.breakdown[key])}</dd></div>)}</dl><p className="companion-usage-note">按 UTF-8 字节数 / 3 估算，和模型的实际分词可能有差异。</p></details>
    </section>}
  </div>;
}

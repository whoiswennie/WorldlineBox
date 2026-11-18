import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BOT_PRESENCE_ROUND_DAYS, BOT_PRESENCE_ROUND_LIMIT, type BotDesktopCaptureScope, type BotHeartbeatRound, type BotHeartbeatState, type BotMediaResponse, type WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';
import { BotHeartbeatPlayer } from './BotHeartbeatPlayer';
import { BotIcon } from './BotIcon';
import { BotErrorNotice } from './BotErrorNotice';

const phases: Record<BotHeartbeatState, [string, string]> = {
  sealing: ['正在收尾', 'Finishing capture'], preparing: ['正在整理素材', 'Preparing inputs'], observing: ['正在回顾', 'Reviewing'],
  completed: ['已处理', 'Processed'], empty: ['未收到素材', 'No inputs'], interrupted: ['已中断', 'Interrupted'], failed: ['处理失败', 'Failed'],
};
export function BotPresenceArchive({ api, scope, zh, onClose }: {
  api: WorldlineBoxBotMediaApi; scope: BotDesktopCaptureScope; zh: boolean; onClose(): void;
}) {
  const [data, setData] = useState<BotMediaResponse>(), [roundId, setRoundId] = useState<number>(), [part, setPart] = useState('');
  const [pages, setPages] = useState<number[]>([]), [refresh, setRefresh] = useState(0), [clearing, setClearing] = useState(false), [error, setError] = useState('');
  const revision = useRef(0), first = useRef(true), dialog = useRef<HTMLDialogElement>(null);
  const title = useId(), before = pages.at(-1);
  const clock = (at: number, day = false) => new Date(at).toLocaleString(zh ? 'zh-CN' : 'en-GB', {
    ...(day ? { month: '2-digit', day: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const duration = (ms: number) => (Math.max(0, ms) / 1000).toFixed(1) + (zh ? ' 秒' : ' s');
  useEffect(() => { const modal = dialog.current!; modal.showModal(); return () => modal.close(); }, []);
  useEffect(() => {
    if (clearing) return;
    const token = ++revision.current;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const show = first.current && scope.surface === 'pet';
        first.current = false;
        const result = await api.request({ type: 'desktop.presence.archive.list', ...scope, before, show });
        if (!live || token !== revision.current) return;
        if (!result.ok) throw Error(result.error);
        setData(result); setError('');
      } catch (reason) { if (live && token === revision.current) setError(reason instanceof Error ? reason.message : String(reason)); }
      if (live && token === revision.current) timer = setTimeout(() => void load(), 2500);
    };
    void load();
    return () => { live = false; clearTimeout(timer); };
  }, [api, scope, before, refresh, clearing]);
  const items = data?.recordings ?? [], rounds = data?.rounds ?? [], available = new Set(items.map(item => item.id));
  const pending = items.filter(item => item.status === 'pending').sort((a, b) => a.startedAt - b.startedAt);
  const round = roundId === 0 && pending.length ? undefined : rounds.find(item => item.id === roundId) ?? rounds[0];
  const inputs = round?.inputs ?? pending;
  const videos = inputs.filter(item => item.kind === 'video'), screens = inputs.length - videos.length;
  const totalVideo = videos.reduce((total, item) => total + item.at - item.startedAt, 0);
  const selected = inputs.find(item => item.id === part);
  const allVideos = videos.length > 0 && videos.every(item => available.has(item.id));
  const playingParts = selected ? [selected] : allVideos ? videos : inputs.filter(item => available.has(item.id)).slice(0, 1);
  const ids = playingParts.map(item => item.id).join(',');
  const selectRound = (id: number) => { setRoundId(id); setPart(''); };
  const clear = async () => {
    if (clearing) return;
    ++revision.current; setClearing(true);
    try {
      const result = await api.request({ type: 'desktop.presence.archive.clear', ...scope });
      if (!result.ok) throw Error(result.error);
      setData(result); setPages([]); setRoundId(undefined); setPart(''); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setClearing(false); }
  };
  const label = (entry: BotHeartbeatRound) => {
    const clips = entry.inputs.filter(input => input.kind === 'video').length;
    return zh ? `${clips} 段录像 · ${entry.inputs.length - clips} 张截图` : `${clips} clips · ${entry.inputs.length - clips} screenshots`;
  };
  return createPortal(<dialog ref={dialog} className="bot-presence-archive" aria-labelledby={title} onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}>
    <header><div><h2 id={title}>{zh ? '心跳事件线' : 'Heartbeat timeline'}</h2>
      <small>{zh ? `事件最多保留 ${BOT_PRESENCE_ROUND_DAYS} 天、${BOT_PRESENCE_ROUND_LIMIT} 轮。原始素材自动清理，清理后仍可查看接收记录。` : 'Events are kept for up to 3 days or 4,096 rounds. Input details remain after recordings expire.'}</small></div>
      <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={onClose}><BotIcon name="close" /></button></header>
    <div className="bot-presence-archive-body">
      <div className="bot-heartbeat-history"><ol aria-label={zh ? '心跳触发记录' : 'Heartbeat events'}>
        {!before && pending.length > 0 && <li><button aria-current={!round} onClick={() => selectRound(0)}>{zh ? '等待下次心跳' : 'Awaiting next heartbeat'} · {pending.length}</button></li>}
        {rounds.map(entry => <li key={entry.id}><button aria-current={round?.id === entry.id} onClick={() => selectRound(entry.id)}>
          <BotIcon name="clock" /><span><time dateTime={new Date(entry.at).toISOString()}>{clock(entry.at, true)}</time>
          <small>{label(entry)}</small><small>{phases[entry.state][zh ? 0 : 1]}</small></span></button></li>)}
      </ol>
      {(before || data?.olderRounds) && <div className="bot-heartbeat-paging"><button disabled={!before} onClick={() => { setPages(p => p.slice(0, -1)); setRoundId(undefined); setPart(''); }}>{zh ? '较新' : 'Newer'}</button>
        <button disabled={!data?.olderRounds} onClick={() => { setPages(p => [...p, rounds.at(-1)!.id]); setRoundId(undefined); setPart(''); }}>{zh ? '较早' : 'Older'}</button></div>}</div>
      <section className="bot-heartbeat-detail">
        {round || pending.length ? <>
          <div className="bot-heartbeat-summary"><h3>{round ? (zh ? '心跳触发于 ' : 'Heartbeat at ') + clock(round.at) : zh ? '等待下一轮接收' : 'Waiting for next heartbeat'}</h3>
            <small>{round && (zh ? '计划等待 ' : 'Scheduled wait ') + duration(round.waitMs) + ' · '}{(zh ? '录像合计 ' : 'Recorded ') + duration(totalVideo)}
              {round?.finishedAt !== undefined && ' · ' + (zh ? '结束于 ' : 'Finished at ') + clock(round.finishedAt)}</small>
          </div>
          {round?.error && <BotErrorNotice message={round.error} zh={zh} />}
          {ids && <BotHeartbeatPlayer key={ids} ids={ids} kind={playingParts[0]!.kind} api={api} scope={scope} zh={zh} />}
          <div className="bot-heartbeat-inputs" aria-label={zh ? '本轮素材' : 'Round inputs'}>
            <strong>{round ? zh ? '本轮收到' : 'Inputs received' : zh ? '已采集' : 'Captured'} · {zh ? `${videos.length} 段录像，${screens} 张截图` : `${videos.length} clips, ${screens} screenshots`}</strong>
            {videos.length > 1 && <button disabled={!allVideos} aria-pressed={!selected && allVideos} onClick={() => setPart('')}>{zh ? '连续回放' : 'Play full recording'} · {duration(totalVideo)}</button>}
            {inputs.map((item, index) => <button key={item.id} disabled={!available.has(item.id)} aria-pressed={selected?.id === item.id || playingParts.length === 1 && playingParts[0]?.id === item.id}
              title={item.name} onClick={() => setPart(item.id)}><BotIcon name={item.kind === 'video' ? 'video' : 'screen'} /><span>{index + 1}. {item.kind === 'video'
                ? `${clock(item.startedAt)} – ${clock(item.at)} · ${duration(item.at - item.startedAt)}`
                : (zh ? '截图 ' : 'Screenshot ') + clock(item.at)}</span>{!available.has(item.id) && <small>{zh ? '已清理' : 'Expired'}</small>}</button>)}
          </div></> : <p>{!data ? zh ? '正在加载…' : 'Loading…' : zh ? '还没有心跳事件' : 'No heartbeats yet'}</p>}
        {error && <p role="alert">{error}</p>}
      </section>
    </div>
    <footer><button onClick={() => setRefresh(n => n + 1)} disabled={clearing}>{zh ? '刷新' : 'Refresh'}</button>
      <button onClick={() => void clear()} disabled={clearing || !rounds.some(r => r.finishedAt !== undefined) && !items.some(r => r.status === 'archived') && !data?.olderRounds}>{zh ? '清空历史' : 'Clear history'}</button></footer>
  </dialog>, document.body);
}

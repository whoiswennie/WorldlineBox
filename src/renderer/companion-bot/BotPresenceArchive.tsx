import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BOT_PRESENCE_ARCHIVE_LIMIT, type BotDesktopCaptureScope, type BotPresenceRecording, type WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';
import { BotIcon } from './BotIcon';

export function BotPresenceArchive({ api, scope, zh, onClose, onClear }: {
  api: WorldlineBoxBotMediaApi; scope: BotDesktopCaptureScope; zh: boolean; onClose(): void; onClear(): Promise<BotPresenceRecording[]>;
}) {
  const [items, setItems] = useState<BotPresenceRecording[]>();
  const [selectedId, setSelectedId] = useState<string>();
  const [preview, setPreview] = useState<{ id: string; url: string }>();
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const selection = items?.find(item => item.id === selectedId) ?? items?.[0];
  const selected = selection?.id, kind = selection?.kind;
  const labels = zh ? {
    title: '观察缓存', video: '录像', screen: '截图', pending: '待处理', processing: '处理中', archived: '已归档', close: '关闭', clear: '清空归档',
    empty: '暂无观察记录', loading: '正在加载', refresh: '刷新', limit: `保留最近 ${BOT_PRESENCE_ARCHIVE_LIMIT} 条归档，清理时保留待处理和处理中的素材。`,
  } : {
    title: 'Observation cache', video: 'Video', screen: 'Screenshot', pending: 'Queued', processing: 'Processing', archived: 'Archived', close: 'Close', clear: 'Clear archive',
    empty: 'No observations yet', loading: 'Loading', refresh: 'Refresh', limit: `Keeps up to ${BOT_PRESENCE_ARCHIVE_LIMIT} archived items. Clearing preserves queued and active items.`,
  };
  const dateFormat = new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23',
  });
  const warn = useCallback((reason: unknown) => setError((reason instanceof Error ? reason.message : String(reason ?? '')) || (zh ? '无法加载观察缓存。' : 'Could not load the observation cache.')), [zh]);
  const applyItems = (records: BotPresenceRecording[]) => {
    setItems(records);
    setSelectedId(previous => records.some(item => item.id === previous) ? previous : records[0]?.id);
  };
  useEffect(() => {
    const modal = dialog.current!;
    modal.showModal();
    return () => modal.close();
  }, []);
  useEffect(() => {
    let live = true;
    const load = (show = false) => {
      void api.request({ type: 'desktop.presence.archive.list', ...scope, show }).then(result => {
        if (!live) return;
        if (!result.ok) { warn(result.error); return; }
        applyItems(result.recordings ?? []);
      }, reason => { if (live) warn(reason); });
    };
    load(scope.surface === 'pet');
    const timer = setInterval(load, 2500);
    return () => { live = false; clearInterval(timer); };
  }, [api, scope, warn]);
  const refresh = async () => {
    try {
      const result = await api.request({ type: 'desktop.presence.archive.list', ...scope });
      if (!result.ok) throw Error(result.error);
      applyItems(result.recordings ?? []);
      setError('');
    } catch (reason) { warn(reason); }
  };
  useEffect(() => {
    if (!selected) return;
    let active = true, url: string | undefined;
    void api.request({ type: 'desktop.presence.archive.read', ...scope, id: selected }).then(result => {
      if (!active) return;
      if (!result.ok || !result.recordingBytes) throw Error(result.error);
      url = URL.createObjectURL(new Blob([new Uint8Array(result.recordingBytes)], { type: kind === 'video' ? 'video/webm' : 'image/jpeg' }));
      setPreview({ id: selected, url });
    }).catch(reason => { if (active) warn(reason); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [api, scope, selected, kind, warn]);
  return createPortal(<dialog ref={dialog} className="bot-presence-archive" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header>
      <div><h2 id={titleId}>{labels.title}</h2><small>{labels.limit}</small></div>
      <button type="button" aria-label={labels.close} onClick={onClose}><BotIcon name="close" /></button>
    </header>
    <div className="bot-presence-archive-body">
      <ol aria-label={labels.title}>
        {items?.map(item => <li key={item.id}>
          <button type="button" aria-current={item.id === selected ? 'true' : undefined} onClick={() => { setSelectedId(item.id); setError(''); }}>
            <BotIcon name={item.kind === 'video' ? 'video' : 'screen'} />
            <span><time dateTime={new Date(item.at).toISOString()}>{dateFormat.format(item.at)}</time>
              <small>{labels[item.kind]} · {labels[item.status]}</small></span>
          </button>
        </li>)}
      </ol>
      <section className="bot-presence-archive-preview">
        {selection && preview && preview.id === selected ? <>
          {selection.kind === 'video' ? <video src={preview.url} controls preload="metadata" /> : <img src={preview.url} alt={labels.screen} />}
          <small title={selection.name}>{selection.name}</small>
        </> : <p role={error ? 'alert' : 'status'}>{error || (items?.length || !items ? labels.loading : labels.empty)}</p>}
      </section>
    </div>
    <footer>
      <button type="button" onClick={() => void refresh()}>{labels.refresh}</button>
      <button type="button" disabled={!items?.some(item => item.status === 'archived')} onClick={() => {
        void onClear().then(records => { applyItems(records); setError(''); }, warn);
      }}>{labels.clear}</button>
    </footer>
  </dialog>, document.body);
}

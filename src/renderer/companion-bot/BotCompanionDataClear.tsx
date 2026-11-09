import { useEffect, useRef, useState } from 'react';
import type { BotDataCleanup, WorldlineBoxBotApi } from '../../shared/companion-bot';

export function BotCompanionDataClear({ api, companionId, name, locale, onChanged }: {
  api: WorldlineBoxBotApi; companionId: string; name: string; locale: 'zh-CN' | 'en'; onChanged?(): void;
}) {
  const zh = locale === 'zh-CN', [confirming, setConfirming] = useState(false), [job, setJob] = useState<BotDataCleanup>();
  const [sending, setSending] = useState(false), [error, setError] = useState(''), request = useRef('');
  const completed = useRef(''), changed = useRef(onChanged);
  useEffect(() => { changed.current = onChanged; }, [onChanged]);
  const active = !!job && job.status !== 'completed';
  const phases = zh ? { stopping: '正在停止伙伴回复与记忆写入', planning: '正在核对需要清理的记录', memory: '正在清理 VCP 日记与记忆索引', records: '正在分批清理聊天与任务记录', attachments: '正在清理聊天附件缓存', completed: '聊天、日记与记忆已清空' }
    : { stopping: 'Stopping replies and memory writes', planning: 'Collecting records', memory: 'Clearing VCP diaries and memory indexes', records: 'Clearing chat records in batches', attachments: 'Clearing chat attachment caches', completed: 'Chat, diaries and memories cleared' };
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const result = await api.request({ type: 'companion.data.clear.status', companionId });
        if (!disposed && result.ok) {
          setJob(result.cleanup);
          if (result.cleanup?.status === 'completed' && completed.current !== result.cleanup.id) {
            completed.current = result.cleanup.id; changed.current?.();
          }
        }
      } catch { /* A saved cleanup is retried by Main, independently of this view. */ }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [api, companionId]);
  return <section className="bot-data-clear" aria-label={zh ? '聊天与记忆管理' : 'Chat and memory data'}>
    <h3>{zh ? '聊天与记忆' : 'Chat and memory'}</h3>
    <p>{zh ? `清空与${name}相关的聊天记录、VCP 日记和记忆索引。角色设定、DSH 会话与工作区文件保留。` : `Clear chat records, VCP diaries and memory indexes for ${name}. Character settings, DSH sessions and workspace files are retained.`}</p>
    {active ? <div className="bot-data-clear-progress" role="status" aria-live="polite"><strong>{phases[job.phase]}</strong><span>{zh ? `已清理 ${job.removed.toLocaleString()} 条记录。可关闭此窗口，清理会继续。` : `${job.removed.toLocaleString()} records removed. You may close this window; cleanup will continue.`}</span>{job.status === 'retrying' && <span>{zh ? '清理尚未完成，已保留进度并在后台重试。' : 'Cleanup is unfinished. Progress is saved and a background retry is in progress.'}</span>}</div>
      : confirming ? <div className="bot-data-clear-confirm"><strong>{zh ? '确认清空这些记录？' : 'Clear these records?'}</strong><p>{zh ? '此操作无法撤销。包含这位伙伴的共享群聊、伙伴私聊也会清空相关聊天及对应记忆；其他伙伴的独立私聊会保留。清理时会暂停伙伴回复，完成后可继续聊天。' : 'This cannot be undone. Shared group and peer chats involving this companion, and their corresponding memories, will also be cleared. Other companions’ separate direct chats are retained. Replies pause during cleanup.'}</p><div><button type="button" disabled={sending} onClick={() => { setConfirming(false); request.current = ''; }}>{zh ? '取消' : 'Cancel'}</button><button type="button" className="bot-data-clear-danger" disabled={sending} onClick={() => {
        if (sending) return; setSending(true); setError(''); request.current ||= crypto.randomUUID();
        void api.request({ type: 'companion.data.clear', companionId, requestId: request.current }).then(result => {
          if (result.ok && result.cleanup) { setJob(result.cleanup); setConfirming(false); }
          else setError(result.error || (zh ? '暂时无法开始清理，请重试。' : 'Could not start cleanup. Try again.'));
        }).catch(() => setError(zh ? '暂时无法连接，请重试。' : 'Connection unavailable. Try again.')).finally(() => setSending(false));
      }}>{sending ? zh ? '正在开始…' : 'Starting…' : zh ? '确认清空聊天与记忆' : 'Clear chat and memory'}</button></div></div>
        : <><button type="button" className="bot-data-clear-danger" onClick={() => { setConfirming(true); request.current = ''; }}>{zh ? '清空聊天与记忆' : 'Clear chat and memory'}</button>{job?.status === 'completed' && <p className="bot-data-clear-complete" role="status">{phases.completed}</p>}</>}
    {error && <p className="bot-error" role="alert">{error}</p>}
  </section>;
}

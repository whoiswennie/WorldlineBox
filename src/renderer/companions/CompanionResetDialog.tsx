import { useEffect, useRef, useState } from 'react';
import type { Companion } from '../../shared/companions';
import type { CompanionReset } from '../../shared/companion-reset';
import { Icon } from '../Icons';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { isImeKeyboardEvent } from '../ime-safe-dismiss';
import type { CompanionRequest } from './CompanionDialogs';
import { Avatar } from './CompanionVisuals';
import './companion-reset.css';

export function CompanionResetDialog({ companion, initialJob, request, requestError, onClose, onStarted }: {
  companion: Companion; initialJob?: CompanionReset; request: CompanionRequest; requestError?: string;
  onClose(): void; onStarted(companionId: string): void;
}) {
  const [job, setJob] = useState<CompanionReset | undefined>(initialJob?.status === 'completed' ? undefined : initialJob);
  const [confirmation, setConfirmation] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true);
  useDialogFocusTrap(true, 'companion-reset-' + companion.id);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (job?.status !== 'running') return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const response = await request({ type: 'companion.reset.status', id: companion.id });
      if (stopped) return;
      if (response?.reset) setJob(response.reset);
      timer = setTimeout(() => void poll(), 600);
    };
    timer = setTimeout(() => void poll(), 250);
    return () => { stopped = true; clearTimeout(timer); };
  }, [job?.id, job?.status, request, companion.id]);
  async function start() {
    if (busy || !job && confirmation !== companion.name) return;
    setBusy(true); setError('');
    try {
      const response = await request({ type: 'companion.reset', id: companion.id, scope: 'all', expectedRevision: companion.revision });
      if (!alive.current) return;
      if (response?.reset) { setJob(response.reset); onStarted(companion.id); }
      else {
        const status = await request({ type: 'companion.reset.status', id: companion.id });
        if (!alive.current) return;
        if (status?.reset && status.reset.status !== 'completed') setJob(status.reset);
        setError('重置未能完成，请查看提示后重试。');
      }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '重置未能开始，请重试。'); }
    finally { if (alive.current) setBusy(false); }
  }
  const running = job?.status === 'running', completed = job?.status === 'completed', failed = job?.status === 'failed';
  return <div className="companions-modal-backdrop" onKeyDown={event => { if (event.key === 'Escape' && !isImeKeyboardEvent(event.nativeEvent)) { event.stopPropagation(); onClose(); } }}>
    <section className="companion-reset-dialog" role="dialog" aria-modal="true" aria-label="重置伙伴">
      <header><div><span>伙伴管理</span><h2>重置伙伴</h2></div><button className="companion-icon-button" type="button" aria-label="关闭重置窗口" onClick={onClose}><Icon name="close" /></button></header>
      <div className="companion-reset-body">
        <div className="companion-reset-identity"><Avatar companion={companion} large showPresence={false} /><div><h3>{completed ? '已经重新开始' : running ? '正在整理，稍等片刻' : `让${companion.name}重新开始`}</h3><p>{completed ? '默认人设、形象与设置已恢复，可以重新认识彼此了。' : '保留这位伙伴的身份，清除相处记录并恢复初始设置。'}</p></div></div>
        {!job && <><div className="companion-reset-scope">
          <div><Icon name="message-circle" /><span><strong>聊天与记忆</strong><small>私聊、本人群聊发言与全部个人记忆</small></span></div>
          <div><Icon name="clock" /><span><strong>任务与虚拟世界</strong><small>停止任务与拜访，重置小屋、位置、日常与世界状态</small></span></div>
          <div><Icon name="heart" /><span><strong>情绪与关系</strong><small>重置心情、好感与社交经历</small></span></div>
          <div><Icon name="settings" /><span><strong>人设与形象</strong><small>恢复内置设定、头像、三视图与全局模型</small></span></div>
        </div><p className="companion-reset-boundary">其他伙伴的资料和群聊发言会保留。这位伙伴会退出所有群聊，与其有关的私聊、社交关系、拜访和个人记忆会清空；你的用户资料和本机原文件不受影响。</p>
        <label className="companion-reset-confirm">输入「{companion.name}」以确认<input autoComplete="off" spellCheck={false} aria-label="确认重置的伙伴名字" placeholder={companion.name} value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} /></label></>}
        {job && <div className={`companion-reset-progress${completed ? ' is-completed' : failed ? ' is-failed' : ''}`} role="status" aria-live="polite"><div><Icon name={completed ? 'check' : failed ? 'alert-circle' : 'loader'} /><strong>{completed ? '重置完成' : failed ? '重置已暂停' : job.phase === 'stopping' ? '正在停止旧任务' : '正在清理伙伴记录'}</strong></div>{running && <progress aria-label="重置进度" />}<p>{completed ? '历史记录已清理，伙伴已恢复默认设置。' : failed ? job.error || '记录已受保护，解决问题后可以继续重置。' : '已处理 ' + job.processed.toLocaleString() + ' 项数据'}</p>{!completed && <small>可以关闭窗口继续使用软件。中途退出后，下次启动会接着处理。</small>}</div>}
        {(error || requestError) && <p className="companion-reset-error" role="alert">{error || requestError}</p>}
      </div>
      <footer><p>{completed ? '从新的相处开始。' : running ? '重置期间暂停这位伙伴的互动。' : '此操作无法撤销。'}</p><button type="button" className="companion-secondary-button" onClick={onClose}>{completed ? '完成' : running ? '后台继续' : '取消'}</button>{!running && !completed && <button type="button" className="companion-danger-button" disabled={busy || !job && confirmation !== companion.name} onClick={() => void start()}>{busy ? '正在开始…' : failed ? '继续重置' : '确认重置'}</button>}</footer>
    </section>
  </div>;
}

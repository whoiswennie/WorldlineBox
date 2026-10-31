import { useEffect, useRef, useState } from 'react';
import type { Companion } from '../../shared/companions';
import type { CompanionReset } from '../../shared/companion-reset';
import { COMPANION_RESET_CLEANUP_LABELS, COMPANION_RETIRE_PHASE_LABELS } from '../../shared/companion-reset';
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
  const [job, setJob] = useState<CompanionReset | undefined>(initialJob);
  const [confirmation, setConfirmation] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const alive = useRef(true);
  useDialogFocusTrap(true, 'companion-reset-' + companion.id);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (job?.status !== 'running') return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await request({ type: 'companion.retire.status', id: companion.id });
        if (stopped) return;
        if (response?.ok && response.reset?.companionId === companion.id) { setJob(response.reset); setPollError(''); }
        else setPollError(response?.error || '暂时无法读取进度。后台清理仍会继续，请稍后重试。');
      } catch (cause) { if (!stopped) setPollError(cause instanceof Error ? cause.message : '暂时无法读取进度，请稍后重试。'); }
      finally { if (!stopped) timer = setTimeout(() => void poll(), 600); }
    };
    timer = setTimeout(() => void poll(), 250);
    return () => { stopped = true; clearTimeout(timer); };
  }, [job?.id, job?.status, request, companion.id]);
  async function start() {
    if (busy || !job && confirmation !== companion.name) return;
    setBusy(true); setError('');
    try {
      const response = await request({ type: 'companion.retire', id: companion.id, scope: 'all', expectedRevision: companion.revision });
      if (!alive.current) return;
      if (response?.reset) { setJob(response.reset); onStarted(companion.id); }
      else {
        const status = await request({ type: 'companion.retire.status', id: companion.id });
        if (!alive.current) return;
        if (status?.reset?.companionId === companion.id) { setJob(status.reset); onStarted(companion.id); }
        else setError('删除未能完成，请查看提示后重试。');
      }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '删除未能开始，请重试。'); }
    finally { if (alive.current) setBusy(false); }
  }
  const running = job?.status === 'running', completed = job?.status === 'completed', failed = job?.status === 'failed';
  const preparing = running && job.phase === 'stopping';
  const progressLabel = job?.cleanupStage ? COMPANION_RESET_CLEANUP_LABELS[job.cleanupStage] : '正在停止旧任务';
  const stage = completed ? 4 : job?.phase === 'stopping' ? 0 : ['attachments', 'files'].includes(job?.phase ?? '') ? 2 : job?.phase === 'finish' ? 3 : 1;
  return <div className="companions-modal-backdrop" onKeyDown={event => { if (event.key === 'Escape' && !isImeKeyboardEvent(event.nativeEvent)) { event.stopPropagation(); onClose(); } }}>
    <section className="companion-reset-dialog" role="dialog" aria-modal="true" aria-label="删除伙伴及个人记录">
      <header><div><span>伙伴管理</span><h2>删除伙伴及个人记录</h2></div><button className="companion-icon-button" type="button" aria-label="关闭删除窗口" onClick={onClose}><Icon name="close" /></button></header>
      <div className="companion-reset-body">
        <div className="companion-reset-identity"><Avatar companion={companion} large showPresence={false} /><div><h3>{completed ? '已经完成删除' : running ? '正在删除个人记录' : `删除${companion.name}的身份`}</h3><p>{completed ? '这个身份已删除；再次添加联系人会创建新的身份。' : '这个身份与积累的个人记录将一并删除。之后仍可用模板创建新的伙伴。'}</p></div></div>
        {!job && <><div className="companion-reset-scope">
          <div><Icon name="message-circle" /><span><strong>聊天与记忆</strong><small>私聊、本人群聊发言与全部个人记忆</small></span></div>
          <div><Icon name="clock" /><span><strong>任务与虚拟世界</strong><small>停止任务与拜访，清理这位伙伴的生活与世界记录</small></span></div>
          <div><Icon name="heart" /><span><strong>体验与关系经历</strong><small>删除本人体验、具体关系约定和成长记录</small></span></div>
          <div><Icon name="settings" /><span><strong>角色起点与成长档案</strong><small>人设、提示词、知识与自我认识一并清理</small></span></div>
        </div><p className="companion-reset-boundary">其他伙伴的资料和群聊发言会保留。这位伙伴会退出所有群聊，与其有关的私聊、社交关系、拜访和个人记忆会清空；你的用户资料和本机原文件不受影响。</p>
        <label className="companion-reset-confirm">输入「{companion.name}」以确认<input autoComplete="off" spellCheck={false} aria-label="确认删除的伙伴名字" placeholder={companion.name} value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} /></label></>}
        {job && <>
          <ol className="companion-retire-stages" aria-label="删除步骤">{['停止互动', '清理个人记录', '清理文件', '完成确认'].map((label, index) => <li key={label} data-state={stage > index ? 'done' : stage === index ? 'current' : 'waiting'} aria-current={stage === index ? 'step' : undefined}><span>{stage > index ? <Icon name="check" /> : index + 1}</span>{label}</li>)}</ol>
          <div className={`companion-reset-progress${completed ? ' is-completed' : failed ? ' is-failed' : ''}`} role="status" aria-live="polite"><div><Icon name={completed ? 'check' : failed ? 'alert-circle' : 'loader'} /><strong>{completed ? '删除完成' : failed ? '清理已暂停' : job.phase === 'stopping' ? progressLabel : COMPANION_RETIRE_PHASE_LABELS[job.phase]}</strong></div>{failed && <span className="companion-retire-phase">暂停于{COMPANION_RETIRE_PHASE_LABELS[job.phase]}</span>}{running && <progress aria-label="删除清理进度" />}<p>{completed ? '个人记录已清理，这个身份已经删除。' : failed ? job.error || '已完成的步骤会保留，解决问题后可以继续清理。' : preparing ? job.cleanupStage === 'native-records' ? '正在核验原生运行环境并清理这位伙伴的任务记录，完成后会自动继续。' : '正在完成当前准备步骤，完成后会自动继续。' : '已处理 ' + job.processed.toLocaleString() + ' 项数据'}</p>{!completed && <small>可以关闭窗口继续使用软件。中途退出后，下次启动会接着处理。</small>}</div>
        </>}
        {pollError && <p className="companion-reset-error" role="alert">{pollError}</p>}
        {(error || requestError) && <p className="companion-reset-error" role="alert">{error || requestError}</p>}
      </div>
      <footer><p>{completed ? '新伙伴需另行创建。' : running ? '清理期间暂停这位伙伴的互动。' : '此操作无法撤销。'}</p><button type="button" className="companion-secondary-button" onClick={onClose}>{completed ? '完成' : running ? '后台继续' : '取消'}</button>{!running && !completed && <button type="button" className="companion-danger-button" disabled={busy || !job && confirmation !== companion.name} onClick={() => void start()}>{busy ? '正在开始…' : failed ? '继续清理' : '确认删除'}</button>}</footer>
    </section>
  </div>;
}

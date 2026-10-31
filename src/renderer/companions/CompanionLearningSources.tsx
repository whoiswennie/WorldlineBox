import { useCallback, useEffect, useRef, useState } from 'react';
import type { Companion, WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionLearningGrant, CompanionLearningStatus, CompanionLearningWorkspaceCommand } from '../../shared/companion-learning';
import { Avatar } from './CompanionVisuals';
import { Icon } from '../Icons';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import './companion-learning-sources.css';

function readTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function LearningGrant({ grant, busy, onCommand, authorizationOnly = false }: { grant: CompanionLearningGrant; busy: boolean; onCommand(command: CompanionLearningWorkspaceCommand): Promise<boolean>; authorizationOnly?: boolean }) {
  const [autonomous, setAutonomous] = useState(grant.autonomous), [interval, setInterval] = useState(grant.intervalMinutes), [revoking, setRevoking] = useState(false);
  const changed = autonomous !== grant.autonomous || interval !== grant.intervalMinutes;
  return <article className="learning-source" aria-label={grant.libraryName + (grant.folderName ? ' / ' + grant.folderName : ' / 全部文本')}>
    <header><span className="learning-source-icon"><Icon name="folder" /></span><div><h3>{grant.libraryName}</h3><p>{grant.folderName || '全部文本资料'}</p></div><span className={'learning-source-status is-' + grant.status}>{authorizationOnly ? '已授权的资料范围' : grant.status === 'reading' ? '正在阅读' : grant.status === 'waiting' || grant.status === 'failed' ? '等待重试' : grant.autonomous ? '按计划阅读' : '手动安排'}</span></header>
    {!authorizationOnly && <div className="learning-source-schedule"><label><input type="checkbox" checked={autonomous} disabled={busy} onChange={event => setAutonomous(event.target.checked)} /><span>空闲时自主阅读</span></label><label>核对间隔（现实时间） <select aria-label={grant.libraryName + '核对间隔'} value={interval} disabled={busy} onChange={event => setInterval(Number(event.target.value))}>{[5, 15, 30, 60, 180, 360, 1440].map(value => <option key={value} value={value}>{value < 60 ? value + ' 分钟' : value / 60 + ' 小时'}</option>)}{![5, 15, 30, 60, 180, 360, 1440].includes(interval) && <option value={interval}>{interval} 分钟</option>}</select></label></div>}
    {grant.error && <p className="learning-source-error" role="status">{grant.error}</p>}
    <footer><small>已读取 {grant.reads} 段 · 本来源中相同版本不重复收录</small><div>{!authorizationOnly && changed && <button className="learning-primary" disabled={busy} onClick={() => void onCommand({ type: 'memory.learning.update', companionId: grant.companionId, id: grant.id, expectedRevision: grant.revision, autonomous, intervalMinutes: interval })}>保存安排</button>}{!authorizationOnly && <button disabled={busy || grant.status === 'reading'} onClick={() => void onCommand({ type: 'memory.learning.run', companionId: grant.companionId, id: grant.id, expectedRevision: grant.revision })}><Icon name="file-text" />读一轮</button>}<button className="learning-remove" disabled={busy} onClick={() => setRevoking(true)}>移除来源</button></div></footer>
    {revoking && <div className="learning-source-confirm"><p>移除后会停止阅读，并撤回由此来源形成的记忆。资料库中的文件仍然保留。</p><div><button disabled={busy} onClick={() => setRevoking(false)}>保留来源</button><button className="learning-danger" disabled={busy} onClick={() => void onCommand({ type: 'memory.learning.revoke', companionId: grant.companionId, id: grant.id, expectedRevision: grant.revision })}>移除并撤回记忆</button></div></div>}
  </article>;
}

export function CompanionLearningSources({ owner, api, onClose, embedded = false, authorizationOnly = false }: { owner: Companion; api?: WorldlineBoxCompanionsApi; onClose(): void; embedded?: boolean; authorizationOnly?: boolean }) {
  useDialogFocusTrap(!embedded, '学习来源管理');
  const [status, setStatus] = useState<CompanionLearningStatus>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [adding, setAdding] = useState(false);
  const [libraryId, setLibraryId] = useState(''), [folderId, setFolderId] = useState(''), [addAutonomous, setAddAutonomous] = useState(!authorizationOnly);
  const alive = useRef(true), serial = useRef(0), lock = useRef(false);
  const library = status?.libraries?.find(item => item.libraryId === libraryId);
  const load = useCallback(async () => {
    const epoch = ++serial.current;
    try {
      if (!api?.workspace) throw new Error('学习来源接口暂不可用，请重新打开伙伴页面。');
      const result = await api.workspace({ type: 'memory.learning.status', companionId: owner.id });
      if (!alive.current || epoch !== serial.current) return;
      if (!result.ok || !result.learning) throw new Error(result.error || '学习来源暂不可用。');
      setStatus(result.learning);
    } catch (cause) { if (alive.current && epoch === serial.current) setError(cause instanceof Error ? cause.message : '学习来源暂不可用。'); }
  }, [api, owner.id]);
  useEffect(() => { alive.current = true; void Promise.resolve().then(load); return () => { alive.current = false; }; }, [load]);
  useEffect(() => { let timer: ReturnType<typeof setTimeout> | undefined; const unsubscribe = api?.onChanged(() => { clearTimeout(timer); timer = setTimeout(() => void load(), 300); }); return () => { clearTimeout(timer); unsubscribe?.(); }; }, [api, load]);
  useEffect(() => { if (!status?.grants.some(grant => grant.status === 'reading')) return; const timer = setInterval(() => void load(), 3000); return () => clearInterval(timer); }, [status, load]);
  const command = async (input: CompanionLearningWorkspaceCommand): Promise<boolean> => {
    if (lock.current || !api?.workspace) return false;
    lock.current = true; ++serial.current; setBusy(true); setError('');
    try {
      const result = await api.workspace(input);
      if (!result.ok || !result.learning) throw new Error(result.error || '学习安排未保存。');
      if (alive.current) { ++serial.current; setStatus(result.learning); }
      return true;
    } catch (cause) { if (alive.current) { setError(cause instanceof Error ? cause.message : '学习安排未保存。'); void load(); } return false; }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  return <section className="companion-learning-sources" role={embedded ? 'region' : 'dialog'} aria-modal={embedded ? undefined : true} aria-label="学习来源管理">
    <header className="learning-header"><button onClick={onClose} aria-label="返回记忆库"><Icon name="chevron-left" /></button><Avatar companion={owner} /><div><h2>学习来源</h2><p>{owner.name} 的阅读与成长</p></div></header>
    <div className="learning-layout"><main className="learning-main"><div className="learning-intro"><span className="learning-eyebrow">让成长有来处</span><h2>把适合的资料，留给伙伴慢慢读。</h2><p>选择资产库或其中的目录。伙伴会阅读原文，把值得记住的内容整理进自己的资料与日记，在以后的对话和生活中回想起来。</p></div>
      {error && <p className="learning-error" role="alert">{error}<button onClick={() => { setError(''); void load(); }}>重试</button></p>}
      <div className="learning-section-title"><h3>已授权的来源 <small>{status?.grants.length ?? 0}</small></h3><button className="learning-primary" disabled={busy || !status} onClick={() => { const first = status?.libraries?.[0]; setLibraryId(first?.libraryId ?? ''); setFolderId(''); setAddAutonomous(true); setAdding(true); }}><Icon name="plus" />添加来源</button></div>
      {adding && <form className="learning-add" onSubmit={event => { event.preventDefault(); if (!libraryId) return; void command({ type: 'memory.learning.grant', companionId: owner.id, libraryId, ...(folderId ? { folderId } : {}), autonomous: authorizationOnly ? false : addAutonomous, intervalMinutes: 30 }).then(saved => { if (saved && alive.current) setAdding(false); }); }}><label>资产库<select aria-label="学习资料资产库" value={libraryId} disabled={busy} onChange={event => { setLibraryId(event.target.value); setFolderId(''); }}><option value="">请选择已打开的资产库</option>{status?.libraries?.map(item => <option key={item.libraryId} value={item.libraryId}>{item.displayName}</option>)}</select></label><label>阅读范围<select aria-label="学习资料目录" value={folderId} disabled={busy || !libraryId} onChange={event => setFolderId(event.target.value)}><option value="">整个资产库的文本资料</option>{library?.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>{!authorizationOnly && <label><input type="checkbox" checked={addAutonomous} disabled={busy} onChange={event => setAddAutonomous(event.target.checked)} /><span>添加后空闲时自主阅读</span></label>}<p>{authorizationOnly ? '这里只授予资料范围，何时阅读由伙伴日程与长期方向统一安排。' : addAutonomous ? '添加后会在伙伴空闲时自动开始，之后按阅读安排继续。' : '添加后由你安排阅读；也可以随时开启自主阅读。'}伙伴私有记忆目录不会被读取。</p>{!status?.libraries?.length && <p>请先在资产管理中打开要使用的资料库。</p>}<div><button type="button" disabled={busy} onClick={() => setAdding(false)}>取消</button><button type="submit" className="learning-primary" disabled={busy || !libraryId}>添加为学习来源</button></div></form>}
      {!status && !error && <p className="learning-placeholder" role="status">正在读取学习安排…</p>}
      {status && !status.grants.length && !adding && <div className="learning-empty"><Icon name="file-text" /><h3>从一份值得读的资料开始</h3><p>不同伙伴可以学习同一个资料库，也可以拥有各自的阅读范围。未授权的资料不会自动进入记忆。</p></div>}
      {status?.grants.map(grant => <LearningGrant key={grant.id + ':' + grant.revision} grant={grant} busy={busy} onCommand={command} authorizationOnly={authorizationOnly} />)}
      <p className="learning-format-note"><Icon name="file-text" />当前阅读支持 UTF-8 / UTF-16 的纯文本、Markdown 与文本代码文件（单文件不超过 2 MiB）。图片、音频和视频仍可在资产库中使用多模态语义搜索。</p>
    </main><aside className="learning-history"><header><h3>最近阅读</h3><span>最近 30 段</span></header><p>这里记录实际读过的原文。读过之后，仍会按内容价值选择是否写入长期记忆。</p><ol>{status?.reads.map(read => <li key={read.id} className={read.status === 'withdrawn' ? 'is-withdrawn' : ''}><span className="learning-read-dot" /><div><strong title={read.assetName}>{read.assetName}</strong><small>{readTime(read.readAt)} · {read.characters.toLocaleString('zh-CN')} 字符</small><p>{read.status === 'withdrawn' ? '来源已移除，相关记忆已撤回' : '已读取原文 · 交由记忆系统整理'}</p></div></li>)}</ol>{status && !status.reads.length && <p className="learning-history-empty">还没有阅读记录。安排一次阅读后，出处会留在这里。</p>}<div className="learning-method"><Icon name="sparkles" /><h4>阅读，理解，再沉淀</h4><p>资料中的观点会保留出处，不会直接变成人格、真实经历或已经掌握的技能。睡眠中的反思会继续整合已有记忆。</p></div></aside></div>
  </section>;
}

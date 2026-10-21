import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionWorkspaceResponse } from '../../shared/companion-workspace';
import { Icon } from '../Icons';
import './companion-workspace.css';

export function CompanionWorkspace({ api, children, onOpenAssets }: {
  api?: WorldlineBoxCompanionsApi; children: ReactNode; onOpenAssets(): void;
}) {
  const [state, setState] = useState<CompanionWorkspaceResponse>();
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!api?.workspace) return;
    try { const value = await api.workspace({ type: 'status' }); setState(value); if (!value.ok) setError(value.error ?? '无法读取伙伴资产库。'); }
    catch { setError('无法读取伙伴资产库，请重试。'); }
  }, [api]);
  useEffect(() => { const timer = setTimeout(() => { void load(); }, 0); return () => clearTimeout(timer); }, [load]);
  const choose = async (libraryId?: string) => {
    if (!api?.workspace || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api.workspace(libraryId ? { type: 'select', libraryId } : { type: 'choose' });
      if (!result.ok) setError(result.error ?? '无法选择伙伴资产库。');
      else if (!result.cancelled) { setState(result); setChoosing(false); }
    } catch { setError('无法选择伙伴资产库，请重试。'); }
    finally { setBusy(false); }
  };
  if (!api?.workspace) return <>{children}</>;
  if (state?.selected && !choosing) return <div className="companion-workspace-bound" key={state.selected.libraryPath}>
    <div className="companion-workspace-bar"><div className="companion-workspace-location" title={state.selected.libraryPath}><Icon name="folder" size={15} /><span className="companion-workspace-label">记忆资产库</span><span className="companion-workspace-name">{state.selected.displayName}</span></div>
      <div className="companion-workspace-bar-actions"><button type="button" onClick={() => { void api.workspace!({ type: 'reveal' }).then(result => { if (!result.ok) setError(result.error ?? '无法打开目录。'); }).catch(() => setError('无法打开伙伴记忆目录。')); }}>打开记忆目录<Icon name="external-link" size={13} /></button>
      <button type="button" onClick={() => { setChoosing(true); void load(); }}>更换资产库</button></div></div>
    {error ? <p role="alert">{error}</p> : null}{children}
  </div>;
  return <section className="companion-workspace-picker" aria-label="伙伴资产库">
    <div><p className="companion-workspace-eyebrow">WorldlineBox · 持续生活</p><h1>为伙伴安置一个共同的资产库</h1>
      <p>每位伙伴拥有自己的子目录，保存日记、学习资料、自我认识和时间线。聊天、世界状态与向量索引也保存在这个资产库中。</p>
      {state?.libraries?.length ? <div className="companion-workspace-libraries">{state.libraries.map(library => <button disabled={busy} type="button" key={library.libraryId} onClick={() => { void choose(library.libraryId); }}>
        <strong>{library.displayName}</strong><span>{library.libraryPath}</span></button>)}</div> : null}
      <div className="companion-workspace-actions"><button type="button" disabled={busy} onClick={() => { void choose(); }}>{busy ? '正在准备资产库…' : '选择资产库目录'}</button>
        <button type="button" disabled={busy} onClick={onOpenAssets}>前往资产管理创建资产库</button>
        {state?.selected ? <button type="button" disabled={busy} onClick={() => setChoosing(false)}>返回伙伴</button> : null}</div>
      {error ? <p role="alert">{error}</p> : null}
      {!state && !error ? <p role="status">正在读取资产库…</p> : null}
    </div>
  </section>;
}

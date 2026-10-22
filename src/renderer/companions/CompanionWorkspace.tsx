import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionWorkspaceLibrary, CompanionWorkspaceResponse } from '../../shared/companion-workspace';
import type { WorldlineBoxLibraryApi } from '../../shared/library-api';
import { Icon } from '../Icons';
import { CompanionLibraryDialog } from './CompanionLibraryDialog';
import './companion-workspace.css';

export function CompanionWorkspace({ api, libraryApi, children }: {
  api?: WorldlineBoxCompanionsApi; libraryApi?: WorldlineBoxLibraryApi; children: ReactNode;
}) {
  const [state, setState] = useState<CompanionWorkspaceResponse>();
  const [busy, setBusy] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(true);
  const [created, setCreated] = useState<CompanionWorkspaceLibrary>();
  const [error, setError] = useState('');
  const lock = useRef(false), serial = useRef({ epoch: 0 });
  const load = useCallback(async (preserveDialog = false) => {
    if (!api?.workspace || lock.current) return;
    const epoch = ++serial.current.epoch;
    try {
      const value = await api.workspace({ type: 'status' });
      if (epoch !== serial.current.epoch) return;
      setState(current => value.ok ? value : current ?? value); setError(value.ok ? '' : value.error ?? '无法读取伙伴资产库。');
      if (value.ok && !preserveDialog) setDialogOpen(!value.selected);
    } catch { if (epoch === serial.current.epoch) setError('无法读取伙伴资产库，请重试。'); }
  }, [api]);
  useEffect(() => {
    const requests = serial.current;
    const timer = setTimeout(() => { void load(); }, 0);
    return () => { clearTimeout(timer); ++requests.epoch; };
  }, [load]);
  const openWorkspace = async (input: { libraryId?: string; createName?: string }) => {
    if (!api?.workspace || lock.current) return;
    lock.current = true; ++serial.current.epoch; setBusy(true); setError('');
    try {
      let libraryId = input.libraryId;
      if (input.createName) {
        if (!libraryApi) throw new Error('资产库创建功能暂不可用，请重新打开应用。');
        if (created) libraryId = created.libraryId;
        else {
          const result = await libraryApi.create({ displayName: input.createName });
          if (!result.ok) {
            if (result.error.code === 'CANCELLED') return;
            throw new Error(result.error.message || '无法创建资产库，请换一个保存位置重试。');
          }
          libraryId = result.value.libraryId;
          const library = { libraryId, displayName: result.value.displayName, libraryPath: result.value.displayPath };
          // A successful create must never be repeated when only binding failed.
          setCreated(library);
          setState(current => current ? { ...current, libraries: [...(current.libraries ?? []).filter(item => item.libraryId !== libraryId), library] } : current);
        }
      }
      const result = await api.workspace(libraryId ? { type: 'select', libraryId } : { type: 'choose' });
      if (!result.ok) setError(result.error ?? '无法选择伙伴资产库。');
      else if (!result.cancelled && result.selected) { setState(result); setDialogOpen(false); setCreated(undefined); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法打开伙伴资产库，请重试。'); }
    finally { lock.current = false; setBusy(false); }
  };
  if (!api?.workspace) return <>{children}</>;
  return <>
  {state?.selected ? <div className="companion-workspace-bound" key={state.selected.libraryPath}>
    <div className="companion-workspace-bar"><div className="companion-workspace-location" title={state.selected.libraryPath}><Icon name="folder" size={15} /><span className="companion-workspace-label">记忆资产库</span><span className="companion-workspace-name">{state.selected.displayName}</span></div>
      <div className="companion-workspace-bar-actions"><button type="button" onClick={() => { void api.workspace!({ type: 'reveal' }).then(result => { if (!result.ok) setError(result.error ?? '无法打开目录。'); }).catch(() => setError('无法打开伙伴记忆目录。')); }}>打开记忆目录<Icon name="external-link" size={13} /></button>
      <button type="button" onClick={() => { setError(''); setDialogOpen(true); void load(true); }}>更换资产库</button></div></div>
    {error && !dialogOpen ? <p role="alert">{error}</p> : null}{children}
  </div> : <section className="companion-workspace-empty" aria-label="伙伴资产库">
    <div><span className="companion-workspace-empty-icon"><Icon name="users" size={28} /></span><h1>伙伴</h1>
      <p>从一个伙伴资产库，开始你们的共同生活。</p>
      {!state && !error ? <p role="status">正在读取资产库…</p> : <button className="primary-button" type="button" onClick={() => { setDialogOpen(true); void load(true); }}>{state?.ok ? '创建伙伴资产库' : '重试'}</button>}
      {error && (!dialogOpen || !state?.ok) ? <p role="alert">{error}</p> : null}
    </div>
  </section>}
  {state?.ok && dialogOpen && <CompanionLibraryDialog libraries={state.libraries ?? []} selectedId={state.selected?.libraryId} busy={busy} error={error} createdName={created?.displayName}
    onCreate={name => { void openWorkspace({ createName: name }); }} onChoose={libraryId => { void openWorkspace({ libraryId }); }} onClose={() => { if (!lock.current) { setDialogOpen(false); setError(''); } }} />}
  </>;
}

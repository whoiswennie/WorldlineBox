import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionWorkspaceResponse } from '../../shared/companion-workspace';
import './companion-prompt-assets.css';

type Snapshot = NonNullable<CompanionWorkspaceResponse['modelResources']>;
type Draft = { revision: string; content: string };
/** The shared connection budget is editable; the displayed counters belong to this owner. */
export function CompanionModelResourcesPanel({ companionId, api }: { companionId: string; api?: Pick<WorldlineBoxCompanionsApi, 'workspace'> }) {
  const [open, setOpen] = useState(false), [snapshot, setSnapshot] = useState<Snapshot>();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [failure, setFailure] = useState<{ owner: string; message: string }>(), [notice, setNotice] = useState<{ owner: string; message: string }>();
  const [busy, setBusy] = useState<{ owner: string; saving: boolean }>();
  const owner = useRef(companionId), alive = useRef(false), serial = useRef(0), writing = useRef(false);
  useLayoutEffect(() => { owner.current = companionId; serial.current++; }, [companionId]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = snapshot?.companionId === companionId ? snapshot : undefined;
  const draft = drafts[companionId] ?? (current ? { revision: current.revision, content: current.content } : undefined);
  const dirty = !!current && !!draft && draft.content !== current.content;
  const loading = busy?.owner === companionId, saving = loading && busy.saving;
  const valid = (requestOwner: string, sequence: number) => alive.current && owner.current === requestOwner && sequence === serial.current;
  const refresh = useCallback(async () => {
    if (writing.current || !api?.workspace) return;
    const requestOwner = companionId, sequence = ++serial.current;
    setBusy({ owner: requestOwner, saving: false }); setFailure(undefined); setNotice(undefined);
    try {
      const response = await api.workspace({ type: 'model.resources.read', companionId: requestOwner });
      if (!alive.current || owner.current !== requestOwner || sequence !== serial.current) return;
      if (!response.ok || response.modelResources?.companionId !== requestOwner) throw Error(response.error || '模型资源预算暂不可读取。');
      setSnapshot(response.modelResources);
    } catch (cause) { if (alive.current && owner.current === requestOwner && sequence === serial.current) setFailure({ owner: requestOwner, message: cause instanceof Error ? cause.message : '读取失败。' }); }
    finally { if (alive.current && owner.current === requestOwner && sequence === serial.current) setBusy(undefined); }
  }, [api, companionId]);
  const latestRefresh = useRef(refresh);
  useLayoutEffect(() => { latestRefresh.current = refresh; }, [refresh]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.resolve().then(() => { if (!cancelled) return refresh(); });
    return () => { cancelled = true; };
  }, [open, refresh]);
  const save = async () => {
    if (!api?.workspace || !draft || writing.current) return;
    const requestOwner = companionId, submitted = draft, sequence = ++serial.current;
    writing.current = true; setBusy({ owner: requestOwner, saving: true }); setFailure(undefined); setNotice(undefined);
    try {
      const response = await api.workspace({ type: 'model.resources.save', companionId: requestOwner, expectedRevision: submitted.revision, content: submitted.content });
      if (!valid(requestOwner, sequence)) return;
      if (!response.ok || response.modelResources?.companionId !== requestOwner) throw Error(response.error || '保存失败，草稿已保留。');
      const saved = response.modelResources; setSnapshot(saved);
      setDrafts(previous => ({ ...previous, [requestOwner]: { revision: saved.revision, content: saved.content } }));
      setNotice({ owner: requestOwner, message: '已写入 ' + saved.path + '；后续请求实时读取。' });
    } catch (cause) { if (valid(requestOwner, sequence)) setFailure({ owner: requestOwner, message: cause instanceof Error ? cause.message : '保存失败，草稿已保留。' }); }
    finally {
      writing.current = false;
      if (valid(requestOwner, sequence)) setBusy(undefined);
      // An owner switch may happen during a save; never leave the next owner unrefreshed.
      if (alive.current && owner.current !== requestOwner) void latestRefresh.current();
    }
  };
  return <section className="companion-prompt-assets companion-model-resources"><details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>模型资源与预算</summary>
    {open && <div className="companion-prompt-assets-body">
      <p>预算文件由此资产库的伙伴共享，按聊天模型连接限制；下列统计仅属于当前伙伴，统计日以 UTC 为准。本预算不计入编码器请求。</p>
      {!api?.workspace && <p role="alert">模型资源文件接口暂不可用。</p>}
      {failure?.owner === companionId && <p role="alert">{failure.message} 未保存草稿会保留。</p>}
      {notice?.owner === companionId && <p role="status">{notice.message}</p>}
      {current && <dl className="companion-model-usage" aria-label="当前伙伴当日模型请求统计">
        <div><dt>已发送与结果未知的请求</dt><dd>{current.usage.requests.toLocaleString('zh-CN')}</dd></div>
        <div><dt>输入量</dt><dd>{(current.usage.inputBytes / 1048576).toFixed(2)} MiB</dd></div>
        <div><dt>预留输出</dt><dd>{current.usage.reservedOutputTokens.toLocaleString('zh-CN')} tokens</dd></div>
        <div><dt>其中日记编码请求</dt><dd>{(current.usage.purposes?.find(item => item.purpose === 'journal')?.requests ?? 0).toLocaleString('zh-CN')}</dd></div>
        <div><dt>网络失败 / 中断 / 待响应</dt><dd>{current.usage.networkErrors} / {current.usage.interrupted} / {current.usage.unfinished}</dd></div>
      </dl>}
      <p>每次实际发送分别记账，未知网络结果保留预算预留。可在文件中填写价格与成本上限；预留值用于限制请求，不代表实际账单。</p>
      <div className="companion-prompt-assets-controls"><button type="button" disabled={loading || busy?.saving || !api?.workspace} onClick={() => void refresh()}>{loading && !saving ? '正在读取…' : '重读预算与统计'}</button>
        {current && <code>{current.path}</code>}</div>
      {current && draft && <><label>资源预算文件内容<textarea aria-label="资源预算文件内容" value={draft.content} spellCheck={false} disabled={saving}
        onChange={event => setDrafts(previous => ({ ...previous, [companionId]: { revision: draft.revision, content: event.target.value } }))} /></label>
        <div className="companion-prompt-assets-controls"><button type="button" disabled={loading || !dirty || !draft.content.trim()} onClick={() => void save()}>{saving ? '正在保存…' : '保存预算文件'}</button>
          {drafts[companionId] && (dirty || draft.revision !== current.revision) && <button type="button" disabled={saving} onClick={() => {
            setDrafts(previous => ({ ...previous, [companionId]: { revision: current.revision, content: current.content } })); setFailure(undefined); setNotice(undefined);
          }}>用最新文件替换草稿</button>}
          <small>{dirty ? '有未保存草稿' : '已与读取的文件一致'}</small></div></>}
    </div>}
  </details></section>;
}

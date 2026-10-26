import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionWorkspaceResponse } from '../../shared/companion-workspace';
import './companion-prompt-assets.css';

type Snapshot = NonNullable<CompanionWorkspaceResponse['companionAssets']>;
type Draft = { revision: string; content: string };
export function CompanionPromptAssetsEditor({ companionId, api, disabled = false, initiallyOpen = false }: {
  companionId: string; api?: Pick<WorldlineBoxCompanionsApi, 'workspace'>; disabled?: boolean; initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen), [snapshot, setSnapshot] = useState<Snapshot>();
  const [selected, setSelected] = useState(''), [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  const owner = useRef(companionId), serial = useRef(0), alive = useRef(true);
  useEffect(() => {
    owner.current = companionId; serial.current++; alive.current = true;
    return () => { alive.current = false; };
  }, [companionId]);
  const current = snapshot?.companionId === companionId ? snapshot : undefined;
  const file = current?.prompts.find(item => item.path === selected) ?? current?.prompts[0];
  const key = file ? companionId + '/' + file.path : '', storedDraft = key ? drafts[key] : undefined;
  const draft = storedDraft ?? (file ? { revision: file.revision, content: file.content } : undefined);
  const dirty = !!file && !!draft && draft.content !== file.content;
  const refresh = useCallback(async () => {
    if (!api?.workspace) { setError('伙伴提示词文件接口暂不可用。'); return; }
    const requestOwner = companionId, sequence = ++serial.current; setLoading(true); setError(''); setNotice('');
    try {
      const response = await api.workspace({ type: 'companion.assets.read', companionId: requestOwner });
      if (!alive.current || owner.current !== requestOwner || sequence !== serial.current) return;
      if (!response.ok || response.companionAssets?.companionId !== requestOwner) throw new Error(response.error || '当前伙伴提示词文件不可读取。');
      setSnapshot(response.companionAssets);
      setSelected(previous => response.companionAssets!.prompts.some(item => item.path === previous) ? previous : response.companionAssets!.prompts[0]?.path ?? '');
    } catch (cause) { if (alive.current && owner.current === requestOwner && sequence === serial.current) setError(cause instanceof Error ? cause.message : '提示词读取失败。'); }
    finally { if (alive.current && owner.current === requestOwner && sequence === serial.current) setLoading(false); }
  }, [api, companionId]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.resolve().then(() => { if (!cancelled) return refresh(); });
    return () => { cancelled = true; };
  }, [open, refresh]);
  const save = async () => {
    if (!api?.workspace || !file || !draft || disabled || saving) return;
    const requestOwner = companionId, path = file.path, submitted = draft, sequence = ++serial.current;
    setSaving(true); setError(''); setNotice('');
    try {
      const response = await api.workspace({ type: 'companion.assets.prompt.save', companionId: requestOwner, path,
        expectedRevision: submitted.revision, content: submitted.content });
      if (!alive.current || owner.current !== requestOwner || sequence !== serial.current) return;
      if (!response.ok || response.companionAssets?.companionId !== requestOwner) throw new Error(response.error || '保存未完成；本地草稿已保留。');
      const saved = response.companionAssets.prompts.find(item => item.path === path);
      if (!saved) throw new Error('保存后的文件清单发生变化；本地草稿已保留。');
      setSnapshot(response.companionAssets); setDrafts(previous => ({ ...previous, [requestOwner + '/' + path]: { revision: saved.revision, content: saved.content } }));
      setNotice('已保存到此伙伴的 ' + path + '，后续上下文会实时读取。');
    } catch (cause) { if (alive.current && owner.current === requestOwner && sequence === serial.current) setError(cause instanceof Error ? cause.message : '保存失败；本地草稿已保留。'); }
    finally { if (alive.current && owner.current === requestOwner && sequence === serial.current) setSaving(false); }
  };
  return <section className="companion-prompt-assets"><details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>本伙伴的提示词文件</summary>
    {open && <div className="companion-prompt-assets-body">
      <p className="companions-subtle">初始模板只用于首次创建。这里的修改会写入当前伙伴目录，影响后续上下文；不会改动内置模板或其他伙伴。</p>
      {error && <p role="alert">{error} 本地草稿会保留；可重读文件后核对。</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="companion-prompt-assets-controls"><label>提示词文件<select aria-label="提示词文件" disabled={loading || saving} value={file?.path ?? ''}
        onChange={event => { setSelected(event.target.value); setError(''); setNotice(''); }}>
        {!current && <option value="">{loading ? '正在读取…' : '尚未读取'}</option>}
        {current?.prompts.map(item => <option value={item.path} key={item.path}>{item.path}</option>)}
      </select></label><button type="button" className="companion-secondary-button" disabled={loading || saving} onClick={() => void refresh()}>重读文件</button></div>
      {file && draft && <><p className="companions-subtle"><code>{companionId}/{file.path}</code>{file.purposes.length ? ' · ' + file.purposes.join('、') : ''}</p>
        <textarea aria-label="提示词正文" spellCheck={false} value={draft.content} disabled={disabled || saving}
          onChange={event => setDrafts(previous => ({ ...previous, [key]: { revision: draft.revision, content: event.target.value } }))} />
        <div className="companion-prompt-assets-controls"><button type="button" className="companion-primary-button" disabled={disabled || loading || saving || !dirty || !draft.content.trim()}
          onClick={() => void save()}>{saving ? '正在保存…' : '保存到伙伴文件'}</button>
          {storedDraft && (dirty || storedDraft.revision !== file.revision) && <button type="button" className="companion-secondary-button" disabled={saving}
            onClick={() => { setDrafts(previous => ({ ...previous, [key]: { revision: file.revision, content: file.content } })); setError(''); setNotice('已用刚读取的文件内容替换本地草稿。'); }}>使用最新文件替换草稿</button>}
          <small>{dirty ? '有未保存草稿' : '已与读取的文件一致'}</small></div></>}
    </div>}
  </details></section>;
}

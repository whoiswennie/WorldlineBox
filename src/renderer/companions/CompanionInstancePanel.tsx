import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Companion, WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionWorkspaceResponse } from '../../shared/companion-workspace';
import { CompanionCharacterEditor } from './CompanionCharacterEditor';
import { CompanionPromptAssetsEditor } from './CompanionPromptAssetsEditor';
import { CompanionAssetNavigation } from './companion-asset-navigation';
import { Icon } from '../Icons';
import { Avatar } from './CompanionVisuals';
import './companion-instance-panel.css';

type Snapshot = NonNullable<CompanionWorkspaceResponse['companionAssets']>;
const fileLabels: Record<string, string> = { profile: '角色资料', prompts: '提示词清单', memoryPolicy: '记忆规则', diary: '日记', knowledge: '学习资料', development: '自我认识', world: '世界经历', timeline: '时间线', sources: '记录来源', history: '修订历史', images: '形象', index: '检索索引' };
export function CompanionInstancePanel({ companionId, companion, api, view, onDirtyChange }: {
  companionId: string; companion?: Companion; api?: WorldlineBoxCompanionsApi; view: 'profile' | 'prompts' | 'appearance'; onDirtyChange(dirty: boolean): void;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>(), [draft, setDraft] = useState<Snapshot['profile']>();
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const alive = useRef(true), sequence = useRef({ value: 0 }), openAssets = useContext(CompanionAssetNavigation);
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(snapshot?.profile);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  const load = useCallback(async () => {
    const epoch = ++sequence.current.value;
    try {
      const result = await api?.workspace?.({ type: 'companion.assets.read', companionId });
      if (!alive.current || epoch !== sequence.current.value) return;
      if (!result?.ok || result.companionAssets?.companionId !== companionId || !result.companionAssets.profile) throw new Error(result?.error || '当前伙伴实例不可读取。');
      setSnapshot(result.companionAssets); setDraft(result.companionAssets.profile); setError('');
    } catch (cause) { if (alive.current && epoch === sequence.current.value) setError(cause instanceof Error ? cause.message : '实例读取失败。'); }
  }, [api, companionId]);
  useEffect(() => { alive.current = true; const counter = sequence.current;
    void Promise.resolve().then(() => { if (alive.current) return load(); });
    return () => { alive.current = false; ++counter.value; }; }, [load]);
  const save = async () => {
    if (!snapshot || !draft || !api?.workspace || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.workspace({ type: 'companion.assets.profile.save', companionId, expectedRevision: snapshot.profileRevision, profile: draft });
      if (!alive.current) return;
      if (!result.ok || !result.companionAssets?.profile) throw new Error(result.error || '资料未能保存，修改已保留。');
      setSnapshot(result.companionAssets); setDraft(result.companionAssets.profile); setNotice('已保存到当前伙伴实例，下一次主脑推理使用此版本。');
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '保存失败，修改已保留。'); }
    finally { if (alive.current) setBusy(false); }
  };
  const reveal = async () => {
    try {
      const result = await api?.workspace?.({ type: 'companion.assets.location', companionId });
      if (!result?.ok || !result.assetLocation || !openAssets) throw new Error(result?.error || '资产管理入口暂不可用。');
      openAssets(result.assetLocation);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法定位实例目录。'); }
  };
  return <article className="companion-instance-panel" aria-label="当前伙伴实例">
    <header className="instance-intro"><span className="instance-intro-icon"><Icon name={view === 'profile' ? 'user' : view === 'appearance' ? 'camera' : 'sliders'} /></span><div><h2>{view === 'profile' ? '角色资料' : view === 'appearance' ? '伙伴形象' : '提示词与记忆规则'}</h2><p>{view === 'profile' ? '塑造她的身份、性格和相处方式。保存后，后续交流会使用新的设定。' : view === 'appearance' ? '当前伙伴实际使用的头像和公开三视图。' : '按职责组织的行为配置，与日记、学习和成长记录分别管理。'}</p></div>
      {openAssets && <button type="button" className="memory-library-quiet instance-open-assets" aria-label="在资产管理中打开此伙伴" onClick={() => void reveal()}><Icon name="external-link" />打开资产目录</button>}
    </header>
    {error && <p className="instance-feedback is-error" role="alert">{error}</p>}{notice && <p className="instance-feedback" role="status"><Icon name="check" />{notice}</p>}
    {view === 'appearance' ? <div className="instance-image-grid">{(['avatar', 'orthographic'] as const).map(role => <figure key={role}><div>{companion?.assetImages?.[role] ? <img src={companion.assetImages[role].url} alt={role === 'avatar' ? '伙伴头像' : '公开三视图'} /> : <span><Icon name="camera" />尚未设置</span>}</div><figcaption><strong>{role === 'avatar' ? '聊天头像' : '公开三视图'}</strong><span>{role === 'avatar' ? '用于联系人与聊天显示' : '用于交流时呈现角色的外观设定'}</span></figcaption></figure>)}<p className="companions-subtle">在联系人“编辑资料”中更换形象。这里只统计实际图片，不包含内部状态文件。</p></div> : view === 'prompts' ? <CompanionPromptAssetsEditor key={companionId} companionId={companionId} api={api} initiallyOpen onDirtyChange={onDirtyChange} /> : draft ? <>
      <section className="instance-identity"><Avatar companion={companion} large showPresence={false} /><div className="instance-identity-fields"><label>名字<input value={draft.name} maxLength={60} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>个性签名<input value={draft.description} maxLength={500} disabled={busy} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label></div></section>
      <section className="instance-character-card"><CompanionCharacterEditor value={draft.persona} name={draft.name} disabled={busy} onChange={persona => setDraft({ ...draft, persona })} /></section>
      <footer className="instance-save-bar"><span><i className={dirty ? 'is-dirty' : ''} />{busy ? '正在保存到伙伴资产库' : dirty ? '有未保存的修改' : '已与当前资料同步'}</span><button className="memory-library-primary" disabled={busy || !dirty || !draft.name.trim()} onClick={() => void save()}><Icon name="check" />{busy ? '正在保存…' : '保存实例资料'}</button></footer>
    </> : !error && <p role="status">正在读取当前实例…</p>}
    {snapshot?.root && <details className="instance-storage"><summary><Icon name="folder" /><span>存储位置与文件结构</span><Icon name="chevron-right" /></summary><div><p>角色资料、行为配置和成长记录都保存在这个伙伴目录。</p><code>{snapshot.root}</code>{snapshot.instance && <dl>{Object.entries(snapshot.instance.files).map(([key, file]) => <div key={key}><dt>{fileLabels[key] ?? key}</dt><dd>{file}</dd></div>)}</dl>}</div></details>}
  </article>;
}

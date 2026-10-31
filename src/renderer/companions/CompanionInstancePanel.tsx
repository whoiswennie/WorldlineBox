import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Companion, WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionWorkspaceResponse } from '../../shared/companion-workspace';
import { CompanionCognitionDossier } from './CompanionCognitionDossier';
import { CompanionAssetNavigation } from './companion-asset-navigation';
import { Icon } from '../Icons';
import { createCoalescedRefresh } from './coalesced-refresh';
import './companion-instance-panel.css';

type Snapshot = NonNullable<CompanionWorkspaceResponse['companionAssets']>;
const fileLabels: Record<string, string> = { profile: '已发布人格', prompts: '职能指导索引', memoryPolicy: '认知整理策略', diary: '经历记忆', knowledge: '知识与方法', development: '自我认识', world: '世界经历', timeline: '记忆导航', sources: '来源凭证', history: '修订历史', images: '形象', index: '检索索引' };
export function CompanionInstancePanel({ companionId, companion, api, view, onDirtyChange, onOpenLearning, active = true }: {
  companionId: string; companion?: Companion; api?: WorldlineBoxCompanionsApi; view: 'profile' | 'prompts' | 'appearance'; onDirtyChange(dirty: boolean): void; onOpenLearning?(): void;
  active?: boolean;
}) {
  const [loadedSnapshot, setSnapshot] = useState<Snapshot>();
  const [error, setError] = useState('');
  const alive = useRef(true), sequence = useRef({ value: 0 }), openAssets = useContext(CompanionAssetNavigation);
  const snapshot = active ? loadedSnapshot : undefined;
  useEffect(() => { onDirtyChange(false); }, [onDirtyChange]);
  const load = useCallback(async () => {
    if (!active || view === 'appearance') return;
    const epoch = ++sequence.current.value;
    try {
      const result = await api?.workspace?.({ type: 'companion.assets.read', companionId });
      if (!alive.current || epoch !== sequence.current.value) return;
      if (!result?.ok || result.companionAssets?.companionId !== companionId || !result.companionAssets.profile) throw new Error(result?.error || '当前伙伴实例不可读取。');
      setSnapshot(result.companionAssets); setError('');
    } catch (cause) { if (alive.current && epoch === sequence.current.value) { setSnapshot(undefined); setError(cause instanceof Error ? cause.message : '实例读取失败。'); } }
  }, [api, companionId, active, view]);
  useLayoutEffect(() => {
    if (!active || view === 'appearance') {
      alive.current = false; ++sequence.current.value;
      return;
    }
    alive.current = true; const counter = sequence.current;
    void Promise.resolve().then(() => { if (alive.current) return load(); });
    // Progress cannot change role files. A full/legacy notification may be a
    // withdrawal, so remove private bodies before starting their fresh read.
    const updates = createCoalescedRefresh(load, undefined, 1000);
    const unsubscribe = api?.onChanged(change => {
      if (change?.kind === 'progress') return;
      ++counter.value; setSnapshot(undefined); setError('');
      void updates.trigger();
    });
    return () => { alive.current = false; ++counter.value; setSnapshot(undefined); setError(''); updates.dispose(); unsubscribe?.(); };
  }, [load, api, active, view]);
  const reveal = async () => {
    try {
      const result = await api?.workspace?.({ type: 'companion.assets.location', companionId });
      if (!result?.ok || !result.assetLocation || !openAssets) throw new Error(result?.error || '资产管理入口暂不可用。');
      openAssets(result.assetLocation);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法定位实例目录。'); }
  };
  return <article className="companion-instance-panel" aria-label="当前伙伴实例">
    <header className="instance-intro"><span className="instance-intro-icon"><Icon name={view === 'appearance' ? 'camera' : 'user'} /></span><div><h2>{view === 'appearance' ? '伙伴形象' : '伙伴认知档案'}</h2><p>{view === 'appearance' ? '当前伙伴实际使用的头像和公开三视图。' : '当前人格、表达、认识与成长依据，完整只读展示。'}</p></div>
      {openAssets && <button type="button" className="memory-library-quiet instance-open-assets" aria-label="在资产管理中打开此伙伴" onClick={() => void reveal()}><Icon name="external-link" />打开资产目录</button>}
    </header>
    {error && <div className="instance-feedback is-error" role="alert"><Icon name="shield" /><span>{error}</span><button type="button" onClick={() => void load()}>重新核对</button></div>}
    {view === 'appearance' ? <div className="instance-image-grid">{(['avatar', 'orthographic'] as const).map(role => <figure key={role}><div>{companion?.assetImages?.[role] ? <img src={companion.assetImages[role].url} alt={role === 'avatar' ? '伙伴头像' : '公开三视图'} /> : <span><Icon name="camera" />尚未设置</span>}</div><figcaption><strong>{role === 'avatar' ? '聊天头像' : '公开三视图'}</strong><span>{role === 'avatar' ? '用于联系人与聊天显示' : '用于交流时呈现角色的外观设定'}</span></figcaption></figure>)}<p className="companions-subtle">可在联系人“运行设置”中管理形象。</p></div> : snapshot?.companionId === companionId ? <CompanionCognitionDossier key={companionId} companionId={companionId} companion={companion} api={api} assets={snapshot} onOpenLearning={onOpenLearning} initialPage={view === 'prompts' ? 'instructions' : 'self'} /> : !error && <div className="instance-loading" role="status"><Icon name="clock" /><div><strong>正在核对伙伴资料</strong><p>从已登记版本读取当前人格与依据。</p></div></div>}
    {snapshot?.root && <details className="instance-storage"><summary><Icon name="folder" /><span>存储位置与文件结构</span><Icon name="chevron-right" /></summary><div><p>角色资料、行为配置和成长记录都保存在这个伙伴目录。</p><code>{snapshot.root}</code>{snapshot.instance && <dl>{Object.entries(snapshot.instance.files).map(([key, file]) => <div key={key}><dt>{fileLabels[key] ?? key}</dt><dd>{file}</dd></div>)}</dl>}</div></details>}
  </article>;
}

import { useEffect, useState } from 'react';
import { LOCAL_TEXT_EMBEDDING_MODEL, type LocalTextEmbeddingInstallStatus } from '../shared/embedding/global-profile';
import type { PublicError } from '../shared/protocol/errors';
import { useLocale } from './i18n';
import { notifyEmbeddingCatalogChanged } from './embedding-catalog-events';
import { Icon } from './Icons';
import { Button } from './ui/primitives';
import './local-embedding-settings.css';

export interface LocalTextEmbeddingApi {
  embeddingLocalTextStatus(): Promise<{ ok: boolean; value?: LocalTextEmbeddingInstallStatus; error?: PublicError }>;
  embeddingLocalTextInstall(input: { update?: boolean }): Promise<{ ok: boolean; value?: LocalTextEmbeddingInstallStatus; error?: PublicError }>;
  embeddingLocalTextDelete(): Promise<{ ok: boolean; value?: LocalTextEmbeddingInstallStatus; error?: PublicError }>;
}

export function LocalTextEmbeddingSettings({ api }: { api?: LocalTextEmbeddingApi }) {
  const { locale } = useLocale();
  const zh = locale === 'zh-CN';
  const [status, setStatus] = useState<LocalTextEmbeddingInstallStatus>();
  const [checking, setChecking] = useState(true);
  const [readFailed, setReadFailed] = useState(false);
  const [operation, setOperation] = useState<'repair' | 'clear' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    // File inspection only: opening Settings never starts inference.
    const load = async () => {
      try {
        const result = await api.embeddingLocalTextStatus();
        if (cancelled) return;
        if (result.ok && result.value) { setStatus(result.value); setReadFailed(false); }
        else setReadFailed(true);
      } catch { if (!cancelled) setReadFailed(true); }
      finally { if (!cancelled) setChecking(false); }
    };
    void load();
    const timer = operation ? setInterval(() => { void load(); }, 750) : undefined;
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [api, operation]);

  if (!api) return null;

  async function run(action: 'repair' | 'clear') {
    if (operation || checking || !api) return;
    setOperation(action); setError('');
    try {
      const result = action === 'clear' ? await api.embeddingLocalTextDelete() : await api.embeddingLocalTextInstall({ update: true });
      if (result.ok && result.value) { setStatus(result.value); setReadFailed(false); notifyEmbeddingCatalogChanged(); }
      else setError(zh ? '操作未完成，请稍后重试。' : 'The operation did not complete. Please retry.');
    } catch { setError(zh ? '无法连接模型管理服务，请稍后重试。' : 'Could not reach model management. Please retry.'); }
    finally { setOperation(null); }
  }

  const ready = status?.phase === 'ready' && status.installed && status.runtimeInstalled && !readFailed;
  const working = checking || operation !== null || status?.phase === 'verifying' || status?.phase === 'downloading';
  const state = working ? 'checking' : ready ? 'ready' : 'unavailable';
  const stateLabel = operation === 'clear' ? (zh ? '正在清理' : 'Clearing cache')
    : working ? (zh ? '正在检查' : 'Checking') : ready ? (zh ? '已就绪' : 'Ready') : (zh ? '资源异常' : 'Needs repair');
  const modelMiB = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(LOCAL_TEXT_EMBEDDING_MODEL.packageBytes / 1024 ** 2);
  const issue = error || (!working && !ready ? (zh ? '内置资源暂不可用，请验证与修复；仍有问题时请修复应用安装。' : 'Bundled files are unavailable. Verify and repair them, or repair the app installation.') : '');

  return <article className="local-embedding-settings" role="listitem" aria-label={zh ? '内置多模态向量服务' : 'Built-in multimodal embeddings'} aria-busy={working}>
    <div className="local-embedding-settings__identity">
      <span className="local-embedding-settings__icon" aria-hidden="true"><Icon name="layers" size={20} /></span>
      <div className="local-embedding-settings__copy">
        <div className="local-embedding-settings__name"><strong>{LOCAL_TEXT_EMBEDDING_MODEL.name}</strong><span>{zh ? '内置 · 多模态' : 'Built-in · Multimodal'}</span></div>
        <p>{zh ? '文本、图片、音频和视频，本地共用于资产搜索与伙伴记忆。' : 'Local text, image, audio and video embeddings for asset search and companion memory.'}</p>
      </div>
      <span className="local-embedding-settings__status" data-state={state} role="status"><Icon name={working ? 'clock' : ready ? 'check' : 'alert-circle'} size={14} />{stateLabel}</span>
    </div>
    <div className="local-embedding-settings__footer">
      <span className="local-embedding-settings__facts" title={zh ? '模型文件的磁盘大小，不代表运行内存。随应用提供；按需启动，自动使用可用显卡或 CPU。' : 'Model file size on disk, not runtime memory. Bundled with the app; starts on demand using an available GPU or CPU.'}>
        {LOCAL_TEXT_EMBEDDING_MODEL.dimension} {zh ? '维' : 'dimensions'}<span aria-hidden="true">·</span>{zh ? '约 ' : '~'}{modelMiB} MiB<Icon name="info" size={13} />
      </span>
      <div className="local-embedding-settings__actions">
        <Button disabled={working} loading={operation === 'repair'} onClick={() => { void run('repair'); }}>{zh ? '验证与修复' : 'Verify and repair'}</Button>
        <Button variant="quiet" disabled={working || !ready} loading={operation === 'clear'} onClick={() => { void run('clear'); }}>{zh ? '清理运行缓存' : 'Clear runtime cache'}</Button>
      </div>
    </div>
    {issue && <p className="local-embedding-settings__error" role="alert"><Icon name="alert-circle" size={14} />{issue}</p>}
  </article>;
}

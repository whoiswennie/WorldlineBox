import { useEffect, useRef, useState } from 'react';
import type { DshLauncherState, DshPack } from '../../shared/dsh-launcher';
import type { DshPackDistribution } from '../../shared/dsh-pack-distribution';
import { formatBytes } from '../format-file-meta';
import { useT } from '../i18n';
import { Button, Select, TextField } from '../ui';
import type { LauncherRunRequest } from './DshLauncher';
import { LauncherDrawer } from './LauncherDrawer';
import { terminalExternalLink } from './terminal-stream';

/** URL import is deliberately reviewed before the separate import action. */
export function PackUrlImport({ run, disabled }: { readonly run: LauncherRunRequest; readonly disabled: boolean }) {
  const t = useT();
  const [url, setUrl] = useState('');
  const [review, setReview] = useState<{ url: string; manifest: DshPackDistribution }>();
  const [checking, setChecking] = useState(false);
  const requestId = useRef(0);
  useEffect(() => () => { requestId.current++; }, []);
  const inspect = async () => {
    const source = url.trim(); if (!terminalExternalLink(source)) return;
    const ticket = ++requestId.current; setChecking(true); setReview(undefined);
    try {
      const result = await run({ type: 'pack.inspect-url', manifestUrl: source });
      if (ticket === requestId.current && result.ok && result.packDistribution) setReview({ url: source, manifest: result.packDistribution });
    } finally { if (ticket === requestId.current) setChecking(false); }
  };
  return <section className="launcher-card launcher-pack-url" data-pack-url-import>
    <div className="launcher-card-heading"><div><h2>{t('launcher.packUrlImport')}</h2><p>{t('launcher.packUrlImportNote')}</p></div></div>
    <form className="launcher-pack-url-form" onSubmit={event => { event.preventDefault(); void inspect(); }}>
      <TextField label={t('launcher.packManifestUrl')} maxLength={4096} onChange={event => { requestId.current++; setChecking(false); setReview(undefined); setUrl(event.target.value); }} placeholder="https://…/pack-manifest.json" value={url} />
      <Button disabled={disabled || checking || !terminalExternalLink(url.trim())} iconName="check" type="submit">{t(checking ? 'launcher.packInspecting' : 'launcher.packInspectUrl')}</Button>
    </form>
    {review ? <LauncherDrawer title={t('launcher.packInspectUrl')} onClose={() => setReview(undefined)}><div className="launcher-pack-review" data-pack-url-review><div><strong>{review.manifest.name} · {review.manifest.version}</strong><span>DSH {review.manifest.runtime.version} · {formatBytes(review.manifest.archive.byteLength)}</span></div><dl className="launcher-paths"><div><dt>{t('launcher.packArchiveDigest')}</dt><dd className="launcher-mono">{review.manifest.archive.sha256}</dd></div><div><dt>{t('launcher.packLockedFiles')}</dt><dd>{review.manifest.lock.fileCount}</dd></div></dl><p className="launcher-help">{t('launcher.packVerifiedImportNote')}</p><Button disabled={disabled || checking || review.url !== url.trim()} iconName="upload" onClick={() => void run({ type: 'pack.import-url', manifestUrl: review.url })} variant="primary">{t('launcher.packImportReviewed')}</Button></div></LauncherDrawer> : null}
  </section>;
}

export function PackSharing({ pack, state, run, disabled }: { readonly pack: DshPack; readonly state: DshLauncherState; readonly run: LauncherRunRequest; readonly disabled: boolean }) {
  const t = useT();
  const [mode, setMode] = useState<'closed' | 'export' | 'publish'>('closed');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [repository, setRepository] = useState('');
  const [tag, setTag] = useState(`pack-${pack.version}`);
  const [title, setTitle] = useState(`${pack.name} ${pack.version}`);
  const [notes, setNotes] = useState('');
  const [token, setToken] = useState('');
  const [draft, setDraft] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const publications = (state.packPublications ?? []).filter(publication => publication.packId === pack.id);
  const publish = async () => {
    if (disabled || submitting || !repository.trim() || !tag.trim() || !token.trim()) return;
    setSubmitting(true);
    try {
      const result = await run({ type: 'pack.publish', packId: pack.id, repository: repository.trim(), tag: tag.trim(), token: token.trim(), title: title.trim(), notes, draft });
      if (result.ok) setToken('');
    } finally { setSubmitting(false); }
  };
  const openRelease = (value: string) => {
    const url = terminalExternalLink(value); if (!url) return;
    const shell = (window as Window & { worldlinebox?: { shell?: { openExternalUrl(url: string): Promise<unknown> } } }).worldlinebox?.shell;
    if (shell) void shell.openExternalUrl(url);
  };
  return <div className="launcher-pack-sharing" data-pack-sharing={pack.id}>
    <div className="launcher-actions"><Button aria-expanded={mode === 'export'} disabled={disabled} iconName="download" onClick={() => setMode(mode === 'export' ? 'closed' : 'export')} size="sm" variant="quiet">{t('launcher.packDistribute')}</Button><Button aria-expanded={mode === 'publish'} disabled={disabled} iconName="upload" onClick={() => setMode(mode === 'publish' ? 'closed' : 'publish')} size="sm" variant="quiet">{t('launcher.packPublish')}</Button></div>
    {mode !== 'closed' ? <LauncherDrawer title={t(mode === 'export' ? 'launcher.packDistribute' : 'launcher.packPublish')} onClose={() => setMode('closed')}>{mode === 'export' ? <form className="launcher-pack-share-form" onSubmit={event => { event.preventDefault(); void run({ type: 'pack.distribute', packId: pack.id, ...(downloadUrl.trim() ? { downloadUrl: downloadUrl.trim() } : {}) }); }}><h3>{t('launcher.packDistribute')}</h3><p className="launcher-help">{t('launcher.packDistributeNote')}</p><TextField label={t('launcher.packArchiveUrl')} maxLength={4096} onChange={event => setDownloadUrl(event.target.value)} placeholder="https://…/pack.dshpack" value={downloadUrl} /><div className="launcher-actions"><Button disabled={disabled || (!!downloadUrl.trim() && !terminalExternalLink(downloadUrl.trim()))} type="submit">{t('launcher.packChooseDistributionPath')}</Button></div></form> : mode === 'publish' ? <form autoComplete="off" className="launcher-pack-share-form" onSubmit={event => { event.preventDefault(); void publish(); }}><h3>{t('launcher.packPublish')}</h3><p className="launcher-help">{t('launcher.packPublishNote')}</p><div className="launcher-pack-publish-fields"><TextField label={t('launcher.packRepository')} maxLength={200} onChange={event => setRepository(event.target.value)} placeholder="owner/repository" value={repository} /><TextField label={t('launcher.packReleaseTag')} maxLength={100} onChange={event => setTag(event.target.value)} value={tag} /><TextField label={t('launcher.packReleaseTitle')} maxLength={200} onChange={event => setTitle(event.target.value)} value={title} /><Select label={t('launcher.packReleaseVisibility')} onValueChange={value => setDraft(value === 'draft')} options={[{ value: 'draft', label: t('launcher.packDraft') }, { value: 'published', label: t('launcher.packPublished') }]} value={draft ? 'draft' : 'published'} /></div><label className="launcher-pack-notes"><span>{t('launcher.packReleaseNotes')}</span><textarea maxLength={30000} onChange={event => setNotes(event.target.value)} rows={4} value={notes} /></label><TextField autoComplete="off" label={t('launcher.packGithubToken')} maxLength={1024} onChange={event => setToken(event.target.value)} type="password" value={token} /><p className="launcher-help">{t('launcher.packTokenNote')}</p><div className="launcher-actions"><Button disabled={disabled || submitting || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.trim()) || !tag.trim() || !token.trim()} iconName="upload" type="submit" variant="primary">{t(draft ? 'launcher.packCreateDraft' : 'launcher.packPublishNow')}</Button></div></form> : null}</LauncherDrawer> : null}
    {publications.length ? <div className="launcher-pack-publications"><h3>{t('launcher.packPublications')}</h3>{publications.slice().reverse().map(publication => <div key={`${publication.repository}:${publication.tag}:${publication.createdAt}`}><span>{publication.repository} · {publication.tag} <span className="launcher-badge">{t(publication.draft ? 'launcher.packDraft' : 'launcher.packPublished')}</span></span><Button disabled={!terminalExternalLink(publication.releaseUrl)} onClick={() => openRelease(publication.releaseUrl)} size="sm" variant="quiet">{t('launcher.packViewRelease')}</Button></div>)}</div> : null}
  </div>;
}

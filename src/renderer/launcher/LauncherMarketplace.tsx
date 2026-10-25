import { useCallback, useEffect, useRef, useState } from 'react';
import type { DshLauncherState } from '../../shared/dsh-launcher';
import type { DshMarketEntry, DshMarketPage, DshSkillInspection, DshSkillTarget } from '../../shared/dsh-marketplace';
import { useT } from '../i18n';
import { Button, Select, TextField } from '../ui';
import type { LauncherRunRequest } from './DshLauncher';
import { terminalExternalLink } from './terminal-stream';
import { InstancePluginControls } from './InstancePluginControls';
import { InstanceSkillControls } from './InstanceSkillControls';
import { InstanceManagementTarget } from './InstanceManagementTarget';
import { LauncherDrawer } from './LauncherDrawer';

const PAGE_SIZE = 24;
export function LauncherMarketplace(props: { readonly kind: 'plugin' | 'skill'; readonly state: DshLauncherState; readonly run: LauncherRunRequest; readonly disabled?: boolean }) {
  return <MarketBrowser key={props.kind} {...props} />;
}

function MarketBrowser({ kind, state, run, disabled = false }: { readonly kind: 'plugin' | 'skill'; readonly state: DshLauncherState; readonly run: LauncherRunRequest; readonly disabled?: boolean }) {
  const t = useT(); const cached = kind === 'plugin' ? state.marketplace?.plugins : state.marketplace?.skills;
  const [catalog, setCatalog] = useState<DshMarketPage | undefined>(cached);
  const catalogRef = useRef(cached);
  const [query, setQuery] = useState(cached?.query ?? ''); const [page, setPage] = useState(cached?.page ?? 1);
  const [loading, setLoading] = useState(false);
  const [targetId, setTargetId] = useState('');
  const [inspection, setInspection] = useState<DshSkillInspection | undefined>();
  const [inspecting, setInspecting] = useState(false);
  const [skillQuery, setSkillQuery] = useState('');
  const [showInstalled, setShowInstalled] = useState(false);
  const requestId = useRef(0); const inspectId = useRef(0);
  useEffect(() => { catalogRef.current = catalog; }, [catalog]);
  const load = useCallback(async (refresh = false) => {
    const previous = catalogRef.current;
    const age = previous?.fetchedAt ? Date.now() - Date.parse(previous.fetchedAt) : 0;
    if (!refresh && previous && !previous.stale && !(age > 30 * 60_000) && previous.query === query && previous.page === page) return;
    const ticket = ++requestId.current; setLoading(true);
    try {
      const response = await run({ type: 'market.search', kind, query, page, pageSize: PAGE_SIZE, refresh });
      if (ticket !== requestId.current) return;
      if (response.ok && response.marketPage) setCatalog(response.marketPage);
    } finally { if (ticket === requestId.current) setLoading(false); }
  }, [kind, page, query, run]);
  useEffect(() => {
    const requests = requestId;
    const timer = setTimeout(() => { void load(); }, query ? 250 : 0);
    return () => { clearTimeout(timer); requests.current++; };
  }, [load, query]);
  useEffect(() => () => { inspectId.current++; }, []);
  const target = state.instances.find(instance => instance.id === targetId);
  const changing = state.operations.some(operation => operation.status === 'running' && operation.instanceId === targetId);
  const locked = disabled || changing || !target || ['starting', 'stopping'].includes(target.status);
  const inspect = async (entry: DshMarketEntry) => {
    if (!entry.repository) return;
    setShowInstalled(false);
    const ticket = ++inspectId.current; setInspecting(true); setInspection(undefined); setSkillQuery('');
    try {
      const response = await run({ type: 'skill.inspect', repository: entry.repository });
      if (ticket === inspectId.current && response.ok && response.skillInspection) setInspection(response.skillInspection);
    } finally { if (ticket === inspectId.current) setInspecting(false); }
  };
  const installSkill = async (skill: DshSkillTarget) => {
    if (locked || !targetId) return;
    await run({ type: 'skill.install', instanceId: targetId, target: skill });
  };
  const openSource = (value: string) => {
    const url = terminalExternalLink(value); if (!url) return;
    const shell = (window as Window & { worldlinebox?: { shell?: { openExternalUrl(url: string): Promise<unknown> } } }).worldlinebox?.shell;
    if (shell) void shell.openExternalUrl(url);
  };
  const maxPage = Math.max(1, Math.ceil((catalog?.total ?? 0) / (catalog?.pageSize ?? PAGE_SIZE)));
  const availableSkills = (inspection?.targets ?? []).filter(skill => `${skill.name} ${skill.description} ${skill.sourcePath}`.toLowerCase().includes(skillQuery.toLowerCase())).slice(0, 60);
  const closeInspection = () => { inspectId.current++; setInspecting(false); setInspection(undefined); };
  const chooseTarget = (id: string) => { setTargetId(id); closeInspection(); setShowInstalled(false); };
  return <div className="launcher-page launcher-marketplace-page" data-dsh-market={kind}>
    <div className="launcher-page-heading"><div><h1>{t(kind === 'plugin' ? 'launcher.pluginMarket' : 'launcher.skillMarket')}</h1><p>{t(kind === 'plugin' ? 'launcher.pluginMarketNote' : 'launcher.skillMarketNote')}</p></div><div className="launcher-actions"><Button disabled={!targetId} iconName={kind === 'plugin' ? 'grid' : 'smart'} onClick={() => { closeInspection(); setShowInstalled(true); }} size="sm" variant="quiet">{t(kind === 'plugin' ? 'launcher.installedPlugins' : 'launcher.installedSkills')}</Button><Button disabled={disabled || loading} iconName="refresh" onClick={() => void load(true)} variant="quiet">{t('launcher.refreshCatalog')}</Button></div></div>
    <section className="launcher-card launcher-market-target"><Select label={t('launcher.marketTarget')} disabled={disabled} onValueChange={chooseTarget} options={[{ value: '', label: t('launcher.marketChooseTarget') }, ...state.instances.map(instance => ({ value: instance.id, label: `${instance.name} · DSH ${state.runtimes.find(runtime => runtime.id === instance.runtimeId)?.version ?? instance.runtimeId}` }))]} value={targetId} /><div><InstanceManagementTarget state={state} instanceId={targetId} /><p className="launcher-help">{target && ['starting', 'stopping'].includes(target.status) ? t('launcher.marketStopTarget') : t('launcher.marketTargetNote')}</p></div></section>
    <div className="launcher-market-search"><TextField aria-label={t('launcher.searchCatalog')} onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder={t(kind === 'plugin' ? 'launcher.searchPlugins' : 'launcher.searchSkills')} value={query} /><span aria-live="polite">{loading ? t('launcher.searchingCatalog') : t('launcher.catalogResultCount', { count: catalog?.total ?? 0 })}{catalog?.stale ? ` · ${t('launcher.catalogCached')}` : ''}</span></div>
    {showInstalled && target ? <LauncherDrawer title={t(kind === 'plugin' ? 'launcher.installedPlugins' : 'launcher.installedSkills')} description={`${target.name} · DSH ${state.runtimes.find(runtime => runtime.id === target.runtimeId)?.version ?? target.runtimeId}`} onClose={() => setShowInstalled(false)}>{kind === 'plugin' ? <InstancePluginControls key={targetId} state={state} instanceId={targetId} run={run} disabled={disabled} /> : <InstanceSkillControls key={targetId} state={state} instanceId={targetId} run={run} disabled={disabled} />}</LauncherDrawer> : null}
    {inspecting || inspection ? <LauncherDrawer title={t('launcher.chooseRepositorySkill')} description={inspection ? `${inspection.repository} · ${inspection.commit.slice(0, 12)}` : t('launcher.inspectingSkills')} onClose={closeInspection}><section className="launcher-skill-inspection" aria-busy={inspecting}><InstanceManagementTarget state={state} instanceId={targetId} />{inspection ? <><TextField aria-label={t('launcher.filterRepositorySkills')} onChange={event => setSkillQuery(event.target.value)} placeholder={t('launcher.filterRepositorySkills')} value={skillQuery} /><p className="launcher-help">{t('launcher.skillPinnedSourceNote')}</p><div className="launcher-skill-targets">{availableSkills.map(skill => <article key={skill.sourcePath}><div><strong>{skill.name}</strong><p>{skill.description}</p><code>{skill.sourcePath}</code></div><Button disabled={locked} onClick={() => void installSkill(skill)} size="sm" variant="primary">{target ? t('launcher.installIntoNamedInstance', { name: target.name }) : t('launcher.installSkill')}</Button></article>)}</div>{inspection.targets.length > availableSkills.length ? <p className="launcher-help">{t('launcher.skillRefineSearch')}</p> : null}</> : <div className="launcher-drawer-loading" role="status"><span className="launcher-loading-indicator" />{t('launcher.inspectingSkills')}</div>}</section></LauncherDrawer> : null}
    {catalog?.entries.length ? <div className="launcher-market-grid" aria-busy={loading}>{catalog.entries.map(entry => <article className="launcher-card launcher-market-card" data-market-entry={entry.id} key={entry.id}><div className="launcher-market-card-title"><strong>{entry.name}</strong><span>{entry.category}</span></div><p className="launcher-market-description">{entry.description || t('launcher.noCatalogDescription')}</p><div className="launcher-market-entry-meta">{entry.repository ? <span>{entry.repository}</span> : null}{entry.version ? <span>v{entry.version}</span> : null}<span>{t('launcher.catalogDownloads', { count: entry.downloads.toLocaleString() })}</span></div>{entry.riskLabels.length ? <div className="launcher-market-tags">{entry.riskLabels.map(label => <span key={label}>{label}</span>)}</div> : null}<div className="launcher-actions"><Button disabled={!entry.sourceUrl} onClick={() => openSource(entry.sourceUrl)} size="sm" variant="quiet">{t('launcher.viewCatalogSource')}</Button>{kind === 'plugin' ? <Button disabled={locked || !entry.npmName} iconName="plus" onClick={() => void run({ type: 'market.plugin.install', instanceId: targetId, entryId: entry.id })} size="sm">{t(entry.npmName ? 'launcher.installPluginToTarget' : 'launcher.sourceOnlyPlugin')}</Button> : <Button disabled={disabled || inspecting || !entry.repository} onClick={() => void inspect(entry)} size="sm">{t('launcher.chooseSkill')}</Button>}</div></article>)}</div> : <div className="launcher-catalog-empty"><strong>{t(loading ? 'launcher.loadingCatalog' : 'launcher.emptyCatalog')}</strong><p>{t(catalog?.error ? 'launcher.catalogUnavailable' : 'launcher.catalogSearchHint')}</p></div>}
    {maxPage > 1 ? <div className="launcher-catalog-pagination"><Button disabled={loading || page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))} size="sm">{t('launcher.previousPage')}</Button><span>{catalog?.page ?? page} / {maxPage}</span><Button disabled={loading || page >= maxPage} onClick={() => setPage(value => value + 1)} size="sm">{t('launcher.nextPage')}</Button></div> : null}
    {catalog?.error && catalog.entries.length ? <p className="launcher-help">{t('launcher.catalogUnavailable')}</p> : null}
  </div>;
}

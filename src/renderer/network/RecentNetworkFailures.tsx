import { useState } from 'react';
import type { ApplicationNetworkState } from '../../shared/application-network';
import { useT } from '../i18n';
import { Button, TextField } from '../ui';
import type { NetworkRunRequest } from './NetworkSettings';

const pageSize = 10;

export function RecentNetworkFailures({ network, run }: { readonly network: ApplicationNetworkState; readonly run: NetworkRunRequest }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState('');
  const failures = network.recentFailures ?? [];
  const needle = query.trim().toLocaleLowerCase();
  const filtered = failures.filter(failure => !needle || [failure.origin, failure.error, failure.resourceType, failure.module].join(' ').toLocaleLowerCase().includes(needle));
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const clear = async () => {
    setClearing(true); setError('');
    try {
      const response = await run({ type: 'network.diagnostics.clear' });
      if (!response.ok) setError(response.error);
      else { setPage(0); setQuery(''); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setClearing(false); }
  };
  return <section className="launcher-card" data-network-failures>
    <div className="launcher-card-heading"><div><h2>{t('appNetwork.failures')}</h2><p>{t('appNetwork.failuresNote')}</p></div><Button size="sm" variant="quiet" disabled={clearing || !failures.length} loading={clearing} iconName="trash" onClick={() => void clear()}>{t('appNetwork.clearFailures')}</Button></div>
    <p className="launcher-help">{t('appNetwork.failuresHelp')}</p>
    {error ? <p className="launcher-network-error" role="alert">{error}</p> : null}
    {failures.length ? <TextField label={t('appNetwork.searchFailures')} type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /> : null}
    <ul className="application-network-failures">{filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(failure => <li key={failure.id}>
      <div><code>{failure.origin}</code><span className="launcher-badge">{t(failure.resourceType === 'mainFrame' ? 'appNetwork.failureMain' : 'appNetwork.failureResource')}</span><time dateTime={failure.occurredAt}>{new Date(failure.occurredAt).toLocaleString()}</time></div>
      <p><code>{failure.error}</code> · {failure.resourceType} · {t('appNetwork.failureCount', { count: failure.count })}</p>
    </li>)}</ul>
    {!filtered.length ? <p className="launcher-help">{t(needle ? 'appNetwork.failuresNoMatch' : 'appNetwork.failuresEmpty')}</p> : null}
    {filtered.length > pageSize ? <div className="launcher-catalog-pagination"><span>{t('appNetwork.failurePage', { page: currentPage + 1, pages, count: filtered.length })}</span><Button size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t('launcher.previousPage')}</Button><Button size="sm" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>{t('launcher.nextPage')}</Button></div> : null}
  </section>;
}

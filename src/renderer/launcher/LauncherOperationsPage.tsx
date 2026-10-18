import { useMemo, useRef, useState } from 'react';
import { isDshOperationTerminal, type DshLauncherState, type DshOperation } from '../../shared/dsh-launcher';
import { useT } from '../i18n';
import { Button, Select, TextField } from '../ui';
import type { LauncherRunRequest } from './DshLauncher';
import { OperationControls } from './OperationControls';

export const OPERATIONS_PAGE_SIZE = 20;
type OperationStatus = 'all' | DshOperation['status'];
const statuses: readonly OperationStatus[] = ['all', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled'];
function formatStartedAt(value: string): string {
  const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function LauncherOperationsPage({ state, disabled, run }: { readonly state: DshLauncherState; readonly disabled: boolean; readonly run: LauncherRunRequest }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<OperationStatus>('all');
  const [page, setPage] = useState(0);
  const pageRoot = useRef<HTMLDivElement>(null);
  const matching = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const instances = new Map(state.instances.map(instance => [instance.id, instance.name]));
    return state.operations.filter(operation => {
      if (status !== 'all' && operation.status !== status) return false;
      if (!terms.length) return true;
      const text = [operation.label, operation.kind, operation.instanceId, instances.get(operation.instanceId ?? ''), operation.error, operation.status, t(`launcher.operationStatus.${operation.status}`), operation.phase].filter(Boolean).join(' ').toLocaleLowerCase();
      return terms.every(term => text.includes(term));
    });
  }, [query, state.instances, state.operations, status, t]);
  const pages = Math.max(1, Math.ceil(matching.length / OPERATIONS_PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  // Clearing records or receiving new state can remove the current final page.
  // Commit the correction so adding records later cannot revive a stale page.
  if (currentPage !== page) setPage(currentPage);
  const start = currentPage * OPERATIONS_PAGE_SIZE;
  const entries = matching.slice(start, start + OPERATIONS_PAGE_SIZE);
  const filtered = !!query || status !== 'all';
  const clearFilters = () => { setQuery(''); setStatus('all'); setPage(0); };
  const changePage = (next: number) => { setPage(next); pageRoot.current?.scrollIntoView?.({ block: 'start' }); };
  return <div className="launcher-page launcher-operations-page" ref={pageRoot}>
    <div className="launcher-page-heading"><div><h1>{t('launcher.operations')}</h1><p>{t('launcher.operationNote')}</p><p>{t('launcher.operationHistoryNote')}</p></div><Button disabled={disabled || !state.operations.some(isDshOperationTerminal)} iconName="trash" onClick={() => void run({ type: 'operation.clear-finished' })} variant="quiet">{t('launcher.clearFinishedOperations')}</Button></div>
    <div className="launcher-operations-toolbar">
      <TextField aria-label={t('launcher.searchOperations')} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder={t('launcher.searchOperationsPlaceholder')} value={query} />
      <Select aria-label={t('launcher.filterOperationStatus')} onValueChange={value => { setStatus(value as OperationStatus); setPage(0); }} options={statuses.map(value => ({ value, label: t(value === 'all' ? 'launcher.allOperationStatuses' : `launcher.operationStatus.${value}`) }))} value={status} />
      {filtered ? <Button onClick={clearFilters} size="sm" variant="quiet">{t('launcher.clearOperationFilters')}</Button> : null}
    </div>
    <div className="launcher-operations-meta" aria-live="polite">{t('launcher.operationResultRange', { start: entries.length ? start + 1 : 0, end: start + entries.length, count: matching.length, total: state.operations.length })}</div>
    {entries.length ? entries.map(operation => <section className="launcher-card launcher-operation" data-dsh-operation={operation.id} key={operation.id}>
      <div className="launcher-card-heading"><div><h2>{operation.label}</h2><span className={`launcher-operation-status is-${operation.status}`}>{t(`launcher.operationStatus.${operation.status}`)}</span></div></div>
      <OperationControls operation={operation} run={run} />
      <p className="launcher-help">{t('launcher.startedAt')}: {formatStartedAt(operation.startedAt)}</p>
      {operation.error ? <pre className="launcher-command-output is-error">{operation.error}</pre> : null}
    </section>) : <div className="launcher-inline-empty">{t(state.operations.length ? 'launcher.noMatchingOperations' : 'launcher.noOperations')}</div>}
    {pages > 1 ? <nav className="launcher-catalog-pagination" aria-label={t('launcher.operationPages')}>
      <Button disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)} size="sm">{t('launcher.previousPage')}</Button>
      <span>{t('launcher.operationPageNumber', { page: currentPage + 1, pages })}</span>
      <Button disabled={currentPage + 1 >= pages} onClick={() => changePage(currentPage + 1)} size="sm">{t('launcher.nextPage')}</Button>
    </nav> : null}
  </div>;
}

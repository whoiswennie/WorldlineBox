import { useMemo, useRef, useState } from 'react';
import { isDshOperationTerminal, type DshLauncherState, type DshOperation } from '../../shared/dsh-launcher';
import { useT, type TranslateFn } from '../i18n';
import { Button, TextField } from '../ui';
import { Icon } from '../Icons';
import type { LauncherRunRequest } from './DshLauncher';
import { OperationControls } from './OperationControls';

export const OPERATIONS_PAGE_SIZE = 20;
type OperationStatus = 'all' | DshOperation['status'];
const statuses: readonly OperationStatus[] = ['all', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled'];
function formatStartedAt(value: string): string {
  const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
function operationTitle(t: TranslateFn, operation: DshOperation): string {
  if (operation.label !== operation.kind && operation.kind !== 'versions.refresh') return operation.label;
  const key = `launcher.operationKinds.${operation.kind.replaceAll('.', '-')}`;
  const label = t(key);
  return label === key ? operation.label : label;
}

export function LauncherOperationsPage({ state, disabled, run }: { readonly state: DshLauncherState; readonly disabled: boolean; readonly run: LauncherRunRequest }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<OperationStatus>('all');
  const [page, setPage] = useState(0);
  const pageRoot = useRef<HTMLDivElement>(null);
  const instances = useMemo(() => new Map(state.instances.map(instance => [instance.id, instance.name])), [state.instances]);
  const counts = useMemo(() => {
    const totals: Record<OperationStatus, number> = { all: state.operations.length, running: 0, succeeded: 0, failed: 0, interrupted: 0, cancelled: 0 };
    for (const operation of state.operations) totals[operation.status]++;
    return totals;
  }, [state.operations]);
  const matching = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return state.operations.filter(operation => {
      if (status !== 'all' && operation.status !== status) return false;
      if (!terms.length) return true;
      const text = [operationTitle(t, operation), operation.label, operation.kind, operation.instanceId, instances.get(operation.instanceId ?? ''), operation.error, operation.status, t(`launcher.operationStatus.${operation.status}`), operation.phase].filter(Boolean).join(' ').toLocaleLowerCase();
      return terms.every(term => text.includes(term));
    });
  }, [query, instances, state.operations, status, t]);
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
    <div className="launcher-page-heading"><h1>{t('launcher.operations')}</h1><Button disabled={disabled || !state.operations.some(isDshOperationTerminal)} iconName="trash" onClick={() => void run({ type: 'operation.clear-finished' })} variant="quiet">{t('launcher.clearFinishedOperations')}</Button></div>
    <div className="launcher-operations-toolbar">
      <div className="launcher-operation-filters" role="group" aria-label={t('launcher.filterOperationStatus')}>
        {statuses.map(value => <button key={value} type="button" data-operation-filter={value} aria-pressed={status === value} onClick={() => { setStatus(value); setPage(0); }}>
          {t(value === 'all' ? 'launcher.operationAll' : `launcher.operationStatus.${value}`)}
          <span>{counts[value]}</span>
        </button>)}
      </div>
      <div className="launcher-operations-search">
        <TextField aria-label={t('launcher.searchOperations')} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder={t('launcher.searchOperations')} startAdornment={<Icon name="search" size={16} />} value={query} />
        {filtered ? <Button onClick={clearFilters} size="sm" variant="quiet">{t('launcher.clearOperationFilters')}</Button> : null}
      </div>
    </div>
    <div className="launcher-operations-results">
      <div className="launcher-operations-meta" aria-live="polite">
        {t('launcher.operationResultRange', { start: entries.length ? start + 1 : 0, end: start + entries.length, count: matching.length, total: state.operations.length })}
      </div>
      {pages > 1 ? <nav className="launcher-operation-pagination" aria-label={t('launcher.operationPages')}>
        <Button disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)} size="sm">{t('launcher.previousPage')}</Button>
        <span>{t('launcher.operationPageNumber', { page: currentPage + 1, pages })}</span>
        <Button disabled={currentPage + 1 >= pages} onClick={() => changePage(currentPage + 1)} size="sm">{t('launcher.nextPage')}</Button>
      </nav> : null}
    </div>
    {entries.length ? <div className="launcher-operation-list">
      <div className="launcher-operation-columns" aria-hidden="true">
        <span>{t('launcher.operationColumn')}</span><span>{t('launcher.filterOperationStatus')}</span><span>{t('launcher.startedAt')}</span>
      </div>
      {entries.map(operation => {
        const instance = operation.instanceId ? instances.get(operation.instanceId) : undefined;
        const icon = operation.kind.startsWith('instance.') ? 'box' : operation.kind.startsWith('runtime.') ? 'download' : operation.kind.startsWith('pack.') || operation.kind.startsWith('snapshot.') ? 'archive' : 'refresh';
        return <article className="launcher-operation" data-dsh-operation={operation.id} key={operation.id}>
          <div className="launcher-operation-identity">
            <span className="launcher-operation-icon"><Icon name={icon} size={17} /></span>
            <div><h2>{operationTitle(t, operation)}</h2>{instance ? <span className="launcher-operation-instance">{instance}</span> : null}</div>
          </div>
          <span className={`launcher-operation-status is-${operation.status}`}>{t(`launcher.operationStatus.${operation.status}`)}</span>
          <time className="launcher-operation-time" dateTime={operation.startedAt} title={t('launcher.startedAt')}>{formatStartedAt(operation.startedAt)}</time>
          {(operation.status === 'running' || (operation.retryRequest && operation.status !== 'succeeded')) ? <OperationControls operation={operation} run={run} showTerminalPhase={false} /> : null}
          {operation.error ? <div className="launcher-operation-error"><Icon name="alert-circle" size={15} /><span>{operation.error}</span></div> : null}
        </article>;
      })}</div> : <div className="launcher-inline-empty">{t(state.operations.length ? 'launcher.noMatchingOperations' : 'launcher.noOperations')}</div>}
  </div>;
}

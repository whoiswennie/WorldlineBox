import { useCallback, useEffect, useState } from 'react';
import type { ApplicationNetworkState, WorldlineBoxApplicationNetworkApi } from '../../shared/application-network';
import { Icon } from '../Icons';
import { useT } from '../i18n';
import { Button } from '../ui';
import { NetworkSettings, type NetworkRunRequest } from './NetworkSettings';
import '../launcher/launcher.css';
import './application-network.css';

/** This module connects directly to the application network service, without activating DSH or Assets. */
export function ApplicationNetworkPage({ api }: { readonly api?: WorldlineBoxApplicationNetworkApi }) {
  const t = useT();
  const [network, setNetwork] = useState<ApplicationNetworkState>();
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const accept = useCallback((next: ApplicationNetworkState) => {
    setNetwork(previous => previous && previous.revision > next.revision ? previous : next);
  }, []);
  const run = useCallback<NetworkRunRequest>(async request => {
    if (!api) return { ok: false, error: t('appNetwork.unavailable') };
    try {
      const response = await api.request(request);
      if (response.ok && response.state) accept(response.state);
      return response;
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : t('launcher.errorFallback') };
    }
  }, [api, accept, t]);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    const result = await run({ type: 'state' });
    setError(result.ok ? '' : result.error);
    setRefreshing(false);
  }, [run]);
  useEffect(() => {
    if (!api) return;
    let active = true;
    const unsubscribe = api.onChanged(next => { if (active) accept(next); });
    void api.request({ type: 'state' }).then(result => {
      if (!active) return;
      if (result.ok && result.state) accept(result.state);
      else if (!result.ok) setError(result.error);
    }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : t('launcher.errorFallback')); });
    return () => { active = false; unsubscribe(); };
  }, [api, accept, t]);
  return <section className="application-network" aria-label={t('appNavigation.network')} data-application-network>
    <header className="launcher-titlebar">
      <div className="launcher-titlebar-heading"><Icon name="network" size={19} /><strong>{t('appNavigation.network')}</strong><span>{t('appNetwork.subtitle')}</span></div>
      <Button disabled={!api || refreshing} loading={refreshing} iconName="refresh" onClick={() => void refresh()} variant="quiet">{t('launcher.refresh')}</Button>
    </header>
    <main className="launcher-main">
      {error ? <div className="launcher-page"><p className="launcher-network-error" role="alert">{error}</p></div> : null}
      {!api ? <div className="launcher-page"><h1>{t('appNavigation.network')}</h1><p role="status">{t('appNetwork.unavailable')}</p></div>
        : !network && error ? null : <NetworkSettings network={network} run={run} />}
    </main>
  </section>;
}

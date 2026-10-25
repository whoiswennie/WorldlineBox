import { useCallback, useEffect, useRef, useState } from 'react';
import type { DshLauncherState } from '../../shared/dsh-launcher';
import type { DshInstalledPlugin } from '../../shared/dsh-plugins';
import { useT } from '../i18n';
import { Button } from '../ui';
import type { LauncherRunRequest } from './DshLauncher';
import { terminalExternalLink } from './terminal-stream';
import { InstanceManagementTarget } from './InstanceManagementTarget';

export function InstancePluginControls({ state, instanceId, run, disabled = false }: {
  readonly state: DshLauncherState; readonly instanceId: string; readonly run: LauncherRunRequest; readonly disabled?: boolean;
}) {
  const t = useT(); const [inventory, setInventory] = useState<{ instanceId: string; plugins: DshInstalledPlugin[] }>({ instanceId: '', plugins: [] });
  const plugins = inventory.instanceId === instanceId ? inventory.plugins : [];
  const [loading, setLoading] = useState(false); const ticket = useRef(0);
  const instance = state.instances.find(item => item.id === instanceId);
  const revision = state.operations.filter(operation => operation.instanceId === instanceId && ['instance.plugin', 'instance.plugin-toggle', 'market.plugin.install'].includes(operation.kind) && operation.status !== 'running').map(operation => `${operation.id}:${operation.status}`).join('|');
  const locked = disabled || !instance || ['starting', 'stopping'].includes(instance.status) || state.operations.some(operation => operation.status === 'running' && operation.instanceId === instanceId);
  const load = useCallback(async () => {
    const request = ++ticket.current; setLoading(true);
    try {
      const response = await run({ type: 'instance.plugins', instanceId });
      if (request === ticket.current && response.ok && response.installedPlugins) setInventory({ instanceId, plugins: response.installedPlugins });
    } finally { if (request === ticket.current) setLoading(false); }
  }, [instanceId, run]);
  useEffect(() => {
    const requests = ticket;
    const timer = setTimeout(() => { void load(); }, 0);
    return () => { clearTimeout(timer); requests.current++; };
  }, [load, revision]);
  const mutate = async (plugin: DshInstalledPlugin, remove: boolean) => {
    if (locked || plugin.core) return;
    const response = await run(remove ? { type: 'instance.plugin', instanceId, action: 'remove', spec: plugin.name } : { type: 'instance.plugin-toggle', instanceId, name: plugin.name, enabled: !plugin.enabled });
    if (response.ok && !response.operationId) await load();
  };
  const openSource = (value: string) => {
    const url = terminalExternalLink(value); if (!url) return;
    const shell = (window as Window & { worldlinebox?: { shell?: { openExternalUrl(url: string): Promise<unknown> } } }).worldlinebox?.shell;
    if (shell) void shell.openExternalUrl(url);
  };
  return <section className="launcher-card launcher-installed-plugins" data-installed-plugins={instanceId}>
    <div className="launcher-card-heading"><div><h2>{t('launcher.installedPlugins')}</h2><p>{instance?.name} · {t('launcher.pluginToggleNote')}</p></div><Button disabled={loading || disabled} iconName="refresh" onClick={() => void load()} size="sm" variant="quiet">{t('launcher.refresh')}</Button></div>
    <InstanceManagementTarget state={state} instanceId={instanceId} />
    {plugins.length ? plugins.map(plugin => <div className="launcher-installed-skill" data-installed-plugin={plugin.name} key={plugin.name}><div><strong>{plugin.name}{plugin.version ? ` · ${plugin.version}` : ''}</strong><p>{plugin.description}</p><span>{t(plugin.core ? 'launcher.pluginCore' : !plugin.bundle ? 'launcher.pluginDependency' : plugin.enabled ? 'launcher.skillEnabled' : 'launcher.skillDisabled')}</span><span>{t(plugin.scope === 'runtime' ? 'launcher.pluginRuntimeSource' : 'launcher.pluginInstanceSource')} · {plugin.spec}</span>{plugin.installPath ? <code title={plugin.installPath}>{plugin.installPath}</code> : null}{plugin.error ? <p className="launcher-help">{plugin.error}</p> : null}</div><div className="launcher-actions">{plugin.sourceUrl ? <Button disabled={!terminalExternalLink(plugin.sourceUrl)} onClick={() => openSource(plugin.sourceUrl!)} size="sm" variant="quiet">{t('launcher.viewCatalogSource')}</Button> : null}{plugin.bundle && !plugin.core && plugin.toggleable !== false ? <Button disabled={locked} onClick={() => void mutate(plugin, false)} size="sm" variant="quiet">{t(plugin.enabled ? 'launcher.disableSkill' : 'launcher.enableSkill')}</Button> : null}{!plugin.core && plugin.removable !== false && plugin.scope !== 'runtime' ? <Button disabled={locked} iconName="trash" onClick={() => void mutate(plugin, true)} size="sm" variant="quiet">{t('launcher.removeSkill')}</Button> : null}</div></div>) : <p className="launcher-help">{t(loading ? 'launcher.loadingPlugins' : 'launcher.noInstalledPlugins')}</p>}
  </section>;
}

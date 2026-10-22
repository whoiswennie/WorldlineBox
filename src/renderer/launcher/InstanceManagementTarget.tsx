import type { DshLauncherState } from '../../shared/dsh-launcher';
import { useT } from '../i18n';

/** Keep the instance and its pinned runtime visible beside every package management action. */
export function InstanceManagementTarget({ state, instanceId }: { readonly state: DshLauncherState; readonly instanceId: string }) {
  const t = useT(); const instance = state.instances.find(item => item.id === instanceId);
  if (!instance) return <p className="launcher-help">{t('launcher.marketChooseTarget')}</p>;
  const runtime = state.runtimes.find(item => item.id === instance.runtimeId);
  return <div className="launcher-management-target" data-management-target={instance.id}>
    <strong>{t('launcher.managementTarget', { name: instance.name })} · DSH {runtime?.version ?? instance.runtimeId}</strong>
    <span>{instance.id} · {runtime?.id ?? instance.runtimeId}</span>
    <code>{instance.homePath}</code>
  </div>;
}

import type { DshInstance } from '../../shared/dsh-launcher';
import type { DshInstalledPlugin } from '../../shared/dsh-plugins';
import type { NativeHostClient } from './native-host-client';

/** All plugin state and mutations come from DSH's native manager. */
export class PluginControls {
  constructor(private readonly host: (id: string) => Promise<NativeHostClient>) {}
  async listPlugins(instance: DshInstance): Promise<DshInstalledPlugin[]> {
    const client = await this.host(instance.id);
    const bundles = await client.request<Array<{ name: string; version?: string; description?: string; enabled: boolean; installed: boolean; removable: boolean; readOnlyReason?: string; error?: unknown }>>('/plugins', { action: 'list' });
    return bundles.map(bundle => ({ name: bundle.name, spec: bundle.name, version: bundle.version, description: bundle.description ?? '',
      enabled: bundle.enabled, bundle: true, core: !!bundle.readOnlyReason || bundle.name === '@worldlinebox/dsh-bridge',
      removable: bundle.removable && bundle.name !== '@worldlinebox/dsh-bridge', toggleable: !bundle.readOnlyReason && bundle.name !== '@worldlinebox/dsh-bridge',
      scope: bundle.installed ? 'instance' : 'runtime', ...(bundle.error ? { error: JSON.stringify(bundle.error) } : {}) }));
  }
  async setPluginEnabled(instance: DshInstance, name: string, enabled: boolean, signal?: AbortSignal): Promise<{ application: string; error?: unknown }> {
    if (name === '@worldlinebox/dsh-bridge') throw new Error('The native Host bridge is required for partner sessions.');
    const client = await this.host(instance.id);
    const result = await client.request<{ application: string; error?: unknown }>('/plugins', { action: 'toggle', spec: name, enabled }, signal);
    if (result.application === 'failed' || result.application === 'cancelled') throw new Error(JSON.stringify(result.error ?? result));
    return result;
  }
}

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { DshInstance } from '../../shared/dsh-launcher';
import type { CabinWorld } from '../cabin-world';
import { atomicJson, readJson } from './files';
import type { NativeHostClient } from './native-host-client';

const name = '@worldlinebox/dsh-cabin-world';

export async function connectCabinPlugin(input: {
  instance: DshInstance; cabin: Pick<CabinWorld, 'bridgeJson' | 'toolDefinitions'>; packagePath: string;
  ensureHost(): Promise<NativeHostClient>; recordChange(result: { application?: string }): Promise<void>;
}) {
  const { instance, cabin, packagePath } = input;
  const file = path.join(instance.homePath, 'plugin-data', 'worldlinebox-cabin-world', 'config.json');
  const desired = { bridgeJson: cabin.bridgeJson, toolDefinitions: cabin.toolDefinitions };
  const current = await readJson<typeof desired>(file);
  const changed = current?.bridgeJson !== desired.bridgeJson || current?.toolDefinitions !== desired.toolDefinitions;
  const profile = path.join(instance.homePath, 'profiles', 'web', 'node_modules', '@worldlinebox', 'dsh-cabin-world', 'package.json');
  const installed = await readJson<{ version: string }>(profile);
  const bundled = await readJson<{ version: string }>(path.join(packagePath, 'package.json'));
  if (!bundled) throw Error('内置小屋世界 MCP 插件资源缺失。');
  if (changed) { await mkdir(path.dirname(file), { recursive: true }); await atomicJson(file, desired); }
  const client = await input.ensureHost();
  const apply = async (params: object) => {
    const result = await client.request<{ application?: string; error?: unknown }>('/plugins', params, undefined, 240000);
    await input.recordChange(result);
    if (result.application !== 'applied') throw Error(result.application === 'restart-required'
      ? '小屋世界插件已安装。请在启动器中重启默认 DSH 实例。'
      : `小屋世界插件状态 ${result.application ?? '未知'}。${result.error ? JSON.stringify(result.error) : ''}`);
  };
  if (installed?.version !== bundled.version) {
    await apply({ action: 'add', spec: 'file:' + packagePath.replaceAll('\\', '/') });
  }
  const plugins = await client.request<Array<{ name: string; enabled: boolean; error?: unknown }>>('/plugins', { action: 'list' });
  const plugin = plugins.find(item => item.name === name);
  if (!plugin) throw Error('DSH 找不到已安装的小屋世界插件。');
  const reload = (installed?.version === bundled.version && changed) || !!plugin.error;
  if (plugin.enabled && reload) await apply({ action: 'toggle', spec: name, enabled: false });
  if (!plugin.enabled || reload) await apply({ action: 'toggle', spec: name, enabled: true });
}

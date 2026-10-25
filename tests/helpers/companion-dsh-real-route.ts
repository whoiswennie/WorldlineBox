import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';

/** Resolve the explicitly authorized real account without persisting or printing its credential. */
export async function realDshAcceptanceRoute(root: string) {
  if (process.env.WORLDLINEBOX_DSH_REAL_ACCEPTANCE !== '1') throw new Error('DSH_REAL_ACCEPTANCE_NOT_AUTHORIZED');
  const configured = process.env.DEEPSEEK_API_KEY ? {
    apiKey: process.env.DEEPSEEK_API_KEY, apiFormat: 'anthropic' as const,
    model: process.env.WORLDLINEBOX_DSH_REAL_MODEL ?? 'deepseek-flash', baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/anthropic',
  } : await realGlobalChatConfig(root);
  const endpoint = new URL(configured.baseUrl || 'https://api.deepseek.com');
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('DSH_ACCEPTANCE_ENDPOINT_REQUIRES_A_PLAIN_BASE_URL');
  if (endpoint.hostname !== 'api.deepseek.com' && configured.apiFormat !== 'anthropic') throw new Error('DSH_ACCEPTANCE_GLOBAL_ROUTE_IS_NOT_MESSAGES_COMPATIBLE');
  const baseURL = endpoint.hostname === 'api.deepseek.com' ? 'https://api.deepseek.com/anthropic' : endpoint.href.replace(/\/$/, '');
  const model = process.env.WORLDLINEBOX_DSH_REAL_MODEL ?? configured.model;
  return { apiKey: configured.apiKey, model, baseURL,
    description: { source: process.env.DEEPSEEK_API_KEY ? 'explicit-environment' : 'existing-global-config-in-memory', configuredFormat: configured.apiFormat,
      model, configuredHost: endpoint.hostname, nativeProvider: 'deepseek-official', nativeProtocol: 'anthropic-messages', nativeHost: new URL(baseURL).hostname } };
}

/** The current installed runtime is the acceptance target; historical research runtimes are never implicit fallbacks. */
export async function installedDshAcceptanceProgram(): Promise<string> {
  if (process.env.WORLDLINEBOX_DSH_NATIVE_PROGRAM) return path.resolve(process.env.WORLDLINEBOX_DSH_NATIVE_PROGRAM);
  const userData = process.env.WORLDLINEBOX_USER_DATA_PATH ?? path.join(process.env.APPDATA!, 'WorldlineBox');
  const root = path.join(userData, 'dsh');
  const records: Array<{ id: string; version: string; adapter: string }> = JSON.parse(await readFile(path.join(root, 'runtimes.json'), 'utf8'));
  const instances: Array<{ runtimeId: string; isDefault: boolean }> = JSON.parse(await readFile(path.join(root, 'native-instances.json'), 'utf8'));
  const selected = await readFile(path.join(root, 'cli/native-selection.json'), 'utf8').then(text => JSON.parse(text) as { instanceId: string }).catch(() => undefined);
  const instance = (instances as Array<{ id: string; runtimeId: string; isDefault: boolean }>).find(value => value.id === selected?.instanceId) ?? instances.find(value => value.isDefault);
  const target = records.find(record => record.id === instance?.runtimeId && record.adapter === 'node-cli-web-v1');
  if (!target || !/^runtime-[a-f0-9]{24}$/.test(target.id)) throw new Error('DSH_ACCEPTANCE_SELECTED_NATIVE_RUNTIME_NOT_FOUND');
  return path.join(root, 'runtimes', target.id, 'program');
}

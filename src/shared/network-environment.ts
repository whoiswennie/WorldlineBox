import { setGlobalProxyFromEnv } from 'node:http';
import { z } from 'zod';

const proxy = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, '全局代理请使用 HTTP/HTTPS 地址，例如 Clash 的 HTTP 或混合端口。');
export const networkEnvironmentSchema = z.object({ HTTP_PROXY: proxy.optional(), HTTPS_PROXY: proxy.optional(),
  ALL_PROXY: proxy.optional(), NO_PROXY: z.string().max(2048), npm_config_registry: z.string().url().max(2048), PIP_INDEX_URL: z.string().url().max(2048), NODE_USE_ENV_PROXY: z.literal('1') });
export type NetworkEnvironment = z.infer<typeof networkEnvironmentSchema>;
export const networkEnvironmentMessageSchema = z.object({ type: z.literal('worker.network-environment'), environment: networkEnvironmentSchema });
const networkVariable = /^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|PROXY|NO_PROXY|npm_config_(?:registry|proxy|https_proxy|noproxy)|PIP_INDEX_URL|NODE_USE_ENV_PROXY)$/i;

export function networkChildEnvironment(base: NodeJS.ProcessEnv, environment?: NetworkEnvironment): NodeJS.ProcessEnv {
  if (!environment) return { ...base };
  const next = { ...base };
  for (const key of Object.keys(next)) if (networkVariable.test(key)) delete next[key];
  return Object.assign(next, environment);
}

/** Keep Chromium's policy and Node fetch/HTTP plus subsequently spawned tools in agreement. */
export function applyNodeNetworkEnvironment(environment: NetworkEnvironment): void {
  const parsed = networkEnvironmentSchema.parse(environment);
  setGlobalProxyFromEnv(parsed);
  for (const key of Object.keys(process.env)) if (networkVariable.test(key)) delete process.env[key];
  Object.assign(process.env, parsed);
}

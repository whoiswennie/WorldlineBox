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
let restoreGlobalProxy: (() => void) | undefined;
// Node can create its initial proxy dispatcher before this module is imported.
// Remember only valid HTTP(S) routes, for a wildcard bypass on an initial direct policy.
const inheritedHttp = proxy.safeParse(process.env.http_proxy ?? process.env.HTTP_PROXY);
const inheritedHttps = proxy.safeParse(process.env.https_proxy ?? process.env.HTTPS_PROXY);
let lastProxyEnvironment: NodeJS.ProcessEnv | undefined = inheritedHttp.success || inheritedHttps.success ? {
  ...(inheritedHttp.success ? { HTTP_PROXY: inheritedHttp.data } : {}),
  ...(inheritedHttps.success ? { HTTPS_PROXY: inheritedHttps.data } : {}),
} : undefined;

export function networkChildEnvironment(base: NodeJS.ProcessEnv, environment?: NetworkEnvironment): NodeJS.ProcessEnv {
  if (!environment) return { ...base };
  const next = { ...base };
  for (const key of Object.keys(next)) if (networkVariable.test(key)) delete next[key];
  return Object.assign(next, Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined)));
}

/** Keep Chromium's policy and Node fetch/HTTP plus subsequently spawned tools in agreement. */
export function applyNodeNetworkEnvironment(environment: NetworkEnvironment): void {
  const parsed = networkEnvironmentSchema.parse(environment);
  // The Node API deliberately does nothing when both proxy variables are absent.
  // Restore its previous dispatcher/agents first so turning the proxy off also
  // affects existing Node fetch/HTTP callers rather than only future processes.
  restoreGlobalProxy?.();
  const hasProxy = Boolean(parsed.HTTP_PROXY || parsed.HTTPS_PROXY);
  // A Worker may have inherited a proxy dispatcher at Node startup. Restoring
  // that baseline alone would still proxy requests. Reuse the last real proxy
  // configuration with a wildcard bypass so every destination is direct.
  const routing = !hasProxy && lastProxyEnvironment ? { ...lastProxyEnvironment, NO_PROXY: '*' } : parsed;
  restoreGlobalProxy = setGlobalProxyFromEnv(routing);
  if (hasProxy) lastProxyEnvironment = parsed;
  for (const key of Object.keys(process.env)) if (networkVariable.test(key)) delete process.env[key];
  // process.env turns an assigned undefined into the literal string "undefined".
  Object.assign(process.env, Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined)));
}

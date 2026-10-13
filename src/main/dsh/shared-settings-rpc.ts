import { randomUUID } from 'node:crypto';

export interface NativeSettingsView {
  ns: string;
  revision: number;
  user?: Record<string, unknown>;
  secrets?: Array<{ path: string[]; set: boolean }>;
}
export interface SettingsMutation { op: 'set' | 'unset'; path: string[]; value?: unknown }
export interface NativeSettingsTransport {
  describe(): Promise<NativeSettingsView[]>;
  mutate(ns: string, ops: SettingsMutation[], expectedRevision: number): Promise<NativeSettingsView>;
  onChanged(listener: (namespace: string) => void): () => void;
  close(): void;
}
export class SharedSettingsRpcError extends Error {
  constructor(readonly code: string) { super(`Shared model settings RPC failed (${code}).`); }
}

/** Authenticate only the supervised instance's loopback URL; secrets never enter errors. */
export async function connectNativeSettings(readyUrl: string, fetchImpl: typeof fetch = fetch): Promise<NativeSettingsTransport> {
  let url: URL;
  try { url = new URL(readyUrl); } catch { throw new SharedSettingsRpcError('invalid-loopback-url'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.hash) throw new SharedSettingsRpcError('invalid-loopback-url');
  const admission = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) }).catch(() => { throw new SharedSettingsRpcError('authentication-unavailable'); });
  const location = admission.headers.get('location');
  const cookies = admission.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  await admission.body?.cancel();
  if (admission.status !== 303 || location !== './' || !cookies) throw new SharedSettingsRpcError('authentication-rejected');
  const origin = url.origin;
  const listeners = new Set<(namespace: string) => void>();
  let closed = false;
  const lifetime = new AbortController();
  const invoke = async (method: string, args: Record<string, unknown>): Promise<unknown> => {
    if (closed) throw new SharedSettingsRpcError('closed');
    const rpcId = randomUUID();
    const response = await fetchImpl(`${origin}/api/${method}`, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', Cookie: cookies, Origin: origin },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]),
    }).catch(() => { throw new SharedSettingsRpcError('transport-unavailable'); });
    if (!response.ok) throw new SharedSettingsRpcError(`http-${response.status}`);
    const value = await response.json().catch(() => { throw new SharedSettingsRpcError('invalid-response'); }) as { type?: string; rpcId?: string; result?: { ok?: boolean; value?: unknown; error?: { code?: unknown } } };
    if (value.type !== 'server-response' || value.rpcId !== rpcId || !value.result) throw new SharedSettingsRpcError('invalid-response');
    if (!value.result.ok) {
      const rawCode = value.result.error?.code;
      throw new SharedSettingsRpcError(typeof rawCode === 'string' && /^[a-z0-9_/-]{1,100}$/i.test(rawCode) ? rawCode : 'rejected');
    }
    return value.result.value;
  };
  // Node 24 supports WebSocketInit headers even when DOM TypeScript overloads do not.
  const Socket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const socket = new Socket(`${origin.replace('http:', 'ws:')}/api/remote.mux`, { headers: { Cookie: cookies, Origin: origin } });
  const streamId = randomUUID();
  socket.addEventListener('open', () => {
    if (!closed) socket.send(JSON.stringify({ type: 'open', streamId, endpoint: '$events', payload: { args: {} } }));
  });
  socket.addEventListener('message', (event) => {
    if (closed || typeof event.data !== 'string' || event.data.length > 1024 * 1024) return;
    try {
      const frame = JSON.parse(event.data) as { type?: string; streamId?: string; value?: { type?: string; event?: string; args?: unknown[] } };
      if (frame.type === 'item' && frame.streamId === streamId && frame.value?.type === 'emit' && frame.value.event === 'settings/document-updated' && typeof frame.value.args?.[0] === 'string') for (const listener of listeners) listener(frame.value.args[0]);
    } catch { /* A malformed event never supplies configuration or secret text. */ }
  });
  socket.addEventListener('error', () => { /* The coordinator's polling also covers a lost event stream. */ });
  return {
    async describe() {
      const result = await invoke('settings/describe', {}) as { namespaces?: NativeSettingsView[] };
      if (!Array.isArray(result?.namespaces)) throw new SharedSettingsRpcError('invalid-describe');
      return result.namespaces;
    },
    async mutate(ns, ops, expectedRevision) { return await invoke('settings/mutate', { ns, ops, expectedRevision }) as NativeSettingsView; },
    onChanged(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { closed = true; lifetime.abort(); listeners.clear(); socket.close(); },
  };
}

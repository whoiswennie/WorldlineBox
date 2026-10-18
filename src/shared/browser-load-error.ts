/** Chromium network failures used by Electron's did-fail-load/loadURL APIs. */
export type BrowserLoadFailureKind = 'dns' | 'connection' | 'offline' | 'timeout' | 'secure' | 'proxy' | 'generic';

const descriptions: Record<number, string> = {
  [-3]: 'ERR_ABORTED', [-7]: 'ERR_TIMED_OUT', [-21]: 'ERR_NETWORK_CHANGED',
  [-100]: 'ERR_CONNECTION_CLOSED', [-101]: 'ERR_CONNECTION_RESET', [-102]: 'ERR_CONNECTION_REFUSED',
  [-103]: 'ERR_CONNECTION_ABORTED', [-104]: 'ERR_CONNECTION_FAILED', [-105]: 'ERR_NAME_NOT_RESOLVED',
  [-106]: 'ERR_INTERNET_DISCONNECTED', [-107]: 'ERR_SSL_PROTOCOL_ERROR', [-109]: 'ERR_ADDRESS_UNREACHABLE',
  [-118]: 'ERR_CONNECTION_TIMED_OUT', [-120]: 'ERR_SOCKS_CONNECTION_FAILED', [-130]: 'ERR_PROXY_CONNECTION_FAILED',
  [-137]: 'ERR_NAME_RESOLUTION_FAILED', [-200]: 'ERR_CERT_COMMON_NAME_INVALID', [-201]: 'ERR_CERT_DATE_INVALID',
  [-202]: 'ERR_CERT_AUTHORITY_INVALID', [-324]: 'ERR_EMPTY_RESPONSE',
};

function details(error: unknown, description?: string): { code?: number; name?: string; message: string } {
  const record = error && typeof error === 'object' ? error as { errno?: unknown; code?: unknown; message?: unknown } : undefined;
  const message = (description ?? (typeof record?.message === 'string' ? record.message : String(error))).slice(0, 1000);
  const numeric = typeof error === 'number' ? error : typeof record?.errno === 'number' ? record.errno
    : typeof record?.code === 'number' ? record.code : undefined;
  const code = numeric ?? Number(message.match(/\((-\d+)\)/)?.[1]);
  const name = (typeof record?.code === 'string' ? record.code.match(/^ERR_[A-Z0-9_]+$/)?.[0] : undefined)
    ?? message.match(/\bERR_[A-Z0-9_]+\b/)?.[0] ?? descriptions[code];
  return { code: Number.isInteger(code) && code < 0 ? code : undefined, name, message };
}

/** Keep a stable Chromium code without serializing a loadURL error's URL/query. */
export function formatBrowserLoadError(error: unknown, description?: string): string {
  const value = details(error, description);
  if (value.name) return value.name + (value.code === undefined ? '' : ` (${value.code})`);
  const suffix = value.code === undefined || value.message.includes(`(${value.code})`) ? '' : ` (${value.code})`;
  return value.message.slice(0, 1000 - suffix.length) + suffix;
}

/** Stops and superseded navigation reject with ERR_ABORTED; they are not failed pages. */
export function shouldIgnoreBrowserLoadError(error: unknown, description?: string): boolean {
  const value = details(error, description);
  return value.code === -3 || value.name === 'ERR_ABORTED';
}

/** Classify only a top-level failure supplied by the browser host, never subresources. */
export function browserLoadFailureKind(error: unknown): BrowserLoadFailureKind {
  const { name = '', code } = details(error);
  if (code === -105 || code === -137 || /^ERR_(?:NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|DNS_)/.test(name)) return 'dns';
  if (code === -106 || name === 'ERR_INTERNET_DISCONNECTED') return 'offline';
  if (code === -7 || code === -118 || name.includes('TIMED_OUT')) return 'timeout';
  if (name.includes('PROXY') || name.includes('SOCKS') || code === -120 || code === -130) return 'proxy';
  if (name.startsWith('ERR_CERT_') || name.startsWith('ERR_SSL_') || (code !== undefined && code <= -200 && code > -300)) return 'secure';
  if ((code !== undefined && [ -21, -100, -101, -102, -103, -104, -109, -324 ].includes(code))
    || /^ERR_(?:CONNECTION_|NETWORK_|ADDRESS_UNREACHABLE|EMPTY_RESPONSE)/.test(name)) return 'connection';
  return 'generic';
}

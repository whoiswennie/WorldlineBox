/** Internal process-only capability; user-supplied proxy settings still forbid credentials. */
export function isManagedNetworkRelayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.username === 'worldlinebox'
      && /^[a-f0-9]{64}$/.test(url.password) && Boolean(url.port) && Number(url.port) >= 1 && Number(url.port) <= 65535
      && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}

import http from 'node:http';
import https from 'node:https';
import { isIP, type Socket } from 'node:net';
import tls from 'node:tls';
import { isManagedNetworkRelayUrl } from '../shared/network-relay-url';

/** Read the current policy on each hop, including after a live proxy switch. */
export function pinnedDownloadProxy(url: URL, environment: NodeJS.ProcessEnv = process.env): URL | undefined {
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const bypass = environment.no_proxy || environment.NO_PROXY || '';
  for (const raw of bypass.split(/[\s,]+/u)) {
    const rule = raw.toLowerCase();
    if (rule === '*') return undefined;
    if (!rule) continue;
    // IPv6 literals must remain bracketed while separating an optional port.
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/u.exec(rule);
    if (!match || (match[2] && match[2] !== port)) continue;
    const target = match[1]!.replace(/^\[|\]$/gu, '');
    const suffix = target.startsWith('*.') ? target.slice(1) : target;
    if (hostname === target || (suffix.startsWith('.') && hostname.endsWith(suffix))) return undefined;
  }
  const value = url.protocol === 'https:'
    ? environment.https_proxy || environment.HTTPS_PROXY || environment.all_proxy || environment.ALL_PROXY
    : environment.http_proxy || environment.HTTP_PROXY || environment.all_proxy || environment.ALL_PROXY;
  if (!value) return undefined;
  const proxy = new URL(value);
  if (!['http:', 'https:'].includes(proxy.protocol)
    || ((proxy.username || proxy.password) && !isManagedNetworkRelayUrl(proxy.href))) {
    throw new Error('The global download proxy must use an HTTP(S) proxy without URL credentials.');
  }
  return proxy;
}

/**
 * Ask the proxy for the validated numeric address, never the untrusted hostname.
 * The origin Host header and TLS identity are still the original URL hostname.
 * This preserves the downloader's DNS-rebinding/SSRF boundary through a proxy.
 */
export function openPinnedProxyTunnel(input: {
  proxy: URL; address: string; url: URL; signal: AbortSignal;
}): Promise<Socket> {
  const { proxy, address, url, signal } = input;
  const managedRelay = isManagedNetworkRelayUrl(proxy.href);
  const endpoint = new URL(proxy);
  endpoint.username = ''; endpoint.password = '';
  signal.throwIfAborted();
  const authority = `${isIP(address) === 6 ? `[${address}]` : address}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
  return new Promise((resolve, reject) => {
    let socket: Socket | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) { socket?.destroy(); request.destroy(); reject(error); }
      else resolve(socket!);
    };
    const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error('Download cancelled.'));
    // This request itself is direct to the configured proxy. Reusing the
    // global proxy agent here would recursively proxy the CONNECT request.
    const request = (proxy.protocol === 'https:' ? https : http).request(endpoint, {
      method: 'CONNECT', path: authority, agent: false, headers: { Host: authority,
        ...(managedRelay ? {
          'Proxy-Authorization': `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`,
          // PAC policy needs the original hostname. The relay still connects
          // only to authority (the already validated numeric address above).
          'x-worldlinebox-pinned-origin': url.origin,
        } : {}),
      },
      signal,
    });
    request.once('error', error => finish(error));
    request.once('response', response => {
      response.destroy(); finish(new Error(`Download proxy refused CONNECT (HTTP ${response.statusCode ?? 0}).`));
    });
    request.once('connect', (response, connected, head) => {
      socket = connected;
      if (response.statusCode !== 200) {
        finish(new Error(`Download proxy refused CONNECT (HTTP ${response.statusCode ?? 0}).`)); return;
      }
      if (head.length) connected.unshift(head);
      if (url.protocol === 'http:') { finish(); return; }
      const hostname = url.hostname.replace(/^\[|\]$/gu, '');
      const secured = tls.connect({ socket: connected, host: hostname,
        ...(isIP(hostname) === 0 ? { servername: hostname } : {}), rejectUnauthorized: true,
        checkServerIdentity: (_hostname, certificate) => tls.checkServerIdentity(hostname, certificate),
      });
      socket = secured;
      secured.once('error', error => finish(error));
      secured.once('secureConnect', () => finish());
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else request.end();
  });
}

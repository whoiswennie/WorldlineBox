import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { openPinnedProxyTunnel, pinnedDownloadProxy } from './pinned-proxy-tunnel';

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type DnsLookup = (hostname: string) => Promise<ResolvedAddress[]>;

export interface PinnedHttpResponse {
  body: AsyncIterable<Uint8Array> | null;
  cancel(): void;
  headers: Headers;
  status: number;
}

export interface PinnedHttpRequest {
  address: string;
  family: number;
  headers: Record<string, string>;
  signal: AbortSignal;
  url: URL;
}

export type PinnedHttpTransport = (
  request: PinnedHttpRequest,
) => Promise<PinnedHttpResponse>;

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (value !== undefined) {
      result.set(name, value);
    }
  }
  return result;
}

/**
 * Opens one HTTP(S) hop while retaining the URL hostname for Host and TLS SNI.
 * The custom lookup never performs DNS: it returns the already validated IP.
 */
export const defaultPinnedHttpTransport: PinnedHttpTransport = async ({
  address,
  family,
  headers,
  signal,
  url,
}) => {
  const proxy = pinnedDownloadProxy(url);
  const socket = proxy ? await openPinnedProxyTunnel({ proxy, address, url, signal }) : undefined;
  const agent = socket ? (url.protocol === 'https:' ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false })) : undefined;
  // Exactly one already established connection is consumed. No proxy or origin
  // hostname lookup can replace the address validated by LibraryService.
  if (agent && socket) agent.createConnection = () => socket;
  if (signal.aborted) { socket?.destroy(); agent?.destroy(); signal.throwIfAborted(); }
  return new Promise((resolve, reject) => {
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) {
        callback(null, [{ address, family }]);
        return;
      }
      callback(null, address, family);
    };
    const requester = url.protocol === 'https:' ? https : http;
    const tlsHostname = url.hostname.replace(/^\[|\]$/gu, '');
    try {
      const request = requester.request(url, {
        agent: agent ?? false,
        headers,
        lookup,
        signal,
        ...(url.protocol === 'https:' && isIP(tlsHostname) === 0
          ? { servername: tlsHostname }
          : {}),
      }, (response: IncomingMessage) => {
        response.once('close', () => agent?.destroy());
        resolve({
          body: response,
          cancel: () => response.destroy(),
          headers: responseHeaders(response.headers),
          status: response.statusCode ?? 0,
        });
      });
      request.once('error', error => { agent?.destroy(); reject(error); });
      request.end();
    } catch (error) {
      agent?.destroy(); reject(error);
    }
  });
};

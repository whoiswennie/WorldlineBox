import { net, type Session } from 'electron';
import { Readable } from 'node:stream';
import { httpsDownloadUrl, type HttpsDownloadFetch } from './https-download';
import type { PackPublishRequest } from './pack-distribution';

/** Chromium networking retains system proxy support and validates every redirect before following it. */
export function createElectronHttpsDownload(networkSession?: Session): HttpsDownloadFetch {
return (url, { signal, headers }) => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  let current = httpsDownloadUrl(url).href;
  const request = net.request({ url: current, method: 'GET', redirect: 'manual', cache: 'no-store', headers, ...(networkSession ? { session: networkSession } : {}) });
  let body: Readable | undefined;
  let completed = false;
  let redirects = 0;
  const fail = (error: Error) => {
    if (completed) return;
    completed = true;
    signal.removeEventListener('abort', abort);
    reject(error);
    body?.destroy(error);
    request.abort();
  };
  const abort = () => fail(signal.reason instanceof Error ? signal.reason : new Error('Installer download cancelled.'));
  signal.addEventListener('abort', abort, { once: true });
  request.on('error', fail);
  request.on('redirect', (_status, _method, destination) => {
    try {
      if (++redirects > 5) throw new Error('The installer server returned too many redirects.');
      current = httpsDownloadUrl(destination, current).href;
      request.followRedirect();
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
  request.on('response', incoming => {
    // Electron documents IncomingMessage as Readable, but its declarations omit stream methods.
    body = incoming as unknown as Readable;
    body.once('error', fail);
    body.once('aborted', () => fail(new Error('The installer connection ended before the download completed.')));
    body.once('close', () => { if (!body?.readableEnded && !completed) fail(new Error('The installer connection ended before the download completed.')); });
    body.once('end', () => { completed = true; signal.removeEventListener('abort', abort); });
    try {
      const headers = new Headers();
      for (const [name, values] of Object.entries(incoming.headers)) {
        for (const value of Array.isArray(values) ? values : [values]) headers.append(name, value);
      }
      const emptyStatus = [204, 205, 304].includes(incoming.statusCode);
      const response = new Response(emptyStatus ? null : Readable.toWeb(body) as ReadableStream<Uint8Array>, { status: incoming.statusCode, headers });
      Object.defineProperty(response, 'url', { value: current });
      resolve(response);
      if (emptyStatus) { completed = true; signal.removeEventListener('abort', abort); request.abort(); }
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
  // The writable request can emit close after request.end(), before response arrives.
  // Transfer completion belongs to IncomingMessage; network failures emit error.
  request.end();
});
}
export const electronHttpsDownload = createElectronHttpsDownload();

/** Authenticated publication never follows redirects or sends a token to a mirror. */
export function createElectronPublicationRequest(networkSession: Session) {
  return (value: string, input: PackPublishRequest): Promise<Response> => new Promise((resolve, reject) => {
    input.signal.throwIfAborted();
    const url = httpsDownloadUrl(value);
    if (!['api.github.com', 'uploads.github.com'].includes(url.hostname)) throw new Error('Publication must use the official GitHub API.');
    const request = net.request({ url: url.href, method: input.method, redirect: 'manual', cache: 'no-store', session: networkSession, headers: input.headers });
    let body: Readable | undefined; let completed = false;
    const fail = (error: Error) => {
      if (completed) return; completed = true; input.signal.removeEventListener('abort', abort);
      if (input.body instanceof Readable) input.body.destroy();
      body?.destroy(error); request.abort(); reject(new Error('GitHub publication transport failed.', { cause: error }));
    };
    const abort = () => fail(new Error('Publication cancelled.'));
    input.signal.addEventListener('abort', abort, { once: true });
    request.on('error', fail);
    request.on('redirect', () => fail(new Error('Authenticated redirects are refused.')));
    request.on('response', incoming => {
      body = incoming as unknown as Readable;
      body.once('error', fail);
      body.once('aborted', () => fail(new Error('Publication response was interrupted.')));
      body.once('close', () => { if (!body?.readableEnded && !completed) fail(new Error('Publication response was incomplete.')); });
      body.once('end', () => { completed = true; input.signal.removeEventListener('abort', abort); });
      try {
        const headers = new Headers();
        for (const [name, values] of Object.entries(incoming.headers)) for (const entry of Array.isArray(values) ? values : [values]) headers.append(name, entry);
        const empty = [204, 205, 304].includes(incoming.statusCode);
        const response = new Response(empty ? null : Readable.toWeb(body) as ReadableStream<Uint8Array>, { status: incoming.statusCode, headers });
        Object.defineProperty(response, 'url', { value: url.href }); resolve(response);
        if (empty) { completed = true; input.signal.removeEventListener('abort', abort); request.abort(); }
      } catch (error) { fail(error instanceof Error ? error : new Error('Invalid publication response.')); }
    });
    void (async () => {
      // Electron write callbacks bound the in-flight upload to one stream chunk.
      const write = (chunk: Buffer | string) => new Promise<void>((done, failed) => {
        const cleanup = () => { request.removeListener('error', onError); input.signal.removeEventListener('abort', onAbort); };
        const onError = (error: Error) => { cleanup(); failed(error); };
        const onAbort = () => { cleanup(); failed(new Error('Publication cancelled.')); };
        request.once('error', onError);
        input.signal.addEventListener('abort', onAbort, { once: true });
        if (input.signal.aborted) { onAbort(); return; }
        request.write(chunk, undefined, () => { cleanup(); done(); });
      });
      try {
        if (input.body instanceof Readable) for await (const chunk of input.body) { input.signal.throwIfAborted(); await write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); }
        else if (input.body !== undefined) await write(typeof input.body === 'string' ? input.body : Buffer.from(input.body));
        input.signal.throwIfAborted(); request.end();
      } catch (error) { fail(error instanceof Error ? error : new Error('Publication upload failed.')); }
    })();
  });
}

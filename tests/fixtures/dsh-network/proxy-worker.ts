import { applyNodeNetworkEnvironment, networkEnvironmentMessageSchema } from '../../../src/shared/network-environment';

const port = process.parentPort!;
port.on('message', ({ data }: { data: unknown }) => {
  const environment = networkEnvironmentMessageSchema.safeParse(data);
  if (environment.success) { applyNodeNetworkEnvironment(environment.data.environment); return; }
  const request = data as { type: string; id: number; url: string };
  if (request.type === 'probe') void fetch(request.url, { signal: AbortSignal.timeout(8000) }).then(response => response.text())
    .then(text => port.postMessage({ id: request.id, text, proxy: process.env.HTTP_PROXY }))
    .catch(error => port.postMessage({ id: request.id, error: String(error) }));
});
// Fetch before the first policy message so Node's inherited dispatcher is instantiated.
void fetch(process.env.WORLDLINEBOX_PROXY_WORKER_ORIGIN!, { signal: AbortSignal.timeout(8000) }).then(response => response.text())
  .then(text => port.postMessage({ type: 'ready', text, inheritedProxy: process.env.HTTP_PROXY }))
  .catch(error => port.postMessage({ type: 'ready', error: String(error) }));

import type { EmbeddingDeviceCapability } from '../shared/embedding/device-capability';

/** Share immutable bundle verification between device preparation and actual
 * inference. Failed attempts never become cached admission. */
export function createEmbeddingResourcePreparation(verify: () => Promise<unknown>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => pending ??= Promise.resolve().then(verify).then(() => undefined).catch(error => { pending = undefined; throw error; });
}

/** Restore measured device capability without launching inference, and prime
 * only while the requesting library/service still owns this work. */
export async function prepareEmbeddingIdleStartup(ports: {
  isCurrent(): boolean;
  readDeviceStatus(): Promise<Pick<EmbeddingDeviceCapability, 'state'>>;
  verifyResources(): Promise<void>;
  requestIdlePrime(): void;
}): Promise<'requested' | 'unavailable' | 'obsolete'> {
  if (!ports.isCurrent()) return 'obsolete';
  const status = await ports.readDeviceStatus();
  if (!ports.isCurrent()) return 'obsolete';
  if (status.state !== 'supported') return 'unavailable';
  await ports.verifyResources();
  if (!ports.isCurrent()) return 'obsolete';
  ports.requestIdlePrime();
  return 'requested';
}

import type { EmbeddingDeviceCapability } from '../../shared/embedding/device-capability';

/** Process-wide immutable resource verification is shared by idle startup and
 * real inference. A failed attempt is never cached as successful admission. */
export function createCompanionEmbeddingResourcePreparation(verify: () => Promise<unknown>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => pending ??= Promise.resolve().then(verify).then(() => undefined).catch(error => { pending = undefined; throw error; });
}

/** Restore only an already measured, still valid device status. This port must
 * be status(), never ensureSupported()/test(), so unchecked devices stay idle.
 * No owner work is resumed after its library/service lifetime has ended. */
export async function prepareCompanionMemoryIdleStartup(ports: {
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

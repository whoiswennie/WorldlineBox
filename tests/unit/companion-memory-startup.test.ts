import { expect, it, vi } from 'vitest';
import { createCompanionEmbeddingResourcePreparation, prepareCompanionMemoryIdleStartup } from '../../src/main/companions/memory-startup';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it('shares complete resource verification with a foreground caller and retries an actual failure', async () => {
  const gate = deferred<void>(), verify = vi.fn(async () => gate.promise), prepare = createCompanionEmbeddingResourcePreparation(verify);
  const idle = prepare(), foreground = prepare();
  expect(idle).toBe(foreground); await Promise.resolve(); expect(verify).toHaveBeenCalledOnce();
  gate.resolve(); await Promise.all([idle, foreground]); await prepare(); expect(verify).toHaveBeenCalledOnce();
  const failing = vi.fn().mockRejectedValueOnce(new Error('actual integrity failure')).mockResolvedValue(undefined);
  const retry = createCompanionEmbeddingResourcePreparation(failing);
  await expect(retry()).rejects.toThrow('actual integrity failure'); await expect(retry()).resolves.toBeUndefined();
  expect(failing).toHaveBeenCalledTimes(2);
});

it('requests existing idle preparation only after a restored supported status and full verification', async () => {
  const gate = deferred<void>(), requestIdlePrime = vi.fn(), verifyResources = vi.fn(async () => gate.promise);
  const startup = prepareCompanionMemoryIdleStartup({ isCurrent: () => true,
    readDeviceStatus: async () => ({ state: 'supported' }), verifyResources, requestIdlePrime });
  await Promise.resolve(); expect(verifyResources).toHaveBeenCalledOnce(); expect(requestIdlePrime).not.toHaveBeenCalled();
  gate.resolve(); await expect(startup).resolves.toBe('requested'); expect(requestIdlePrime).toHaveBeenCalledOnce();
});

it.each(['unchecked', 'unsupported', 'testing', 'error'] as const)('never starts verification or physical preparation for device state %s', async state => {
  const verifyResources = vi.fn(async () => undefined), requestIdlePrime = vi.fn();
  await expect(prepareCompanionMemoryIdleStartup({ isCurrent: () => true, readDeviceStatus: async () => ({ state }),
    verifyResources, requestIdlePrime })).resolves.toBe('unavailable');
  expect(verifyResources).not.toHaveBeenCalled(); expect(requestIdlePrime).not.toHaveBeenCalled();
});

it('does not start device or resource work for an already replaced library service', async () => {
  const readDeviceStatus = vi.fn(async () => ({ state: 'supported' as const })), verifyResources = vi.fn(async () => undefined), requestIdlePrime = vi.fn();
  await expect(prepareCompanionMemoryIdleStartup({ isCurrent: () => false, readDeviceStatus, verifyResources, requestIdlePrime })).resolves.toBe('obsolete');
  expect(readDeviceStatus).not.toHaveBeenCalled(); expect(verifyResources).not.toHaveBeenCalled(); expect(requestIdlePrime).not.toHaveBeenCalled();
});

it('refuses a late device status after its library has switched', async () => {
  let current = true;
  const gate = deferred<{ state: 'supported' }>(), verifyResources = vi.fn(async () => undefined), requestIdlePrime = vi.fn();
  const startup = prepareCompanionMemoryIdleStartup({ isCurrent: () => current, readDeviceStatus: () => gate.promise, verifyResources, requestIdlePrime });
  current = false; gate.resolve({ state: 'supported' });
  await expect(startup).resolves.toBe('obsolete'); expect(verifyResources).not.toHaveBeenCalled(); expect(requestIdlePrime).not.toHaveBeenCalled();
});

it('lets shared immutable verification settle without priming a closed or switched service', async () => {
  let current = true;
  const gate = deferred<void>(), requestIdlePrime = vi.fn(), prepare = createCompanionEmbeddingResourcePreparation(async () => gate.promise);
  const startup = prepareCompanionMemoryIdleStartup({ isCurrent: () => current, readDeviceStatus: async () => ({ state: 'supported' }),
    verifyResources: prepare, requestIdlePrime });
  await Promise.resolve(); const foreground = prepare(); current = false; gate.resolve();
  await expect(startup).resolves.toBe('obsolete'); await expect(foreground).resolves.toBeUndefined(); expect(requestIdlePrime).not.toHaveBeenCalled();
});

it('preserves verification failure instead of treating failed idle startup as a valid model admission', async () => {
  const requestIdlePrime = vi.fn();
  await expect(prepareCompanionMemoryIdleStartup({ isCurrent: () => true, readDeviceStatus: async () => ({ state: 'supported' }),
    verifyResources: async () => { throw new Error('pinned bytes changed'); }, requestIdlePrime })).rejects.toThrow('pinned bytes changed');
  expect(requestIdlePrime).not.toHaveBeenCalled();
});

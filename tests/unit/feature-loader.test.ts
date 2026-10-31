import { expect, it, vi } from 'vitest';
import { featureLoader } from '../../src/renderer/feature-loader';

it('shares an intent preload with lazy rendering without mounting or starting a second import', async () => {
  let resolve!: (value: { default: string }) => void;
  const load = vi.fn(() => new Promise<{ default: string }>(done => { resolve = done; }));
  const feature = featureLoader(load);
  feature.preload(); feature.preload();
  const first = feature.load(), second = feature.load();
  expect(load).toHaveBeenCalledOnce(); expect(first).toBe(second);
  resolve({ default: 'loaded code' });
  await expect(first).resolves.toEqual({ default: 'loaded code' });
  expect(feature.load()).toBe(first);
});

it('an unsuccessful speculative import can be retried by a real navigation', async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error('temporary chunk failure')).mockResolvedValueOnce({ default: 'ready' });
  const feature = featureLoader(load); feature.preload();
  await new Promise(resolve => setTimeout(resolve, 0));
  await expect(feature.load()).resolves.toEqual({ default: 'ready' });
  expect(load).toHaveBeenCalledTimes(2);
});

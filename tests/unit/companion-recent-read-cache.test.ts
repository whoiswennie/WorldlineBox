import { expect, it } from 'vitest';
import { CompanionRecentReadCache } from '../../src/renderer/companions/recent-read-cache';

it('bounds snapshots by count and UTF-8 bytes and evicts the least recently viewed entry', () => {
  const cache = new CompanionRecentReadCache<string>(3, 32);
  cache.set('one', '海边'); cache.set('two', '灯塔'); cache.set('three', '约定');
  expect(cache.get('one')).toBe('海边');
  cache.set('four', '朋友');
  expect(cache.get('two')).toBeUndefined();
  for (let n = 0; n < 100; n++) cache.set(String(n), '深海🐟');
  expect(cache.snapshot().entries).toBeLessThanOrEqual(3);
  expect(cache.snapshot().bytes).toBeLessThanOrEqual(32);
  cache.set('too-large', '鱼'.repeat(100));
  expect(cache.get('too-large')).toBeUndefined();
});

it('a host invalidation prevents an old in-flight result from repopulating the cache', () => {
  const cache = new CompanionRecentReadCache<string>();
  const before = cache.generation;
  cache.set('room', 'old'); cache.clear(); cache.set('room', 'late revoked content', before);
  expect(cache.get('room')).toBeUndefined();
  expect(cache.snapshot()).toMatchObject({ entries: 0, bytes: 0 });
  cache.set('room', 'fresh'); expect(cache.get('room')).toBe('fresh');
});

import { checkNetworkSource } from '../../src/main/dsh/network-diagnostics';
import { expect, it, vi } from 'vitest';
const signal = () => new AbortController().signal;
it('records actual per-target proxies and fallback errors instead of claiming the first mirror worked', async () => {
  const cancel = vi.fn();
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('<html>not releases</html>')); c.close(); }, cancel })))
    .mockResolvedValueOnce(new Response('[]'));
  const result = await checkNetworkSource('github', ['https://mirror.example/releases', 'https://api.github.com/releases'], fetcher, async url => url.includes('mirror') ? 'DIRECT' : 'http://127.0.0.1:7897', signal());
  expect(result.ok).toBe(true); expect(result.attempts).toHaveLength(2);
  expect(result.attempts[0]).toMatchObject({ ok: false, proxy: 'DIRECT' }); expect(result.attempts[0]!.error).toBeTruthy();
  expect(result.attempts[1]).toMatchObject({ ok: true, proxy: 'http://127.0.0.1:7897', url: 'https://api.github.com/releases' });
});
it('limits diagnostic payloads and validates registry metadata rather than accepting an HTML success page', async () => {
  const huge = await checkNetworkSource('npm', ['https://registry.example/zod/latest'], async () => new Response('x'.repeat(1024 * 1024 + 1)), async () => 'DIRECT', signal());
  expect(huge.ok).toBe(false); expect(huge.attempts[0]!.error).toContain('1 MiB');
  const wrong = await checkNetworkSource('npm', ['https://registry.example/zod/latest'], async () => new Response('{"name":"another","version":"1"}'), async () => 'DIRECT', signal()); expect(wrong.ok).toBe(false);
  const good = await checkNetworkSource('npm', ['https://registry.example/zod/latest'], async () => new Response('{"name":"zod","version":"4"}'), async () => 'DIRECT', signal()); expect(good.ok).toBe(true);
});
it('stops reading the Python package catalogue after a bounded prefix and cancels the stream', async () => {
  const cancel = vi.fn(); const result = await checkNetworkSource('python', ['https://python.example/simple/'], async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('<html>index</html>')); }, cancel })), async () => 'DIRECT', signal());
  expect(result.ok).toBe(true); expect(cancel).toHaveBeenCalledOnce();
});
it('shows every failed status and caps fallback attempts, while explicit cancellation propagates', async () => {
  const fetcher = vi.fn(async () => new Response('blocked', { status: 403 }));
  const result = await checkNetworkSource('github', Array.from({ length: 10 }, (_, i) => 'https://mirror.example/' + i), fetcher, async () => 'DIRECT', signal());
  expect(result.ok).toBe(false); expect(result.attempts).toHaveLength(4); expect(result.attempts.every(item => item.error === 'HTTP 403')).toBe(true);
  const controller = new AbortController(); controller.abort(Error('cancelled'));
  await expect(checkNetworkSource('npm', ['https://registry.example'], fetcher, async () => 'DIRECT', controller.signal)).rejects.toThrow('cancelled');
});

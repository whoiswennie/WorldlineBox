import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApplicationNetworkDiagnostics } from '../../src/main/application-network-diagnostics';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-18T10:00:00Z')); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const failure = (url = 'https://example.com/path?token=secret') => ({ url, error: 'net::ERR_CONNECTION_CLOSED', resourceType: 'image', module: 'browser' as const });

it('stores and reports only the site origin, excluding credentials, paths, query strings and fragments', () => {
  const report = vi.fn(); const diagnostics = new ApplicationNetworkDiagnostics(report);
  diagnostics.record(failure('https://private-user:private-password@example.com:8443/private-path?token=private-token#private-fragment'));
  expect(diagnostics.state()).toHaveLength(1);
  expect(diagnostics.state()[0]).toMatchObject({ origin: 'https://example.com:8443', count: 1, module: 'browser', resourceType: 'image', error: 'net::ERR_CONNECTION_CLOSED' });
  expect(report).toHaveBeenCalledOnce();
  const serialized = JSON.stringify([diagnostics.state(), report.mock.calls]);
  for (const secret of ['private-user', 'private-password', 'private-path', 'private-token', 'private-fragment']) expect(serialized).not.toContain(secret);
});

it('aggregates repeated origin/error/resource/module failures, refreshes the timestamp and moves the row to the front', () => {
  const report = vi.fn(); const diagnostics = new ApplicationNetworkDiagnostics(report);
  diagnostics.record(failure());
  const first = diagnostics.state()[0]!;
  diagnostics.record(failure('https://second.example/asset'));
  vi.setSystemTime(new Date('2026-10-18T10:01:00Z'));
  diagnostics.record(failure('https://example.com/another?credential=private'));
  expect(diagnostics.state()).toHaveLength(2);
  expect(diagnostics.state()[0]).toMatchObject({ id: first.id, count: 2, occurredAt: '2026-10-18T10:01:00.000Z' });
  expect(diagnostics.state()[1]!.origin).toBe('https://second.example');
  expect(report).toHaveBeenCalledTimes(2);
  expect(report.mock.calls[0]![0]).toMatchObject({ count: 1, occurredAt: '2026-10-18T10:00:00.000Z' });
});

it('keeps distinct errors, modules and resource types as separate diagnostic rows', () => {
  const diagnostics = new ApplicationNetworkDiagnostics();
  diagnostics.record(failure());
  diagnostics.record({ ...failure(), module: 'application' });
  diagnostics.record({ ...failure(), resourceType: 'mainFrame' });
  diagnostics.record({ ...failure(), error: 'net::ERR_NAME_NOT_RESOLVED' });
  expect(diagnostics.state()).toHaveLength(4);
  expect(diagnostics.state().every(row => row.count === 1)).toBe(true);
});

it('ignores normal navigation aborts, malformed URLs and non-HTTP resources without notifying listeners', () => {
  const report = vi.fn(); const changed = vi.fn(); const diagnostics = new ApplicationNetworkDiagnostics(report);
  diagnostics.subscribe(changed);
  for (const url of ['file:///private/file.png', 'data:image/png;base64,private', 'blob:https://example.com/private', 'worldlinebox://private', 'not a URL', `https://${'x'.repeat(2100)}.invalid/path`]) diagnostics.record(failure(url));
  for (const error of ['net::ERR_ABORTED', 'ERR_ABORTED']) diagnostics.record({ ...failure(), error });
  vi.advanceTimersByTime(1000);
  expect(diagnostics.state()).toEqual([]); expect(report).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
});

it('bounds the history at 40 recent rows and returns isolated snapshots', () => {
  const diagnostics = new ApplicationNetworkDiagnostics();
  for (let index = 0; index < 45; index++) diagnostics.record(failure(`https://host-${index}.example/private?secret=yes`));
  const snapshot = diagnostics.state();
  expect(snapshot).toHaveLength(40);
  expect(snapshot[0]!.origin).toBe('https://host-44.example');
  expect(snapshot.at(-1)!.origin).toBe('https://host-5.example');
  snapshot[0]!.origin = 'tampered'; snapshot.pop();
  expect(diagnostics.state()).toHaveLength(40);
  expect(diagnostics.state()[0]!.origin).toBe('https://host-44.example');
});

it('coalesces a burst of updates and stops delivering notifications after unsubscribe', () => {
  const diagnostics = new ApplicationNetworkDiagnostics(); const changed = vi.fn(); const stop = diagnostics.subscribe(changed);
  diagnostics.record(failure()); diagnostics.record(failure()); diagnostics.record(failure('http://another.example'));
  vi.advanceTimersByTime(249); expect(changed).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(changed).toHaveBeenCalledOnce();
  diagnostics.record(failure()); vi.advanceTimersByTime(250); expect(changed).toHaveBeenCalledTimes(2);
  stop(); diagnostics.record(failure()); vi.advanceTimersByTime(250); expect(changed).toHaveBeenCalledTimes(2);
});

it('clears immediately and cancels a pending broadcast instead of restoring stale failures', () => {
  const diagnostics = new ApplicationNetworkDiagnostics(); const changed = vi.fn(); diagnostics.subscribe(changed);
  diagnostics.record(failure()); diagnostics.clear();
  expect(diagnostics.state()).toEqual([]); expect(changed).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1000); expect(changed).toHaveBeenCalledOnce(); expect(diagnostics.state()).toEqual([]);
  diagnostics.record(failure()); expect(diagnostics.state()[0]!.count).toBe(1);
});

it('limits stored diagnostic field sizes and aggregates repeated normalized failures', () => {
  const diagnostics = new ApplicationNetworkDiagnostics();
  diagnostics.record({ ...failure(), error: 'x'.repeat(300), resourceType: 'r'.repeat(200) });
  diagnostics.record({ ...failure(), error: 'x'.repeat(300), resourceType: 'r'.repeat(200) });
  expect(diagnostics.state()).toHaveLength(1);
  expect(diagnostics.state()[0]!.error).toHaveLength(200);
  expect(diagnostics.state()[0]!.resourceType).toHaveLength(100);
  expect(diagnostics.state()[0]!.count).toBe(2);
});

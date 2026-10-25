import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionStorageClient } from '../../src/main/companions/storage-client';

const transport = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: transport.fork } }));
let client: CompanionStorageClient;
let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; postMessage: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> };
let report = vi.fn<(error: Error) => void>();
beforeEach(() => {
  vi.useFakeTimers(); report = vi.fn<(error: Error) => void>();
  child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), postMessage: vi.fn(), kill: vi.fn() });
  child.postMessage.mockImplementation(message => {
    if (message.type === 'storage.initialize') child.emit('message', { type: 'storage.ready' });
    if (message.type === 'storage.close') child.emit('message', { type: 'storage.closed' });
  });
  transport.fork.mockImplementation(() => { Promise.resolve().then(() => child.emit('message', { type: 'storage.booted' })); return child; });
  client = new CompanionStorageClient('worker.js', 'messages.sqlite', () => undefined, report);
});
afterEach(async () => { await client.close(); vi.useRealTimers(); });

it('settles a lost request after 30 seconds without replaying a mutation or killing its still-running worker', async () => {
  await client.start();
  const pending = client.request({ type: 'action.update', id: 'action_one', patch: { stage: '正在准备' } });
  const rejected = expect(pending).rejects.toThrow('action.update 等待超过 30 秒');
  await vi.advanceTimersByTimeAsync(30_000); await rejected;
  expect(report).toHaveBeenCalledOnce(); expect(child.kill).not.toHaveBeenCalled();
  const sent = child.postMessage.mock.calls.find(([message]) => message.command)?.[0];
  child.emit('message', { requestId: sent.requestId, response: { ok: true } });
  expect(child.postMessage.mock.calls.filter(([message]) => message.command)).toHaveLength(1);
  const next = client.request({ type: 'action.get', id: 'action_one' }); await Promise.resolve();
  const latest = child.postMessage.mock.calls.at(-1)![0];
  child.emit('message', { requestId: latest.requestId, response: { ok: true } });
  await expect(next).resolves.toEqual({ ok: true });
});

it('clears completed and closed request timers', async () => {
  await client.start();
  const completed = client.request({ type: 'action.get', id: 'action_one' }); await Promise.resolve();
  const sent = child.postMessage.mock.calls.at(-1)![0];
  child.emit('message', { requestId: sent.requestId, response: { ok: true } });
  await expect(completed).resolves.toEqual({ ok: true });
  const pending = client.request({ type: 'action.get', id: 'action_two' });
  const rejected = expect(pending).rejects.toThrow('伙伴存储已关闭'); await Promise.resolve();
  await client.close(); await rejected;
  await vi.advanceTimersByTimeAsync(60_000); expect(report).not.toHaveBeenCalled();
});

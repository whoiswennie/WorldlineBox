import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';

it('replies to an incompatible worker command with its request ID instead of silently dropping it', async () => {
  const previous = Object.getOwnPropertyDescriptor(process, 'parentPort');
  const before = new Set(process.listeners('exit'));
  const port = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  Object.defineProperty(process, 'parentPort', { configurable: true, value: port });
  try {
    await import('../../src/companions/worker');
    port.emit('message', { data: { requestId: 'request_one', command: { type: 'unknown.future-command' } } });
    expect(port.postMessage).toHaveBeenCalledWith({ requestId: 'request_one', response: { ok: false,
      error: '伙伴存储请求格式不匹配，请重启应用后重试。' } });
    const count = port.postMessage.mock.calls.length;
    port.emit('message', { data: { command: { type: 'unknown.future-command' } } });
    expect(port.postMessage.mock.calls).toHaveLength(count);
  } finally {
    for (const listener of process.listeners('exit')) if (!before.has(listener)) process.removeListener('exit', listener);
    if (previous) Object.defineProperty(process, 'parentPort', previous);
    else Reflect.deleteProperty(process, 'parentPort');
  }
});

import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { companionThoughtCapabilities } from '../../src/main/companions/thought-capabilities';

it('routes isolated thought and bounded record reads without replacing the existing world capability', async () => {
  const execute = vi.fn(async () => ({ world: true }));
  const run = vi.fn(async () => ({ analysis: 'actual result' }));
  const read = vi.fn(async () => ({ record: true }));
  const base = { tools: [{ name: 'world', description: 'existing', parameters: { type: 'object' } }], execute };
  const capabilities = companionThoughtCapabilities(base, { run, read });
  expect(capabilities.dshContext).toBe('thought');
  expect(capabilities.tools.map(tool => tool.name)).toEqual(['world', 'dsh']);
  expect(capabilities.tools[1]!.parameters).toMatchObject({ type: 'object', anyOf: expect.any(Array) });
  const signal = new AbortController().signal;
  const call = (name: string, input: unknown) => ({ id: 'stable-effect', name, arguments: JSON.stringify(input) });
  const worldCall = call('world', { operation: 'experience' });
  expect(await capabilities.execute(worldCall, signal)).toEqual({ world: true });
  expect(execute).toHaveBeenCalledWith(worldCall, signal);
  expect(await capabilities.execute(call('dsh', { tasks: [{ title: '核对依赖', prompt: '分析已提供的依赖。' }] }), signal))
    .toEqual({ analysis: 'actual result' });
  expect(run).toHaveBeenCalledWith({ title: '核对依赖', prompt: '分析已提供的依赖。' }, 'stable-effect', signal);
  const recordId = randomUUID();
  expect(await capabilities.execute(call('dsh', { operation: 'record', query: { recordId, start: 4, end: 4, textOffset: 2000 } }), signal))
    .toEqual({ record: true });
  expect(read).toHaveBeenCalledWith({ recordId, start: 4, end: 4, textOffset: 2000, entryChars: 2000 }, signal);
});

it('rejects execution permissions, unsupported operations, duplicate bindings and aborted calls', async () => {
  const run = vi.fn(async () => ({}));
  const base = { tools: [], execute: vi.fn(async () => ({})) };
  const capabilities = companionThoughtCapabilities(base, { run });
  const call = (input: unknown) => ({ id: 'effect', name: 'dsh', arguments: JSON.stringify(input) });
  await expect(capabilities.execute(call({ operation: 'run', tasks: [{ title: 't', prompt: 'p', tools: ['filesystem'] }] })))
    .rejects.toThrow();
  await expect(capabilities.execute(call({ operation: 'record', query: { recordId: randomUUID() } }))).rejects.toThrow();
  await expect(capabilities.execute(call({ operation: 'resume', sessionId: 'unowned' }))).rejects.toThrow();
  const controller = new AbortController(); controller.abort();
  await expect(capabilities.execute(call({ tasks: [{ title: 't', prompt: 'p' }] }), controller.signal)).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
  expect(() => companionThoughtCapabilities({ ...base, tools: capabilities.tools }, { run })).toThrow('已经绑定DSH');
});

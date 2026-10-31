import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { CompanionCapabilityJournal, type CompanionCapabilityScope } from '../../src/main/companions/capability-journal';
import type { CompanionAction } from '../../src/shared/companions';
import type { CompanionLoopCall } from '../../src/shared/companion-loop';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../src/shared/companion-storage';

const scope: CompanionCapabilityScope = { companionId: 'alice', conversationId: 'private_alice', invocationId: 'real_invocation', sourceMessageId: 'source', parentMessageId: 'reply' };
const call: CompanionLoopCall = { id: 'call_one', name: 'agenda', arguments: '{"action":"tasks.read"}' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) { for (let i = 0; i < 40 && !check(); i++) await Promise.resolve(); expect(check()).toBe(true); }
function fixture(options: { beforeBegin?: () => Promise<void>; finishFailure?: 'throw' | 'response'; readFailure?: 'throw' | 'response' } = {}) {
  const actions = new Map<string, CompanionAction>(), commands: CompanionStorageCommand[] = [], order: string[] = [], controllers = new Map<string, AbortController>();
  const changed = vi.fn(), report = vi.fn();
  const request = vi.fn(async (command: CompanionStorageCommand): Promise<CompanionStorageResponse> => {
    commands.push(structuredClone(command)); order.push(command.type);
    if (command.type === 'action.get') {
      if (options.readFailure === 'throw') throw Error('数据库暂不可用');
      if (options.readFailure === 'response') return { ok: false, error: '数据库暂不可用' };
      const action = actions.get(command.id); if (!action) throw Error('行动不存在。'); return { ok: true, action: structuredClone(action) };
    }
    if (command.type === 'capability.begin') {
      await options.beforeBegin?.();
      const id = 'cap_' + createHash('sha256').update(JSON.stringify([command.companionId, command.conversationId, command.invocationId, command.callId])).digest('hex');
      const action: CompanionAction = { id, companionId: command.companionId, conversationId: command.conversationId, status: 'running', title: command.title,
        parentMessageId: command.parentMessageId, sourceMessageId: command.sourceMessageId, createdAt: '2026-10-29T10:00:00.000Z', updatedAt: '2026-10-29T10:00:00.000Z',
        capability: { name: command.name, callId: command.callId, invocationId: command.invocationId, agendaRunId: command.agendaRunId,
          inputHash: createHash('sha256').update(command.input).digest('hex') }, events: [] };
      actions.set(id, action); return { ok: true, action: structuredClone(action) };
    }
    if (command.type === 'action.update') {
      if (options.finishFailure === 'throw') throw Error('完成日志写入失败');
      if (options.finishFailure === 'response') return { ok: false, error: '完成日志写入失败' };
      const previous = actions.get(command.id)!; const action = { ...previous, ...command.patch }; actions.set(command.id, action);
      return { ok: true, action: structuredClone(action) };
    }
    throw Error('Unexpected command: ' + command.type);
  });
  const journal = new CompanionCapabilityJournal({ request, changed, report, controller: (id, controller) => { if (controller) controllers.set(id, controller); else controllers.delete(id); } });
  const run = <T>(execute: (signal: AbortSignal) => Promise<T>, input = call, signal = new AbortController().signal) => journal.run(scope, input, signal, execute);
  return { journal, run, actions, commands, order, controllers, changed, report, request };
}

it('waits for durable visible begin before calling the actual operation', async () => {
  const begin = deferred<void>(), f = fixture({ beforeBegin: () => begin.promise });
  const execute = vi.fn(async () => { f.order.push('actual-operation'); expect(f.changed).toHaveBeenCalledTimes(1); expect(f.actions.size).toBe(1); return { ok: true }; });
  const task = f.run(execute); await until(() => f.commands.some(item => item.type === 'capability.begin'));
  expect(execute).not.toHaveBeenCalled(); begin.resolve(); await task;
  expect(f.order).toEqual(['action.get', 'capability.begin', 'actual-operation', 'action.update']);
  expect([...f.actions.values()][0]!.status).toBe('succeeded'); expect(f.controllers.size).toBe(0);
});

it.each([false, true])('records an explicit failed result, including wrapped tool content=%s', async wrapped => {
  const f = fixture(), data = { ok: false, error: '当前资料不满足条件。' }, result = wrapped ? { content: JSON.stringify(data) } : data;
  expect(await f.run(async () => result)).toBe(result);
  expect([...f.actions.values()][0]).toMatchObject({ status: 'failed', error: data.error, stage: data.error });
  expect([...f.actions.values()][0]!.events?.[0]?.type).toBe('capability.failed');
});

it('records a thrown operation failure and releases its cancellation controller', async () => {
  const f = fixture(), error = Error('读取操作失败');
  await expect(f.run(async () => { throw error; })).rejects.toBe(error);
  expect([...f.actions.values()][0]).toMatchObject({ status: 'failed', error: error.message }); expect(f.controllers.size).toBe(0);
});

it.each(['failed', 'cancelled'] as const)('preserves a native thought %s outcome rather than showing a successful capability', async outcome => {
  const f = fixture(), actual = { outcome, error: '原生思考没有完成。', result: '{"taskId":"actual-native-task"}' };
  expect(await f.run(async () => actual, { ...call, name: 'think' })).toBe(actual);
  const action = [...f.actions.values()][0]!;
  expect(action.status).toBe(outcome); expect(action.stage).toBe(actual.error);
  expect(action.events?.[0]?.type).toBe('capability.' + outcome);
  expect(JSON.parse(action.result!)).toEqual(actual);
});

it('records cancellation even if the underlying operation ignores abort and returns late', async () => {
  const f = fixture(), done = deferred<string>(), started = deferred<void>();
  const task = f.run(async signal => { expect(signal.aborted).toBe(false); started.resolve(); return done.promise; });
  const rejected = expect(task).rejects.toThrow('停止本次操作'); await started.promise;
  [...f.controllers.values()][0]!.abort(Error('停止本次操作')); done.resolve('迟到返回'); await rejected;
  expect([...f.actions.values()][0]!.status).toBe('cancelled'); expect(f.controllers.size).toBe(0);
});

it('does not register or execute an already aborted invocation', async () => {
  const f = fixture(), controller = new AbortController(), execute = vi.fn(async () => 'unused'); controller.abort(Error('已取消'));
  await expect(f.run(execute, call, controller.signal)).rejects.toThrow('已取消'); expect(execute).not.toHaveBeenCalled(); expect(f.commands).toEqual([]);
});

it('deduplicates a concurrent same call while independent calls run concurrently', async () => {
  const f = fixture(), first = deferred<string>(), second = deferred<string>();
  const executeFirst = vi.fn(async () => first.promise), executeSecond = vi.fn(async () => second.promise);
  const a = f.run(executeFirst), duplicate = f.run(executeFirst), b = f.run(executeSecond, { ...call, id: 'call_two' });
  expect(duplicate).toBe(a); await until(() => executeFirst.mock.calls.length === 1 && executeSecond.mock.calls.length === 1);
  expect(f.controllers.size).toBe(2); second.resolve('second'); expect(await b).toBe('second'); expect(f.controllers.size).toBe(1);
  first.resolve('first'); expect(await a).toBe('first'); expect(await duplicate).toBe('first'); expect(f.actions.size).toBe(2);
});

it.each(['running', 'succeeded', 'cancelled'] as const)('never resends an existing %s receipt after the local invocation ends', async status => {
  const f = fixture(); await f.run(async () => 'already returned');
  const existing = [...f.actions.values()][0]!; f.actions.set(existing.id, { ...existing, status });
  const execute = vi.fn(async () => 'must not rerun'); await expect(f.run(execute)).rejects.toThrow('已有原过程'); expect(execute).not.toHaveBeenCalled();
  expect(f.commands.filter(item => item.type === 'capability.begin')).toHaveLength(1);
});

it.each(['throw', 'response'] as const)('returns the actual result when completion journal fails by %s and never repeats the operation', async finishFailure => {
  const f = fixture({ finishFailure }), actual = { ok: true, realReceipt: 'actual-id' }, execute = vi.fn(async () => actual);
  expect(await f.run(execute)).toBe(actual); expect(execute).toHaveBeenCalledOnce(); expect(f.report).toHaveBeenCalledOnce();
  await expect(f.run(execute)).rejects.toThrow('已有原过程'); expect(execute).toHaveBeenCalledOnce();
});

it.each(['throw', 'response'] as const)('fails closed if the existing receipt cannot be read by %s', async readFailure => {
  const f = fixture({ readFailure }), execute = vi.fn(async () => 'hidden start');
  await expect(f.run(execute)).rejects.toThrow('数据库暂不可用'); expect(execute).not.toHaveBeenCalled();
  expect(f.commands.map(item => item.type)).toEqual(['action.get']);
});

it('returns the actual result even if both completion storage and its reporter fail', async () => {
  const f = fixture({ finishFailure: 'response' }), actual = { ok: true, taskId: 'actual-native-task' };
  f.report.mockImplementationOnce(() => { throw Error('错误报告也暂不可用'); });
  expect(await f.run(async () => actual)).toBe(actual);
  expect(f.report).toHaveBeenCalledOnce(); expect(f.controllers.size).toBe(0);
});

it('redacts credential fields in visible input and output while returning the unmodified actual value', async () => {
  const f = fixture(), input = { action: 'tasks.read', apiKey: 'private-input', nested: { token: 'nested-input', Password: 'password-input' }, safe: 'visible' };
  const actual = { content: JSON.stringify({ ok: true, secret: 'private-output', nested: { authorization: 'Bearer private-output', cookie: 'cookie-output' }, data: 'actual-result' }) };
  expect(await f.run(async () => actual, { ...call, arguments: JSON.stringify(input) })).toBe(actual);
  const begin = f.commands.find(item => item.type === 'capability.begin')!;
  expect(begin.type === 'capability.begin' && JSON.parse(begin.input)).toMatchObject({ apiKey: '[已隐藏凭据]', nested: { token: '[已隐藏凭据]', Password: '[已隐藏凭据]' }, safe: 'visible' });
  const receipt = [...f.actions.values()][0]!; expect(receipt.result).not.toContain('private-output'); expect(receipt.result).not.toContain('cookie-output');
  expect(JSON.parse(receipt.result!)).toMatchObject({ ok: true, data: 'actual-result', nested: { authorization: '[已隐藏凭据]' } });
});

it('redacts structured credential details in a visible thrown error without changing the original rejection', async () => {
  const f = fixture(), error = Error('{"error":"连接失败","token":"error-private-token"}');
  await expect(f.run(async () => { throw error; })).rejects.toBe(error);
  const receipt = [...f.actions.values()][0]!; expect(JSON.stringify(receipt)).not.toContain('error-private-token');
  expect(JSON.parse(receipt.error!)).toEqual({ error: '连接失败', token: '[已隐藏凭据]' });
});

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import type { VcpMemoryCommand, VcpMemoryOwnerPrompts, VcpMemoryPreparedPayload } from '../../src/main/vcp-memory/contracts';
import { VcpPreparedRecallStore } from '../../src/main/vcp-memory/prepared-recall-store';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
const prompts = (version: string): VcpMemoryOwnerPrompts => ({ aimemoTemplate: `${version} focus`, timelineTemplate: `${version} timeline`,
  summaryTemplate: `${version} summary`, focusGuidanceSignature: createHash('sha256').update(version).digest('hex') });
const options = (dataRoot: string) => ({ dataRoot, vendorRoot: path.resolve('vendor/vcp-memory'), workerPath: path.resolve('src/main/vcp-memory/worker.cjs'),
  embedding: { baseUrl: 'http://127.0.0.1', apiKey: 'fixture', model: 'fixture', dimension: 4 } });

it('captures immutable prompts before the first await for overlapping same-owner old/new/manual commands sharing one worker', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-query-prompts-')), events = new EventEmitter(), sent: VcpMemoryCommand[] = [];
  let ready!: () => void;
  const client = new VcpMemoryClient({ ...options(root), plugins: { ownerPrompts: prompts('current-one') }, launch: () => ({
    on: events.on.bind(events), kill: () => { events.emit('exit', 0); }, postMessage(message: unknown) {
      const { requestId, command } = message as { requestId: string; command: VcpMemoryCommand }; sent.push(command);
      const respond = () => { events.emit('message', { requestId, ok: true, value: { messages: [], events: [] }, ...(command.type === 'close' ? { cleanupComplete: true } : {}) });
        if (command.type === 'close') events.emit('exit', 0); };
      if (command.type === 'initialize') ready = respond; else queueMicrotask(respond);
    },
  }) });
  try {
    const original = prompts('old-task'), old = client.bindOwnerPrompts(original), next = client.bindOwnerPrompts(prompts('new-task'));
    original.aimemoTemplate = 'mutated caller';
    const pending = [old.preprocess({ scopeId: 'same-owner' }, [{ role: 'user', content: 'old' }]),
      next.timeline({ scopeId: 'same-owner' }, { operation: 'generateSummaries', agentName: 'fixture', month: '2026-11' }),
      client.preprocess({ scopeId: 'same-owner' }, [{ role: 'user', content: 'manual' }])];
    client.setOwnerPrompts(prompts('current-two'));
    await vi.waitFor(() => expect(ready).toBeTypeOf('function')); ready(); await Promise.all(pending);
    const commands = sent.filter(command => ['preprocess', 'timeline'].includes(command.type));
    expect(commands).toHaveLength(3);
    expect(commands.map(command => command.ownerPrompts)).toEqual([prompts('old-task'), prompts('new-task'), prompts('current-one')]);
    expect(() => old.setOwnerPrompts(prompts('forged'))).toThrow('immutable');
    await old.timeline({ scopeId: 'same-owner' }, { operation: 'generateTimelines' });
    expect(sent.at(-1)!.ownerPrompts).toEqual(prompts('old-task'));
  } finally { await client.close(); await removeOwnedDirectory(root); }
});

it('keeps detached focus receipt namespaces on the effective frozen signature while defaults and another lease change', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-query-prompts-')), client = new VcpMemoryClient({ ...options(root), plugins: { ownerPrompts: prompts('current') } });
  const store = new VcpPreparedRecallStore(root);
  const payload: VcpMemoryPreparedPayload = { schema: 'worldlinebox.prepared-recall-payload', groups: [],
    modelIdentity: createHash('sha256').update(JSON.stringify([null, null, null, null])).digest('hex'),
    receipt: { messages: [{ role: 'system', content: 'unchanged exact source inputs' }], events: [] } };
  const old = client.bindOwnerPrompts(prompts('old')), next = client.bindOwnerPrompts(prompts('new'));
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
  try {
    const first = await store.save('same-owner', payload);
    let paused = false;
    const focusing = old.focusRecall(first, { validate: async () => { if (!paused) { paused = true; enter(); await barrier; } } });
    await entered;
    client.setOwnerPrompts(prompts('later-current'));
    const newer = await store.save('same-owner', payload); await next.focusRecall(newer);
    release(); await focusing;
    const oldAgain = await store.save('same-owner', payload), result = await old.focusRecall(oldAgain);
    expect(result.receiptCache?.hit).toBe(true);
    const newAgain = await store.save('same-owner', payload); expect((await next.focusRecall(newAgain)).receiptCache?.hit).toBe(true);
    const manual = await store.save('same-owner', payload); expect((await client.focusRecall(manual)).receiptCache?.hit).not.toBe(true);
  } finally { release(); await client.close(); await store.close(); await removeOwnedDirectory(root); }
});

import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { DshTaskBroker, type DshTaskBrokerOptions } from '../../src/main/dsh/task-broker';
import type { NativeHostClient, NativeHostEvent } from '../../src/main/dsh/native-host-client';
import { dshInstanceSchema, dshRuntimeSchema } from '../../src/shared/dsh-launcher';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-native-broker-')); const workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const instance = dshInstanceSchema.parse({ id: 'native-instance', name: 'Native', runtimeId: 'native-runtime', createdAt: '', updatedAt: '', profile: 'web',
    status: 'running', homePath: path.join(root, 'home'), agentsPath: path.join(root, 'agents'), workspacePath: workspace, browserPartition: 'persist:test', isDefault: true });
  const runtime = dshRuntimeSchema.parse({ id: instance.runtimeId, version: '0.2.1-rc.2', nodeVersion: '24', platform: 'win32-x64', adapter: 'node-cli-web-v1',
    source: 'official', sourceSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64), installedAt: '', fileCount: 0, byteLength: 0 });
  const sessions = new Map<string, { events: NativeHostEvent[]; wait?: () => void; prompt?: string }>();
  const calls: Array<{ endpoint: string; input: Record<string, unknown> }> = [];
  const publish = (sessionId: string, event: Partial<NativeHostEvent>) => {
    const session = sessions.get(sessionId)!; session.events.push({ type: 'status', receivedAt: new Date().toISOString(), sequence: session.events.length, sessionId, ...event }); session.wait?.();
  };
  const capabilities = { modes: ['native'], preset: 'standard', tools: [{ name: 'pwsh', description: 'Native shell' }], skills: [], toolRestrictions: true, skillSelection: true,
    effective: { digest: 'c'.repeat(64), mode: 'native', preset: 'standard', toolCount: 1, skillCount: 0 } };
  const client = { pid: 5678, request: vi.fn(async (endpoint: string, input: Record<string, unknown>) => {
    calls.push({ endpoint, input });
    if (endpoint === '/capabilities') return capabilities;
    if (endpoint === '/sessions') {
      const id = String(input.sessionId); if (!sessions.has(id)) sessions.set(id, { events: [] });
      return { sessionId: id, cursor: sessions.get(id)!.events.length - 1, capabilities, accessMode: input.accessMode ?? 'danger-full-access' };
    }
    const id = endpoint.split('/')[2]!;
    if (endpoint.endsWith('/cancel')) { publish(id, { type: 'complete', status: 'cancelled' }); return { accepted: true }; }
    if (endpoint.endsWith('/prompt')) {
      sessions.get(id)!.prompt = String(input.prompt);
      if (!String(input.prompt).startsWith('wait')) publish(id, { type: 'complete', status: 'succeeded', text: String(input.prompt).startsWith('json') ? '{"count":2}' : 'native reply' });
      return { accepted: true, ...(Array.isArray(input.visualInputs) ? { visualInputsAccepted: input.visualInputs.map(({ mime, sha256, source }: { mime: string; sha256: string; source: object }) => ({ mime, sha256, source })) } : {}) };
    }
    throw new Error('Unexpected native operation: ' + endpoint);
  }), async *events(id: string, after: number, signal: AbortSignal) {
    const session = sessions.get(id)!;
    while (!signal.aborted) {
      for (const event of session.events.filter(event => event.sequence > after)) { after = event.sequence; yield event; }
      await new Promise<void>((resolve, reject) => {
        session.wait = resolve; const abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  } } as unknown as NativeHostClient;
  const getHost = vi.fn<DshTaskBrokerOptions['getHost']>(async () => ({ instance, runtime, client }));
  const broker = new DshTaskBroker({ rootPath: root, getHost });
  cleanups.push(async () => { await broker.shutdown(); await rm(root, { recursive: true, force: true }); });
  const operation = () => ({ id: randomUUID(), signal: new AbortController().signal, log: async () => undefined, update: async () => undefined });
  const scope = { actionId: randomUUID(), companionId: 'fish', conversationId: 'room', sourceMessageId: 'user-message' };
  return { broker, root, workspace, client, getHost, calls, operation, scope, publish };
}
it('bounds reset host startup and retains owned task records when native cleanup times out', async () => {
  const f = await fixture(), operation = f.operation();
  await f.broker.execute({ prompt: 'hello', title: 'Finished owner task' }, operation, { recordScope: f.scope });
  const abort = new AbortController(), deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(abort.signal);
  let received: AbortSignal | undefined;
  f.getHost.mockImplementationOnce(async (_id, signal) => {
    received = signal;
    return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
  });
  try {
    const resetting = f.broker.removeCompanionRecords('fish');
    const rejected = expect(resetting).rejects.toThrow('原生任务记录清理超时');
    await vi.waitFor(() => expect(received).toBe(abort.signal)); abort.abort(new Error('fixture timeout')); await rejected;
    expect(deadline).toHaveBeenCalledWith(120000);
    expect(f.broker.state().some(record => record.id === operation.id)).toBe(true);
    expect((await f.broker.readRecord({ recordId: operation.id })).overview.recordId).toBe(operation.id);
  } finally { deadline.mockRestore(); }
});
it('submits native Session parameters and keeps model/account configuration in the Host', async () => {
  const f = await fixture(), op = f.operation();
  const result = await f.broker.execute({ prompt: 'hello', title: 'Native task' }, op, { recordScope: f.scope, task: { instructions: 'read only' } });
  expect(result.text).toBe('native reply'); expect(f.broker.state()[0]).toMatchObject({ pid: f.client.pid, status: 'succeeded', accessMode: 'danger-full-access' });
  const create = f.calls.find(value => value.endpoint === '/sessions')!;
  expect(create.input).toMatchObject({ cwd: f.workspace, policy: {} });
  expect(create.input.accessMode).toBe('danger-full-access'); expect(create.input).not.toHaveProperty('model');
  expect(f.calls.find(value => value.endpoint.endsWith('/prompt'))?.input.prompt).toContain('read only');
  const saved = await f.broker.readRecord({ recordId: op.id }); expect(saved.overview.status).toBe('succeeded');
});
it('submits validated Main-only observation pixels to a zero-tool native Session and archives only their acceptance manifest', async () => {
  const f = await fixture(), op = f.operation(), bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'blue' } }).png().toBuffer();
  const visual = { mime: 'image/png' as const, dataBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'),
    source: { kind: 'observation_storyboard' as const, sourceId: 'window:1:0', observedAt: '2026-10-29T10:00:00.000Z' } };
  const scope = { ...f.scope, agendaOrigin: { runId: 'actual_run', ruleId: 'actual_rule', occurrenceId: 'actual_occurrence', grantId: 'actual_grant', grantRevision: 1 } };
  const result = await f.broker.execute({ prompt: '请只分析实际抽样画面，不当作完整视频。' }, op, { cognitiveOnly: true, recordScope: scope,
    workspaceRootPath: path.join(f.root, 'owner-workspaces'), visualInputs: [visual] });
  expect(result.text).toBe('native reply');
  const session = f.calls.find(call => call.endpoint === '/sessions')!;
  const manifest = [{ mime: visual.mime, sha256: visual.sha256, source: visual.source }];
  expect(session.input).toMatchObject({ accessMode: 'read-only', policy: { cognitiveOnly: true, tools: [], skills: [], visualInputManifest: manifest } });
  const submission = f.calls.find(call => call.endpoint.endsWith('/prompt'))!.input;
  expect(submission.visualInputs).toEqual([visual]); expect(submission.prompt).not.toContain(visual.dataBase64);
  const events = await f.broker.readEvents(op.id);
  expect(JSON.stringify(events)).toContain('visual_inputs_accepted'); expect(JSON.stringify(events)).toContain(visual.sha256);
  expect(JSON.stringify(events)).not.toContain(visual.dataBase64);
});
it('uses one Host for parallel partner tasks with separate native Sessions', async () => {
  const f = await fixture(); const results = await Promise.all([1, 2].map(() => f.broker.execute({ prompt: 'hello' }, f.operation())));
  expect(results[0]!.sessionId).not.toBe(results[1]!.sessionId); expect(new Set(f.broker.state().map(value => value.pid))).toEqual(new Set([5678]));
  expect(f.calls.filter(value => value.endpoint === '/sessions')).toHaveLength(2);
});
it('replays complete parent reports across event-ring overflow and a broker restart', async () => {
  const f = await fixture(), operation = f.operation();
  const executing = f.broker.execute({ prompt: 'wait for report replay' }, operation, { recordScope: f.scope });
  await vi.waitFor(() => expect(f.calls.some(call => call.endpoint.endsWith('/prompt'))).toBe(true));
  const sessionId = f.broker.state().find(task => task.id === operation.id)!.sessionId!;
  const checkpoint = JSON.stringify({ kind: 'checkpoint', text: '不能截断的阶段成果'.repeat(1000) });
  f.publish(sessionId, { type: 'parent_report', text: checkpoint, callId: 'durable-report' });
  for (let index = 0; index < 1050; index++) f.publish(sessionId, { type: 'status', summary: '后续进度 ' + index });
  f.publish(sessionId, { type: 'complete', status: 'succeeded', text: '已完成' }); await executing;
  expect(f.broker.events(operation.id).some(event => event.type === 'parent_report')).toBe(false);
  const first = await f.broker.readEvents(operation.id);
  expect(first.taskEvents.find(event => event.type === 'parent_report')?.text).toBe(checkpoint);
  expect(first.taskEventsHasMore).toBe(true);
  await f.broker.shutdown();
  const restored = new DshTaskBroker({ rootPath: f.root, getHost: f.getHost });
  try {
    let after = -1, done = false; const sequences: number[] = [], reports: string[] = [];
    while (!done) {
      const page = await restored.readEvents(operation.id, after);
      for (const event of page.taskEvents) { sequences.push(event.sequence); if (event.type === 'parent_report') reports.push(event.text!); }
      after = page.taskEvents.at(-1)?.sequence ?? after; done = !page.taskEventsHasMore;
    }
    expect(new Set(sequences).size).toBe(sequences.length); expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, index) => index));
    expect(reports).toEqual([checkpoint]); expect(sequences.length).toBeGreaterThan(1000);
  } finally { await restored.shutdown(); }
});
it('names a partner’s native workspace from Main and reuses its directory across task Sessions', async () => {
  const f = await fixture();
  const execution = { recordScope: f.scope, companionName: '小肥鱼', workspaceRootPath: path.join(f.root, 'partners') };
  const first = await f.broker.execute({ prompt: 'hello' }, f.operation(), execution);
  const second = await f.broker.execute({ prompt: 'hello' }, f.operation(), { ...execution, companionName: '新名字' });
  expect(first.sessionId).not.toBe(second.sessionId); expect(first.workspacePath).toBe(second.workspacePath);
  expect(f.calls.filter(call => call.endpoint === '/sessions').map(call => call.input.workspaceTitle)).toEqual(['小肥鱼', '新名字']);
  await f.broker.execute({ prompt: 'hello' }, f.operation(), { ...execution, allowedWorkspaceRoots: [f.workspace], task: { workspace: { mode: 'existing', path: f.workspace } } });
  expect(f.calls.filter(call => call.endpoint === '/sessions').at(-1)!.input).not.toHaveProperty('workspaceTitle');
});
it('isolates concurrent invocations of one partner while reusing the same invocation workspace', async () => {
  const f = await fixture();
  const execution = { recordScope: { ...f.scope, invocationId: 'website-a' }, companionName: '同一伙伴', workspaceRootPath: path.join(f.root, 'partners') };
  const [first, second] = await Promise.all([
    f.broker.execute({ prompt: 'build website a' }, f.operation(), execution),
    f.broker.execute({ prompt: 'build website b' }, f.operation(), { ...execution, recordScope: { ...f.scope, invocationId: 'website-b' } }),
  ]);
  expect(first.sessionId).not.toBe(second.sessionId);
  expect(first.workspacePath).not.toBe(second.workspacePath);
  const sessions = f.calls.filter(call => call.endpoint === '/sessions');
  expect(sessions.map(call => call.input.cwd)).toEqual([path.join(f.root, 'partners', 'fish'), path.join(f.root, 'partners', 'fish')]);
  expect(f.calls.filter(call => call.endpoint.endsWith('/prompt')).map(call => call.input.prompt)).toEqual(expect.arrayContaining([
    expect.stringContaining(first.workspacePath!), expect.stringContaining(second.workspacePath!),
  ]));
  const nextStep = await f.broker.execute({ prompt: 'verify website a' }, f.operation(), execution);
  expect(nextStep.workspacePath).toBe(first.workspacePath);
});
it('does not treat rejected native Session creation as unconfirmed running work', async () => {
  const f = await fixture(); const original = vi.mocked(f.client.request).getMockImplementation()!;
  vi.mocked(f.client.request).mockImplementationOnce(async () => { throw new Error('Unknown native tool'); });
  await expect(f.broker.execute({ prompt: 'hello' }, f.operation())).rejects.toThrow('Unknown native tool');
  expect(f.calls.some(call => call.endpoint.endsWith('/cancel'))).toBe(false);
  vi.mocked(f.client.request).mockImplementation(original);
  expect((await f.broker.execute({ prompt: 'hello' }, f.operation())).text).toBe('native reply');
});
it('cancels only the selected Session and leaves the other partner operational', async () => {
  const f = await fixture(), op = f.operation(); const pending = f.broker.execute({ prompt: 'wait' }, op); const rejection = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(f.calls.some(value => value.endpoint.endsWith('/prompt'))).toBe(true));
  f.broker.cancel(op.id); await rejection;
  expect(f.calls.filter(value => value.endpoint.endsWith('/cancel'))).toHaveLength(1);
  expect((await f.broker.execute({ prompt: 'hello' }, f.operation())).text).toBe('native reply');
});
it('discovers the live native registry without a model prompt or task record', async () => {
  const f = await fixture(); expect((await f.broker.discover()).tools[0]!.name).toBe('pwsh');
  expect(f.calls.map(value => value.endpoint)).toEqual(['/capabilities']); expect(f.broker.state()).toEqual([]);
});
it('holds early follow-ups until the native prompt is accepted and deduplicates simultaneous delivery', async () => {
  const f = await fixture(), op = f.operation(); let release!: () => void;
  const original = f.getHost.getMockImplementation()!;
  f.getHost.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return original(); });
  const task = f.broker.execute({ prompt: 'wait for follow-up' }, op);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const first = f.broker.sendInput(op.id, 'continue', 'steer', 'same-message');
  const duplicate = f.broker.sendInput(op.id, 'continue', 'steer', 'same-message');
  expect(f.calls).toHaveLength(0); release(); await Promise.all([first, duplicate]); await task;
  expect(f.calls.filter(call => call.input.messageId === 'same-message')).toHaveLength(1);
});
it('records unconfirmed cancellation as interrupted and blocks resume until native termination is confirmed', async () => {
  const f = await fixture(), op = f.operation();
  const original = vi.mocked(f.client.request).getMockImplementation()!; let refuse = true;
  vi.mocked(f.client.request).mockImplementation(async (...args) => {
    if (args[0].endsWith('/cancel') && refuse) throw new Error('transport unavailable');
    return original(...args);
  });
  const pending = f.broker.execute({ prompt: 'wait' }, op, { recordScope: f.scope }); const rejection = expect(pending).rejects.toThrow('unconfirmed');
  await vi.waitFor(() => expect(f.calls.some(call => call.endpoint.endsWith('/prompt'))).toBe(true));
  f.broker.cancel(op.id); await rejection; expect(f.broker.state()[0]!.status).toBe('interrupted');
  await expect(f.broker.execute({ prompt: 'resume' }, f.operation(), { recordScope: f.scope, task: { session: { mode: 'resume', taskId: op.id } } })).rejects.toThrow('unconfirmed');
  refuse = false; await f.broker.terminate(op.id); expect(f.broker.state()[0]!.status).toBe('cancelled');
});
it('validates JSON delivery and preserves the exact user constraints sent to DSH', async () => {
  const f = await fixture(); const constraint = { id: 'readonly', sourceMessageId: 'user-message', text: '不得修改文件；只列出第一层', kind: 'constraint' as const };
  const result = await f.broker.execute({ prompt: 'json delivery' }, f.operation(), { constraints: [constraint], task: { delivery: {
    format: 'json', jsonSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] } } } });
  expect(result.structured).toEqual({ count: 2 }); expect(result.verification?.jsonSchema).toBe(true);
  expect(String(f.calls.find(value => value.endpoint.endsWith('/prompt'))?.input.prompt)).toContain(constraint.text);
  expect(String(f.calls.find(value => value.endpoint.endsWith('/prompt'))?.input.prompt)).not.toContain('sourceMessageId');
  expect(f.broker.state()[0]!.constraintsDigest).toMatch(/^[a-f0-9]{64}$/u);
});
it('rejects unauthorized Session reuse and foreign partner checkpoints before dispatch', async () => {
  const f = await fixture(); await expect(f.broker.execute({ prompt: 'hello', sessionId: 'foreign' }, f.operation())).rejects.toThrow('checkpoint');
  const first = f.operation(); await f.broker.execute({ prompt: 'hello' }, first, { recordScope: f.scope });
  const count = f.calls.length;
  await expect(f.broker.execute({ prompt: 'hello' }, f.operation(), { recordScope: { ...f.scope, companionId: 'other' }, task: { session: { mode: 'resume', taskId: first.id } } })).rejects.toThrow('another companion');
  expect(f.calls).toHaveLength(count);
});
it('continues an authorized native Session while retaining its workspace and tool selection', async () => {
  const f = await fixture(), first = f.operation(); const before = await f.broker.execute({ prompt: 'hello' }, first, { recordScope: f.scope, task: { tools: ['pwsh'] } });
  const after = await f.broker.execute({ prompt: 'continue' }, f.operation(), { recordScope: f.scope, task: { session: { mode: 'resume', taskId: first.id } } });
  expect(after.sessionId).toBe(before.sessionId); expect(after.workspacePath).toBe(before.workspacePath);
  expect(f.calls.filter(value => value.endpoint === '/sessions')[1]!.input.policy).toMatchObject({ tools: ['pwsh'] });
});
it('rejects a claimed artifact that does not exist before reporting success', async () => {
  const f = await fixture(); await writeFile(path.join(f.workspace, 'present.txt'), 'actual');
  await expect(f.broker.execute({ prompt: 'hello' }, f.operation(), { task: { delivery: { format: 'text', artifacts: [{ path: 'missing.txt' }] } } })).rejects.toThrow('not presented');
  expect(f.broker.state()[0]!.status).toBe('failed');
});

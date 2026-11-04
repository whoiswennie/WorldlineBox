import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { createBotNativeHost } from '../fixtures/bot-native-host';
import { preserveBotNativeJournals } from '../fixtures/bot-native-journal-evidence';

type Message = { role: string; content?: string };
type Workspace = { id: string; path: string; title: string; sessionIds: string[] };
type JournalRecord = { type: string; id?: string; cwd?: string; data?: { cwd?: string; title?: string; source?: { kind: string } } };

// Real installed DSH Host, native workspaces, Session journals and write tools.
// Only provider completions/effect acknowledgements are local protocol fixtures;
// this never borrows the user's Host, account, task prompts or private history.
it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('shares a companion-named native workspace while task Sessions keep their names and independent real working directories across restart', async () => {
  const requests: Array<{ messages: Message[] }> = [], effects: string[] = [];
  let writes = 0;
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const input = JSON.parse(text);
    if (request.url === '/bot/tool') {
      expect(request.headers.authorization).toBe('Bearer ' + 'f'.repeat(64));
      expect(['worker_effect_start', 'worker_effect_commit']).toContain(input.name); effects.push(input.name);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true,
        result: input.name === 'worker_effect_start' ? { state: 'admitted', callId: input.callId } : { recorded: true } })); return;
    }
    requests.push(input);
    const used = input.messages.some((message: Message) => message.role === 'tool');
    const marker = input.messages.map((message: Message) => message.content ?? '').join('\n').includes('WORKSPACE_TASK_A') ? 'A' : 'B';
    const delta = used ? { content: `已完成隔离任务${marker}。` } : { tool_calls: [{ index: 0, id: 'workspace-write-' + randomUUID(), type: 'function',
      function: { name: 'write', arguments: JSON.stringify({ file_path: 'same-name.txt', content: `Independent task ${marker}` }) } }] };
    if (!used) writes++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: used ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }) + '\n\n');
    response.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No native workspace fixture port.');
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  let client = await native.instances.ensureHost(native.instance.id);
  const brain = new BotDshBrain({ getHost: async () => ({ client }) });
  const project = path.join(native.root, 'companions', '大肥鱼'), directory = path.resolve('artifacts/superagent-bot-development/workspace-grouping-native');
  const common = { role: 'worker' as const, workerAccess: 'scoped' as const, tools: [], workspaceTitle: '大肥鱼', workspaceParent: { path: project, title: '大肥鱼' },
    callback: { url: `http://127.0.0.1:${address.port}/bot/tool`, token: 'f'.repeat(64) },
    model: { apiFormat: 'openai_chat' as const, model: 'protocol-fixture', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'local-no-billing' } };
  const tasks = [
    { ...common, laneId: 'worker-workspace-a', eventId: 'work-workspace-a', cwd: path.join(project, 'task-a'), sessionTitle: '整理附件', system: 'WORKSPACE_TASK_A: Write only in this task directory.', prompt: 'WORKSPACE_TASK_A' },
    { ...common, laneId: 'worker-workspace-b', eventId: 'work-workspace-b', cwd: path.join(project, 'task-b'), sessionTitle: '查询天气', system: 'WORKSPACE_TASK_B: Write only in this task directory.', prompt: 'WORKSPACE_TASK_B' },
  ];
  const inspect = (task: typeof tasks[number]) => client.request<{ workspace: Workspace }>('/bot/lanes', { ...task, sessionId: BotDshBrain.sessionId(task.laneId) });
  const journals = async (name: string) => {
    const filename = path.join(directory, name); await preserveBotNativeJournals(native.root, filename, value => value.replaceAll('local-no-billing', '<fixture-key>').replaceAll('f'.repeat(64), '<fixture-token>'));
    return JSON.parse(await readFile(filename, 'utf8')) as Array<{ path: string; records: JournalRecord[] }>;
  };
  try {
    await mkdir(directory, { recursive: true });
    const first = await Promise.all(tasks.map(task => brain.run(task)));
    expect(first.map(result => result.text)).toEqual(['已完成隔离任务A。', '已完成隔离任务B。']);
    const before = await Promise.all(tasks.map(inspect));
    expect(before[0]!.workspace.id).toBe(before[1]!.workspace.id);
    expect(before[0]!.workspace).toMatchObject({ path: project, title: '大肥鱼' });
    expect([...before[1]!.workspace.sessionIds].sort()).toEqual(first.map(result => result.sessionId).sort());
    expect(await readFile(path.join(tasks[0]!.cwd, 'same-name.txt'), 'utf8')).toBe('Independent task A');
    expect(await readFile(path.join(tasks[1]!.cwd, 'same-name.txt'), 'utf8')).toBe('Independent task B');
    expect(effects.filter(name => name === 'worker_effect_start')).toHaveLength(2);
    expect(effects.filter(name => name === 'worker_effect_commit')).toHaveLength(2);
    const beforeRestartRequests = requests.length;
    await brain.close(); await native.instances.stop(native.instance.id);
    const physical = await journals('before-restart-journals.json');
    for (const [index, task] of tasks.entries()) {
      const journal = physical.find(value => value.records[0]?.id === first[index]!.sessionId);
      expect(journal, 'Native Session journal is missing').toBeDefined();
      expect(journal!.records[0]).toMatchObject({ type: 'session', cwd: project });
      expect(journal!.records.filter(record => record.type === 'working-directory/change').at(-1)?.data?.cwd).toBe(task.cwd);
      expect(journal!.records.filter(record => record.type === 'session/title').at(-1)?.data).toMatchObject({ title: task.sessionTitle, source: { kind: 'user' } });
    }
    client = await native.instances.ensureHost(native.instance.id);
    const restored = await Promise.all(tasks.map(inspect));
    expect(restored.map(value => value.workspace)).toEqual(before.map(value => value.workspace));
    expect(await Promise.all(tasks.map(task => brain.run(task)))).toEqual(first);
    expect(writes).toBe(2); expect(requests).toHaveLength(beforeRestartRequests);
    await brain.close(); await native.instances.stop(native.instance.id);
    const after = await journals('after-restart-journals.json');
    for (const [index, task] of tasks.entries()) {
      const journal = after.find(value => value.records[0]?.id === first[index]!.sessionId)!;
      expect(journal.records[0]?.cwd).toBe(project);
      expect(journal.records.filter(record => record.type === 'working-directory/change').at(-1)?.data?.cwd).toBe(task.cwd);
      expect(journal.records.filter(record => record.type === 'session/title').at(-1)?.data?.title).toBe(task.sessionTitle);
    }
    await writeFile(path.join(directory, 'evidence.json'), JSON.stringify({ actualNativeHost: true, runtimeVersion: native.runtimeVersion,
      actualModelInference: false, productionStateReadOrWritten: false, workspace: before[1]!.workspace, taskNames: tasks.map(task => task.sessionTitle),
      independentRealWrites: true, stableHeaderProject: true, effectiveTaskDirectories: true, restartTitlesAndRegistryPreserved: true,
      providerRequests: requests.length, duplicateWritesAfterRestart: writes - 2, paidRequests: 0 }, null, 2) + '\n');
  } finally {
    await brain.close().catch(() => undefined); await native.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 180000);

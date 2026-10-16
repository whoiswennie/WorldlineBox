import { afterEach, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { companionRuntimeSource } from '../../src/main/dsh/companion-runtime-source';
import { prepareNativeCliMode } from '../../src/main/dsh/cli-profile-mode';
import { dshTaskExecutionPatch } from '../../src/main/dsh/task-execution';
import { canonicalRuntimeEntryPaths } from '../../src/main/dsh/runtime-paths';
import { instanceEnvironment, launchCli, terminateOwnedProcess } from '../../src/main/dsh/instance-process';
import { removeManaged } from '../../src/main/dsh/files';

const program = process.env.WORLDLINEBOX_DSH_NATIVE_PROGRAM ?? path.resolve('.tools/dsh-native-node/manager/runtimes/runtime-79b482dcb2445eba3925bbfb/program');
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(tmpdir(), root); });

it.skipIf(process.platform !== 'win32' || !existsSync(path.join(program, 'bin/node.exe')))('executes two real native companion tasks with the stored profile model and key, without a Web Host or configuration rewrite', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-native-profile-')); roots.push(root);
  const home = path.join(root, 'home'), workspace = path.join(root, 'workspace'); await mkdir(workspace);
  const sdk = path.join(program, 'dsh/node_modules');
  const anchor = path.join(sdk, '@deepseek-ai/dsh/package.json');
  const { version } = JSON.parse(await readFile(anchor, 'utf8')) as { version: string };
  const plan = { ...canonicalRuntimeEntryPaths(program, 'node-cli-web-v1'), env: {} };
  const env = await instanceEnvironment(root, { id: 'fixture', name: 'fixture', runtimeId: 'fixture', profile: 'web', status: 'stopped',
    homePath: home, agentsPath: path.join(root, 'agents'), workspacePath: workspace, browserPartition: 'temporary:profile', isDefault: false, createdAt: '', updatedAt: '' }, plan);
  env.DSH_TELEMETRY_DISABLED = '1';
  const init = path.join(root, 'initialize.mjs');
  await writeFile(init, `import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';const load=createRequire(${JSON.stringify(anchor)});const native=await import(pathToFileURL(load.resolve('@deepseek-ai/dsh-app-boot')));native.initProfile(${JSON.stringify(path.join(home, 'profiles/web'))},['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']);`);
  const initializer = await launchCli({ ...plan, cli: init }, [], env, workspace); initializer.stdout.resume(); initializer.stderr.resume();
  try { expect(await new Promise<number | null>((resolve, reject) => { initializer.once('error', reject); initializer.once('close', resolve); })).toBe(0); }
  finally { await terminateOwnedProcess(initializer); }

  const requests: Array<{ key: string | string[] | undefined; model: string; path: string }> = [];
  const key = 'synthetic-native-instance-key';
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { model: string; stream?: boolean };
    requests.push({ key: incoming.headers['x-api-key'], model: body.model, path: incoming.url ?? '' });
    if (incoming.url?.endsWith('/count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 5 })); return; }
    const text = 'NATIVE_INSTANCE_CONFIGURATION_CONFIRMED';
    if (!body.stream) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'synthetic-message', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } })); return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'message_start', message: { id: 'synthetic-message', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const profileFile = path.join(home, 'profiles/web/cordis.patch.yml'), credentialsFile = path.join(home, '.credentials.yaml');
  await writeFile(profileFile, JSON.stringify([{ id: 'llm-deepseek', config: { baseURL: `http://127.0.0.1:${port}/v1` } }, { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } }]));
  await writeFile(credentialsFile, `version: 1\nrefs:\n  DEEPSEEK_API_KEY: ${key}\nrecords: {}\n`);
  const before = await readFile(profileFile), credentialsBefore = await readFile(credentialsFile);
  const plugin = path.join(root, 'companion.mjs'), patch = path.join(root, 'task.patch.json');
  await writeFile(plugin, companionRuntimeSource(anchor));
  await writeFile(patch, JSON.stringify([...dshTaskExecutionPatch({ toolkit: true, interactive: true }), { id: 'headless-startup', disabled: true }, { id: 'headless-runner', disabled: true }, { insert: [{ id: 'worldlinebox-companion-runtime', name: plugin }] }]));
  const prefix = await prepareNativeCliMode(root, program, version);
  try {
    const durations: number[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = performance.now();
      const child = await launchCli(plan, [...prefix, '--patch', patch], env, workspace);
      let output = '', diagnostics = '', pending = '', sent = false;
      child.stdout.on('data', chunk => {
        output += chunk; pending += chunk;
        for (let at = pending.indexOf('\n'); at >= 0; at = pending.indexOf('\n')) {
          const line = pending.slice(0, at); pending = pending.slice(at + 1);
          if (!line.startsWith('{')) continue;
          const event = JSON.parse(line);
          if (event.type === 'ready' && !sent) { sent = true; child.stdin.write(JSON.stringify({ type: 'start', requestId: 'synthetic-input', content: 'Return the local fixture response.', sourceInputId: 'synthetic-input' }) + '\n'); }
        }
      });
      child.stderr.on('data', chunk => { diagnostics += chunk; });
      const timer = setTimeout(() => { console.error('Native task readiness timeout', { output: output.slice(-8000), diagnostics: diagnostics.slice(-4000), prefix }); void terminateOwnedProcess(child); }, 40000);
      try {
        const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        expect(code, output + diagnostics).toBe(0);
        const events = output.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
        expect(events.find(event => event.type === 'final')?.text).toBe('NATIVE_INSTANCE_CONFIGURATION_CONFIRMED');
        expect(output).not.toContain('dsh web:');
        expect(await readFile(profileFile)).toEqual(before); expect(await readFile(credentialsFile)).toEqual(credentialsBefore);
        durations.push(Math.round(performance.now() - started));
      } finally { clearTimeout(timer); await terminateOwnedProcess(child); }
    }
    // The native loop may perform more than one model step for a task.
    expect(requests.filter(request => request.path.endsWith('/messages')).length).toBeGreaterThanOrEqual(2);
    expect(requests.every(request => request.key === key && request.model === 'deepseek-flash')).toBe(true);
    console.log(`Native ${version} configured companion tasks (local synthetic model): ${durations.join(' ms, ')} ms`);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 100000);

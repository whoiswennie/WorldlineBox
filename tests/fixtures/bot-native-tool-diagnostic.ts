/** No paid model: a local deterministic protocol driver invokes genuine native
 * DSH tools and records the real tool receipts delivered back to the provider. */
import { app } from 'electron';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createBotNativeHost } from './bot-native-host';
import { preserveBotNativeJournals } from './bot-native-journal-evidence';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { BotToolServer } from '../../src/main/companion-bot/tool-server';
import { createOwnedNativeEffectHost } from './bot-native-effect-host';

const root = process.env.WORLDLINEBOX_BOT_REAL_ROOT!, source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT!;
const output = process.env.WORLDLINEBOX_BOT_DSH_CAPABILITY_OUTPUT!;
if (!root || !source || !output || process.env.WORLDLINEBOX_BOT_NATIVE_DIAGNOSTIC !== '1') throw new Error('Explicit owned no-paid diagnostic input required.');
app.setPath('userData', path.join(root, 'electron-profile')); app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
  const providerRequests: unknown[] = [], events: unknown[] = [], errors: unknown[] = [];
  const report: Record<string, unknown> = { kind: 'bot-dsh-capability-result', mode: 'deterministic-local-tool-protocol-diagnostic', usesPaidModel: false,
    modelQualityAcceptance: false, passed: false, providerRequests, events, errors };
  let native: Awaited<ReturnType<typeof createBotNativeHost>> | undefined, worker: BotDshBrain | undefined, tools: BotToolServer | undefined;
  const effects = createOwnedNativeEffectHost(path.join(root, 'effect-host.sqlite'));
  const cwd = path.join(root, 'tool-probe'), desktop = path.join(root, 'Desktop'); await mkdir(cwd); await mkdir(desktop);
  await writeFile(path.join(desktop, 'owned-probe-name.txt'), 'do not read this content');
  let calls = 0;
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const bytes of request) raw += bytes;
      const body = JSON.parse(raw); providerRequests.push(body); calls++;
      const step = calls === 1 ? { name: 'pwsh', arguments: { description: 'List owned diagnostic desktop file names', command: `Get-ChildItem -LiteralPath '${desktop.replaceAll("'", "''")}' -File | Select-Object -ExpandProperty Name`, workdir: cwd } }
        : calls === 2 ? { name: 'write', arguments: { file_path: path.join(cwd, 'native-probe.txt'), content: 'genuine native write probe\n' } }
          : undefined;
      const message = step ? { role: 'assistant', content: null, tool_calls: [{ id: `native-local-probe-${calls}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] }
        : { role: 'assistant', content: '本机协议探针结束；请以原生工具回执为准。' };
      if (body.stream) {
        response.setHeader('content-type', 'text/event-stream');
        const delta = step ? { role: 'assistant', tool_calls: [{ index: 0, id: `native-local-probe-${calls}`, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.arguments) } }] }
          : { role: 'assistant', content: message.content };
        const chunk = (value: unknown) => `data: ${JSON.stringify({ id: `local-probe-${calls}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'local-protocol-fixture', choices: [value] })}\n\n`;
        response.end(chunk({ index: 0, delta, finish_reason: null }) + chunk({ index: 0, delta: {}, finish_reason: step ? 'tool_calls' : 'stop' }) + 'data: [DONE]\n\n');
      } else {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ id: `local-probe-${calls}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'local-protocol-fixture', choices: [{ index: 0, message, finish_reason: step ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
      }
    } catch (error) { errors.push(String(error)); response.statusCode = 500; response.end('{}'); }
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local diagnostic provider.');
    const records = JSON.parse(await readFile(path.join(source, 'dsh/runtimes.json'), 'utf8')) as Array<{ id: string; adapter: string; version: string }>;
    const installed = records.filter(value => value.adapter === 'node-cli-web-v1').sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
    if (!installed) throw new Error('No installed DSH.');
    native = await createBotNativeHost(path.join(source, 'dsh/runtimes', installed.id, 'program'), { onStartup: value => process.send?.({ kind: 'bot-dsh-capability-progress', stage: 'diagnostic-' + value.phase }) });
    process.send?.({ kind: 'bot-real-owned-root', root: native.root });
    const client = await native.instances.ensureHost(native.instance.id); report.nativePid = client.pid;
    worker = new BotDshBrain({ getHost: async () => ({ client, instance: { id: native!.instance.id } }) });
    tools = new BotToolServer(async call => effects.handle(call));
    const { laneId, eventId } = effects.register(randomUUID(), 'Only list the owned diagnostic Desktop and write the owned native-probe.txt.');
    const result = await worker.run({ laneId, eventId, cwd, role: 'worker', workerAccess: 'full', system: 'Run only this controlled diagnostic.', prompt: 'Execute the locally scripted native tool protocol.',
      tools: [], callback: await tools.forWorker(laneId, eventId), model: { apiFormat: 'openai_chat', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'local-protocol-fixture', apiKey: 'local-not-a-real-key', contextWindow: 65536, maxTokens: 1024 },
      signal: AbortSignal.timeout(120000), onEvent: value => { if (value.type !== 'text_stream') events.push(value); } });
    report.result = result;
    report.nativeWrite = await readFile(path.join(cwd, 'native-probe.txt'), 'utf8').catch(error => ({ error: error.code }));
    report.protocolCompleted = calls >= 3;
    report.passed = calls >= 3 && report.nativeWrite === 'genuine native write probe\n';
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  finally {
    if (native) report.nativeJournal = await preserveBotNativeJournals(native.root, path.join(output, 'native-journals.json'), value => value.replace(/Bearer\s+\S+/giu, 'Bearer <redacted>')).catch(error => ({ error: String(error) }));
    report.effects = effects.rows();
    await worker?.close().catch(error => errors.push(String(error))); await tools?.close().catch(error => errors.push(String(error))); await native?.close().catch(error => errors.push(String(error))); effects.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await writeFile(path.join(output, 'result.partial.json'), JSON.stringify(report, null, 2) + '\n');
    process.send?.(report); app.exit(report.passed ? 0 : 1);
  }
}).catch(() => app.exit(1));

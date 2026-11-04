import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotDshBrain, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import type { BotAnsweredQuestion } from '../../src/shared/companion-bot-task';
import { createBotNativeHost } from '../fixtures/bot-native-host';
import { preserveBotNativeJournals } from '../fixtures/bot-native-journal-evidence';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { const deadline = Date.now() + 30000; while (!check()) { if (Date.now() > deadline) throw Error('Native access upgrade did not reach the pending original question'); await pause(20); } }

/** Scripted local provider, actual official Host and actual native tools. This
 * verifies permission/replay semantics and deliberately does not score an LLM. */
it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('promotes hot and cold legacy scoped workers in the same native Session without replaying work, changing identity or downgrading full access', async () => {
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  const output = path.resolve('artifacts/superagent-bot-development/dsh-legacy-access-native', path.basename(native.root)); await mkdir(output, { recursive: true });
  const destination = path.join(native.root, 'authorized-outside-task'); await mkdir(destination);
  const questions = new Map<string, BotAnsweredQuestion>(), allowed = new Set<string>(), effects = new Map<string, { hash: string; state: string }>();
  const calls = new Map<string, number>(), requests: Array<Record<string, unknown>> = [];
  let client: Awaited<ReturnType<typeof native.instances.ensureHost>>, legacy: BotDshBrain | undefined, restored: BotDshBrain | undefined;
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw);
      if (request.url === '/bot/tool') {
        const { name, args } = body; let result;
        if (name === 'worker_question') {
          const kind = args.nativeCallId === 'ask-hot' ? 'hot' : 'cold';
          questions.set(kind, { ...args, answers: [{ id: 'continue', selected: ['Proceed'] }] });
          result = { state: 'queued', questionId: args.questionId };
        } else if (name === 'worker_question_result') {
          const kind = [...questions].find(([, value]) => value.questionId === args.questionId)?.[0];
          result = kind && allowed.has(kind) ? { state: 'answered', questionId: args.questionId, answers: questions.get(kind)!.answers } : { state: 'queued', questionId: args.questionId };
        } else if (name === 'worker_effect_start') {
          const saved = effects.get(args.callId);
          if (saved && saved.hash !== args.argsHash) throw Error('Native call fingerprint changed');
          result = saved?.state === 'committed' ? { state: 'already_committed', callId: args.callId, provenance: 'native_committed' } : { state: 'admitted', callId: args.callId };
          if (!saved) effects.set(args.callId, { hash: args.argsHash, state: 'pending' });
        } else if (name === 'worker_effect_commit') { effects.get(args.callId)!.state = args.isError ? 'failed' : 'committed'; result = { recorded: true }; }
        else throw Error(`Unexpected fixture callback ${name}`);
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: true, result })); return;
      }
      const serialized = JSON.stringify(body.messages), kind = serialized.includes('LEGACY_HOT_ORIGINAL') ? 'hot' : serialized.includes('LEGACY_COLD_ORIGINAL') ? 'cold' : 'brain';
      const step = calls.get(kind) ?? 0; calls.set(kind, step + 1);
      const catalog = (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name);
      requests.push({ kind, step, catalog, messages: body.messages });
      let tool: { name: string; args: object; id: string } | undefined;
      if (kind !== 'brain') {
        if (step === 0) { expect(catalog).not.toContain('pwsh'); tool = { name: 'write', id: `prefix-${kind}`, args: { file_path: 'prefix-proof.txt', content: `PREFIX_${kind}_ONCE` } }; }
        else if (step === 1) tool = { name: 'ask_user_question', id: `ask-${kind}`, args: { questions: [{ id: 'continue', question: 'Continue the original authorized task?', options: [{ label: 'Proceed', description: 'Use the original goal and restrictions.' }] }] } };
        else if (step === 2) {
          expect(catalog).toContain('pwsh');
          expect(serialized).toContain(`PREFIX_${kind}_ONCE`);
          expect(serialized).toMatch(/answer_to_pending_question|\\"answers\\"/u);
          tool = { name: 'write', id: `outside-${kind}`, args: { file_path: path.join(destination, `${kind}-proof.txt`), content: `UPGRADED_${kind}` } };
        }
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = tool ? { tool_calls: [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { content: `NATIVE_${kind}_FINISHED` };
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 30 } })}\n\ndata: [DONE]\n\n`);
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw Error('Local native fixture endpoint unavailable');
    client = await native.instances.ensureHost(native.instance.id);
    legacy = new BotDshBrain({ getHost: async () => ({ client }) }); restored = new BotDshBrain({ getHost: async () => ({ client }) });
    const base = (kind: 'hot' | 'cold'): BotDshRun => ({ laneId: `worker-legacy-${kind}`, eventId: `work-legacy-${kind}`, cwd: path.join(native.root, `task-${kind}`), role: 'worker', workerAccess: 'scoped',
      system: 'Legacy scoped fixture. Preserve the original input and do not read unrelated files.', prompt: `LEGACY_${kind.toUpperCase()}_ORIGINAL`, tools: [],
      model: { apiFormat: 'openai_chat', model: 'local-native-upgrade-fixture', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'local-no-billing', contextWindow: 65536, maxTokens: 1024 },
      callback: { url: `http://127.0.0.1:${address.port}/bot/tool`, token: 'c'.repeat(64) } });
    const hot = base('hot'), hotRun = legacy.run(hot).catch(error => error); await until(() => questions.has('hot'));
    const id = BotDshBrain.sessionId(hot.laneId), beforeUpgrade = calls.get('hot');
    for (const mismatch of [{ laneId: 'worker-foreign' }, { eventId: 'work-foreign' }, { cwd: destination }, { role: 'brain' }]) {
      await expect(client.request(`/bot/lanes/${id}/access`, { ...hot, workerAccess: 'full', ...mismatch })).rejects.toThrow('ownership');
    }
    await expect(client.request('/bot/lanes', { ...hot, sessionId: id, workerAccess: 'full', tools: [{ name: 'foreign_tool', description: 'Cannot silently change tool ownership', parameters: {} }] })).rejects.toThrow('tool selection');
    const upgraded = await restored.upgradeWorkerAccess({ ...hot, system: 'Full tool capability; retain the original goal and explicit restrictions.' });
    expect(upgraded).toMatchObject({ previousAccess: 'scoped', workerAccess: 'full', sessionId: id, sameSessionId: id, eventId: hot.eventId });
    expect(await restored.upgradeWorkerAccess({ ...hot, system: 'Full tool capability; retain the original goal and explicit restrictions.' })).toMatchObject({ previousAccess: 'full', sameSessionId: id });
    expect(calls.get('hot')).toBe(beforeUpgrade);
    await expect(client.request('/bot/lanes', { ...hot, sessionId: id })).rejects.toThrow('downgrade');
    allowed.add('hot'); expect(await hotRun).toMatchObject({ status: 'succeeded', sessionId: id, eventId: hot.eventId });
    expect(await readFile(path.join(destination, 'hot-proof.txt'), 'utf8')).toBe('UPGRADED_hot');
    const cold = base('cold'), controller = new AbortController(), coldRun = legacy.run({ ...cold, signal: controller.signal }).catch(error => error);
    await until(() => questions.has('cold')); controller.abort(Object.assign(new Error('Pause the exact old question before cold recovery'), { code: 'BOT_SUSPEND' }));
    expect(await coldRun).toMatchObject({ code: 'BOT_PAUSE_ACKNOWLEDGED' });
    const beforeCold = calls.get('cold'); await native.instances.stop(native.instance.id); client = await native.instances.ensureHost(native.instance.id);
    const absent = await restored.upgradeWorkerAccess({ ...cold, system: 'Full tool capability; original restrictions remain.' });
    expect(absent).toMatchObject({ absent: true, sessionId: BotDshBrain.sessionId(cold.laneId), eventId: cold.eventId }); expect(calls.get('cold')).toBe(beforeCold);
    allowed.add('cold');
    expect(await restored.run({ ...cold, workerAccess: 'full', answeredQuestions: [questions.get('cold')!] })).toMatchObject({ status: 'succeeded', sessionId: absent.sessionId, eventId: cold.eventId });
    expect(await readFile(path.join(destination, 'cold-proof.txt'), 'utf8')).toBe('UPGRADED_cold');
    const brain = { ...hot, role: 'brain' as const, laneId: 'cognitive-control', eventId: 'cognitive-event', cwd: path.join(native.root, 'cognition'), prompt: 'COGNITIVE_CONTROL' };
    await restored.run(brain);
    await expect(client.request(`/bot/lanes/${BotDshBrain.sessionId(brain.laneId)}/access`, { ...brain, role: 'worker', workerAccess: 'full' })).rejects.toThrow('ownership');
    await preserveBotNativeJournals(native.root, path.join(output, 'native-journals.json'), value => value);
    const journals = JSON.parse(await readFile(path.join(output, 'native-journals.json'), 'utf8')) as Array<{ path: string; records: Array<{ type: string; data?: { id?: string; name?: string; mode?: string; policy?: string } }> }>;
    for (const input of [hot, cold]) {
      const journal = journals.find(journal => journal.path.includes(BotDshBrain.sessionId(input.laneId)))!;
      expect(journal).toBeTruthy();
      expect(journal.records.filter(record => record.type === 'user/message' && record.data?.id === `worldlinebox-bot:${input.eventId}`)).toHaveLength(1);
      const kind = input === hot ? 'hot' : 'cold';
      expect(journal.records.filter(record => record.type === 'tool/call' && JSON.stringify(record).includes(`prefix-${kind}`))).toHaveLength(1);
      expect(journal.records.filter(record => record.type === 'tool/call' && JSON.stringify(record).includes(`outside-${kind}`))).toHaveLength(1);
      expect(journal.records.filter(record => record.type === 'sandbox/mode').at(-1)?.data?.mode).toBe('danger-full-access');
      expect(journal.records.filter(record => record.type === 'approval/policy').at(-1)?.data?.policy).toBe('never');
    }
    const cognitive = journals.find(journal => journal.path.includes(BotDshBrain.sessionId(brain.laneId)))!;
    expect(cognitive.records.filter(record => record.type === 'sandbox/mode').at(-1)?.data?.mode).toBe('workspace-write');
    await writeFile(path.join(output, 'receipt.json'), JSON.stringify({ actualNativeHost: true, usesPaidModel: false, modelQualityAcceptance: false, instanceId: native.instance.id,
      hotUpgrade: upgraded, coldAbsentUpgrade: absent, originalInputCountPerSession: 1, prefixEffectCallsPerSession: 1, outsideWritesVerified: 2,
      scopedCatalogExpanded: true, identityChangesRejected: 5, downgradeRejected: true, cognitiveBrainUnchanged: true, exactColdPausePreserved: true }, null, 2));
  } finally {
    await writeFile(path.join(output, 'requests.json'), JSON.stringify(requests, null, 2));
    await preserveBotNativeJournals(native.root, path.join(output, 'native-journals.json'), value => value).catch(() => undefined);
    await legacy?.close().catch(() => undefined); await restored?.close().catch(() => undefined);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await native.close();
  }
}, 180000);

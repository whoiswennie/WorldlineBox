import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { BotDshBrain } from '../../src/main/companion-bot/dsh-brain';
import { createBotNativeHost } from '../fixtures/bot-native-host';
import { startBotProtocolModel } from '../fixtures/bot-protocol-model';

const bridgePath = '../../resources/dsh-bridge/topics.js';
const { nativeTopicStates } = await import(bridgePath);
const binding = (laneId: string, cwd = path.resolve('.tools/topic-catalog-fixture')) => ({ laneId, cwd, sessionId: BotDshBrain.sessionId(laneId) });

it('reads only bound, nonblank sessions from the native UI catalogue without loading agents or reading logs', async () => {
  const one = binding('one'), blank = binding('blank'), missing = binding('missing'), foreign = binding('foreign');
  const list = vi.fn(async () => ({ items: [
    { ...one, blank: false, updatedAt: 1794384000000, projections: { values: { title: 'DSH 中的名称' } } },
    { ...blank, blank: true }, { ...foreign, cwd: path.resolve('.tools/another-room'), blank: false },
    { sessionId: 'unrelated-native-session', cwd: one.cwd, blank: false },
  ] }));
  const result = await nativeTopicStates({ sessionController: { list } }, { bindings: [one, blank, missing, foreign] }, new AbortController().signal);
  expect(result).toEqual([
    { laneId: one.laneId, sessionId: one.sessionId, exists: true, title: 'DSH 中的名称', updatedAt: new Date(1794384000000).toISOString() },
    ...[blank, missing, foreign].map(row => ({ laneId: row.laneId, sessionId: row.sessionId, exists: false })),
  ]);
  expect(list).toHaveBeenCalledTimes(1);
  await expect(nativeTopicStates({ sessionController: { list } }, { bindings: [{ ...one, sessionId: 'forged' }] })).rejects.toThrow('identity');
  expect(list).toHaveBeenCalledTimes(1);
  await expect(nativeTopicStates({ sessionController: { list: async () => ({}) } }, { bindings: [one] })).rejects.toThrow('unavailable');
});

it.runIf(!!process.env.WORLDLINEBOX_BOT_DSH_PROGRAM)('matches real native session creation and renaming without manufacturing a draft session', async () => {
  const native = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
  const model = await startBotProtocolModel();
  let brain: BotDshBrain | undefined;
  try {
    const client = await native.instances.ensureHost(native.instance.id, AbortSignal.timeout(60000));
    brain = new BotDshBrain({ getHost: async () => ({ client }) });
    const cwd = path.join(native.root, 'companion'); await mkdir(cwd, { recursive: true });
    const live = binding('topic-catalog-live', cwd), draft = binding('topic-catalog-draft', cwd);
    const signal = () => AbortSignal.timeout(10000);
    expect(await brain.nativeTopics([live, draft], signal())).toMatchObject([{ exists: false }, { exists: false }]);
    expect(model.counters.requests).toBe(0);
    await brain.run({ ...live, eventId: 'catalog-event', role: 'worker', workerAccess: 'full',
      workspaceTitle: '话题同步验收', sessionTitle: '真实会话', system: 'Respond briefly.', prompt: '你好', tools: [],
      callback: {url:model.baseUrl+'/bot/tool',token:'f'.repeat(64)},
      model: { apiFormat: 'openai_chat', model: 'catalog-fixture', baseUrl: model.baseUrl, apiKey: 'fixture', contextWindow: 32768, maxTokens: 2048 } });
    const actual = await brain.nativeTopics([live, draft], signal());
    expect(actual).toMatchObject([{ sessionId: live.sessionId, exists: true, title: '真实会话' }, { exists: false }]);
    expect(actual[0]!.updatedAt).toBeTruthy();
    await brain.renameTopic(live.laneId, { cwd, title: '在原生会话中重命名', revision: 1 });
    expect(await brain.nativeTopics([live], signal())).toMatchObject([{ exists: true, title: '在原生会话中重命名' }]);
    expect(await brain.nativeTopics([binding(live.laneId, path.join(native.root, 'another-companion'))], signal())).toMatchObject([{ exists: false }]);
  } finally { await brain?.close(); await model.close(); await native.close(); }
}, 120000);

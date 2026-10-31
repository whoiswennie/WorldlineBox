import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import { VcpPreparedRecallStore } from '../../src/main/vcp-memory/prepared-recall-store';
import type { VcpMemoryPreparedPayload, VcpMemoryQueryClock } from '../../src/main/vcp-memory/contracts';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
const require = createRequire(import.meta.url);
const { modelIdentity } = require('../../src/main/vcp-memory/prepared-focus.cjs') as { modelIdentity(value: object): string };
const chat = { baseUrl: 'https://fixture.invalid', model: 'synthetic-focus', apiKey: 'fixture' };
const clock = (now: string): VcpMemoryQueryClock => ({ now, timeZone: 'Asia/Shanghai' });
let root: string, client: VcpMemoryClient, store: VcpPreparedRecallStore;
const calls: string[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'focus-clock-cache-')); calls.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  store = new VcpPreparedRecallStore(root);
  client = new VcpMemoryClient({ dataRoot: root, vendorRoot: path.resolve('vendor/vcp-memory'), workerPath: path.resolve('src/main/vcp-memory/worker.cjs'),
    embedding: { baseUrl: 'https://fixture.invalid', apiKey: 'fixture', model: 'fixture', dimension: 4 }, plugins: { chat },
    launch: () => { throw new Error('Focusing cache checks must not start a worker or native graph.'); } });
});
afterEach(async () => {
  await client.close(); await store.close(); vi.restoreAllMocks();
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('focus-clock-cache-')) throw new Error('Unexpected fixture directory');
  await rm(root, { recursive: true, force: true });
});
async function focus(template: string, queryClock?: VcpMemoryQueryClock, source = 'ACTUAL_SYNTHETIC_INPUT') {
  const token = 'WORLDLINE_PREPARED_FOCUS_' + 'a'.repeat(32);
  const payload: VcpMemoryPreparedPayload = { schema: 'worldlinebox.prepared-recall-payload', modelIdentity: modelIdentity(chat),
    groups: [{ token, dbNames: ['fixture'], userContent: '同一合成问题', aiContent: null, combinedQueryForDisplay: '', promptTemplate: template,
      config: { model: chat.model, batchSize: 5, maxTokensPerBatch: 60000, promptFile: 'fixture' },
      options: { sourceFiles: [{ name: 'fixture-note', dbName: 'fixture', content: source, tokens: 20 }] } }],
    receipt: { messages: [{ role: 'system', content: token }], events: [], ...(queryClock ? { queryClock } : {}),
      cacheClock: { bucket: 'constant-test-bucket', invalidated: false }, receiptCache: { hit: false, corpusEpoch: 1 } } };
  const handle = await store.save('clock-input', payload);
  return client.focusRecall(handle, { validate: async () => undefined, fetchFn: async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }; calls.push(request.messages[0]!.content);
    return new Response(JSON.stringify({ choices: [{ message: { content: '这是我获取的所有相关知识/记忆[[合成来源的原始结果。]]' } }] }),
      { headers: { 'content-type': 'application/json' } });
  } });
}

it('keys actual rendered Time by the frozen second while retaining reuse within that same second', async () => {
  const template = 'TIME={{Time}}\n{{knowledge_base}}\n{{current_user_prompt}}';
  await focus(template, clock('2026-10-29T01:02:03.100Z'));
  expect((await focus(template, clock('2026-10-29T01:02:03.900Z'))).receiptCache?.hit).toBe(true);
  expect((await focus(template, clock('2026-10-29T01:02:04.000Z'))).receiptCache?.hit).toBe(false);
  expect(calls).toHaveLength(2); expect(calls[0]).toContain('TIME=09:02:03'); expect(calls[1]).toContain('TIME=09:02:04');
});

it('also keys Time placeholders inserted through actual source content before upstream template replacement', async () => {
  const template = '{{knowledge_base}}\n{{current_user_prompt}}', source = 'SOURCE_TIME={{Time}}';
  await focus(template, clock('2026-10-29T01:02:03Z'), source);
  await focus(template, clock('2026-10-29T01:02:04Z'), source);
  expect(calls).toHaveLength(2); expect(calls[0]).toContain('SOURCE_TIME=09:02:03'); expect(calls[1]).toContain('SOURCE_TIME=09:02:04');
});

it('keys rendered Date by its query timezone civil day without disabling stable same-day reuse', async () => {
  const template = 'DATE={{Date}}\n{{knowledge_base}}';
  await focus(template, clock('2026-10-29T01:00:00Z'));
  expect((await focus(template, clock('2026-10-29T07:00:00Z'))).receiptCache?.hit).toBe(true);
  await focus(template, clock('2026-10-29T16:00:00Z'));
  expect(calls).toHaveLength(2); expect(calls[0]).toContain('DATE=2026-10-29'); expect(calls[1]).toContain('DATE=2026-10-30');
});

it('does not cache a dynamic wall-clock prompt when no immutable query clock was captured', async () => {
  await focus('TIME={{Time}}\n{{knowledge_base}}'); await focus('TIME={{Time}}\n{{knowledge_base}}');
  expect(calls).toHaveLength(2);
});

it('preserves existing complete receipt reuse for an unchanged prompt without rendered clock placeholders', async () => {
  await focus('{{knowledge_base}}\n{{current_user_prompt}}', clock('2026-10-29T01:02:03Z'));
  expect((await focus('{{knowledge_base}}\n{{current_user_prompt}}', clock('2026-10-29T01:02:04Z'))).receiptCache?.hit).toBe(true);
  expect(calls).toHaveLength(1);
});

it('refocuses unchanged native input when the live owner gateway system guidance changes', async () => {
  const template = '{{knowledge_base}}\n{{current_user_prompt}}';
  const guidance = (system: string) => ({ aimemoTemplate: template, focusGuidanceSignature: createHash('sha256').update(system).digest('hex') });
  client.setOwnerPrompts(guidance('common v1\nfocus guidance v1'));
  await focus(template);
  expect((await focus(template)).receiptCache?.hit).toBe(true);
  client.setOwnerPrompts(guidance('common v1\nfocus guidance v2'));
  expect((await focus(template)).receiptCache?.hit).toBe(false);
  client.setOwnerPrompts(guidance('common v2\nfocus guidance v2'));
  expect((await focus(template)).receiptCache?.hit).toBe(false);
  expect((await focus(template)).receiptCache?.hit).toBe(true);
  expect(calls).toHaveLength(3);
});

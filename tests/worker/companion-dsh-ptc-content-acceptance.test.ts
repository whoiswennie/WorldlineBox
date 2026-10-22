import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, onTestFinished } from 'vitest';
import { createNativeAcceptanceBroker } from '../helpers/companion-dsh-native-broker';
import { installedDshAcceptanceProgram, realDshAcceptanceRoute } from '../helpers/companion-dsh-real-route';

it.skipIf(process.env.WORLDLINEBOX_DSH_PTC_ACCEPTANCE !== '1')('uses the actual installed PTC Agent with a selected underlying tool set and verifies its delivered file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-ptc-content-'));
  const owned: { native?: Awaited<ReturnType<typeof createNativeAcceptanceBroker>> } = {};
  onTestFinished(async () => { await owned.native?.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10 }); });
  const route = await realDshAcceptanceRoute(root), program = await installedDshAcceptanceProgram();
  const native = await createNativeAcceptanceBroker({ program, apiKey: route.apiKey, model: route.model, baseURL: route.baseURL }); owned.native = native;
  const marker = randomUUID(), started = Date.now();
  const result = await native.broker.execute({ title: 'PTC actual file proof', timeoutMs: 180000,
    prompt: `Use your programmatic tool calling mode. Your only underlying tools are read, write and present. In your own workspace write ptc-proof.json with exactly {"marker":"${marker}","values":[17,23,19],"total":59}. Actually read it back and verify the values and sum, then present that existing file. Return only JSON {"verified":true,"total":59}. Do not simulate another companion or use a shell.` }, native.operation(),
  { ...native.execution, task: { mode: 'ptc', tools: ['read', 'write', 'present'], skills: [], delivery: { format: 'json' } } });
  expect(result.structured).toEqual({ verified: true, total: 59 });
  const content = JSON.parse(await readFile(path.join(result.workspacePath!, 'ptc-proof.json'), 'utf8'));
  expect(content).toEqual({ marker, values: [17, 23, 19], total: 59 });
  expect(result.artifacts?.some(artifact => path.basename(artifact.path) === 'ptc-proof.json')).toBe(true);
  const record = (await native.broker.readRecord({ recordId: result.taskId })).overview;
  expect(record.status).toBe('succeeded');
  const events = native.broker.events(result.taskId);
  expect(events.some(event => event.toolName === 'run_code')).toBe(true);
  const file = path.resolve('.tools/test-output/companion-dsh-ptc-content.json'); await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ status: 'passed', runtime: JSON.parse(await readFile(path.join(program, 'dsh/node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version,
    mode: 'ptc', elapsedMs: Date.now() - started, tools: ['read', 'write', 'present'], verifiedContent: content,
    structured: result.structured, nativeToolNames: [...new Set(events.map(event => event.toolName).filter(Boolean))] }, null, 2));
}, 300000);

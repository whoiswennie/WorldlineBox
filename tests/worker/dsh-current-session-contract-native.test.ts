import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createNativeAcceptanceBroker } from '../helpers/companion-dsh-native-broker';
import { installedDshAcceptanceProgram } from '../helpers/companion-dsh-real-route';

it('pins actual installed native tools and skill content across zero-model resume', async () => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.writeHead(500).end('No model requests permitted.'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const test = await createNativeAcceptanceBroker({ program: await installedDshAcceptanceProgram(), apiKey: 'synthetic-contract-probe', model: 'deepseek-flash', baseURL: `http://127.0.0.1:${port}/v1` });
  const directory = path.join(test.root, 'instances/acceptance/agents/skills/contract-probe'); await mkdir(directory, { recursive: true });
  const skill = path.join(directory, 'SKILL.md');
  const scope = { ...test.execution.recordScope!, topicId: 'topic-contract', sourceDigest: 'a'.repeat(64), domain: 'reality' as const };
  try {
    await writeFile(skill, '---\nname: contract-probe\ndescription: Contract probe.\n---\nOriginal instructions.\n');
    const first = await test.broker.execute({ prompt: 'Discover original contract.' }, test.operation(), { ...test.execution, recordScope: scope, discover: true, task: {} });
    expect(first.runtimeVersion).toBe('0.2.1-rc.2'); expect(first.effective?.digest).toMatch(/^[a-f0-9]{64}$/);
    const continued = await test.broker.execute({ prompt: 'Continue discovery.' }, test.operation(), { ...test.execution, recordScope: scope, resumeScope: scope, discover: true,
      task: { session: { mode: 'resume', taskId: first.taskId } } });
    expect(continued.sessionId).toBe(first.sessionId); expect(continued.effective?.digest).toBe(first.effective?.digest);
    const continuedScope = { ...scope, actionId: test.execution.recordScope!.actionId };
    await writeFile(skill, '---\nname: contract-probe\ndescription: Contract probe.\n---\nChanged instructions.\n');
    await expect(test.broker.execute({ prompt: 'Resume under changed skill.' }, test.operation(), { ...test.execution, recordScope: scope, resumeScope: continuedScope,
      discover: true, task: { session: { mode: 'resume', taskId: continued.taskId } } })).rejects.toThrow('capabilities changed');
    expect(requests).toBe(0);
  } finally { await test.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 120000);

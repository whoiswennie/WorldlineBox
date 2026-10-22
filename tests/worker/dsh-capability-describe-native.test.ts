import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { createNativeAcceptanceBroker } from '../helpers/companion-dsh-native-broker';
import { installedDshAcceptanceProgram } from '../helpers/companion-dsh-real-route';

const installed = path.join(process.env.APPDATA ?? '', 'WorldlineBox/dsh-launcher/runtimes.json');
it.skipIf(process.platform !== 'win32' || !existsSync(installed))('describes real scoped tool schemas, complete paged skills and native commands without model requests', async () => {
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.writeHead(500).end('Model requests are forbidden in capability discovery.'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Capability probe server did not bind.');
  const test = await createNativeAcceptanceBroker({ program: await installedDshAcceptanceProgram(), apiKey: 'capability-probe-no-real-key', model: 'deepseek-flash', baseURL: `http://127.0.0.1:${address.port}/v1` });
  try {
    const skillDirectory = path.join(test.root, 'instances/acceptance/agents/skills/capability-probe'); await mkdir(skillDirectory, { recursive: true });
    const marker = 'COMPLETE_SKILL_END_MARKER';
    await writeFile(path.join(skillDirectory, 'SKILL.md'), `---\nname: capability-probe\ndescription: Native capability reference acceptance fixture.\n---\n# Complete native instructions\n${'Detailed instruction material.\n'.repeat(1000)}${marker}\n`);
    const overview = await test.broker.discover('acceptance');
    expect(overview.tools.some(tool => tool.name === 'read')).toBe(true);
    expect(overview.skills.some(skill => skill.name === 'capability-probe')).toBe(true);
    const tool = await test.broker.discover('acceptance', { capabilityQuery: { kind: 'tool', name: 'read' } });
    expect(tool.detail).toMatchObject({ kind: 'tool', available: true, source: 'native-agent-scope', tool: { name: 'read' } });
    const schema = tool.detail!.tool as { parameters?: object }; expect(schema.parameters).toBeTypeOf('object'); expect(JSON.stringify(schema.parameters)).toContain('path');
    const first = await test.broker.discover('acceptance', { capabilityQuery: { kind: 'skill', name: 'capability-probe', maxChars: 1000 } });
    expect(first.detail?.skill).toMatchObject({ textOffset: 0, truncated: true, nextTextOffset: 1000 });
    const remaining = await test.broker.discover('acceptance', { capabilityQuery: { kind: 'skill', name: 'capability-probe', textOffset: first.detail!.skill!.nextTextOffset, maxChars: 64000 } });
    const full = first.detail!.skill!.content + remaining.detail!.skill!.content;
    expect(full).toContain(marker); expect(full.length).toBe(first.detail!.skill!.totalChars); expect(remaining.detail?.skill?.truncated).toBe(false);
    const commands = await test.broker.discover('acceptance', { capabilityQuery: { kind: 'commands' } });
    expect(commands.detail?.commands?.length).toBeGreaterThan(0); expect(commands.detail?.cli?.help).toContain('--profile');
    expect(commands.detail?.commandsExecutable).toBe(false);
    const missing = await test.broker.discover('acceptance', { capabilityQuery: { kind: 'tool', name: 'invented_nonexistent_tool' } });
    expect(missing.detail).toMatchObject({ available: false, name: 'invented_nonexistent_tool' });
    expect(requests).toBe(0);
    await mkdir(path.resolve('.tools/test-output'), { recursive: true });
    await writeFile(path.resolve('.tools/test-output/companion-dsh-capability-describe-native.json'), JSON.stringify({ status: 'passed', runtimeVersion: overview.runtimeVersion,
      toolName: 'read', toolSchemaFields: Object.keys(schema), completeSkillChars: full.length, pagedSkillReadParts: 2,
      commandNames: commands.detail?.commands?.map(command => command.name), nativeCliHelpVerified: true, modelRequests: requests }, null, 2));
  } finally { await test.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 120000);

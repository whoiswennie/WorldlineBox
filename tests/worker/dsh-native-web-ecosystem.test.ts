import { expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createNativeAcceptanceBroker, installedNativeAcceptanceSource } from '../helpers/companion-dsh-native-broker';
import { PluginControls } from '../../src/main/dsh/plugin-controls';

it.skipIf(process.env.WORLDLINEBOX_DSH_ECOSYSTEM_REAL !== '1')('shares installed native bundles and skills between two partner Sessions on the actual Web Host', async () => {
  const source = await installedNativeAcceptanceSource();
  const native = await createNativeAcceptanceBroker(source);
  const reportRoot = path.resolve(process.env.WORLDLINEBOX_DSH_ECOSYSTEM_REPORT ?? 'artifacts/native-web-ecosystem'); await mkdir(reportRoot, { recursive: true });
  const marker = 'NATIVE_SHARED_' + randomUUID();
  try {
    let client = await native.instances.ensureHost(native.instance.id), pid = client.pid;
    const before = await native.broker.discover();
    const install = async (name: string, code: string) => {
      const directory = path.join(native.root, 'fixture-plugins', name); await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: '@wlb-test/' + name, version: '1.0.0', type: 'module', main: 'index.js',
        dsh: { bundle: { patch: './cordis.patch.yml' } }, engines: { dsh: '>=0.2.0-0 <0.3.0' } }));
      await writeFile(path.join(directory, 'cordis.patch.yml'), `- insert:\n    - id: ${name}\n      name: '@wlb-test/${name}'\n`);
      await writeFile(path.join(directory, 'index.js'), `export const name = '${name}'; export const inject = ['tools']; export function apply(ctx) { ${code} }`);
      return JSON.parse(await native.instances.plugin(native.instance.id, 'add', 'file:' + directory.replaceAll('\\', '/'), native.operation()));
    };
    const render = "render: (_args, value) => [{type:'text',text:JSON.stringify(value)}]";
    const first = await install('marker', `ctx.tools.register({name:'native_marker', description:'Read the native fixture marker.', parameters:{type:'object',properties:{},additionalProperties:false},
      output:{schema:{type:'object',properties:{marker:{type:'string'}},required:['marker'],additionalProperties:false},${render}}, execute:async()=>({marker:${JSON.stringify(marker)}})});`);
    const second = await install('add', `ctx.tools.register({name:'native_add', description:'Add two integers.', parameters:{type:'object',properties:{a:{type:'integer'},b:{type:'integer'}},required:['a','b'],additionalProperties:false},
      output:{schema:{type:'object',properties:{sum:{type:'integer'}},required:['sum'],additionalProperties:false},${render}}, execute:async args=>({sum:args.a+args.b})});`);
    const official = JSON.parse(await native.instances.plugin(native.instance.id, 'add', '@deepseek-ai/dsh-experimental-badge-skill-bundle@' + native.runtimeVersion, native.operation()));
    const skillDirectory = path.join(native.instance.agentsPath, 'skills', 'native-shared-probe'); await mkdir(skillDirectory, { recursive: true });
    await writeFile(path.join(skillDirectory, 'SKILL.md'), `---\nname: native-shared-probe\ndescription: Read the shared native integration marker.\n---\nThe skill verification value is SKILL_${marker}. Include this exact value in the final JSON field skill.\n`);
    await vi.waitFor(async () => {
      const current = await native.broker.discover();
      expect(current.tools.map(value => value.name)).toEqual(expect.arrayContaining(['native_marker', 'native_add']));
      expect(current.skills.map(value => value.name)).toContain('native-shared-probe');
    }, { timeout: 15000 });
    expect((await native.instances.ensureHost(native.instance.id)).pid).toBe(pid);
    const controls = new PluginControls(id => native.instances.ensureHost(id));
    const userSessionId = randomUUID();
    await client.request('/sessions', { sessionId: userSessionId, cwd: native.instance.workspacePath });
    const userTools = () => client.request<{ tools: Array<{ name: string }> }>(`/sessions/${userSessionId}/capabilities`);
    const changes: Array<{ application: string; error?: unknown }> = [];
    const toggle = async (enabled: boolean) => {
      const change = await controls.setPluginEnabled(native.instance, '@wlb-test/marker', enabled);
      changes.push(change); await native.instances.recordPluginChange(native.instance.id, change);
      if (change.application === 'restart-required') {
        expect(native.instances.get(native.instance.id).restartRequired).toBe(true);
        await native.instances.stop(native.instance.id); client = await native.instances.ensureHost(native.instance.id); pid = client.pid;
        await client.request('/sessions', { sessionId: userSessionId, resume: true, cwd: native.instance.workspacePath });
        expect(native.instances.get(native.instance.id).restartRequired).toBeUndefined();
      }
      await vi.waitFor(async () => expect((await native.broker.discover()).tools.some(tool => tool.name === 'native_marker')).toBe(enabled), { timeout: 5000 });
      expect((await userTools()).tools.some(tool => tool.name === 'native_marker')).toBe(enabled);
    };
    await toggle(false); await toggle(true);
    await writeFile(path.join(reportRoot, 'toggles.json'), JSON.stringify({ pid, changes, nativeUserSession: userSessionId, userAndPartnerDisabled: true, userAndPartnerReenabled: true }, null, 2));
    const selected = await client.request<{ capabilities: { tools: Array<{ name: string }>; skills: Array<{ name: string }> } }>('/sessions', {
      sessionId: randomUUID(), cwd: native.instance.workspacePath, policy: { tools: ['native_add', 'skill'], skills: ['native-shared-probe'] },
    });
    expect(selected.capabilities.tools.map(value => value.name).sort()).toEqual(['native_add', 'skill']);
    expect(selected.capabilities.skills.map(value => value.name)).toEqual(['native-shared-probe']);
    const cognitive = await client.request<typeof selected>('/sessions', { sessionId: randomUUID(), cwd: native.instance.workspacePath, policy: { cognitiveOnly: true } });
    expect(cognitive.capabilities.tools).toEqual([]); expect(cognitive.capabilities.skills).toEqual([]);
    expect((await native.broker.discover()).tools.map(value => value.name)).toContain('native_marker');
    const input = { prompt: '请依次调用 native_marker、native_add（a=19,b=23）、skill（name=native-shared-probe）。仅返回 JSON，字段为 marker、sum、skill；内容来自真实工具结果。不要调用其他工具。', title: '共享插件与技能验证', timeoutMs: 120000 };
    const jsonSchema = { type: 'object', properties: { marker: { const: marker }, sum: { const: 42 }, skill: { const: 'SKILL_' + marker } }, required: ['marker', 'sum', 'skill'], additionalProperties: false };
    const started = performance.now();
    const results = await Promise.all(['fish', 'sister'].map(companionId => native.broker.execute(input, native.operation(), {
      ...native.execution, recordScope: { actionId: randomUUID(), companionId, conversationId: 'native-ecosystem', sourceMessageId: 'authorized-fixture' },
      task: { delivery: { format: 'json', jsonSchema } },
    })));
    for (const result of results) {
      expect(result.structured).toEqual({ marker, sum: 42, skill: 'SKILL_' + marker });
      const calls = native.broker.events(result.taskId).filter(value => value.stage === 'tool_start').map(value => value.toolName);
      expect(calls).toEqual(expect.arrayContaining(['native_marker', 'native_add', 'skill']));
    }
    expect(results[0]!.sessionId).not.toBe(results[1]!.sessionId);
    expect(native.broker.state().every(value => value.pid === pid)).toBe(true);
    expect(await native.sourceConfigurationUnchanged()).toBe(true);
    await writeFile(path.join(reportRoot, 'result.json'), JSON.stringify({ pid, webHostPid: native.instances.get(native.instance.id).pid,
      runtimeVersion: native.runtimeVersion, installs: { first, second, official }, before, after: await native.broker.discover(),
      elapsedMs: performance.now() - started, tasks: native.broker.state(), results }, null, 2));
    // Native profile state survives a full stop/start, including locally installed bundles and skills.
    await native.instances.stop(native.instance.id); const restarted = await native.instances.ensureHost(native.instance.id);
    expect(restarted.pid).not.toBe(pid); const afterRestart = await native.broker.discover();
    expect(afterRestart.tools.map(value => value.name)).toEqual(expect.arrayContaining(['native_marker', 'native_add']));
    expect(afterRestart.skills.map(value => value.name)).toContain('native-shared-probe');
    const previous = results[0]!, scope = (await native.broker.recordMetadata(previous.taskId)).scope;
    const adoption = await restarted.request<{ sessionId: string }>('/sessions', { sessionId: previous.sessionId, resume: true, cwd: previous.workspacePath });
    await writeFile(path.join(reportRoot, 'adoption.json'), JSON.stringify({ requested: previous.sessionId, returned: adoption.sessionId }, null, 2));
    expect(adoption.sessionId).toBe(previous.sessionId);
    const resumed = await native.broker.execute({ prompt: '请根据本会话此前的真实工具结果，重新返回同样的 marker、sum、skill JSON。无需再调用工具。', timeoutMs: 120000 }, native.operation(), {
      ...native.execution, recordScope: scope, task: { session: { mode: 'resume', taskId: previous.taskId }, delivery: { format: 'json', jsonSchema } },
    });
    expect(resumed.sessionId).toBe(previous.sessionId); expect(resumed.structured).toEqual(previous.structured);
    await writeFile(path.join(reportRoot, 'restart.json'), JSON.stringify({ pid: restarted.pid, tools: afterRestart.tools, skills: afterRestart.skills }, null, 2));
    await writeFile(path.join(reportRoot, 'resumed.json'), JSON.stringify(resumed, null, 2));
    await mkdir(path.join(native.instance.workspacePath, 'logs'), { recursive: true });
    await writeFile(path.join(native.instance.workspacePath, 'logs', 'user-data.txt'), marker);
    await native.instances.stop(native.instance.id);
    const backup = path.join(native.root, 'native-backup'); await native.instances.exportTo(native.instance.id, backup);
    const restored = await native.instances.restoreFrom(backup, 'Restored native instance');
    expect(await readFile(path.join(restored.workspacePath, 'logs/user-data.txt'), 'utf8')).toBe(marker);
    const restoredHost = await native.instances.ensureHost(restored.id);
    const restoredSession = await restoredHost.request<{ sessionId: string; capabilities: { tools: Array<{ name: string }> } }>('/sessions', {
      sessionId: previous.sessionId, resume: true, cwd: previous.workspacePath,
    });
    expect(restoredSession.sessionId).toBe(previous.sessionId);
    expect(restoredSession.capabilities.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['native_marker', 'native_add']));
    await writeFile(path.join(reportRoot, 'backup.json'), JSON.stringify({ format: 'worldlinebox-native-dsh-backup-v1', restoredPid: restoredHost.pid,
      restoredSessionId: restoredSession.sessionId, userWorkspaceFilePreserved: true, nativeToolsPreserved: true }, null, 2));
  } catch (error) {
    await writeFile(path.join(reportRoot, 'failure.json'), JSON.stringify({ error: String(error), tasks: native.broker.state(),
      logs: await readFile(path.join(native.instances.getRoot(native.instance.id), 'logs/host.log'), 'utf8').then(text => text.slice(-20000)) }, null, 2));
    throw error;
  } finally { await native.dispose(); }
}, 300000);

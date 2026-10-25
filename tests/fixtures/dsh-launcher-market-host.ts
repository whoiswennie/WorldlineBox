import { app, type BrowserWindow } from 'electron';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DshLauncher } from '../../src/main/dsh/launcher';
import { getApplicationNetwork, closeApplicationNetwork } from '../../src/main/application-network';
import type { DshLauncherRequest, DshLauncherResponse } from '../../src/shared/dsh-launcher';
import type { InstanceService } from '../../src/main/dsh/instance-service';

const output = path.resolve('artifacts/native-launcher-market');
app.disableHardwareAcceleration(); app.getAppPath = () => process.cwd(); app.setPath('userData', path.join(output, 'electron')); app.setPath('sessionData', path.join(output, 'electron'));
void app.whenReady().then(async () => {
  await mkdir(output, { recursive: true });
  const original = app.getPath; app.getPath = name => name === 'userData' ? path.join(process.env.APPDATA!, 'WorldlineBox') : original.call(app, name);
  const network = await getApplicationNetwork(); const launcher = new DshLauncher(() => undefined, undefined, network); app.getPath = original;
  const internal = launcher as unknown as { initialization: Promise<void>; instances: InstanceService; windows: Map<string, BrowserWindow>; handle(request: DshLauncherRequest): Promise<DshLauncherResponse> };
  const invoke = async (request: DshLauncherRequest) => {
    process.stdout.write(request.type + ('kind' in request ? ' ' + request.kind : '') + '\n');
    const response = await internal.handle(request); if (!response.ok) throw new Error(response.error);
    if (response.operationId) while (true) {
      const operation = launcher.state().operations.find(value => value.id === response.operationId)!;
      if (operation.status === 'succeeded') break;
      if (operation.status !== 'running') throw new Error(operation.error ?? operation.status);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return response;
  };
  try {
    await internal.initialization;
    const instance = launcher.state().instances.find(value => value.isDefault)!; if (!instance) throw new Error('Configure a native instance first.');
    const client = await internal.instances.ensureHost(instance.id); const pid = client.pid;
    const plugins = await invoke({ type: 'market.search', kind: 'plugin', query: '', pageSize: 100, refresh: true });
    await writeFile(path.join(output, 'plugin-catalog.json'), JSON.stringify(plugins.marketPage, null, 2));
    const community: unknown[] = [];
    for (const npmName of ['dsh-glass-weather', '@climber47/dsh-step-clock']) {
      const found = await invoke({ type: 'market.search', kind: 'plugin', query: npmName, pageSize: 100 });
      const entry = found.marketPage?.entries.find(value => value.npmName === npmName);
      if (!entry) throw new Error('The real marketplace did not resolve: ' + npmName);
      const existing = await invoke({ type: 'instance.plugins', instanceId: instance.id });
      if (!existing.installedPlugins?.some(value => value.name === npmName)) await invoke({ type: 'market.plugin.install', instanceId: instance.id, entryId: entry.id });
      community.push({ name: npmName, entryId: entry.id });
    }
    const skills = await invoke({ type: 'market.search', kind: 'skill', query: 'internal-comms', refresh: true });
    await writeFile(path.join(output, 'skill-catalog.json'), JSON.stringify(skills.marketPage, null, 2));
    const installed = await invoke({ type: 'skill.list', instanceId: instance.id });
    const saved = installed.installedSkills?.filter(value => ['internal-comms', 'webapp-testing'].includes(value.name)) ?? [];
    // A prior successful download already pinned both sources; repeated execution tests need no new GitHub request.
    const selected = saved.length === 2 ? saved : (await invoke({ type: 'skill.inspect', repository: 'anthropics/skills' })).skillInspection!.targets.filter(value => ['internal-comms', 'webapp-testing'].includes(value.name));
    if (selected.length !== 2) throw new Error('The upstream sample skill names changed.');
    for (const target of selected) {
      const existing = await invoke({ type: 'skill.list', instanceId: instance.id });
      if (!existing.installedSkills?.some(value => value.name === target.name)) {
        if (!target.repository || !target.commit || !target.archiveSha256 || !target.sourcePath) throw new Error('The inspected skill has no pinned source.');
        await invoke({ type: 'skill.install', instanceId: instance.id, target: { ...target, repository: target.repository, commit: target.commit, archiveSha256: target.archiveSha256, sourcePath: target.sourcePath } });
      }
    }
    const currentPlugins = await invoke({ type: 'instance.plugins', instanceId: instance.id });
    if (!currentPlugins.installedPlugins?.some(value => value.name === '@deepseek-ai/dsh-experimental-badge-skill-bundle')) await invoke({ type: 'instance.plugin', instanceId: instance.id, action: 'add', spec: '@deepseek-ai/dsh-experimental-badge-skill-bundle@0.2.1-rc.2' });
    const inventory = await invoke({ type: 'instance.plugins', instanceId: instance.id });
    const capabilities = await launcher.taskCapabilities();
    if (!capabilities.tools.some(value => value.name === 'get_weather')) throw new Error('The community weather tool was not registered in the native Host.');
    for (const name of selected.map(value => value.name)) if (!capabilities.skills.some(value => value.name === name)) throw new Error('Installed skill missing from native Host: ' + name);
    const results: unknown[] = [];
    for (const companionId of ['deepseek-flash', 'deepseek-sister']) {
      const task = await launcher.requestTask({ type: 'task.run', title: '启动器插件与技能验证', prompt: '请调用 skill 工具加载 internal-comms，再加载 webapp-testing，再调用 get_weather 查询 Shanghai 天气。仅返回 JSON，loaded 为 ["internal-comms","webapp-testing"]，weather 字段为真实工具返回的温度、城市和数据来源；如工具出错，weather 字段明确记录错误。不要执行技能中的其他操作，不要调用其他工具。', timeoutMs: 120000 },
        { recordScope: { actionId: randomUUID(), companionId, conversationId: 'native-market-test', sourceMessageId: 'user-authorized-market-test' }, task: { delivery: { format: 'json' } } });
      if (!task.ok || !task.operationId) throw new Error('Partner task was not accepted.');
      while (launcher.state().operations.find(value => value.id === task.operationId)!.status === 'running') await new Promise(resolve => setTimeout(resolve, 100));
      const operation = launcher.state().operations.find(value => value.id === task.operationId)!; if (operation.status !== 'succeeded') throw new Error(operation.error ?? operation.status);
      const response = await launcher.requestTask({ type: 'task.result', taskId: task.operationId }); if (!response.ok) throw new Error(response.error);
      results.push(response.taskResult);
      const events = await launcher.requestTask({ type: 'task.events', taskId: task.operationId });
      if (!events.ok || events.taskEvents?.filter(value => value.toolName === 'skill' && value.stage === 'tool_start').length !== 2) throw new Error('The partner did not load both skills.');
      if (!events.taskEvents?.some(value => value.toolName === 'get_weather' && value.stage === 'tool_start')) throw new Error('The partner did not execute the installed community weather tool.');
      await writeFile(path.join(output, companionId + '-events.json'), JSON.stringify(events.taskEvents, null, 2));
    }
    const userSession = randomUUID();
    const user = await client.request<{ capabilities: { skills: Array<{ name: string }>; tools: Array<{ name: string }> } }>('/sessions', { sessionId: userSession, cwd: instance.workspacePath });
    for (const name of selected.map(value => value.name)) if (!user.capabilities.skills.some(value => value.name === name)) throw new Error('User Session cannot see installed skill.');
    if (!user.capabilities.tools.some(value => value.name === 'get_weather')) throw new Error('The user Session cannot see the community weather tool.');
    await invoke({ type: 'instance.open', instanceId: instance.id });
    const window = internal.windows.get(instance.id)!;
    let clientModules: string[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      clientModules = await window.webContents.executeJavaScript("performance.getEntriesByType('resource').map(entry => { const url=new URL(entry.name); return url.pathname+url.search; }).filter(name => /glass-weather|step-clock/.test(decodeURIComponent(name)))");
      if (community.every(value => clientModules.some(url => decodeURIComponent(url).includes((value as { name: string }).name)))) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    await writeFile(path.join(output, 'web-ui.json'), JSON.stringify(await window.webContents.executeJavaScript("({resources:performance.getEntriesByType('resource').map(entry=>{const url=new URL(entry.name); for(const key of [...url.searchParams.keys()]) if(/token|auth|secret/i.test(key)) url.searchParams.delete(key); return url.pathname+url.search;}),pluginElements:Array.from(document.querySelectorAll('[class]')).map(element=>element.className).filter(name=>typeof name==='string'&&/dshwx|stepclock/.test(name)),pluginStyles:Array.from(document.querySelectorAll('style')).map(element=>element.textContent).filter(text=>/dshwx|stepclock/.test(text)).map(text=>({weather:/dshwx/.test(text),clock:/stepclock/.test(text)})),title:document.title})"), null, 2));
    for (const name of ['dsh-glass-weather', '@climber47/dsh-step-clock']) if (!clientModules.some(url => decodeURIComponent(url).includes(name))) throw new Error('The native Web UI did not load client module ' + name);
    if ((await internal.instances.ensureHost(instance.id)).pid !== pid) throw new Error('Marketplace operations replaced the shared Web Host.');
    await writeFile(path.join(output, 'result.json'), JSON.stringify({ pid, nativeUserSession: userSession, installedSkills: selected.map(value => ({ name: value.name, commit: value.commit })),
      communityPlugins: community, clientModules, pluginInventory: inventory.installedPlugins, capabilities, results, tasks: launcher.state().tasks }, null, 2));
    process.stdout.write('NATIVE_LAUNCHER_MARKET_OK\n');
  } finally { await launcher.shutdown(); await closeApplicationNetwork(); }
}).then(() => app.exit(0), error => { process.stderr.write(String(error.stack ?? error) + '\n'); app.exit(1); });

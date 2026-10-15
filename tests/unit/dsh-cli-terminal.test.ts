import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Script } from 'node:vm';
import { DshCliTerminal, activeDshCliUses, externalShimSource, maskDshTerminalOutput, withDshCliExclusive, type DshCliSelection } from '../../src/main/dsh/cli-terminal';
import { inventoryTree } from '../../src/main/dsh/files';
import { instanceEnvironment } from '../../src/main/dsh/instance-process';
import { compatibilityContract } from '../../src/main/dsh/runtime-compatibility';
import { dshCompatibilityCheckIds } from '../../src/shared/dsh-runtime-compatibility';
import type { DshInstance } from '../../src/shared/dsh-launcher';
import { resolvePortableTools } from '../../src/main/portable-tools';

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }));

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const absolute = path.resolve(root);
    if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('worldlinebox-cli-test-')) throw new Error('Unexpected CLI fixture root.');
    // Windows can release ConPTY's directory handle a moment after Job accounting reaches zero.
    await rm(absolute, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
  }
});
async function setup(adapter: 'desktop-cli-web-v1' | 'node-cli-web-v1' = 'desktop-cli-web-v1', toolchain?: () => Promise<{ pathDirectories: string[]; gitCaBundle?: string }>) {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-cli-test-')); roots.push(root);
  const records: Array<{ id: string; version: string; contentSha256: string; adapter: string }> = [];
  const selections: DshCliSelection[] = [];
  const workspacePath = path.join(root, 'shared', 'documents', 'deepseek-harness', 'default-workspace'); await mkdir(workspacePath, { recursive: true });
  for (const label of ['a', 'b']) {
    const runtimeVersion=label==='a'?'0.2.0-rc.2':'0.2.1-alpha.2';
    const temporary = path.join(root, `staging-${label}`); await mkdir(temporary);
    const executableRelative = adapter === 'node-cli-web-v1' ? 'bin/node.exe' : 'DeepSeek Harness.exe';
    const cliRelative = adapter === 'node-cli-web-v1' ? 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js' : 'cli.cjs';
    await mkdir(path.dirname(path.join(temporary, executableRelative)), { recursive: true });
    await mkdir(path.dirname(path.join(temporary, cliRelative)), { recursive: true });
    await copyFile(process.execPath, path.join(temporary, executableRelative));
    await writeFile(path.join(temporary, cliRelative), `
const fs=require('node:fs'),{randomUUID}=require('node:crypto');const args=process.argv.slice(2);
if(args.includes('--version'))console.log('fixture-version-${label}');
else if(args.includes('--help'))console.log('fixture-help-${label}');
else if(args.includes('--hold')){console.log('fixture task held');setInterval(()=>{},1000)}
else if(args.includes('--bundled-tools-probe')){const {spawnSync}=require('node:child_process');const run=(name,args)=>{const r=spawnSync(name,args,{encoding:'utf8',windowsHide:true,shell:false});if(r.error||r.status!==0)throw Error(name+' failed: '+r.stderr);return r.stdout.trim()};console.log('BUNDLED_TOOLS '+JSON.stringify({node:run('node.exe',['-p','process.execPath']),python:run('python.exe',['-c','import sys; print(sys.executable)']),git:run('git.exe',['--version']),ffmpeg:run('ffmpeg.exe',['-version']).split('\\n')[0],ffprobe:run('ffprobe.exe',['-version']).split('\\n')[0],pathKeys:Object.keys(process.env).filter(key=>key.toLowerCase()==='path').length}));}
else if(args.includes('--env-probe'))console.log('FIXTURE_ENV '+JSON.stringify({npmCache:process.env.npm_config_cache,pnpmStore:process.env.pnpm_config_store_dir,credentialAbsent:!process.env.OPENAI_API_KEY,electronRunAsNode:process.env.ELECTRON_RUN_AS_NODE??null,pythonUserBase:process.env.PYTHONUSERBASE,pipUser:process.env.PIP_USER,pythonNoUserSite:process.env.PYTHONNOUSERSITE??null,psModules:process.env.PSModulePath,npmKeyCount:Object.keys(process.env).filter(key=>/^npm_config_cache$/i.test(key)).length,pnpmKeyCount:Object.keys(process.env).filter(key=>/^pnpm_config_store_dir$/i.test(key)).length,httpProxy:process.env.HTTP_PROXY??null,httpsProxy:process.env.HTTPS_PROXY??null,allProxy:process.env.ALL_PROXY??null,registry:process.env.npm_config_registry,pythonIndex:process.env.PIP_INDEX_URL}));
else if(args[0]==='plugin'){console.log('plugin-home '+process.env.DSH_HOME);console.log('PLUGIN_ARGS '+JSON.stringify(args))}
else{let task='';process.stdin.on('data',chunk=>task+=chunk);process.stdin.on('end',()=>{const at=args.indexOf('--session-id');const id=at>=0?args[at+1]:randomUUID();console.log(JSON.stringify({type:'session',sessionId:id}));console.log(JSON.stringify({type:'final',text:'answer-${label} '+task.trim()}));console.log('api_key="fixture secret with spaces"')})}
`);
    const seal = await inventoryTree(temporary); const runtimeId = `runtime-${seal.contentSha256.slice(0, 24)}`;
    const program = path.join(root, 'runtimes', runtimeId, 'program'); await mkdir(path.dirname(program), { recursive: true });
    const { rename } = await import('node:fs/promises'); await rename(temporary, program);
    await writeFile(path.join(path.dirname(program), 'seal.json'), JSON.stringify(seal)); records.push({ id: runtimeId, version: runtimeVersion, contentSha256: seal.contentSha256, adapter });
    const instanceRoot = path.join(root, 'instances', `instance-${label}`); const routingPatch = path.join(instanceRoot, 'launcher', 'routing.patch.yml');
    await mkdir(path.dirname(routingPatch), { recursive: true }); await writeFile(routingPatch, '[]');
    const instance: DshInstance = { id: `instance-${label}`, name: `实例 ${label}`, runtimeId, createdAt: 'date', updatedAt: 'date', profile: 'web', status: 'stopped', isDefault: label === 'a',
      homePath: path.join(instanceRoot, 'home'), agentsPath: path.join(instanceRoot, 'agents'), workspacePath: path.join(instanceRoot, 'workspace'), browserPartition: `persist:${label}` };
    const plan = { executable: path.join(program, executableRelative), cli: path.join(program, cliRelative), env: {} };
    const env = await instanceEnvironment(instanceRoot, instance, plan); env.OPENAI_API_KEY = 'must-not-persist-credential';
    selections.push({ instance, plan, env, workspacePath, routingPatch, nativeCli: plan.cli, nativeArgs: ['web', '--patch', routingPatch], runtimeVersion });
  }
  await writeFile(path.join(root, 'runtimes.json'), JSON.stringify(records));
  // Synthetic transport-only receipts. Actual compatibility is exercised separately with real SDKs.
  await mkdir(path.join(root, 'compatibility'), { recursive: true });
  for (const record of records) await writeFile(path.join(root, 'compatibility', `${record.id}.json`), JSON.stringify({
    runtimeId: record.id, contentSha256: record.contentSha256, contract: compatibilityContract(), status: 'passed',
    startedAt: new Date().toISOString(), peers: [], checks: dshCompatibilityCheckIds.map(id => ({ id, status: 'passed', detail: 'synthetic transport fixture' })),
  }));
  await writeFile(path.join(root, 'instances.json'), JSON.stringify(selections.map(selection => selection.instance)));
  await writeFile(path.join(root,'network.json'),JSON.stringify({proxyMode:'direct',npmRegistry:'https://registry.npmjs.org',pythonIndex:'https://pypi.org/simple'}));
  const outputs: string[] = []; const terminal = new DshCliTerminal({ rootPath: root, onChanged: () => undefined, onOutput: event => {
    outputs.push(event.text); if(event.text.includes('\x1b[6n'))terminal.write('\x1b[1;1R',event.terminalId);
  }, resolveSelection: async () => selections[0]!, toolchain });
  await terminal.init();
  return { root, selections, terminal, outputs };
}
async function runShim(root: string, args: string[], input?: string) {
  const child = spawn(process.execPath, [path.join(root, 'cli', 'shim.cjs'), ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.on('data', chunk => { stdout += chunk.toString(); }); child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.stdin.end(input ?? '');
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  return { code, stdout, stderr };
}
async function waitOutput(terminal: DshCliTerminal, text: string) {
  const deadline = Date.now() + 15_000;
  while (!terminal.state().output.includes(text) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
  expect(terminal.state().output).toContain(text);
}
function alive(pid:number):boolean{try{process.kill(pid,0);return true;}catch{return false;}}
async function waitStopped(terminal:DshCliTerminal,id:string){const deadline=Date.now()+15_000;while(terminal.state().terminals.find(item=>item.id===id)?.status==='running'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,30));expect(terminal.state().terminals.find(item=>item.id===id)?.status).toBe('stopped');}
async function waitGone(pid:number){const deadline=Date.now()+15_000;while(alive(pid)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,30));expect(alive(pid)).toBe(false);}
async function ownedParentPid(pid:number){const executable=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');return Number((await promisify(execFile)(executable,['-NoLogo','-NoProfile','-NonInteractive','-Command',`[Console]::Write((Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').ParentProcessId)`],{windowsHide:true,timeout:10_000})).stdout.trim());}

describe('managed CLI entrypoint', () => {
  it.skipIf(process.platform !== 'win32' || !existsSync(path.resolve('resources/portable-tools/win32-x64/manifest.json')))('lets the DSH CLI and its child tools resolve the bundled toolchain by command name', async () => {
    const tools = await resolvePortableTools({ appPath: process.cwd(), resourcesPath: process.cwd() });
    const { root, selections, terminal } = await setup('desktop-cli-web-v1', async () => tools);
    try {
      await terminal.selectContext(selections[0]);
      const result = await runShim(root, ['--bundled-tools-probe']);
      expect(result.code, result.stderr).toBe(0);
      const output = JSON.parse(/^BUNDLED_TOOLS (.+)$/m.exec(result.stdout)![1]!);
      expect(path.resolve(output.node).toLowerCase()).toBe(path.resolve(tools.nodeExecutable).toLowerCase());
      expect(path.resolve(output.python).toLowerCase()).toBe(path.resolve(tools.pythonExecutable).toLowerCase());
      expect(output.git).toContain('2.48.1.windows.1');
      expect(output.ffmpeg).toContain('8.0.1-essentials_build'); expect(output.ffprobe).toContain('8.0.1-essentials_build');
      expect(output.pathKeys).toBe(1);
    } finally { await terminal.close(); }
  }, 60_000);
  it('emits syntactically valid standalone code and masks credentials including ANSI and spaces', () => {
    expect(() => new Script(externalShimSource('C:\\managed', 'C:\\managed\\cli\\context.json', 'C:\\app\\koffi.cjs'))).not.toThrow();
    expect(maskDshTerminalOutput('api_key="secret with spaces"\nauthorization=Bearer xyz\n\x1b[31mpassword: hidden\x1b[0m')).not.toMatch(/secret with spaces|xyz|hidden/);
    expect(maskDshTerminalOutput('proxy=https://fixture-user:fixture-pass@example.org/')).not.toMatch(/fixture-user|fixture-pass/);
  });
  it.skipIf(process.platform !== 'win32')('dynamically selects the exact registered version without starting a Host or persisting credentials', async () => {
    const { root, selections, terminal } = await setup();
    try {
      await terminal.selectContext(selections[0]); expect((await runShim(root, ['--version'])).stdout).toContain('fixture-version-a');
      const unmanagedWeb = await runShim(root, ['web', '--no-open']); expect(unmanagedWeb.code).toBe(1); expect(unmanagedWeb.stderr).toContain('WebUI is managed by WorldlineBox');
      const raw = await readFile(path.join(root, 'cli/context.json'), 'utf8'); expect(raw).not.toContain('must-not-persist-credential');
      await terminal.selectContext(selections[1]); expect((await runShim(root, ['--version'])).stdout).toContain('fixture-version-b');
      expect((await runShim(root, ['plugin', 'list'])).stdout).toContain(selections[1]!.instance.homePath);
      await terminal.invalidate('instance-a'); expect(terminal.state().selectedInstanceId).toBe('instance-b');
      await terminal.invalidate('instance-b'); expect(terminal.state().selectedInstanceId).toBeUndefined();
      expect((await runShim(root, ['--version'])).code).toBe(1);
    } finally { await terminal.close(); }
  });
  it.skipIf(process.platform !== 'win32')('routes the selected standalone Node release without an Electron executable alias or Electron child environment', async () => {
    const {root,selections,terminal}=await setup('node-cli-web-v1');
    try {
      await terminal.selectContext(selections[0]);
      const version=await runShim(root,['--version']); expect(version.code,version.stderr).toBe(0);expect(version.stdout).toContain('fixture-version-a');
      const env=await runShim(root,['--env-probe']);expect(env.code,env.stderr).toBe(0);
      expect(JSON.parse(/^FIXTURE_ENV (.+)$/m.exec(env.stdout)![1]!)).toMatchObject({electronRunAsNode:null});
      await terminal.selectContext(selections[1]); expect((await runShim(root,['--version'])).stdout).toContain('fixture-version-b');
    } finally {await terminal.close();}
  },30_000);
  it.skipIf(process.platform!=='win32')('uses only the exact private default workspace for an isolated version and refuses a foreign workspace override',async()=>{
    const {root,selections,terminal}=await setup('node-cli-web-v1');const selection=selections[0]!;
    selection.instance.dataScope='isolated';selection.workspacePath=path.join(root,'instances',selection.instance.id,'user','Documents','deepseek-harness','default-workspace');await mkdir(selection.workspacePath,{recursive:true});
    try{
      await terminal.selectContext(selection);const result=await runShim(root,['--version']);expect(result.code,result.stderr).toBe(0);expect(result.stdout).toContain('fixture-version-a');
      const file=path.join(root,'cli','context.json');const context=JSON.parse(await readFile(file,'utf8'));expect(context.dataScope).toBe('isolated');
      context.workspacePath=path.join(root,'shared','documents','deepseek-harness','default-workspace');await writeFile(file,JSON.stringify(context));
      expect((await runShim(root,['--version'])).stderr).toContain('CLI context paths are not managed');
    }finally{await terminal.close();}
  },30_000);
  it.skipIf(process.platform!=='win32')('rereads changed launcher proxy and registries for each command, and direct mode strips inherited proxies',async()=>{
    const {root,selections,terminal}=await setup('node-cli-web-v1');const keys=['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','npm_config_registry','PIP_INDEX_URL'];const previous=Object.entries(process.env).filter(([key])=>keys.some(value=>value.toUpperCase()===key.toUpperCase()));
    const clear=()=>{for(const key of Object.keys(process.env))if(keys.some(value=>value.toUpperCase()===key.toUpperCase()))delete process.env[key]};
    clear();process.env.HTTP_PROXY='http://foreign.invalid:99';process.env.npm_config_registry='https://foreign.invalid';process.env.PIP_INDEX_URL='https://foreign.invalid/python';
    try{
      await terminal.selectContext(selections[0]);const probe=async()=>{const result=await runShim(root,['--env-probe']);expect(result.code,result.stderr).toBe(0);return JSON.parse(/^FIXTURE_ENV (.+)$/m.exec(result.stdout)![1]!)};
      expect(await probe()).toMatchObject({httpProxy:null,httpsProxy:null,allProxy:null,registry:'https://registry.npmjs.org',pythonIndex:'https://pypi.org/simple'});
      await writeFile(path.join(root,'network.json'),JSON.stringify({proxyMode:'custom',proxyUrl:'http://127.0.0.1:7897',npmRegistry:'https://registry.npmmirror.com',pythonIndex:'https://pypi.tuna.tsinghua.edu.cn/simple'}));
      expect(await probe()).toMatchObject({httpProxy:'http://127.0.0.1:7897',httpsProxy:'http://127.0.0.1:7897',allProxy:'http://127.0.0.1:7897',registry:'https://registry.npmmirror.com',pythonIndex:'https://pypi.tuna.tsinghua.edu.cn/simple'});
      const plugin=await runShim(root,['plugin','add','fixture-native-plugin']);expect(plugin.code,plugin.stderr).toBe(0);expect(JSON.parse(/^PLUGIN_ARGS (.+)$/m.exec(plugin.stdout)![1]!)).toContain('https://registry.npmmirror.com');
      await writeFile(path.join(root,'network.json'),JSON.stringify({proxyMode:'direct',npmRegistry:'https://registry.npmjs.org',pythonIndex:'https://pypi.org/simple'}));expect(await probe()).toMatchObject({httpProxy:null,httpsProxy:null,allProxy:null});
      await writeFile(path.join(root,'network.json'),JSON.stringify({proxyMode:'custom',proxyUrl:'http://fixture-user:fixture-secret@127.0.0.1:7897',npmRegistry:'https://registry.npmjs.org',pythonIndex:'https://pypi.org/simple'}));const refused=await runShim(root,['--env-probe']);expect(refused.code).toBe(1);expect(refused.stderr).toContain('Invalid launcher network settings');expect(refused.stderr).not.toContain('fixture-secret');
    }finally{await terminal.close();clear();for(const[key,value]of previous)if(value!==undefined)process.env[key]=value;}
  },30_000);
  it.skipIf(process.platform !== 'win32')('refuses altered runtime content and foreign context environment paths before executing code', async () => {
    const { root, selections, terminal } = await setup(); const selected = selections[0]!;
    await terminal.selectContext(selected);
    const context = JSON.parse(await readFile(path.join(root, 'cli/context.json'), 'utf8')) as { env: Record<string, string> };
    context.env.NODE_OPTIONS = '--require C:\\foreign.cjs'; await writeFile(path.join(root, 'cli/context.json'), JSON.stringify(context));
    const blocked = await runShim(root, ['--version']); expect(blocked.code).toBe(1); expect(blocked.stdout).not.toContain('fixture-version-a');
    await terminal.selectContext(selected); await writeFile(selected.nativeCli!, '// altered sealed runtime');
    expect((await runShim(root, ['--version'])).stderr).toContain('Selected DSH runtime changed');
  });
  it.skipIf(process.platform !== 'win32')('provides a host-free interactive loop with native session IDs and selected-context commands', async () => {
    const { root, selections, terminal } = await setup(); await terminal.selectContext(selections[0]);
    const result = await runShim(root, [], 'first task\nsecond task\n/new\nthird task\n/exit\n');
    expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain('answer-a first task'); expect(result.stdout).toContain('answer-a third task');
    const ids = [...result.stdout.matchAll(/\[Session ([^\]]+)\]/g)].map(match => match[1]); expect(ids).toHaveLength(3); expect(ids[0]).toBe(ids[1]); expect(ids[2]).not.toBe(ids[0]);
  });
  it.skipIf(process.platform !== 'win32')('records an external CLI owner, blocks shared export while it runs and prevents new tasks under the exclusive gate', async () => {
    const { root, selections, terminal } = await setup(); await terminal.selectContext(selections[0]);
    const holder = spawn(process.execPath, [path.join(root, 'cli', 'shim.cjs'), '--hold'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => { let output = ''; holder.stdout.on('data', chunk => { output += chunk.toString(); if (output.includes('fixture task held')) resolve(); }); holder.once('error', reject); holder.once('exit', code => reject(new Error(`Fixture exited ${code}`))); });
      expect((await activeDshCliUses(root))[0]?.instanceId).toBe('instance-a');
      await expect(withDshCliExclusive(root, async () => undefined)).rejects.toThrow('CLI tasks still own');
      holder.kill(); await new Promise<void>(resolve => holder.exitCode === null && holder.signalCode === null ? holder.once('exit', () => resolve()) : resolve());
      const deadline = Date.now() + 10_000; while ((await activeDshCliUses(root)).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
      expect(await activeDshCliUses(root)).toEqual([]);
      await withDshCliExclusive(root, async () => { const blocked = await runShim(root, ['--version']); expect(blocked.code).toBe(1); expect(blocked.stderr).toContain('being backed up'); });
      expect((await runShim(root, ['--version'])).stdout).toContain('fixture-version-a');
    } finally { if (holder.exitCode === null && holder.signalCode === null) { holder.kill(); await new Promise<void>(resolve => holder.once('exit', () => resolve())); } }
  }, 40_000);
});

describe.skipIf(process.platform !== 'win32')('owned live ConPTY PowerShell terminal', () => {
  it('provides true TTY, resize, raw VT, Unicode and Ctrl+C, and naturally releases its isolated native worker',async()=>{
    const {root,selections,terminal}=await setup();
    const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    try{
      await terminal.open(selections[0]);const id=terminal.state().activeTerminalId!;const shellPid=terminal.state().terminal!.pid!;
      expect(terminal.state().terminal?.transport).toBe('conpty');
      const workerPid=await ownedParentPid(shellPid);
      expect(workerPid).toBeGreaterThan(0);expect(workerPid).not.toBe(process.pid);
      terminal.resize(id,91,27);
      terminal.write("[Console]::WriteLine('TTY_'+'REDIRECTED='+[Console]::IsOutputRedirected); [Console]::WriteLine('TTY_'+'WIDTH='+$Host.UI.RawUI.WindowSize.Width); [Console]::WriteLine('中文👋 '+('VT_'+'UNICODE')); [Console]::WriteLine(([char]27)+'[31mVT_'+'RED'+([char]27)+'[0m')\r",id);
      await waitOutput(terminal,'TTY_REDIRECTED=False');await waitOutput(terminal,'TTY_WIDTH=91');await waitOutput(terminal,'中文👋 VT_UNICODE');
      await waitOutput(terminal,'VT_RED');
      expect(terminal.state().terminal?.output).toMatch(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m\\s*VT_RED`));
      const heldPidFile=path.join(root,'held-cli.pid');
      const code=`require('node:fs').writeFileSync(${JSON.stringify(heldPidFile)},String(process.pid));console.log('OWN_'+'HOLD');setInterval(()=>{},1000)`;
      const heldProgram=path.join(root,'held-cli.cjs');await writeFile(heldProgram,code);
      terminal.write(`& '${process.execPath.replaceAll("'","''")}' '${heldProgram.replaceAll("'","''")}'\r`,id);
      await waitOutput(terminal,'OWN_HOLD');const heldPid=Number(await readFile(heldPidFile,'utf8'));expect(alive(heldPid)).toBe(true);
      terminal.write('\x03',id);await waitGone(heldPid);expect(terminal.state().terminal?.status).toBe('running');
      terminal.write("[Console]::WriteLine('CTRL_'+'CONTINUED')\r",id);await waitOutput(terminal,'CTRL_CONTINUED');
      terminal.write('exit 0\r',id);await waitStopped(terminal,id);await waitGone(shellPid);await waitGone(workerPid!);
      expect(terminal.state().terminal?.lastExitCode).toBe(0);expect(unrelated.exitCode).toBeNull();
      await terminal.open(selections[1]);expect(terminal.state().terminal?.instanceId).toBe('instance-b');
    }finally{await terminal.close();unrelated.kill();await new Promise<void>(resolve=>unrelated.exitCode===null?unrelated.once('exit',()=>resolve()):resolve());}
  },45_000);
  it('keeps two terminal dsh commands pinned while the external command follows the new selection, with bounded ring offsets and clear revisions',async()=>{
    const {root,selections,terminal}=await setup();
    try{
      await terminal.open(selections[0]);const a=terminal.state().activeTerminalId!;
      await terminal.open(selections[1]);const b=terminal.state().activeTerminalId!;expect(a).not.toBe(b);expect(terminal.state().terminals).toHaveLength(2);
      await terminal.selectContext(selections[1]);expect((await runShim(root,['--version'])).stdout).toContain('fixture-version-b');
      terminal.select(a);terminal.write('dsh --version\r',a);await waitOutput(terminal,'fixture-version-a');
      terminal.select(b);terminal.write('dsh --version\r',b);await waitOutput(terminal,'fixture-version-b');
      terminal.write("[Console]::WriteLine(('q' * 80000))\r",b);const deadline=Date.now()+15_000;
      while(terminal.state().terminal!.outputOffset===0&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,30));
      expect(terminal.state().terminal!.outputOffset).toBeGreaterThan(0);expect(terminal.state().terminal!.output.length).toBeLessThanOrEqual(64*1024);
      const revision=terminal.state().terminal!.outputRevision;terminal.clear(b);expect(terminal.state().terminal!.outputRevision).toBe(revision+1);expect(terminal.state().terminal!.outputOffset).toBe(0);
      await terminal.close(a);expect(terminal.state().terminals.find(item=>item.id===a)?.status).toBe('stopped');expect(terminal.state().terminals.find(item=>item.id===b)?.status).toBe('running');
      expect(terminal.export(b)).not.toContain('\x1b');
    }finally{await terminal.close();}
  },45_000);
  it('never reintroduces parent uppercase package-manager settings or API keys into the shell or native CLI', async () => {
    const keys = ['NPM_CONFIG_CACHE', 'PNPM_CONFIG_STORE_DIR', 'OPENAI_API_KEY','PYTHONUSERBASE','PYTHONNOUSERSITE','PIP_USER'];
    const original = Object.entries(process.env).filter(([key]) => keys.includes(key.toUpperCase()));
    const clear = () => { for (const key of Object.keys(process.env)) if (keys.includes(key.toUpperCase())) delete process.env[key]; };
    clear(); process.env.NPM_CONFIG_CACHE = 'C:\\global-parent-npm-cache'; process.env.PNPM_CONFIG_STORE_DIR = 'C:\\global-parent-pnpm-store'; process.env.OPENAI_API_KEY = 'dummy-parent-key-not-for-dsh';
    process.env.PYTHONUSERBASE='C:\\foreign-python-userbase';process.env.PYTHONNOUSERSITE='1';process.env.PIP_USER='0';
    let terminal: DshCliTerminal | undefined;
    try {
      const prepared = await setup(); terminal = prepared.terminal; const selection = prepared.selections[0]!;
      // setup's synthetic key exercises context persistence in other tests;
      // this case uses the real scrubbed instanceEnvironment contract.
      delete selection.env.OPENAI_API_KEY;
      await terminal.selectContext(selection);
      const native = await runShim(prepared.root, ['--env-probe']); expect(native.code, native.stderr).toBe(0);
      const probe = JSON.parse(/^FIXTURE_ENV (.+)$/m.exec(native.stdout)![1]!) as Record<string, unknown>;
      expect(probe).toMatchObject({ npmCache: selection.env.npm_config_cache, pnpmStore: selection.env.pnpm_config_store_dir, credentialAbsent: true, npmKeyCount: 1, pnpmKeyCount: 1 });
      expect(probe).toMatchObject({pythonUserBase:path.join(prepared.root,'instances',selection.instance.id,'user','python-userbase'),pipUser:'1',pythonNoUserSite:null,
        psModules:path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules')});
      await terminal.open(selection);
      terminal.resize(terminal.state().activeTerminalId!,600,40);
      const probeFile=path.join(prepared.root,'shell-env-probe.json');
      terminal.write(`[IO.File]::WriteAllText('${probeFile.replaceAll("'","''")}',(@{npmCache=$env:NPM_CONFIG_CACHE;pnpmStore=$env:PNPM_CONFIG_STORE_DIR;credentialAbsent=[string]::IsNullOrEmpty($env:OPENAI_API_KEY)} | ConvertTo-Json -Compress))\r`);
      let shell:Record<string,unknown>|undefined;const deadline=Date.now()+15_000;
      while(!shell&&Date.now()<deadline){try{shell=JSON.parse(await readFile(probeFile,'utf8')) as Record<string,unknown>;}catch{await new Promise(resolve=>setTimeout(resolve,30));}}
      expect(shell).toMatchObject({ npmCache: selection.env.npm_config_cache, pnpmStore: selection.env.pnpm_config_store_dir, credentialAbsent: true });
      expect(terminal.state().output).not.toMatch(/global-parent-|dummy-parent-key/);
    } finally { await terminal?.close(); clear(); for (const [key, value] of original) if (value !== undefined) process.env[key] = value; }
  });
  it('runs UTF-8 pinned dsh commands while future selection changes and stops only its own shell', async () => {
    const { selections, terminal } = await setup();
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      await terminal.open(selections[0]); terminal.write("[Console]::WriteLine('终端 Unicode 验证'); dsh --version\r");
      await waitOutput(terminal, 'fixture-version-a'); expect(terminal.state().output).toContain('终端 Unicode 验证');
      await terminal.selectContext(selections[1]);expect(terminal.state().selectedInstanceId).toBe('instance-b');
      expect(terminal.state().terminal?.instanceId).toBe('instance-a');terminal.write('dsh --version\r');
      terminal.write("[Console]::WriteLine(('x' * 80000))\r");
      await waitOutput(terminal, 'xxxxxxxxxxxxxxxx'); expect(terminal.state().output.length).toBeLessThanOrEqual(64 * 1024);
      expect(() => terminal.write('x'.repeat(64 * 1024 + 1))).toThrow('64 KiB');
      await terminal.close(); expect(terminal.state().terminal?.status).toBe('stopped'); expect(unrelated.exitCode).toBeNull();
      terminal.clear(); expect(terminal.state().output).toBe('');
      await terminal.selectContext(selections[1]);
    } finally { await terminal.close(); unrelated.kill(); await new Promise<void>(resolve => unrelated.exitCode === null ? unrelated.once('exit', () => resolve()) : resolve()); }
  }, 40_000);
  it('refuses a pre-existing foreign dsh command instead of changing user PATH', async () => {
    const { root, terminal } = await setup(); const foreign = path.join(root, 'foreign-bin'); await mkdir(foreign); await writeFile(path.join(foreign, 'dsh.cmd'), '@echo foreign');
    const previous = process.env.PATH; process.env.PATH = `${foreign};${previous ?? ''}`;
    try { await expect(terminal.installCommand()).rejects.toThrow('existing dsh command'); }
    finally { process.env.PATH = previous; }
  });
});

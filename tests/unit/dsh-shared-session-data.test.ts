import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { assertSharedSessionCompatibility, hasPrivateSaveData, migrateInstanceData, prepareSharedSessionData, sharedDataPaths, sharedSessionRoutingPatches } from '../../src/main/dsh/shared-session-data';
import { dshProjectKey, firstSessionFrameEnd } from '../../src/main/dsh/instance-data-rebase';
import { inventoryTree } from '../../src/main/dsh/files';
import { instanceEnvironment, launchCli, sanitizeOutput, terminateOwnedProcess } from '../../src/main/dsh/instance-process';
import type { DshInstance } from '../../src/shared/dsh-launcher';

const roots: string[] = [];
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-shared-session-')); roots.push(root);
  const homePath = path.join(root, 'instance', 'home'); const workspacePath = path.join(root, 'instance', 'workspace'); const sharedRoot = path.join(root, 'shared');
  await mkdir(homePath, { recursive: true }); await mkdir(workspacePath); return { root, homePath, workspacePath, sharedRoot };
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const absolute = path.resolve(root); if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('worldlinebox-shared-session-')) throw new Error('Unexpected shared-session fixture.');
    await rm(absolute, { recursive: true, force: true });
  }
});
async function put(root: string, relative: string, value: string | Buffer) {
  const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); return file;
}
async function session(root: string, cwd: string, id: string, text = 'history', compressed = true, version = 4) {
  const header = Buffer.from(`${JSON.stringify({ type: 'session', version, id, createdAt: 1, cwd, isSeeded: false, delegationDepth: 0 })}\n`);
  const events = Buffer.from(`${JSON.stringify({ type: 'session/title', seq: 0, time: 1, data: { title: text, messageSeqs: [], source: { kind: 'user' } } })}\n`);
  const bytes = compressed ? Buffer.concat([zstdCompressSync(header), zstdCompressSync(events)]) : Buffer.concat([header, events]);
  const file = await put(root, `${dshProjectKey(cwd)}/${id}/session.v${version}.jsonl${compressed ? '.zstd' : ''}`, bytes);
  return { file, bytes, events };
}
function workspace(pathValue: string, version = 2) {
  return JSON.stringify({ unit: { name: 'workspace', version }, global: { initialized: true, workspaceIds: ['default'], defaultWorkspaceId: 'default' }, tables: { workspaces: {
    default: { path: pathValue, title: 'Historical default workspace', sessionIds: ['native-shared-session'], createdAt: 'date', updatedAt: 'date' },
  } } });
}

describe('shared Session and default Workspace routing', () => {
  it('distinguishes new private profiles from legacy saved data without reading credentials', async () => {
    const { root, homePath, workspacePath } = await setup();
    await put(homePath, '.credentials.yaml', 'sensitive credential fixture'); await put(homePath, 'profiles/web/cordis.patch.yml', '[]');
    expect(await hasPrivateSaveData(homePath, workspacePath)).toBe(false);
    await put(path.join(root, 'instance', 'user', 'Documents', 'deepseek-harness', 'default-workspace'), 'legacy.txt', 'legacy working file');
    expect(await hasPrivateSaveData(homePath, workspacePath)).toBe(true);
  });
  it('uses the official bounded overrides while keeping each profile and storage root private', async () => {
    const { sharedRoot } = await setup(); const paths = await prepareSharedSessionData(sharedRoot);
    expect(paths).toEqual(sharedDataPaths(sharedRoot));
    expect(paths.workspacePath).toBe(path.join(sharedRoot, 'documents', 'deepseek-harness', 'default-workspace'));
    expect(paths.settingsPath).toBe(path.join(sharedRoot, 'model-settings.json'));
    expect(sharedSessionRoutingPatches(sharedRoot)).toEqual([
      { id: 'session-persistence-jsonl', config: { root: paths.sessionsPath, compression: 'zstd' } },
      { id: 'attachment-local', config: { dshHome: sharedRoot } },
      { id: 'workspace-controller', config: { documentsDirectory: paths.documentsPath } },
    ]);
  });

  for (const compressed of [true, false]) it(`migrates ${compressed ? 'Zstandard' : 'plain'} Sessions, the actual private Documents workspace and attachments without deleting originals`, async () => {
    const { root, homePath, workspacePath, sharedRoot } = await setup();
    const documentsDefault = path.join(root, 'instance', 'user', 'Documents', 'deepseek-harness', 'default-workspace');
    await put(documentsDefault, 'draft.md', 'private draft'); await put(workspacePath, 'cwd.txt', 'launch working directory');
    const registry = await put(homePath, 'storages/workspace.json', workspace(documentsDefault));
    const original = await session(path.join(homePath, 'sessions'), documentsDefault, 'native-shared-session', `Historical evidence ${documentsDefault}`, compressed);
    const attachment = await put(homePath, 'attachments/v1/objects/aa/object', 'attachment bytes');
    const report = await migrateInstanceData({ instanceId: 'instance-a', homePath, workspacePath, sharedRoot });
    expect(report).toMatchObject({ copiedSessions: 1, conflictingSessions: 0, copiedWorkspaceFiles: 2, copiedAttachments: 1, workspaceRegistryRebased: true });
    const paths = sharedDataPaths(sharedRoot); const migrated = await readFile(path.join(paths.sessionsPath, dshProjectKey(paths.workspacePath), 'native-shared-session', 'session.v4.jsonl.zstd'));
    const offset = firstSessionFrameEnd(migrated); expect(JSON.parse(zstdDecompressSync(migrated.subarray(0, offset)).toString()).cwd).toBe(paths.workspacePath);
    if (compressed) expect(migrated.subarray(offset)).toEqual(original.bytes.subarray(firstSessionFrameEnd(original.bytes)));
    else expect(zstdDecompressSync(migrated.subarray(offset))).toEqual(original.events);
    expect(await readFile(original.file)).toEqual(original.bytes); expect(await readFile(attachment, 'utf8')).toBe('attachment bytes');
    expect(await readFile(path.join(paths.workspacePath, 'draft.md'), 'utf8')).toBe('private draft');
    expect(JSON.parse(await readFile(registry, 'utf8')).tables.workspaces.default.path).toBe(paths.workspacePath);
    expect(await readFile(path.join(report.archivePath!, 'workspace-registry.json'), 'utf8')).toBe(workspace(documentsDefault));
    const again = await migrateInstanceData({ instanceId: 'instance-a', homePath, workspacePath, sharedRoot });
    expect(again).toMatchObject({ copiedSessions: 0, conflictingSessions: 0, copiedWorkspaceFiles: 0, conflictingWorkspaceFiles: 0, copiedAttachments: 0, conflictingAttachments: 0 });
  });

  it('merges only missing entries and archives every conflicting original without replacing public data', async () => {
    const { homePath, workspacePath, sharedRoot } = await setup(); const paths = await prepareSharedSessionData(sharedRoot);
    const source = await session(path.join(homePath, 'sessions'), workspacePath, 'same-id', 'private history');
    const existing = await session(paths.sessionsPath, paths.workspacePath, 'same-id', 'public history');
    await put(workspacePath, 'same.txt', 'private workspace'); await put(paths.workspacePath, 'same.txt', 'public workspace'); await put(workspacePath, 'new.txt', 'new workspace');
    await put(homePath, 'attachments/v1/objects/aa/object', 'private attachment'); await put(paths.attachmentsPath, 'objects/aa/object', 'public attachment');
    const report = await migrateInstanceData({ instanceId: 'conflict-a', homePath, workspacePath, sharedRoot });
    expect(report).toMatchObject({ copiedSessions: 0, conflictingSessions: 1, conflictingWorkspaceFiles: 1, copiedWorkspaceFiles: 1, conflictingAttachments: 1 });
    expect(await readFile(existing.file)).toEqual(existing.bytes); expect(await readFile(source.file)).toEqual(source.bytes);
    expect(await readFile(path.join(paths.workspacePath, 'same.txt'), 'utf8')).toBe('public workspace');
    expect(await readFile(path.join(paths.attachmentsPath, 'objects/aa/object'), 'utf8')).toBe('public attachment');
    expect(await readFile(path.join(report.archivePath!, 'sessions', dshProjectKey(workspacePath), 'same-id', 'session.v4.jsonl.zstd'))).toEqual(source.bytes);
    expect(await readFile(path.join(report.archivePath!, 'workspace-0/same.txt'), 'utf8')).toBe('private workspace');
  });

  it('rebases complete-backup Session headers from their recorded public cwd rather than the archive directory', async () => {
    const { root, homePath, workspacePath, sharedRoot } = await setup(); const oldWorkspacePath = path.join(root, 'original-shared-default');
    const original = await session(path.join(homePath, 'sessions'), oldWorkspacePath, 'backup-session', 'backup history'); await put(workspacePath, 'backup.txt', 'backup workspace');
    const report = await migrateInstanceData({ instanceId: 'backup-a', homePath, workspacePath, sharedRoot, oldWorkspacePath }); expect(report.copiedSessions).toBe(1);
    const paths = sharedDataPaths(sharedRoot); const file = path.join(paths.sessionsPath, dshProjectKey(paths.workspacePath), 'backup-session', 'session.v4.jsonl.zstd');
    const bytes = await readFile(file); const offset = firstSessionFrameEnd(bytes);
    expect(JSON.parse(zstdDecompressSync(bytes.subarray(0, offset)).toString()).cwd).toBe(paths.workspacePath);
    expect(bytes.subarray(offset)).toEqual(original.bytes.subarray(firstSessionFrameEnd(original.bytes)));
  });

  it('refuses future Session, Workspace and attachment schemas before any public data is written', async () => {
    for (const kind of ['session', 'workspace', 'attachment']) {
      const { homePath, workspacePath, sharedRoot } = await setup();
      await session(path.join(homePath, 'sessions'), workspacePath, 'future-id', 'history', true, kind === 'session' ? 99 : 4);
      if (kind === 'workspace') await put(homePath, 'storages/workspace.json', workspace(workspacePath, 99));
      if (kind === 'attachment') await put(homePath, 'attachments/v99/unknown', 'future attachment');
      const before = (await inventoryTree(homePath)).contentSha256;
      await expect(migrateInstanceData({ instanceId: 'future-a', homePath, workspacePath, sharedRoot })).rejects.toThrow(/Unsupported/);
      await expect(readdir(sharedRoot)).rejects.toThrow(); expect((await inventoryTree(homePath)).contentSha256).toBe(before);
    }
  });

  it('rejects a future shared generation and an unverified runtime adapter without changing existing logs', async () => {
    const { sharedRoot } = await setup(); const paths = await prepareSharedSessionData(sharedRoot);
    const current = await session(paths.sessionsPath, paths.workspacePath, 'known-id');
    await expect(assertSharedSessionCompatibility(sharedRoot, 'future-runtime')).rejects.toThrow('no verified'); expect(await readFile(current.file)).toEqual(current.bytes);
    const future = await session(paths.sessionsPath, paths.workspacePath, 'future-id', 'future history', true, 99);
    await expect(prepareSharedSessionData(sharedRoot)).rejects.toThrow('Unsupported'); expect(await readFile(future.file)).toEqual(future.bytes);
  });

  it('rejects a resource junction outside private sessions before any copying', async () => {
    const { root, homePath, workspacePath, sharedRoot } = await setup(); const outside = path.join(root, 'outside'); await mkdir(outside);
    await symlink(outside, path.join(homePath, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(migrateInstanceData({ instanceId: 'linked-a', homePath, workspacePath, sharedRoot })).rejects.toThrow('linked');
    await expect(readdir(sharedRoot)).rejects.toThrow();
  });
});

describe.skipIf(process.platform !== 'win32' || !process.env.WORLDLINEBOX_DSH_REAL_DIRECTORY)('official shared Session single-writer contract', () => {
  it('lets different isolated Hosts read shared history, refuses concurrent writes to one Session and releases the native lease after close', async () => {
    const { root, sharedRoot } = await setup(); const paths = await prepareSharedSessionData(sharedRoot); const program = path.resolve(process.env.WORLDLINEBOX_DSH_REAL_DIRECTORY!);
    const routing = await put(root, 'routing.patch.yml', JSON.stringify(sharedSessionRoutingPatches(sharedRoot)));
    const script = await put(root, 'native-shared.mjs', `
import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url'; import path from 'node:path';
const [program,mode,routing,cwd]=process.argv.slice(2);
const load=createRequire(path.join(program,'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json'));
const {runProfile}=await import(pathToFileURL(load.resolve('@deepseek-ai/dsh/profile-boot')));
const {loadLayeredEnv}=await import(pathToFileURL(load.resolve('@deepseek-ai/dsh-app-boot')));
const running=await runProfile({profile:'web',environment:loadLayeredEnv('dsh'),patchFiles:[routing],args:['--no-open','--port','0']});const {ctx}=running;
if(mode==='hold') { const writer=await ctx.sessionPersistence.create({version:4,id:'native-shared-session',createdAt:1,cwd,isSeeded:false,delegationDepth:0});
await writer.append([{type:'session/title',seq:0,time:1,data:{title:'shared history',messageSeqs:[],source:{kind:'user'}}}]);await writer.flush();
console.log('SHARED_NATIVE_RESULT '+JSON.stringify({held:true,root:ctx.sessionPersistence.root}));process.stdin.once('data',async()=>{await writer.close();console.log('SHARED_NATIVE_RELEASED true')});
} else { const reader=await ctx.sessionPersistence.open('native-shared-session','read');const events=await reader.read();await reader.close();let refused=false;let writer;
try{writer=await ctx.sessionPersistence.open('native-shared-session','write');}catch(error){if(error.name!=='SessionAlreadyOwnedError')throw error;refused=true}
if(writer){await writer.append([{type:'session/title',seq:1,time:2,data:{title:'after handoff',messageSeqs:[],source:{kind:'user'}}}]);await writer.flush();await writer.close()}
const other=await ctx.sessionPersistence.create({version:4,id:'other-'+mode,createdAt:1,cwd,isSeeded:false,delegationDepth:0});await other.flush();await other.close();
console.log('SHARED_NATIVE_RESULT '+JSON.stringify({refused,eventCount:events.events.length,root:ctx.sessionPersistence.root}));await running.shutdown.shutdown(0); }
`);
    const start = async (id: string, mode: string) => {
      const instanceRoot = path.join(root, id); const instance: DshInstance = { id, name: id, runtimeId: 'official', createdAt: 'date', updatedAt: 'date', profile: 'web', status: 'stopped', isDefault: false,
        homePath: path.join(instanceRoot, 'home'), agentsPath: path.join(instanceRoot, 'agents'), workspacePath: paths.workspacePath, browserPartition: `persist:${id}` };
      const plan = { executable: path.join(program, 'DeepSeek Harness.exe'), cli: script, env: { ELECTRON_RUN_AS_NODE: '1', DSH_TELEMETRY_DISABLED: '1' } };
      const child = await launchCli(plan, [program, mode, routing, paths.workspacePath], await instanceEnvironment(instanceRoot, instance, plan), paths.workspacePath);
      const result = new Promise<{ held?: boolean; refused?: boolean; eventCount?: number; root: string }>((resolve, reject) => {
        let output = ''; let errors = ''; const timer = setTimeout(() => reject(new Error('Native shared Session probe timed out.')), 25_000);
        child.stderr.on('data', chunk => { errors += chunk.toString(); }); child.stdout.on('data', chunk => {
          output += chunk.toString(); const line = /^SHARED_NATIVE_RESULT (.+)$/m.exec(output)?.[1]; if (line) { clearTimeout(timer); resolve(JSON.parse(line)); }
        }); child.once('error', error => { clearTimeout(timer); reject(error); }); child.once('close', code => { clearTimeout(timer); if (!/^SHARED_NATIVE_RESULT /m.test(output)) reject(new Error(sanitizeOutput(`Probe ${code}: ${errors}\n${output}`))); });
      }); return { child, result };
    };
    const holder = await start('native-holder', 'hold');
    try {
      expect(await holder.result).toMatchObject({ held: true, root: paths.sessionsPath });
      const contender = await start('native-contender', 'contend');
      try { expect(await contender.result).toMatchObject({ refused: true, eventCount: 1, root: paths.sessionsPath }); }
      finally { await terminateOwnedProcess(contender.child); }
      const released = new Promise<void>((resolve, reject) => {
        let output = ''; const timer = setTimeout(() => reject(new Error('Native writer did not acknowledge close.')), 10_000);
        const onData = (chunk: Buffer) => { output += chunk.toString(); if (output.includes('SHARED_NATIVE_RELEASED true')) { clearTimeout(timer); holder.child.stdout.removeListener('data', onData); resolve(); } };
        holder.child.stdout.on('data', onData);
      });
      holder.child.stdin.write('release\n'); await released;
      const next = await start('native-successor', 'resume');
      try { expect(await next.result).toMatchObject({ refused: false, eventCount: 1, root: paths.sessionsPath }); }
      finally { await terminateOwnedProcess(next.child); }
    } finally { await terminateOwnedProcess(holder.child); }
  }, 90_000);
});

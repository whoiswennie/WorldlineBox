import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { copyTree, inventoryTree } from '../../src/main/dsh/files';
import { dshProjectKey, firstSessionFrameEnd, rebaseCopiedSessionData } from '../../src/main/dsh/instance-data-rebase';
import { instanceEnvironment, launchCli, sanitizeOutput, terminateOwnedProcess } from '../../src/main/dsh/instance-process';
import type { DshInstance } from '../../src/shared/dsh-launcher';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const compress = (bytes: Buffer) => zstdCompressSync(bytes, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-session-rebase-')); roots.push(root);
  const source = path.join(root, 'source'); const copy = path.join(root, 'copy'); const external = path.join(root, 'external');
  await mkdir(path.join(source, 'workspace'), { recursive: true }); await mkdir(external);
  return { root, source, copy, external };
}
async function log(source: string, cwd: string, version: number, compressed: boolean, body: Buffer, id = 'session-1') {
  const directory = path.join(source, 'home/sessions', dshProjectKey(cwd), id); await mkdir(directory, { recursive: true });
  const header = Buffer.from(JSON.stringify({ type: 'session', version, id, createdAt: 1, cwd, isSeeded: false, delegationDepth: 0 }) + '\n');
  const bytes = compressed ? Buffer.concat([compress(header), compress(body)]) : Buffer.concat([header, body]);
  const filename = `session.v${version}.jsonl${compressed ? '.zstd' : ''}`;
  await writeFile(path.join(directory, filename), bytes); return { filename, directory, bytes };
}

describe('version-pinned copied Session working-directory relocation', () => {
  for (const compressed of [true, false]) it(`relocates all known generations and preserves ${compressed ? 'compressed event frames' : 'plain event bytes'}`, async () => {
    const { source, copy, external } = await setup();
    const oldCwd = path.join(source, 'workspace'); const body = Buffer.from(`{"type":"user/message","data":{"text":${JSON.stringify(`Historical evidence mentions ${oldCwd}`)}}}\r\n`);
    const v2 = await log(source, oldCwd, 2, compressed, body); const v4 = await log(source, oldCwd, 4, compressed, body);
    const externalLog = await log(source, external, 4, compressed, body, 'external-session');
    await mkdir(path.join(source, 'home/storages/session_projcache'), { recursive: true });
    await writeFile(path.join(source, 'home/storages/session_projcache/cache.json'), '{}');
    await writeFile(path.join(source, 'home/storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: ['internal', 'external'] }, tables: { workspaces: {
      internal: { path: oldCwd, title: `Keep text ${oldCwd}`, sessionIds: ['session-1'], createdAt: 'date', updatedAt: 'date' },
      external: { path: external, title: 'User-selected external project', sessionIds: ['external-session'], createdAt: 'date', updatedAt: 'date' },
    } } }));
    const original = await inventoryTree(source); await copyTree(source, copy);
    await rebaseCopiedSessionData({ instanceRoot: copy, oldRoot: source, runtimeVersion: '0.2.0-rc.2' });
    const nextCwd = path.join(copy, 'workspace');
    for (const generation of [v2, v4]) {
      const relocated = await readFile(path.join(copy, 'home/sessions', dshProjectKey(nextCwd), 'session-1', generation.filename));
      const oldOffset = compressed ? firstSessionFrameEnd(generation.bytes) : generation.bytes.indexOf(10) + 1;
      const newOffset = compressed ? firstSessionFrameEnd(relocated) : relocated.indexOf(10) + 1;
      expect(relocated.subarray(newOffset)).toEqual(generation.bytes.subarray(oldOffset));
      const header = compressed ? zstdDecompressSync(relocated.subarray(0, newOffset)) : relocated.subarray(0, newOffset);
      expect(JSON.parse(header.toString()).cwd).toBe(nextCwd);
    }
    expect(await readFile(path.join(copy, path.relative(source, externalLog.directory), externalLog.filename))).toEqual(externalLog.bytes);
    const workspace = JSON.parse(await readFile(path.join(copy, 'home/storages/workspace.json'), 'utf8'));
    expect(workspace.tables.workspaces.internal.path).toBe(nextCwd); expect(workspace.tables.workspaces.internal.title).toBe(`Keep text ${oldCwd}`);
    expect(workspace.tables.workspaces.external.path).toBe(external);
    await expect(readFile(path.join(copy, 'home/storages/session_projcache/cache.json'))).rejects.toThrow();
    expect((await inventoryTree(source)).contentSha256).toBe(original.contentSha256);
    expect(JSON.parse(await readFile(path.join(copy, 'session-rebase-receipt.json'), 'utf8')).headers).toHaveLength(2);
  });
  it('rejects truncated first frames and future owned Session formats before changing the copy', async () => {
    for (const kind of ['truncated', 'future']) {
      const { source, copy } = await setup();
      const row = await log(source, path.join(source, 'workspace'), kind === 'future' ? 99 : 4, true, Buffer.from('{}\n'));
      if (kind === 'truncated') await writeFile(path.join(row.directory, row.filename), row.bytes.subarray(0, 7));
      await copyTree(source, copy); const before = await inventoryTree(copy);
      await expect(rebaseCopiedSessionData({ instanceRoot: copy, oldRoot: source, runtimeVersion: '0.2.0-rc.2' })).rejects.toThrow();
      expect((await inventoryTree(copy)).contentSha256).toBe(before.contentSha256);
    }
  });
  it('rejects unverified runtime adapters and cannot mutate the original instance in place', async () => {
    const { source, copy } = await setup(); await log(source, path.join(source, 'workspace'), 4, false, Buffer.from('{}\n')); await copyTree(source, copy);
    await expect(rebaseCopiedSessionData({ instanceRoot: copy, oldRoot: source, runtimeVersion: 'future-version' })).rejects.toThrow('no verified');
    await expect(rebaseCopiedSessionData({ instanceRoot: source, oldRoot: source, runtimeVersion: '0.2.0-rc.2' })).rejects.toThrow('distinct');
  });
});

describe.skipIf(process.platform !== 'win32' || !process.env.WORLDLINEBOX_DSH_REAL_DIRECTORY)('official persistence relocation', () => {
  it('creates a session with the upstream API, relocates its copied generations and lists/opens it through the upstream API', async () => {
    const { root, source, copy } = await setup();
    const program = path.resolve(process.env.WORLDLINEBOX_DSH_REAL_DIRECTORY!);
    const script = path.join(root, 'native-persistence.mjs');
    await writeFile(script, `
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const [program, mode, cwd] = process.argv.slice(2);
const load = createRequire(path.join(program,'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json'));
const { runProfile } = await import(pathToFileURL(load.resolve('@deepseek-ai/dsh/profile-boot')));
const { loadLayeredEnv } = await import(pathToFileURL(load.resolve('@deepseek-ai/dsh-app-boot')));
const running = await runProfile({ profile:'web', environment:loadLayeredEnv('dsh'), patchFiles:[], args:['--no-open','--port','0'] });
const { ctx } = running;
if(mode==='create') {
  const writer=await ctx.sessionPersistence.create({version:4,id:'native-copy-session',createdAt:1,cwd,isSeeded:false,delegationDepth:0});
  await writer.append([{type:'session/title',seq:0,time:1,data:{title:'Historical evidence '+cwd,messageSeqs:[],source:{kind:'user'}}}]);
  await writer.flush(); await writer.close();
  const workspace=await ctx.workspaceRegistry.create(cwd,'Native copy test');
  await workspace.attachSession('native-copy-session');
}
const listing=await ctx.sessionPersistence.list();
const reader=await ctx.sessionPersistence.open('native-copy-session','read');
const events=await reader.read();
console.log('ADAPTER_NATIVE_RESULT '+JSON.stringify({cwd:reader.header.cwd,listed:listing.some(value=>value.header?.id==='native-copy-session'),eventCount:events.events.length,eventTitle:events.events[0]?.data?.title,workspacePaths:ctx.workspaceRegistry.list().map(value=>value.path)}));
await reader.close(); await running.shutdown.shutdown(0);
`);
    const invoke = async (instanceRoot: string, mode: string) => {
      const instance: DshInstance = { id: 'native-copy-test', name: 'Native copy test', runtimeId: 'official', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), profile: 'web', status: 'stopped',
        homePath: path.join(instanceRoot, 'home'), agentsPath: path.join(instanceRoot, 'agents'), workspacePath: path.join(instanceRoot, 'workspace'), browserPartition: 'persist:native-copy-test', isDefault: false };
      const plan = { executable: path.join(program, 'DeepSeek Harness.exe'), cli: script, env: { ELECTRON_RUN_AS_NODE: '1', DSH_TELEMETRY_DISABLED: '1' } };
      const environment = await instanceEnvironment(instanceRoot, instance, plan);
      const child = await launchCli(plan, [program, mode, instance.workspacePath], environment, instance.workspacePath);
      try {
        return await new Promise<{ cwd: string; listed: boolean; eventCount: number; eventTitle: string; workspacePaths: string[] }>((resolve, reject) => {
          let stdout = ''; let stderr = '';
          const timer = setTimeout(() => reject(new Error('Native persistence verification timed out.')), 25_000);
          child.stdout.on('data', chunk => { stdout += chunk.toString(); }); child.stderr.on('data', chunk => { stderr += chunk.toString(); });
          child.once('error', error => { clearTimeout(timer); reject(error); });
          child.once('close', code => {
            clearTimeout(timer);
            const result = /^ADAPTER_NATIVE_RESULT (.+)$/m.exec(stdout)?.[1];
            if (code !== 0 || !result) reject(new Error(sanitizeOutput(stderr + '\n' + stdout)));
            else resolve(JSON.parse(result));
          });
        });
      } finally { await terminateOwnedProcess(child); }
    };
    const created = await invoke(source, 'create'); expect(created.cwd).toBe(path.join(source, 'workspace')); expect(created.listed).toBe(true);
    const original = await inventoryTree(source); await copyTree(source, copy);
    await rebaseCopiedSessionData({ instanceRoot: copy, oldRoot: source, runtimeVersion: '0.2.0-rc.2' });
    const reopened = await invoke(copy, 'read');
    expect(reopened.cwd).toBe(path.join(copy, 'workspace')); expect(reopened.listed).toBe(true); expect(reopened.eventCount).toBe(1);
    expect(reopened.eventTitle).toBe(`Historical evidence ${path.join(source, 'workspace')}`);
    expect(reopened.workspacePaths).toContain(path.join(copy, 'workspace'));
    expect(reopened.workspacePaths).not.toContain(path.join(source, 'workspace'));
    expect((await inventoryTree(source)).contentSha256).toBe(original.contentSha256);
  }, 60_000);
});

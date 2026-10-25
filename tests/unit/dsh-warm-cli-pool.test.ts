import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DshWarmCliPool, dshWorkerGeneration, dshWorkerIdentity } from '../../src/main/dsh/warm-cli-pool';
import { launchCli } from '../../src/main/dsh/instance-process';
import { removeManaged } from '../../src/main/dsh/files';
import type { DshCliSelection } from '../../src/main/dsh/cli-terminal';

const roots: string[] = [], pools: DshWarmCliPool[] = [];
afterEach(async () => { vi.useRealTimers(); for (const pool of pools.splice(0)) await pool.shutdown(); for (const root of roots.splice(0)) await removeManaged(os.tmpdir(), root); });
async function fixture(onChanged?: (instanceId: string, ready: boolean) => void) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-warm-pool-')); roots.push(root);
  const source = path.join(root, 'worker.cjs');
  await writeFile(source, `const rl=require('node:readline').createInterface({input:process.stdin});console.log(JSON.stringify({type:'runtime_ready'}));rl.on('line',line=>{if(JSON.parse(line).type==='open')console.log(JSON.stringify({type:'task_finished',code:0}))});`);
  let starts = 0, disposed = 0;
  const pool = new DshWarmCliPool(onChanged); pools.push(pool);
  const acquire = (key = 'same', signal = new AbortController().signal, instanceId = 'instance', cohort = key) => pool.acquire(key, instanceId, async () => {
    starts++; const child = await launchCli({ executable: process.execPath, cli: source, env: {} }, [], { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, root);
    return { child, disposeContext: async () => { disposed++; } };
  }, signal, cohort);
  return { root, pool, acquire, counts: () => ({starts,disposed}) };
}

it('reuses a ready owned process exclusively, retires generations, and keeps pins until termination', async () => {
  const test = await fixture();
  const first = await test.acquire(); expect(first.reused).toBe(false);
  expect(await test.pool.run(first.worker, {})).toBe(0); first.release();
  const second = await test.acquire(); expect(second.reused).toBe(true); expect(second.worker.child.pid).toBe(first.worker.child.pid);
  expect(test.counts()).toEqual({ starts:1,disposed:0 });
  await test.pool.invalidateIdle('instance'); // Active pins survive; retiring hosts cannot take another task.
  expect(test.counts().disposed).toBe(0); expect(await test.pool.run(second.worker, {})).toBe(0); second.release();
  const third = await test.acquire('changed'); expect(third.reused).toBe(false); expect(third.worker.child.pid).not.toBe(first.worker.child.pid);
  third.release(); await test.pool.shutdown(); expect(test.counts()).toEqual({ starts:2,disposed:2 });
});

it('gives concurrent tasks different processes and destroys an aborted boot', async () => {
  const test = await fixture();
  const first = await test.acquire(), second = await test.acquire();
  expect(first.worker.child.pid).not.toBe(second.worker.child.pid);
  first.release(); second.release();
  const aborted = new AbortController(); aborted.abort();
  const beforeAbort = test.counts().starts;
  await expect(test.acquire('third', aborted.signal)).rejects.toThrow();
  expect(test.counts().starts).toBe(beforeAbort);
  await test.pool.shutdown(); expect(test.counts().disposed).toBe(test.counts().starts);
});

it('closes a late-started owned process when shutdown wins the launch race', async () => {
  const test = await fixture(); let admitted!: () => void, release!: () => void, disposed = 0;
  const starting = new Promise<void>(resolve => { admitted = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const pending = test.pool.acquire('late', 'instance', async () => {
    const child = await launchCli({ executable: process.execPath, cli: path.join(test.root, 'worker.cjs'), env: {} }, [],
      { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, test.root);
    admitted(); await gate; return { child, disposeContext: async () => { disposed++; } };
  }, new AbortController().signal);
  await starting; await test.pool.shutdown(); release();
  await expect(pending).rejects.toThrow('closing'); expect(disposed).toBe(1);
});

it('keeps only the selected standby beyond ten idle minutes and restores expiry after selection or shutdown', async () => {
  const test = await fixture(); test.pool.setStandbyInstance('instance');
  const selected = await test.acquire(), other = await test.acquire('other', undefined, 'other');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); selected.release(); other.release();
  await vi.advanceTimersByTimeAsync(11 * 60_000); vi.useRealTimers();
  await expect.poll(() => test.counts().disposed).toBe(1);
  const later = await test.acquire(); expect(later.worker.child.pid).toBe(selected.worker.child.pid); later.release();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); test.pool.setStandbyInstance('other');
  await vi.advanceTimersByTimeAsync(11 * 60_000); vi.useRealTimers();
  await expect.poll(() => test.counts().disposed).toBe(2);
  await test.pool.shutdown(); test.pool.setStandbyInstance('instance');
  await expect(test.acquire()).rejects.toThrow('closing'); expect(test.counts().starts).toBe(2);
});

it('retires a selected standby at thirty-two uses and publishes its loss before a fresh replacement', async () => {
  const changes: boolean[] = [], test = await fixture((_instanceId, ready) => changes.push(ready)); test.pool.setStandbyInstance('instance');
  let originalPid: number | undefined;
  for (let use = 0; use < 32; use++) {
    const lease = await test.acquire(); originalPid ??= lease.worker.child.pid;
    expect(lease.worker.child.pid).toBe(originalPid); expect(await test.pool.run(lease.worker, { use })).toBe(0); lease.release();
  }
  await expect.poll(() => test.counts().disposed).toBe(1); expect(changes.at(-1)).toBe(false);
  const replacement = await test.acquire(); expect(replacement.worker.child.pid).not.toBe(originalPid); replacement.release();
  expect(changes.at(-1)).toBe(true);
  await test.pool.invalidateIdle('instance'); expect(test.counts().disposed).toBe(2); expect(changes.at(-1)).toBe(false);
});

it('keeps two access-isolated standby keys in one cohort and reports a missing rotated policy while its peer remains ready', async () => {
  const changes: boolean[] = [], test = await fixture((_id, ready) => changes.push(ready)); test.pool.setStandbyInstance('instance');
  const full = await test.acquire('full', undefined, 'instance', 'profile-v1'); full.release();
  const readonly = await test.acquire('readonly-empty-env', undefined, 'instance', 'profile-v1'); readonly.release();
  expect(readonly.worker.child.pid).not.toBe(full.worker.child.pid); expect(test.counts().starts).toBe(2);
  const fullAgain = await test.acquire('full', undefined, 'instance', 'profile-v1'); expect(fullAgain.worker.child.pid).toBe(full.worker.child.pid); fullAgain.release();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); await vi.advanceTimersByTimeAsync(11 * 60_000); vi.useRealTimers();
  expect(test.counts().disposed).toBe(0);
  for (let use = 1; use < 32; use++) {
    const lease = await test.acquire('readonly-empty-env', undefined, 'instance', 'profile-v1');
    expect(lease.worker.child.pid).toBe(readonly.worker.child.pid); expect(await test.pool.run(lease.worker, {})).toBe(0); lease.release();
  }
  await expect.poll(() => test.counts().disposed).toBe(1); expect(changes.at(-1)).toBe(false);
  const replacement = await test.acquire('readonly-empty-env', undefined, 'instance', 'profile-v1'); replacement.release();
  expect(replacement.worker.child.pid).not.toBe(readonly.worker.child.pid); expect(changes.at(-1)).toBe(true);
  const preserved = await test.acquire('full', undefined, 'instance', 'profile-v1'); expect(preserved.worker.child.pid).toBe(full.worker.child.pid); preserved.release();
  const changed = await test.acquire('new-profile', undefined, 'instance', 'profile-v2'); changed.release();
  await expect.poll(() => test.counts().disposed).toBe(3);
});

it('hashes actual configuration changes while ignoring native session output and boot identity state', async () => {
  const test = await fixture(), home = path.join(test.root,'home'), agents = path.join(test.root,'agents'), workspace = path.join(test.root,'workspace');
  await mkdir(path.join(home,'profiles','web'),{recursive:true}); await mkdir(path.join(home,'sessions'),{recursive:true}); await mkdir(agents); await mkdir(workspace);
  const config = path.join(home,'profiles','web','cordis.patch.yml'); await writeFile(config,'[]');
  const selected: DshCliSelection = { instance: { id:'instance', name:'Instance',runtimeId:'runtime-fixture',profile:'web',status:'stopped',homePath:home,agentsPath:agents,
    workspacePath:workspace,browserPartition:'temporary:test',isDefault:true,createdAt:'',updatedAt:'' }, plan:{executable:process.execPath,cli:'fixture',env:{}},workspacePath:workspace,env:{API_KEY:'private-local-fixture'},routingPatch:'' };
  const before = await dshWorkerGeneration(test.root,selected,{mode:'workspace-write'});
  // The old full generation is a persisted continuation contract. This fixture
  // has exactly one profile file, so its previous byte sequence is explicit.
  const legacy = createHash('sha256');
  legacy.update(JSON.stringify({ instance: selected.instance.id, runtime: selected.runtime, args: selected.nativeArgs,
    executable: selected.plan.executable, access: { mode: 'workspace-write' }, env: Object.entries(selected.env).sort(([a], [b]) => a.localeCompare(b)) }));
  for (const item of [home, path.join(home, 'profiles'), path.join(home, 'profiles', 'web'), config]) legacy.update(item);
  legacy.update('[]'); legacy.update(agents);
  for (const item of ['model-settings.json', '.credentials.yaml']) { legacy.update(path.join(test.root, 'shared', item)); legacy.update('missing'); }
  expect(before).toBe(legacy.digest('hex'));
  const fullIdentity = await dshWorkerIdentity(test.root, selected, { mode: 'workspace-write' });
  const readIdentity = await dshWorkerIdentity(test.root, selected, { mode: 'read-only' });
  expect(fullIdentity.key).toBe(before); expect(readIdentity.key).not.toBe(before); expect(readIdentity.cohort).toBe(fullIdentity.cohort);
  const emptyWorkspace = path.join(test.root, 'managed-empty'); await mkdir(emptyWorkspace);
  await writeFile(path.join(workspace, '.env'), 'SOURCE_ONLY=value');
  const sourceEnv = await dshWorkerIdentity(test.root, selected, { mode: 'read-only' });
  const managedEnv = await dshWorkerIdentity(test.root, { ...selected, workspacePath: emptyWorkspace }, { mode: 'read-only' });
  expect(sourceEnv.key).not.toBe(managedEnv.key); expect(sourceEnv.policyKey).not.toBe(managedEnv.policyKey);
  expect(sourceEnv.cohort).toBe(managedEnv.cohort); expect(managedEnv.key).toBe(readIdentity.key);
  await writeFile(path.join(workspace, '.env'), '');
  await writeFile(path.join(home,'sessions','task.jsonl'),'unrelated session changes'); await writeFile(path.join(home,'.anonymous-user-id'),'new-anonymous-id');
  expect(await dshWorkerGeneration(test.root,selected,{mode:'workspace-write'})).toBe(before);
  await writeFile(config,'[{"id":"tool-fs","disabled":true}]');
  expect(await dshWorkerGeneration(test.root,selected,{mode:'workspace-write'})).not.toBe(before);
  await writeFile(config,'[]'); selected.env.API_KEY='new-private-local-fixture';
  expect(await dshWorkerGeneration(test.root,selected,{mode:'workspace-write'})).not.toBe(before);
});

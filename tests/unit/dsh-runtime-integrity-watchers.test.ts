import { afterEach, expect, test, vi } from 'vitest';
import type * as Fs from 'node:fs';
import { mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const monitors = vi.hoisted(() => ({ fail: false, calls: [] as Array<{
  directory: string; callback(event: string, name?: string): void;
  errors: Array<() => void>; closes: number;
}> }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof Fs>();
  return { ...actual, watch: vi.fn((directory: string, _options: unknown, callback: (event: string, name?: string) => void) => {
    if (monitors.fail) throw Error('monitor unavailable');
    const entry = { directory, callback, errors: [] as Array<() => void>, closes: 0 };
    monitors.calls.push(entry);
    const watcher = { on(event: string, listener: () => void) { if (event === 'error') entry.errors.push(listener); return watcher; },
      close() { entry.closes++; } };
    return watcher;
  }) };
});

import { RuntimeIntegrity } from '../../src/main/dsh/runtime-integrity';

const roots: string[] = [], gates: RuntimeIntegrity[] = [];
afterEach(async () => {
  for (const gate of gates.splice(0)) gate.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  monitors.calls.length = 0; monitors.fail = false;
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-integrity-watch-')); roots.push(root);
  const directory = path.join(root, 'artifact'); await mkdir(directory);
  const gate = new RuntimeIntegrity(); gates.push(gate);
  let count = 0;
  return { root, directory, gate, check: async () => { count++; }, count: () => count };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('parent metadata changes dirty the proof without discarding a healthy recursive monitor', async () => {
  const f = await fixture(); await f.gate.verify(f.directory, f.check);
  expect(f.count()).toBe(1); expect(monitors.calls).toHaveLength(2);
  const parent = monitors.calls[0]!;
  parent.callback('change', 'unrelated-runtime');
  await f.gate.verify(f.directory, f.check); expect(f.count()).toBe(1);
  parent.callback('change', 'artifact');
  await Promise.all(Array.from({ length: 8 }, () => f.gate.verify(f.directory, f.check)));
  expect(f.count()).toBe(2); expect(monitors.calls).toHaveLength(2);
  expect(monitors.calls.every(monitor => monitor.closes === 0)).toBe(true);
  await f.gate.verify(f.directory, f.check); expect(f.count()).toBe(2);
});

test.each(['rename', 'error'])('a parent %s rebuilds both monitors and never reuses the old proof or callbacks', async event => {
  const f = await fixture(); await f.gate.verify(f.directory, f.check);
  const oldParent = monitors.calls[0]!, oldChild = monitors.calls[1]!;
  if (event === 'rename') oldParent.callback('rename', 'artifact'); else oldParent.errors[0]!();
  expect(oldParent.closes).toBe(1); expect(oldChild.closes).toBe(1);
  await Promise.all(Array.from({ length: 8 }, () => f.gate.verify(f.directory, f.check)));
  expect(f.count()).toBe(2); expect(monitors.calls).toHaveLength(4);
  const parent = monitors.calls[2]!, child = monitors.calls[3]!;
  oldParent.callback('rename', 'artifact'); oldChild.callback('change', 'module.js'); oldChild.errors[0]!();
  await f.gate.verify(f.directory, f.check);
  expect(f.count()).toBe(2); expect(parent.closes).toBe(0); expect(child.closes).toBe(0);
  child.callback('change', 'module.js'); await f.gate.verify(f.directory, f.check);
  expect(f.count()).toBe(3);
});

test('recovery during an in-flight verification shares the check and requires a new stable generation', async () => {
  const f = await fixture(); let finish!: () => void, checks = 0;
  const checking = async () => { if (++checks === 1) await new Promise<void>(resolve => { finish = resolve; }); };
  const first = f.gate.verify(f.directory, checking);
  while (!finish) await turn();
  monitors.calls[1]!.errors[0]!();
  const following = Array.from({ length: 8 }, () => f.gate.verify(f.directory, checking));
  while (monitors.calls.length < 4) await turn();
  finish(); await Promise.all([first, ...following]);
  expect(checks).toBe(2); expect(monitors.calls).toHaveLength(4);
  await f.gate.verify(f.directory, checking); expect(checks).toBe(2);
});

test('a forced recovery check runs independently after shared work while cancelling a waiter leaves the work intact', async () => {
  const f = await fixture(); let checks = 0, fullChecks = 0, finish!: () => void;
  const checking = async () => { if (++checks === 2) await new Promise<void>(resolve => { finish = resolve; }); };
  await f.gate.verify(f.directory, checking); monitors.calls[1]!.errors[0]!();
  const shared = f.gate.verify(f.directory, checking);
  while (!finish) await turn();
  const forced = f.gate.verify(f.directory, async () => { fullChecks++; }, undefined, true);
  const abort = new AbortController();
  const cancelled = f.gate.verify(f.directory, checking, abort.signal);
  await turn(); abort.abort(Error('caller stopped'));
  await expect(cancelled).rejects.toThrow('caller stopped');
  finish(); await Promise.all([shared, forced]);
  expect(checks).toBe(2); expect(fullChecks).toBe(1); expect(monitors.calls).toHaveLength(4);
  await f.gate.verify(f.directory, checking); expect(checks).toBe(2);
});

test('unsupported monitors recheck every admission and can recover when monitoring becomes available', async () => {
  const f = await fixture(); monitors.fail = true;
  await f.gate.verify(f.directory, f.check); await f.gate.verify(f.directory, f.check);
  expect(f.count()).toBe(2);
  monitors.fail = false;
  await f.gate.verify(f.directory, f.check); await f.gate.verify(f.directory, f.check);
  expect(f.count()).toBe(3); expect(monitors.calls).toHaveLength(2);
});

test('recovery rejects a directory replaced by a link before checking or attaching monitors', async () => {
  const f = await fixture(); await f.gate.verify(f.directory, f.check);
  monitors.calls[0]!.callback('rename', 'artifact');
  const old = path.join(f.root, 'old'); await rename(f.directory, old);
  await symlink(old, f.directory, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(f.gate.verify(f.directory, f.check)).rejects.toThrow('不能是链接');
  expect(f.count()).toBe(1); expect(monitors.calls).toHaveLength(2);
});

test('forgetting a runtime retires its callbacks before another entry watches the same path', async () => {
  const f = await fixture(); await f.gate.verify(f.directory, f.check);
  const oldParent = monitors.calls[0]!;
  f.gate.forget(f.directory); await f.gate.verify(f.directory, f.check);
  oldParent.callback('rename', 'artifact'); oldParent.errors[0]!();
  await f.gate.verify(f.directory, f.check);
  expect(f.count()).toBe(2); expect(monitors.calls).toHaveLength(4);
  expect(monitors.calls[2]!.closes).toBe(0); expect(monitors.calls[3]!.closes).toBe(0);
});

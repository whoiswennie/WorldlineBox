import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

type Options = { root: string; executable: string; key?: string; seal?: string; verify(): object };
type Result = { snapshot: object; snapshotIntegrity: { reused: boolean; seal?: string }; probed: boolean };
const { inspectSnapshot } = createRequire(import.meta.url)(path.resolve('resources/vcp-memory/lib/integrity.cjs')) as {
  inspectSnapshot(options: Options, inspect: (snapshot: object) => object): Result;
};
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bot-memory-integrity-')); roots.push(root);
  mkdirSync(path.join(root, 'upstream', 'toolbox'), { recursive: true });
  const file = path.join(root, 'upstream', 'toolbox', 'memory.js'), manifest = path.join(root, 'upstream', 'manifest.json');
  writeFileSync(file, 'original immutable source');
  writeFileSync(manifest, JSON.stringify({ files: [{ project: 'toolbox', path: 'memory.js' }] }));
  const executable = path.join(root, 'node.exe'); writeFileSync(executable, 'fixture executable identity');
  const verify = vi.fn(() => ({ ok: true, files: 1, failures: [] as string[] }));
  const probe = vi.fn((snapshot: object) => ({ snapshot, probed: true }));
  const options: Options = { root, executable, key: 'ephemeral-current-app-only', verify };
  return { root, file, manifest, executable, options, verify, probe };
}

it('reuses one authenticated release audit across homes while always running native health inspection', () => {
  const f = fixture(), first = inspectSnapshot(f.options, f.probe);
  expect(first.snapshotIntegrity.reused).toBe(false); expect(first.snapshotIntegrity.seal).toBeTruthy();
  const second = inspectSnapshot({ ...f.options, seal: first.snapshotIntegrity.seal }, f.probe);
  expect(second.snapshotIntegrity.reused).toBe(true); expect(second.probed).toBe(true);
  expect(f.verify).toHaveBeenCalledOnce(); expect(f.probe).toHaveBeenCalledTimes(2);
  expect(second.snapshot).toEqual(first.snapshot);
});
it.each(['source', 'manifest', 'node'] as const)('invalidates the audit when %s resources change', kind => {
  const f = fixture(), first = inspectSnapshot(f.options, f.probe);
  if (kind === 'source') writeFileSync(f.file, 'a changed source with different bytes');
  if (kind === 'manifest') writeFileSync(f.manifest, readFileSync(f.manifest, 'utf8') + '\n');
  if (kind === 'node') writeFileSync(f.executable, 'replacement node executable');
  const second = inspectSnapshot({ ...f.options, seal: first.snapshotIntegrity.seal }, f.probe);
  expect(second.snapshotIntegrity.reused).toBe(false); expect(f.verify).toHaveBeenCalledTimes(2);
});
it('rejects forged or previous-application seals and does not cache standalone CLI checks', () => {
  const f = fixture(), first = inspectSnapshot(f.options, f.probe);
  inspectSnapshot({ ...f.options, seal: first.snapshotIntegrity.seal, key: 'a-new-app-process-secret' }, f.probe);
  inspectSnapshot({ ...f.options, seal: first.snapshotIntegrity.seal!.replace(/.$/, value => value === '0' ? '1' : '0') }, f.probe);
  const standalone = inspectSnapshot({ ...f.options, key: undefined, seal: first.snapshotIntegrity.seal }, f.probe);
  expect(standalone.snapshotIntegrity.seal).toBeUndefined(); expect(standalone.snapshotIntegrity.reused).toBe(false);
  expect(f.verify).toHaveBeenCalledTimes(4); expect(f.probe).toHaveBeenCalledTimes(4);
});
it.each(['hash', 'probe'] as const)('does not return an attestation when resources change during the %s boundary', boundary => {
  const f = fixture();
  if (boundary === 'hash') f.verify.mockImplementation(() => { writeFileSync(f.file, 'changed during full hash verification'); return { ok: true, files: 1, failures: [] }; });
  else f.probe.mockImplementation(snapshot => { writeFileSync(f.file, 'changed during native health inspection'); return { snapshot, probed: true }; });
  expect(() => inspectSnapshot(f.options, f.probe)).toThrow('changed during the integrity check');
});
it('refuses project and file path escapes before performing or reusing an audit', () => {
  const f = fixture(), first = inspectSnapshot(f.options, f.probe);
  for (const entry of [{ project: '..', path: 'outside' }, { project: 'toolbox', path: '../../outside' }]) {
    writeFileSync(f.manifest, JSON.stringify({ files: [entry] }));
    expect(() => inspectSnapshot({ ...f.options, seal: first.snapshotIntegrity.seal }, f.probe)).toThrow('escapes');
  }
  expect(f.verify).toHaveBeenCalledOnce(); expect(f.probe).toHaveBeenCalledOnce();
});
it('does not invoke native health or issue a seal after an unconfirmed audit', () => {
  const f = fixture(); f.verify.mockReturnValue({ ok: false, files: 1, failures: ['memory.js'] });
  expect(() => inspectSnapshot(f.options, f.probe)).toThrow('did not confirm integrity');
  expect(f.probe).not.toHaveBeenCalled();
});

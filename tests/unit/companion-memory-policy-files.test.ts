import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CompanionMemoryPolicyFiles } from '../../src/companions/memory-policy-files';
import { COMPANION_MEMORY_POLICY_FILE, initialCompanionMemoryPolicy } from '../../src/shared/companion-memory-policy';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('memory-policy-file-')) throw Error('Unsafe test cleanup');
  rmSync(root, { recursive: true, force: true });
} });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'memory-policy-file-')); roots.push(root);
  const policy = initialCompanionMemoryPolicy(), write = (owner = 'alice') => {
    mkdirSync(path.join(root, owner), { recursive: true });
    writeFileSync(path.join(root, owner, COMPANION_MEMORY_POLICY_FILE), JSON.stringify({ schema: 'worldlinebox.companion-memory-policy-v1', companionId: owner, policy }));
  };
  write(); write('bob'); return { root, policy, write, reader: new CompanionMemoryPolicyFiles(root), file: path.join(root, 'alice', COMPANION_MEMORY_POLICY_FILE) };
}
it('uses the current authorized policy hash, observes file edits and never caches missing or corrupt state', () => {
  const f = fixture(), before = f.reader.read('alice');
  expect(before).toMatchObject({ canonical: true, policy: { mode: 'balanced' } });
  expect(f.reader.read('alice').revision).toBe(before.revision);
  f.policy.capture.quietMs = 120_000; f.write(); const changed = f.reader.read('alice');
  expect(changed.revision).not.toBe(before.revision); expect(changed.policy.capture.quietMs).toBe(120_000);
  writeFileSync(f.file, '{broken'); expect(() => f.reader.read('alice')).toThrow(expect.objectContaining({ code: 'MEMORY_POLICY_UNAVAILABLE' }));
  expect(f.reader.read('bob').policy.capture.quietMs).toBe(60_000);
  f.write(); expect(f.reader.read('alice').revision).toBe(changed.revision);
  unlinkSync(f.file); expect(() => f.reader.read('alice')).toThrow(expect.objectContaining({ code: 'MEMORY_POLICY_UNAVAILABLE' }));
  f.write(); expect(f.reader.read('alice').policy.capture.quietMs).toBe(120_000);
});
it('rejects owner substitution, hardlinks, relative binding and thresholds beyond host limits', () => {
  const f = fixture(); expect(() => new CompanionMemoryPolicyFiles('relative')).toThrow();
  writeFileSync(f.file, JSON.stringify({ schema: 'worldlinebox.companion-memory-policy-v1', companionId: 'bob', policy: f.policy }));
  expect(() => f.reader.read('alice')).toThrow(); f.write();
  linkSync(f.file, path.join(f.root, 'borrowed.json')); expect(() => f.reader.read('alice')).toThrow();
  unlinkSync(path.join(f.root, 'borrowed.json')); f.policy.capture.batchSize = 13; f.write(); expect(() => f.reader.read('alice')).toThrow();
  expect(() => f.reader.read('../bob')).toThrow();
});

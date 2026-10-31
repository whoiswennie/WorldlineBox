import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import type { CompanionManagedCleanupPlan } from '../../src/companions/development-cleanup';

const roots: string[] = [];
const runFile = promisify(execFile), cli = path.resolve('scripts/companion-managed-cleanup.mjs');
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const Database = BetterSqlite3 as { new(file: string): CompanionConnection };
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-dev-cleanup-cli-')) throw new Error('Unexpected CLI fixture root.');
    rmSync(root, { recursive: true, force: true });
  }
});
const run = (args: string[]) => runFile(process.execPath, [cli, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });

it('runs the actual bundled CLI plan and guarded execute, preserving the real human profile without quota or role restoration', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-dev-cleanup-cli-')); roots.push(root);
  const libraryId = randomUUID(), metadata = path.join(root, '.worldlinebox'), dataRoot = path.join(metadata, 'companions'), ownerRoot = path.join(root, '伙伴记忆', 'alice');
  mkdirSync(dataRoot, { recursive: true }); mkdirSync(ownerRoot, { recursive: true });
  const library = new Database(path.join(metadata, 'library.db'));
  library.exec('CREATE TABLE library(library_id TEXT PRIMARY KEY)'); library.prepare('INSERT INTO library VALUES(?)').run(libraryId); library.close();
  const ledger = path.join(dataRoot, 'messages.sqlite'), source = new CompanionsStore(ledger, [{ id: 'alice', name: 'Old owner', description: '', persona: 'PRIVATE_OLD_PERSONA', model: '', avatar: 'custom', proactive: false }]);
  let humanProfile;
  try { humanProfile = source.updatePlayerProfile({ name: 'Human preference', description: 'Keep this human preference.' }, source.getPlayerProfile().revision); }
  finally { source.close(); }
  const legacy = new Database(ledger);
  legacy.exec("CREATE TABLE IF NOT EXISTS companion_model_legacy_usage(id TEXT PRIMARY KEY,cost INTEGER); INSERT INTO companion_model_legacy_usage VALUES('legacy-counter',7)"); legacy.close();
  writeFileSync(path.join(ownerRoot, 'instance.json'), JSON.stringify({ companionId: 'alice' })); writeFileSync(path.join(ownerRoot, 'profile.md'), 'PRIVATE_OLD_PERSONA');
  const unrelated = path.join(root, '伙伴记忆', 'external-reference.md'); writeFileSync(unrelated, 'KEEP_UNREGISTERED_REFERENCE');
  const settings = path.join(dataRoot, 'llm-keys.enc.json'); writeFileSync(settings, 'KEEP_GLOBAL_CONNECTIONS');
  const ledgerBefore = hash(ledger), planFile = path.join(root, 'reviewed-plan.json');
  const planned = JSON.parse((await run(['plan', '--library', root, '--library-id', libraryId, '--out', planFile])).stdout) as { planHash: string };
  const plan = JSON.parse(readFileSync(planFile, 'utf8')) as CompanionManagedCleanupPlan;
  expect(hash(ledger)).toBe(ledgerBefore); expect(plan.planHash).toBe(planned.planHash); expect(plan.retainedHostData.schema).toBe('worldlinebox.retained-host-data-v3');
  expect(plan.retainedHostData).not.toHaveProperty('modelAccounting'); expect(JSON.stringify(plan.retainedHostData)).not.toContain('legacy-counter');
  await expect(run(['execute', '--plan', planFile, '--plan-hash', '0'.repeat(64)])).rejects.toThrow(); expect(hash(ledger)).toBe(ledgerBefore);
  const executed = JSON.parse((await run(['execute', '--plan', planFile, '--plan-hash', plan.planHash])).stdout) as { completed: boolean; retainedHostDataPath: string };
  expect(executed.completed).toBe(true); expect(existsSync(ledger)).toBe(false); expect(existsSync(ownerRoot)).toBe(false);
  expect(readFileSync(unrelated, 'utf8')).toBe('KEEP_UNREGISTERED_REFERENCE'); expect(readFileSync(settings, 'utf8')).toBe('KEEP_GLOBAL_CONNECTIONS');
  const retained = readFileSync(executed.retainedHostDataPath, 'utf8'); expect(retained).not.toContain('PRIVATE_OLD_PERSONA');
  const fresh = new CompanionsStore(ledger, [], { hostRetention: { libraryPath: root, libraryId } });
  try {
    expect(fresh.state().companions).toEqual([]); expect(fresh.getPlayerProfile().name).toBe('Human preference');
    expect(fresh.getPlayerProfile()).toEqual(humanProfile);
  } finally { fresh.close(); }
  const restarted = new CompanionsStore(ledger, [], { hostRetention: { libraryPath: root, libraryId } });
  try { expect(restarted.getPlayerProfile()).toEqual(humanProfile); expect(restarted.state().companions).toEqual([]); }
  finally { restarted.close(); }
  const current = new Database(ledger);
  try { expect(current.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'companion_model_%'").all()).toEqual([]); }
  finally { current.close(); }
});

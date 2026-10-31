import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import { companionStorageCommandSchema } from '../../src/shared/companion-storage';
import { companionWorkspaceRequestSchema } from '../../src/shared/companion-workspace';

it('creates a new cognition database without model allowance tables or a policy initialization marker', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-no-allowances-')), file = path.join(root, 'messages.sqlite');
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-no-allowances-')) throw new Error('Unexpected test directory.');
  const store = new CompanionsStore(file, []);
  store.close();
  const db = new (Database as { new(file: string): CompanionConnection })(file);
  try {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'companion_model_%'").all()).toEqual([]);
    expect(db.prepare("SELECT key FROM metadata WHERE key LIKE 'companion-model-resources%'").all()).toEqual([]);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

it.each(['config.status', 'config.initialized', 'admit', 'finish', 'usage'])('rejects the removed worker allowance command %s at the wire boundary', suffix => {
  expect(companionStorageCommandSchema.safeParse({ type: 'model.resources.' + suffix, companionId: 'alice' }).success).toBe(false);
});

it.each(['read', 'save'])('rejects the removed workspace allowance command %s at the wire boundary', suffix => {
  expect(companionWorkspaceRequestSchema.safeParse({ type: 'model.resources.' + suffix, companionId: 'alice', content: '{}' }).success).toBe(false);
});

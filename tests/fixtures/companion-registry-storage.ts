import BetterSqlite3 from 'better-sqlite3';
import path from 'node:path';
import { CompanionArtifactRegistryStore } from '../../src/companions/artifact-registry-store';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionRegistryStorage } from '../../src/main/companions/artifact-registry';
import { companionStorageCommandSchema } from '../../src/shared/companion-storage';
import type { CompanionRegistryStorageCommand } from '../../src/shared/companion-registry-storage';

/** A real isolated SQLite metadata port; body files remain in the test owner root. */
export function registryStorageFixture(root: string, owners: string[] = ['alice']) {
  const sqlite = new (BetterSqlite3 as { new(filename: string): CompanionConnection })(path.join(root, 'registry-metadata.sqlite'));
  sqlite.exec('CREATE TABLE companions(id TEXT PRIMARY KEY,deleted_at TEXT)');
  for (const owner of owners) sqlite.prepare('INSERT INTO companions VALUES(?,NULL)').run(owner);
  const store = new CompanionArtifactRegistryStore(sqlite as unknown as CompanionConnection); store.initialize();
  const commands: CompanionRegistryStorageCommand[] = [];
  const storage: CompanionRegistryStorage = { request: async command => {
    commands.push(command); const response = store.execute(companionStorageCommandSchema.parse(command));
    if (!response) throw new Error('Unexpected registry fixture command.'); return response;
  } };
  return { storage, sqlite, commands, close: () => sqlite.close() };
}

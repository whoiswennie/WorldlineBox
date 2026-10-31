import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { CompanionConnection } from '../../src/companions/store';
import { COMPANION_COGNITION_PROTOCOL, requireCompanionCognitionProtocol } from '../../src/companions/cognition-protocol';

const Database = BetterSqlite3 as { new(filename: string): CompanionConnection };
const opened: Array<{ close(): void }> = [];
function database() {
  const db = new Database(':memory:'); opened.push(db);
  return db;
}
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

describe('T-034 new cognition protocol boundary', () => {
  it('creates only a new protocol and reopens it idempotently', () => {
    const db = database(); requireCompanionCognitionProtocol(db); requireCompanionCognitionProtocol(db);
    expect(db.prepare('SELECT protocol FROM companion_cognition_protocol').all()).toEqual([{ protocol: COMPANION_COGNITION_PROTOCOL }]);
  });
  it('refuses a historical database without changing or converting its rows', () => {
    const db = database(); db.exec("CREATE TABLE messages(id TEXT PRIMARY KEY,content TEXT); INSERT INTO messages VALUES('old','preserve until explicit scoped cleanup')");
    expect(() => requireCompanionCognitionProtocol(db)).toThrow('旧版伙伴账本');
    expect(db.prepare('SELECT * FROM messages').all()).toEqual([{ id: 'old', content: 'preserve until explicit scoped cleanup' }]);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='companion_cognition_protocol'").get()).toBeUndefined();
  });
  it('refuses an unknown protocol rather than repairing it', () => {
    const db = database(); requireCompanionCognitionProtocol(db);
    db.exec("UPDATE companion_cognition_protocol SET protocol='future-or-old'");
    expect(() => requireCompanionCognitionProtocol(db)).toThrow('不受支持');
  });
});

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { CompanionConnection } from '../../src/companions/store';

/** Real isolated SQL without loading a native addon or another process. */
export function nodeCompanionConnection(filename = ':memory:'): { db: DatabaseSync; connection: CompanionConnection } {
  const db = new DatabaseSync(filename); let sequence = 0;
  const connection: CompanionConnection = {
    prepare(sql) { const statement = db.prepare(sql); return { all: (...args) => statement.all(...args as SQLInputValue[]),
      get: (...args) => statement.get(...args as SQLInputValue[]), run: (...args) => { const result = statement.run(...args as SQLInputValue[]);
        return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid }; } }; },
    exec(sql) { db.exec(sql); }, close() { db.close(); }, pragma(sql) { return db.prepare('PRAGMA ' + sql).get(); },
    function(name, options, fn) { db.function(name, options, value => fn(String(value))); },
    transaction<T>(fn: () => T) { const action = () => { const name = 'fixture_' + ++sequence; db.exec('SAVEPOINT ' + name);
      try { const result = fn(); db.exec('RELEASE ' + name); return result; }
      catch (error) { db.exec('ROLLBACK TO ' + name); db.exec('RELEASE ' + name); throw error; } }; return Object.assign(action, { immediate: action }); },
  };
  return { db, connection };
}

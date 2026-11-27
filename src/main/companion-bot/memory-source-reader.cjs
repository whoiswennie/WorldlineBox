/* global require */
// The native worker journals source withdrawal and its revision atomically in
// SQLite WAL. A read-only connection can observe them during vector work.
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData, { readOnly: true });
try {
  db.exec('PRAGMA query_only=ON; BEGIN');
  const revision = db.prepare("SELECT value FROM metadata WHERE key='forget-revision'").get()?.value ?? 0;
  const sourceEventIds = [], sourceMessageIds = [];
  for (const row of db.prepare("SELECT kind,id FROM tombstones WHERE kind IN ('event','message')").iterate()) {
    (row.kind === 'event' ? sourceEventIds : sourceMessageIds).push(row.id);
  }
  db.exec('COMMIT'); parentPort.postMessage({ revision: String(revision), sourceEventIds, sourceMessageIds });
} finally { db.close(); }

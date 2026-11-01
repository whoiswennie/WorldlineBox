import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';

const roots: string[] = [], stores: CompanionsStore[] = [], connections: CompanionConnection[] = [];
afterEach(() => {
  vi.restoreAllMocks(); for (const db of connections.splice(0)) db.close(); for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('companion-scope-read-')) throw new Error('Unexpected scope fixture root.');
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['complete', 'missing', 'stale-participants'] as const)('reads an existing scope with %s primary without any Store SQL writes and leaves initialization to the explicit entrance', condition => {
  const root = mkdtempSync(path.join(tmpdir(), 'companion-scope-read-')); roots.push(root);
  const filename = path.join(root, 'state.sqlite'), store = new CompanionsStore(filename,
    [{ id: 'alice', name: '独立伙伴', description: '', persona: '正式人格', model: '', avatar: 'sister', active: true, proactive: false }]); stores.push(store);
  const originalScope = store.openPrivate('alice');
  const db = new (BetterSqlite3 as { new(filename: string): CompanionConnection })(filename); connections.push(db);
  if (condition === 'missing') {
    db.prepare('DELETE FROM companion_topic_current WHERE conversation_id=?').run(originalScope.id);
    db.prepare('DELETE FROM metadata WHERE key=?').run('primary-chat-topic/' + originalScope.id);
    db.prepare('DELETE FROM companion_topics WHERE conversation_id=?').run(originalScope.id);
  } else if (condition === 'stale-participants') db.prepare("UPDATE companion_topics SET data=json_set(data,'$.participantIds',json(?)) WHERE id=?")
    .run(JSON.stringify(['user']), originalScope.defaultTopicId!);
  db.prepare('UPDATE conversations SET pinned=1,muted=1 WHERE id=?').run(originalScope.id);
  // Capture the actual native Store connection solely to observe its own
  // total_changes; another connection's counter could not prove no writes.
  const observedStoreDbs = new Set<CompanionConnection>();
  const prototype = Object.getPrototypeOf(db), prepare = prototype.prepare;
  const capture = vi.spyOn(prototype, 'prepare').mockImplementation(function(this: CompanionConnection, ...args: unknown[]) {
    if (typeof args[0] !== 'string') throw new Error('Expected a SQL statement.');
    if (this !== db) observedStoreDbs.add(this);
    return Reflect.apply(prepare, this, args);
  });
  try { store.request({ type: 'player.profile.get' }); } finally { capture.mockRestore(); }
  expect(observedStoreDbs.size).toBe(1);
  const actualStoreDb = [...observedStoreDbs][0];
  const changes = () => actualStoreDb!.prepare('SELECT total_changes() AS n').get();
  const before = changes(), beforeVersion = db.prepare('PRAGMA data_version').get();
  const result = store.request({ type: 'memory.library.scope.read', companionId: 'alice' });
  expect(result.ok).toBe(true); expect(result.conversation).toMatchObject({ id: originalScope.id, kind: 'private', memberIds: ['alice'], pinned: true, muted: true, lastMessage: '' });
  expect(changes()).toEqual(before); expect(db.prepare('PRAGMA data_version').get()).toEqual(beforeVersion);
  expect(result.conversation?.defaultTopicId).toBe(condition === 'missing' ? undefined : originalScope.defaultTopicId);
  if (condition === 'missing') expect(db.prepare('SELECT 1 FROM companion_topics WHERE conversation_id=?').get(originalScope.id)).toBeUndefined();
  if (condition === 'stale-participants') expect(JSON.parse((db.prepare('SELECT data FROM companion_topics WHERE id=?').get(originalScope.defaultTopicId!) as { data: string }).data).participantIds).toEqual(['user']);
  const opened = store.openPrivate('alice');
  expect(opened.defaultTopicId).toBeTruthy();
  const primary = JSON.parse((db.prepare('SELECT data FROM companion_topics WHERE id=?').get(opened.defaultTopicId!) as { data: string }).data);
  expect(primary.participantIds).toEqual(['user', 'alice']); expect(primary.isPrimary).toBe(true);
});

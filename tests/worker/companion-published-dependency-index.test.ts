import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionExecutionReadset } from '../../src/shared/companion-execution-evidence';
import type { CompanionAction } from '../../src/shared/companions';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';
import { certifyPublishedDependencyNode, initializePublishedDependencyIndex, maintainPublishedDependencyIndex, readPublishedDependencyCut, readPublishedActionDependencyCut,
  readPublishedActionFrontier, withPublishedDependencyReadWindow, observePublishedDependencyCut, observePublishedActionDependencyCut } from '../../src/companions/published-dependency-index';
import { CompanionSourceAccess } from '../../src/companions/source-access';
import { currentPublishedSourceCutValid } from '../../src/companions/published-dependency-index';
import { companionMessagePublicationCanonicalJSON as canonical } from '../../src/shared/companion-message-publication';
import { readPublishedMessageActionPins } from '../../src/companions/published-message-action-pins';
import { fencedCompanionConnection } from '../../src/companions/recovery-fence';
import { createCompanionExecutionValidationSession, guardCompanionExecutionSources } from '../../src/main/companions/source-execution-evidence';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fixtures: ReturnType<typeof managedMemoryFiles>[] = [], connections: CompanionConnection[] = [];
afterEach(async () => { for (const db of connections.splice(0)) db.close(); for (const f of fixtures.splice(0)) await f.close(); });
/** Count actual SQL executions: compilation can now be reused across commands,
 * but a prepared statement must never make these fresh-read assertions vacuous. */
function observeReads(h: { db: CompanionConnection }) {
  const reads = vi.fn<(sql: string) => void>();
  h.db = new Proxy(h.db, { get(target, key) {
    if (key === 'prepare') return (sql: string) => {
      const statement = target.prepare(sql);
      return new Proxy(statement, { get(current, member) {
        const value = Reflect.get(current, member, current);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (member === 'get' || member === 'all') reads(sql);
          return Reflect.apply(value, current, args);
        };
      } });
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return reads;
}
function connection(filename: string) {
  const db = new (Database as { new(filename: string): CompanionConnection })(filename); connections.push(db);
  db.exec('PRAGMA foreign_keys=ON');
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens);
  db.function('companion_search_facet', { deterministic: true }, companionSearchFacet); return db;
}
async function fixture() {
  const f = managedMemoryFiles(); fixtures.push(f);
  const source = f.source('实际发布前已经发生的原始记录。'), parent = f.record('真实父修订。', [source.id]), note = f.record('引用准确父修订的事实。', [source.id], [parent.id]);
  await f.publish();
  const receipts = (await f.live.materialize('alice', [note])).receipts;
  const readset: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', complete: true, ...f.scope,
    memories: [{ id: note.id, version: note.version }], sources: [], knowledgeReads: [], topics: [],
    memoryReads: [{ id: note.id, version: note.version, contentRevision: note.contentRevision!, sources: note.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum })) }],
    contexts: [{ revision: 'real-published-memory', profileKey: 'canonical-memory-files', fileReceiptOnly: true, fileReceipts: receipts }] };
  const db = connection(path.join(f.root, 'state.sqlite')); initializePublishedDependencyIndex(db);
  const external = connection(path.join(f.root, 'state.sqlite'));
  const append = (content: string, proof = readset) => f.store.appendMessage({ conversationId: proof.conversationId, authorId: proof.companionId, content, executionReadset: proof });
  const certify = (id: string) => {
    const proofs = f.store.request({ type: 'execution.sources', sourceMessageIds: [id] }).executionSources ?? [];
    const candidate = proofs.find(proof => proof.id === id)?.publicationCandidate;
    expect(candidate).toBeDefined();
    const certificate = f.store.request({ type: 'execution.message.certify', messages: [{ ...candidate!, mode: 'revalidated_historical' }],
      actionBindings: proofs.flatMap(proof => proof.storageActionBinding ? [proof.storageActionBinding] : []) }).messagePublicationCertificates![0]!;
    expect(db.transaction(() => certifyPublishedDependencyNode(db, certificate)).immediate()).toBe(true); return certificate;
  };
  const message = append('这是已经真实完成发布围栏的发言。');
  expect(await f.live.validate('alice', receipts)).toBe(true); const certificate = certify(message.id);
  const generation = () => (db.prepare('SELECT generation FROM companion_published_authority_generation WHERE id=1').get() as { generation: number }).generation;
  return { f, source, parent, note, receipts, readset, message, certificate, db, external, append, certify, generation };
}

function plainReadset(companionId: string, conversationId: string, sources: CompanionExecutionReadset['sources'] = []): CompanionExecutionReadset {
  return { schema: 'worldlinebox.companion-execution-readset-v1', complete: true, companionId, conversationId,
    memories: [], sources, knowledgeReads: [], topics: [], contexts: [] };
}

it('keeps unrelated owners current after a real external source mutation advances the global epoch', async () => {
  const h = await fixture(), bobSource = h.f.source('另一位伙伴实际见过的独立原始来源。', 'bob'), room = h.f.store.openPrivate('bob');
  const bob = h.append('另一位伙伴的正式结论。', plainReadset('bob', room.id, [{ id: bobSource.id, conversationId: room.id, checksum: hash(bobSource.content) }])); h.certify(bob.id);
  const before = h.generation(), own = readPublishedDependencyCut(h.db, h.message.id)!;
  h.external.prepare('UPDATE messages SET content=? WHERE id=?').run('另一位伙伴的来源已经改变。', bobSource.id);
  expect(h.generation()).toBeGreaterThan(before);
  expect(readPublishedDependencyCut(h.db, bob.id)).toBeUndefined();
  expect(readPublishedDependencyCut(h.db, h.message.id)).toMatchObject({ certificate: own.certificate, binding: own.binding });
  expect(h.db.prepare('SELECT generation,covered_epoch FROM companion_published_authority_generation').get()).toEqual({ generation: h.generation(), covered_epoch: h.generation() });
});

it('dirties exactly the reverse dependency closure, retaining an independent publication of the same owner', async () => {
  const h = await fixture(); let previous = h.message;
  const descendants = [];
  for (let index = 0; index < 3; index++) {
    previous = h.append('准确依赖前一条正式回复 ' + index, plainReadset('alice', h.f.scope.conversationId,
      [{ id: previous.id, conversationId: previous.conversationId, checksum: hash(previous.content) }]));
    h.certify(previous.id); descendants.push(previous);
  }
  const independent = h.append('同一伙伴的独立正式内容。', plainReadset('alice', h.f.scope.conversationId)); h.certify(independent.id);
  h.external.prepare('DELETE FROM vcp_source_observers WHERE companion_id=? AND message_id=?').run('alice', h.source.id);
  for (const message of [h.message, ...descendants]) expect(readPublishedDependencyCut(h.db, message.id)).toBeUndefined();
  expect(readPublishedDependencyCut(h.db, independent.id)).toBeDefined();
  const dirty = h.db.prepare('SELECT node_key FROM companion_published_dependency_dirty').all() as Array<{ node_key: string }>;
  expect(dirty.some(row => row.node_key === canonical(['message', previous.id]))).toBe(true);
  expect(dirty.some(row => row.node_key === canonical(['message', independent.id]))).toBe(false);
});

it('does not dirty actual no-op observer, membership, topic, certificate or unrelated runtime updates', async () => {
  const h = await fixture(), before = h.generation();
  h.external.prepare('UPDATE vcp_source_observers SET companion_id=companion_id WHERE message_id=?').run(h.source.id);
  h.external.prepare('UPDATE conversation_members SET companion_id=companion_id WHERE conversation_id=?').run(h.f.scope.conversationId);
  h.external.prepare('UPDATE companion_message_topics SET topic_id=topic_id WHERE message_id=?').run(h.message.id);
  h.external.prepare('UPDATE companion_message_publication_certificates SET data=data WHERE message_id=?').run(h.message.id);
  h.external.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('runtime-unrelated-world-clock', '123');
  expect(h.generation()).toBe(before); expect(readPublishedDependencyCut(h.db, h.message.id)).toBeDefined();
});

it('normalizes repeated dense-window source authority once per reader and physical source during a cold rebuild', async () => {
  const h = await fixture(), messages = [h.message]; let certificate = h.certificate;
  for (let index = 0; index < 7; index++) {
    const proof = structuredClone(h.readset);
    proof.sources = messages.map(message => ({ id: message.id, conversationId: message.conversationId, checksum: hash(message.content) }));
    const message = h.append('窗口内各条正式回复再次作为准确来源 ' + index, proof); certificate = h.certify(message.id); messages.push(message);
  }
  // Invalidate only derived nodes. Actual published certificates, immutable
  // bodies and action pins stay unchanged, as in a first protocol migration.
  h.external.exec(`INSERT INTO companion_published_dependency_dirty
    SELECT node_key,(SELECT generation FROM companion_published_authority_generation WHERE id=1)
    FROM companion_published_dependency_nodes node WHERE NOT EXISTS(
      SELECT 1 FROM companion_published_dependency_dirty dirty WHERE dirty.node_key=node.node_key)`);
  const reads = observeReads(h); initializePublishedDependencyIndex(h.db);
  expect(certifyPublishedDependencyNode(h.db, certificate)).toBe(true);
  const observerReads = reads.mock.calls.filter(([sql]) => sql === 'SELECT 1 FROM vcp_source_observers WHERE companion_id=? AND message_id=?');
  // Seven prior messages plus the common memory source are eight physical
  // authority tuples, despite the dense repeated source edges above.
  expect(observerReads).toHaveLength(messages.length);
  const rootKey = canonical(['message', messages.at(-1)!.id]);
  const sourceEdges = h.db.prepare("SELECT target_key FROM companion_published_dependency_edges WHERE parent_key=? AND target_kind='node'")
    .all(rootKey) as Array<{ target_key: string }>;
  expect(sourceEdges.filter(edge => JSON.parse(edge.target_key)[0] === 'source')).toHaveLength(messages.length - 1);
  expect(readPublishedDependencyCut(h.db, messages.at(-1)!.id)?.assetOwners).toEqual(['alice']);
});

it.each(['not-json', 'null', 'false', '{"status":7}'])('preserves the original source loop rejection for unsupported compact metadata %s', async value => {
  const h = await fixture();
  h.external.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('message-loop/' + h.source.id, value);
  expect(readPublishedDependencyCut(h.db, h.message.id)).toBeUndefined();
  expect(certifyPublishedDependencyNode(h.db, h.certificate)).toBe(false);
  expect(readPublishedDependencyCut(h.db, h.message.id)).toBeUndefined();
});

it('uses the original completed-loop SQL when its compact projection is missing, without lazy rebuilding it', async () => {
  const h = await fixture(), metadataKey = 'message-loop/' + h.source.id;
  h.external.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(metadataKey, JSON.stringify({ status: 'done' }));
  h.external.prepare('DELETE FROM companion_message_loop_headers WHERE metadata_key=?').run(metadataKey);
  const reads = observeReads(h); initializePublishedDependencyIndex(h.db);
  expect(certifyPublishedDependencyNode(h.db, h.certificate)).toBe(true);
  expect(reads.mock.calls.some(([sql]) => sql.includes("json_extract(value,'$.status')"))).toBe(true);
  expect(h.db.prepare('SELECT 1 FROM companion_message_loop_headers WHERE metadata_key=?').get(metadataKey)).toBeUndefined();
  expect(readPublishedDependencyCut(h.db, h.message.id)).toBeDefined();
});

it('never heals an unknown epoch gap with later legitimate writes or an external counter reset', async () => {
  const h = await fixture(), independent = h.append('不依赖旧来源的正式输入。', plainReadset('alice', h.f.scope.conversationId)); h.certify(independent.id);
  h.external.prepare('UPDATE companion_published_authority_generation SET generation=generation+1').run();
  expect(readPublishedDependencyCut(h.db, independent.id)).toBeUndefined();
  expect(() => h.external.prepare('UPDATE companion_published_authority_generation SET covered_epoch=generation').run()).toThrow();
  h.external.prepare('UPDATE messages SET content=? WHERE id=?').run('旧来源变更后旧结论不能重建。', h.source.id);
  const state = h.db.prepare('SELECT generation,covered_epoch FROM companion_published_authority_generation').get() as { generation: number; covered_epoch: number };
  expect(state.generation - state.covered_epoch).toBe(1); expect(readPublishedDependencyCut(h.db, independent.id)).toBeUndefined();
  maintainPublishedDependencyIndex(h.db);
  expect(readPublishedDependencyCut(h.db, independent.id)).toBeDefined(); expect(readPublishedDependencyCut(h.db, h.message.id)).toBeUndefined();
});

it.each(['rollback', 'delete', 'replace'] as const)('protects the authority singleton against external %s', async operation => {
  const h = await fixture();
  if (operation === 'rollback') {
    h.external.prepare('UPDATE companion_published_authority_generation SET generation=generation+1').run();
    expect(() => h.external.prepare('UPDATE companion_published_authority_generation SET generation=generation-1').run()).toThrow();
    expect(readPublishedDependencyCut(h.db, h.message.id)).toBeUndefined();
  } else if (operation === 'delete') expect(() => h.external.prepare('DELETE FROM companion_published_authority_generation').run()).toThrow();
  else expect(() => h.external.prepare('INSERT OR REPLACE INTO companion_published_authority_generation(id,generation) VALUES(1,0)').run()).toThrow();
});

it.each(['node', 'edge'] as const)('propagates external %s deletion and refuses clearing any live dirty marker', async operation => {
  const h = await fixture(), child = h.append('必须继续依赖完整的上游索引。', plainReadset('alice', h.f.scope.conversationId,
    [{ id: h.message.id, conversationId: h.message.conversationId, checksum: hash(h.message.content) }])); h.certify(child.id);
  const parentKey = canonical(['message', h.message.id]), childKey = canonical(['message', child.id]);
  if (operation === 'node') h.external.prepare('DELETE FROM companion_published_dependency_nodes WHERE node_key=?').run(parentKey);
  else h.external.prepare("DELETE FROM companion_published_dependency_edges WHERE parent_key=? AND target_kind='certificate'").run(parentKey);
  expect(readPublishedDependencyCut(h.db, child.id)).toBeUndefined();
  expect(() => h.external.prepare('DELETE FROM companion_published_dependency_dirty WHERE node_key=?').run(childKey)).toThrow('private builder');
  expect(() => h.external.prepare('UPDATE companion_published_dependency_dirty SET epoch=epoch WHERE node_key=?').run(childKey)).toThrow('immutable');
  if (operation === 'node') expect(h.db.prepare('SELECT 1 FROM companion_published_dependency_dirty WHERE node_key=?').get(parentKey)).toBeUndefined();
  expect(h.db.prepare('SELECT 1 FROM companion_published_dependency_dirty WHERE node_key=?').get(childKey)).toBeDefined();
});

it('preserves a Main finite read across unrelated dirty events and still rejects the changed source at its fresh final fence', async () => {
  const h = await fixture(), bobSource = h.f.source('另一位伙伴独立的正式来源。', 'bob'), room = h.f.store.openPrivate('bob');
  const bob = h.append('另一位伙伴实际发出的结论。', plainReadset('bob', room.id, [{ id: bobSource.id, conversationId: room.id, checksum: hash(bobSource.content) }])); h.certify(bob.id);
  const read = async () => {
    const gate = createCompanionExecutionValidationSession();
    await gate.run(() => guardCompanionExecutionSources({ type: 'messages', conversationId: h.f.scope.conversationId }, { ok: true, messages: [h.message] },
      { storage: async command => h.f.store.request(command), identity: {}, revision: () => 0, valid: async () => true }));
    return gate;
  };
  const healthy = await read(); h.external.prepare('UPDATE messages SET content=? WHERE id=?').run('独立来源发生变化。', bobSource.id);
  await expect(healthy.validate()).resolves.toBeUndefined(); healthy.close();
  const changed = await read(); h.external.prepare('UPDATE messages SET content=? WHERE id=?').run('本任务使用的来源发生变化。', h.source.id);
  await expect(changed.validate()).rejects.toThrow(); changed.close();
});

it('rolls back the private builder window on SQL failure and never leaves shared write permission enabled', async () => {
  const h = await fixture(); h.external.prepare('UPDATE companion_published_authority_generation SET generation=generation+1').run();
  h.db.exec(`CREATE TRIGGER test_rebuild_failure BEFORE INSERT ON companion_published_dependency_nodes
    WHEN NEW.node_key='${canonical(['message', h.message.id])}' BEGIN SELECT RAISE(ABORT,'injected rebuild failure'); END`);
  expect(() => maintainPublishedDependencyIndex(h.db)).toThrow('injected rebuild failure');
  expect(h.db.prepare('SELECT index_writing FROM companion_published_authority_generation').get()).toEqual({ index_writing: 0 });
  expect(readPublishedDependencyCut(h.db, h.message.id)).toBeUndefined();
  h.db.exec('DROP TRIGGER test_rebuild_failure'); maintainPublishedDependencyIndex(h.db);
  expect(readPublishedDependencyCut(h.db, h.message.id)).toBeDefined();
});

it('retains only 64 static invalidation origins without source IDs, text or SQL parameters', async () => {
  const h = await fixture();
  for (let index = 0; index < 70; index++) h.external.prepare('UPDATE messages SET content=? WHERE id=?').run('不应进入技术审计的私人参数 ' + index, h.source.id);
  const audit = h.db.prepare('SELECT * FROM companion_published_invalidation_audit ORDER BY epoch').all() as Array<{ origin: string; event: string; epoch: number; affected_count: number }>;
  expect(audit).toHaveLength(64); expect(audit.every(row => row.origin === 'messages' && row.event === 'UPDATE')).toBe(true);
  expect(audit.at(-1)!.epoch).toBe(h.generation()); expect(audit.at(-1)!.affected_count).toBe(0);
  expect(JSON.stringify(audit)).not.toContain(h.source.id); expect(JSON.stringify(audit)).not.toContain('私人参数');
});

it.each([2, 3])('upgrades stale v%s nodes conservatively and preserves authority bytes over a real Store restart', async version => {
  const h = await fixture(), nodeKey = canonical(['message', h.message.id]);
  h.db.function('companion_published_index_writing', { deterministic: false }, () => '1');
  h.db.prepare("UPDATE companion_published_dependency_nodes SET data=json_set(data,'$.indexVersion',?) WHERE node_key=?").run(version, nodeKey);
  h.db.prepare('UPDATE companion_published_authority_generation SET protocol_version=?,generation=generation+1').run(version);
  const certificate = h.db.prepare('SELECT data FROM companion_message_publication_certificates WHERE message_id=?').get(h.message.id);
  initializePublishedDependencyIndex(h.db);
  expect(readPublishedDependencyCut(h.db, h.message.id)).toBeUndefined();
  expect(h.db.prepare('SELECT 1 FROM companion_published_dependency_dirty WHERE node_key=?').get(nodeKey)).toBeDefined();
  h.f.restart(); expect(readPublishedDependencyCut(h.db, h.message.id)).toBeDefined();
  expect(h.db.prepare('SELECT data FROM companion_message_publication_certificates WHERE message_id=?').get(h.message.id)).toEqual(certificate);
});

it('rolls back a failed topology replacement with the old edges, protocol, immutable bindings and authority bytes intact', async () => {
  const h = await fixture();
  h.db.function('companion_published_index_writing', { deterministic: false }, () => '1');
  h.db.exec("UPDATE companion_published_dependency_nodes SET data=json_set(data,'$.indexVersion',3)");
  h.db.exec('UPDATE companion_published_authority_generation SET protocol_version=3');
  const snapshot = () => ({
    epoch: h.db.prepare('SELECT * FROM companion_published_authority_generation').all(),
    nodes: h.db.prepare('SELECT * FROM companion_published_dependency_nodes ORDER BY node_key').all(),
    edges: h.db.prepare('SELECT * FROM companion_published_dependency_edges ORDER BY parent_key,target_kind,target_key').all(),
    dirty: h.db.prepare('SELECT * FROM companion_published_dependency_dirty ORDER BY node_key').all(),
    certificates: h.db.prepare('SELECT * FROM companion_message_publication_certificates ORDER BY message_id').all(),
    pins: h.db.prepare('SELECT * FROM companion_message_publication_action_pins ORDER BY message_id,certificate_hash').all(),
  });
  const before = snapshot();
  const failing = new Proxy(h.db, { get(target, member) {
    if (member === 'exec') return (sql: string) => {
      if (sql.startsWith('CREATE TABLE companion_published_dependency_edges(')) throw new Error('Injected derived topology DDL failure');
      return target.exec(sql);
    };
    const value = Reflect.get(target, member, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  expect(() => initializePublishedDependencyIndex(failing)).toThrow('Injected derived topology DDL failure');
  expect(snapshot()).toEqual(before); expect(readPublishedDependencyCut(h.db, h.message.id)).toBeUndefined();
  initializePublishedDependencyIndex(h.db);
  expect(h.db.prepare('SELECT COUNT(*) AS count FROM companion_published_dependency_edges').get()).toEqual({ count: 0 });
  expect(readPublishedDependencyCut(h.db, h.message.id)).toBeUndefined();
  expect(() => h.external.prepare('INSERT INTO companion_published_dependency_edges VALUES(?,?,?)').run(canonical(['message', h.message.id]), 'message', h.source.id)).toThrow();
  expect(certifyPublishedDependencyNode(h.db, h.certificate)).toBe(true);
  expect(readPublishedDependencyCut(h.db, h.message.id)).toBeDefined();
  h.external.prepare('UPDATE messages SET content=? WHERE id=?').run('迁移后外连修改来源，仍立即失效。', h.source.id);
  expect(readPublishedDependencyCut(h.db, h.message.id)).toBeUndefined();
});

it('retains current v4 topology on reopen and preserves per-row private guards for bulk inserted edges', async () => {
  const h = await fixture(), before = h.db.prepare('SELECT * FROM companion_published_dependency_edges ORDER BY parent_key,target_kind,target_key').all();
  const exec = vi.spyOn(h.db, 'exec'); initializePublishedDependencyIndex(h.db);
  expect(exec.mock.calls.some(([sql]) => sql.includes('DROP TABLE companion_published_dependency_edges'))).toBe(false);
  expect(h.db.prepare('SELECT * FROM companion_published_dependency_edges ORDER BY parent_key,target_kind,target_key').all()).toEqual(before);
  expect(readPublishedDependencyCut(h.db, h.message.id)).toBeDefined();
  expect(() => h.external.prepare("INSERT INTO companion_published_dependency_edges SELECT ?,json_extract(value,'$.kind'),json_extract(value,'$.key') FROM json_each(?)")
    .run(canonical(['message', h.message.id]), canonical([{ kind: 'message', key: 'forged-source' }]))).toThrow();
  h.external.prepare("DELETE FROM companion_published_dependency_edges WHERE parent_key=? AND target_kind='certificate'").run(canonical(['message', h.message.id]));
  expect(readPublishedDependencyCut(h.db, h.message.id)).toBeUndefined();
});

it.each([7, { invalid: 'object must not be coerced into TEXT' }])('refuses a malformed private edge target before hashing or bulk insertion: %j', async malformed => {
  const h = await fixture();
  h.external.exec(`INSERT INTO companion_published_dependency_dirty
    SELECT node_key,(SELECT generation FROM companion_published_authority_generation WHERE id=1)
    FROM companion_published_dependency_nodes node WHERE NOT EXISTS(
      SELECT 1 FROM companion_published_dependency_dirty dirty WHERE dirty.node_key=node.node_key)`);
  const db = new Proxy(h.db, { get(target, member) {
    if (member === 'prepare') return (sql: string) => {
      const statement = target.prepare(sql);
      return new Proxy(statement, { get(current, method) {
        if (method === 'all' && sql === 'SELECT id FROM vcp_source_prohibitions WHERE companion_id=?') return () => [{ id: malformed }];
        const value = Reflect.get(current, method, current); return typeof value === 'function' ? value.bind(current) : value;
      } });
    };
    const value = Reflect.get(target, member, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  initializePublishedDependencyIndex(db);
  const certificate = db.prepare('SELECT data FROM companion_message_publication_certificates WHERE message_id=?').get(h.message.id);
  expect(certifyPublishedDependencyNode(db, h.certificate)).toBe(false);
  expect(readPublishedDependencyCut(db, h.message.id)).toBeUndefined();
  expect(db.prepare('SELECT data FROM companion_message_publication_certificates WHERE message_id=?').get(h.message.id)).toEqual(certificate);
});

it('keeps an offline legacy-v2 full-proof adapter read-only without requiring new authority columns', async () => {
  const h = await legacyFrontier(), filename = path.join(h.f.root, 'legacy-authority.sqlite');
  h.db.prepare('VACUUM INTO ?').run(filename); const db = connection(filename);
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'companion_published_%'").all() as Array<{ name: string }>;
  for (const { name } of triggers) { expect(name).toMatch(/^[a-z_]+$/u); db.exec(`DROP TRIGGER ${name}`); }
  for (const column of ['covered_epoch', 'protocol_version', 'index_writing']) db.exec(`ALTER TABLE companion_published_authority_generation DROP COLUMN ${column}`);
  const changes = db.prepare('SELECT total_changes() AS n').get();
  expect(readPublishedDependencyCut(db, h.parent.id)).toBeUndefined();
  expect(currentPublishedSourceCutValid(db, db.prepare('SELECT * FROM messages WHERE id=?').get(h.parent.id) as Record<string, string | number | null>)).toBe(false);
  withPublishedDependencyReadWindow(db, () => expect(readPublishedActionFrontier(db, h.actions[0]!.action.id)).toBeDefined());
  expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
  expect((db.prepare('PRAGMA table_info(companion_published_authority_generation)').all() as Array<{ name: string }>).map(row => row.name)).toEqual(['id', 'generation']);
});

it('lets the real host retirement finish and leaves no identifiable orphan dirty markers', async () => {
  const h = await fixture(), bobRoom = h.f.store.openPrivate('bob');
  const bob = h.append('无关联伙伴的正式内容继续有效。', plainReadset('bob', bobRoom.id)); h.certify(bob.id);
  const job = h.f.store.request({ type: 'companion.retire', id: 'alice', scope: 'all' }).reset!;
  h.f.store.request({ type: 'companion.retire.cleanup', id: 'alice', jobId: job.id });
  for (let step = 0; step < 300 && h.f.store.request({ type: 'companion.retire.status', id: 'alice' }).reset?.status !== 'completed'; step++) await h.f.store.advanceReset();
  expect(h.f.store.request({ type: 'companion.retire.status', id: 'alice' }).reset?.status).toBe('completed');
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM companion_published_dependency_nodes WHERE companion_id=?').get('alice')).toEqual({ n: 0 });
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM companion_published_dependency_dirty dirty WHERE NOT EXISTS(SELECT 1 FROM companion_published_dependency_nodes node WHERE node.node_key=dirty.node_key)').get()).toEqual({ n: 0 });
  expect(JSON.stringify(h.db.prepare('SELECT * FROM companion_published_dependency_dirty').all())).not.toContain(h.message.id);
  expect(readPublishedDependencyCut(h.db, bob.id)).toBeDefined();
});

it('removes retired peer source identifiers from dirty reader-forget indexes while retaining an independent live owner', async () => {
  const h = await peerWorldClosure(), bobRoom = h.f.store.openPrivate('bob');
  const response = h.f.store.appendMessage({ conversationId: h.room.id, authorId: 'bob', replyToId: h.peer.id, content: '另一位伙伴实际读取这条正式通信。',
    executionReadset: plainReadset('bob', h.room.id, [{ id: h.peer.id, conversationId: h.room.id, checksum: hash(h.peer.content) }]) }); h.certify(response.id);
  const independent = h.append('未参与这条来源链的私人正式内容。', plainReadset('bob', bobRoom.id)); h.certify(independent.id);
  expect(h.db.prepare('SELECT 1 FROM companion_published_dependency_nodes WHERE node_key=?').get(canonical(['forget', 'bob', h.peer.id]))).toBeDefined();
  const job = h.f.store.request({ type: 'companion.retire', id: 'alice', scope: 'all' }).reset!;
  h.f.store.request({ type: 'companion.retire.cleanup', id: 'alice', jobId: job.id });
  for (let step = 0; step < 300 && h.f.store.request({ type: 'companion.retire.status', id: 'alice' }).reset?.status !== 'completed'; step++) await h.f.store.advanceReset();
  expect(h.f.store.request({ type: 'companion.retire.status', id: 'alice' }).reset?.status).toBe('completed');
  expect(JSON.stringify(h.db.prepare('SELECT * FROM companion_published_dependency_dirty').all())).not.toContain(h.peer.id);
  expect(readPublishedDependencyCut(h.db, independent.id)).toBeDefined();
});

it('indexes the actual canonical memory revision and direct typed dependencies only after the private publication certificate', async () => {
  const h = await fixture();
  expect(readPublishedDependencyCut(h.db, h.message.id)).toMatchObject({ certificate: h.certificate, readset: h.readset });
  const unverified = h.append('尚未经过Main完整发布核验。');
  expect(readPublishedDependencyCut(h.db, unverified.id)).toBeUndefined();
  expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, { ...h.certificate, messageId: unverified.id })).immediate()).toBe(false);
  const nodes = h.db.prepare('SELECT node_key FROM companion_published_dependency_nodes').all() as Array<{ node_key: string }>;
  expect(nodes.some(node => node.node_key.includes(h.parent.id))).toBe(true);
  expect(nodes.some(node => node.node_key.includes(h.note.id))).toBe(true);
});

async function hostSnapshotClosure(category: 'contacts' | 'people' = 'contacts') {
  const h = await fixture();
  const snapshot = h.f.store.request({ type: 'memory.world_query', ...h.f.scope, category, query: '', limit: 10,
    beforeSequence: h.source.sequence }).memorySources![0]!;
  const proof = structuredClone(h.readset);
  proof.sources = [{ id: snapshot.id, conversationId: snapshot.conversationId, checksum: hash(snapshot.content) }];
  const reply = h.append('正式回复使用宿主记录的目录快照。', proof), certificate = h.certify(reply.id);
  return { ...h, snapshot, proof, reply, snapshotCertificate: certificate };
}

it.each(['contacts', 'people'] as const)('indexes the real own %s host snapshot without treating its notice as a model publication', async category => {
  const h = await hostSnapshotClosure(category), cut = readPublishedDependencyCut(h.db, h.reply.id)!;
  expect(cut).toMatchObject({ certificate: h.snapshotCertificate, assetOwners: ['alice'], volatileActions: [] });
  expect(h.db.prepare('SELECT 1 FROM companion_message_publication_certificates WHERE message_id=?').get(h.snapshot.id)).toBeUndefined();
  expect(h.f.store.request({ type: 'memory.sources.filter', ...h.f.scope, ids: [h.snapshot.id] }).memorySources?.map(row => row.id)).toContain(h.snapshot.id);
  const sourceKey = canonical(['source', 'alice', h.snapshot.conversationId, h.snapshot.id]);
  expect(h.db.prepare("SELECT 1 FROM companion_published_dependency_edges WHERE parent_key=? AND target_kind='node' AND target_key=?")
    .get(canonical(['message', h.reply.id]), sourceKey)).toBeDefined();
  expect(h.db.prepare("SELECT 1 FROM companion_published_dependency_edges WHERE parent_key=? AND target_kind='metadata' AND target_key=?")
    .get(sourceKey, 'memory-world-observation/' + h.snapshot.id)).toBeDefined();
  expect(readPublishedDependencyCut(h.db, h.reply.id, undefined, new Set(['message:' + h.reply.id]))).toBeUndefined();
});

it.each(['owner', 'checksum', 'world-marker', 'missing-marker', 'observer', 'block', 'reset', 'membership', 'unknown-domain'] as const)(
  'does not retain a host snapshot cut after external %s authority changes', async change => {
    const h = await hostSnapshotClosure(), db = h.external;
    if (change === 'owner') db.prepare("UPDATE metadata SET value=json_set(value,'$.companionId','bob') WHERE key=?").run('memory-world-observation/' + h.snapshot.id);
    if (change === 'checksum') db.prepare("UPDATE metadata SET value=json_set(value,'$.checksum',?) WHERE key=?").run('0'.repeat(64), 'memory-world-observation/' + h.snapshot.id);
    if (change === 'world-marker') db.prepare('UPDATE metadata SET value=? WHERE key=?').run('false', 'world-room/' + h.snapshot.conversationId);
    if (change === 'missing-marker') db.prepare('DELETE FROM metadata WHERE key=?').run('world-room/' + h.snapshot.conversationId);
    if (change === 'observer') db.prepare('DELETE FROM vcp_source_observers WHERE companion_id=? AND message_id=?').run('alice', h.snapshot.id);
    if (change === 'block') db.prepare('INSERT INTO vcp_source_blocks(companion_id,message_id,created_at) VALUES(?,?,?)').run('alice', h.snapshot.id, new Date().toISOString());
    if (change === 'reset') db.prepare('INSERT INTO companion_reset_messages(job_id,message_id,sequence) VALUES(?,?,?)').run('snapshot-reset', h.snapshot.id, h.snapshot.sequence);
    if (change === 'membership') db.prepare('DELETE FROM conversation_members WHERE companion_id=? AND conversation_id=?').run('alice', h.snapshot.conversationId);
    if (change === 'unknown-domain') db.prepare("UPDATE metadata SET value=json_set(value,'$.observation.category','learning') WHERE key=?").run('memory-world-observation/' + h.snapshot.id);
    expect(readPublishedDependencyCut(h.db, h.reply.id)).toBeUndefined();
    expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, h.snapshotCertificate)).immediate()).toBe(false);
  });

async function peerWorldClosure() {
  const h = await fixture(), room = h.f.store.request({ type: 'social.conversation.ensure', companionId: 'alice', memberIds: ['alice', 'bob'], title: '真实伙伴通信' }).socialConversation!;
  const proof: CompanionExecutionReadset = { ...structuredClone(h.readset), conversationId: room.id,
    sources: [{ id: h.source.id, conversationId: h.source.conversationId, checksum: hash(h.source.content) }] };
  const peer = h.append('伙伴之间实际公开的发言。', proof), certificate = h.certify(peer.id);
  return { ...h, room, peer, peerProof: proof, peerCertificate: certificate };
}

it('indexes actual peer discussion world rooms with their own exact membership and Main asset obligations', async () => {
  const h = await peerWorldClosure();
  expect(readPublishedDependencyCut(h.db, h.peer.id)).toMatchObject({ assetOwners: ['alice'] });
  const proof = structuredClone(h.readset); proof.sources = [{ id: h.peer.id, conversationId: h.room.id, checksum: hash(h.peer.content) }];
  const reply = h.append('把真实通信的正式结论带回自己的聊天。', proof); h.certify(reply.id);
  expect(readPublishedDependencyCut(h.db, reply.id)).toMatchObject({ assetOwners: ['alice'] });
  const unknownRoom = h.f.store.createConversation('任意带标记的房间', ['alice', 'bob']);
  h.external.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('world-room/' + unknownRoom.id, 'true');
  const unsupported = h.append('不能将任意world标记变成正式社交许可。', { ...proof, conversationId: unknownRoom.id });
  const candidate = h.f.store.request({ type: 'execution.sources', sourceMessageIds: [unsupported.id] }).executionSources!.find(row => row.id === unsupported.id)!.publicationCandidate!;
  const cert = h.f.store.request({ type: 'execution.message.certify', messages: [{ ...candidate, mode: 'revalidated_historical' }] }).messagePublicationCertificates![0]!;
  expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, cert)).immediate()).toBe(false);
});

it.each(['membership', 'dissolved', 'marker', 'missing-marker', 'social-binding'] as const)('retires peer world cuts when current %s changes', async change => {
  const h = await peerWorldClosure(), db = h.external;
  if (change === 'membership') db.prepare('DELETE FROM conversation_members WHERE companion_id=? AND conversation_id=?').run('alice', h.room.id);
  if (change === 'dissolved') db.prepare('UPDATE conversations SET dissolved_at=? WHERE id=?').run(new Date().toISOString(), h.room.id);
  if (change === 'marker') db.prepare('UPDATE metadata SET value=? WHERE key=?').run('false', 'world-room/' + h.room.id);
  if (change === 'missing-marker') db.prepare('DELETE FROM metadata WHERE key=?').run('world-room/' + h.room.id);
  if (change === 'social-binding') db.prepare('UPDATE companion_social_conversations SET member_key=? WHERE id=?').run('alice|uninvited', h.room.id);
  expect(readPublishedDependencyCut(h.db, h.peer.id)).toBeUndefined();
  expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, h.peerCertificate)).immediate()).toBe(false);
});

it('repairs only derived missing indexes at initialization without minting or replacing historical authority', async () => {
  const h = await hostSnapshotClosure('people');
  const authority = () => ({ certificates: h.db.prepare('SELECT * FROM companion_message_publication_certificates ORDER BY message_id').all(),
    pins: h.db.prepare('SELECT * FROM companion_message_publication_action_pins ORDER BY message_id,certificate_hash').all(),
    readsets: h.db.prepare("SELECT * FROM metadata WHERE key GLOB 'message-execution-readset/*' ORDER BY key").all() });
  const before = authority();
  h.db.function('companion_published_index_writing', { deterministic: false }, () => '1');
  h.db.prepare('DELETE FROM companion_published_dependency_nodes WHERE node_key=?').run(canonical(['message', h.reply.id]));
  initializePublishedDependencyIndex(h.db);
  expect(readPublishedDependencyCut(h.db, h.reply.id)).toBeUndefined();
  h.f.restart();
  expect(readPublishedDependencyCut(h.db, h.reply.id)).toMatchObject({ certificate: h.snapshotCertificate });
  expect(authority()).toEqual(before);
  const unverified = h.append('没有正式发布凭证，不能由维护创建权限。');
  expect(maintainPublishedDependencyIndex(h.db)).toEqual({ indexed: 0, skipped: 0 });
  expect(readPublishedDependencyCut(h.db, unverified.id)).toBeUndefined();
});

it('advances bounded index maintenance past unsupported historical candidates without granting them authority', async () => {
  const h = await hostSnapshotClosure();
  h.db.function('companion_published_index_writing', { deterministic: false }, () => '1');
  h.db.prepare('DELETE FROM companion_published_dependency_nodes WHERE node_key=?').run(canonical(['message', h.reply.id]));
  initializePublishedDependencyIndex(h.db);
  for (let index = 0; index < 103; index++) {
    const unverified = h.append('损坏旧凭证不能阻塞另一项健康的派生索引 ' + index);
    // Deliberate corruption: the retained Main tuple belongs to another ID.
    // Maintenance must reject it rather than manufacture a new certificate.
    h.db.prepare('INSERT INTO companion_message_publication_certificates(message_id,data) VALUES(?,?)').run(unverified.id, canonical(h.snapshotCertificate));
  }
  expect(maintainPublishedDependencyIndex(h.db)).toEqual({ indexed: 0, skipped: 100 });
  expect(readPublishedDependencyCut(h.db, h.reply.id)).toBeUndefined();
  const next = maintainPublishedDependencyIndex(h.db);
  expect(next.indexed).toBe(1); expect(next.skipped).toBeLessThanOrEqual(99);
  expect(readPublishedDependencyCut(h.db, h.reply.id)).toMatchObject({ certificate: h.snapshotCertificate });
  expect(h.db.prepare('SELECT COUNT(*) AS n FROM companion_message_publication_certificates').get()).toEqual({ n: 105 });
});

it('still performs the Main fresh source union after a host snapshot was indexed', async () => {
  const h = await hostSnapshotClosure(), gate = createCompanionExecutionValidationSession(), identity = {};
  await gate.run(() => guardCompanionExecutionSources({ type: 'messages', conversationId: h.reply.conversationId }, { ok: true, messages: [h.reply] },
    { storage: async command => h.f.store.request(command), identity, revision: () => 0, valid: async () => true }));
  h.external.prepare('UPDATE messages SET content=? WHERE id=?').run('宿主记录的正文已经改变。', h.snapshot.id);
  await expect(gate.validate()).rejects.toThrow(); gate.close();
});

it('reuses only fixed compiled reads per fenced connection while executing fresh publication and action gates', async () => {
  const h = await legacyFrontier(); let mutations = 0;
  const guard = <T,>(operation: () => T): T => { mutations++; return operation(); };
  const fenced = fencedCompanionConnection(h.db, guard), compile = vi.fn((sql: string) => fenced.prepare(sql));
  const db = new Proxy(fenced, { get(target, name) {
    if (name === 'prepare') return compile;
    const value = Reflect.get(target, name, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const action = h.actions[0]!.action;
  for (let index = 0; index < 3; index++) withPublishedDependencyReadWindow(db, () => {
    expect(readPublishedDependencyCut(db, h.parent.id, h.proof)).toBeDefined();
    expect(readPublishedActionDependencyCut(db, action.id, h.readset)).toBeDefined();
    expect(readPublishedDependencyCut(db, h.parent.id, h.proof, new Set(['message:' + h.message.id]))).toBeUndefined();
  });
  const compiled = compile.mock.calls.map(([sql]) => sql);
  expect(compiled).toHaveLength(10); expect(new Set(compiled).size).toBe(10);
  expect(mutations).toBe(0); // These are SELECTs, not a mutation admission.
  h.external.prepare("UPDATE actions SET data=json_set(data,'$.error','真实结果已变') WHERE id=?").run(action.id);
  expect(readPublishedDependencyCut(db, h.parent.id, h.proof)).toBeUndefined();
  expect(readPublishedActionDependencyCut(db, action.id, h.readset)).toBeUndefined();
  expect(compile).toHaveBeenCalledTimes(10);
  // Another connection owns distinct prepared statements even for the same DB.
  const otherCompile = vi.fn((sql: string) => h.external.prepare(sql));
  const other = new Proxy(h.external, { get(target, name) {
    if (name === 'prepare') return otherCompile;
    const value = Reflect.get(target, name, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  expect(readPublishedDependencyCut(other, h.parent.id, h.proof)).toBeUndefined();
  expect(otherCompile).toHaveBeenCalled();
});

it('keeps read cost independent of the number of already published message ancestors and does not dirty ordinary appends', async () => {
  const h = await fixture(), initialGeneration = h.generation();
  let previous = h.message;
  for (let index = 0; index < 18; index++) {
    const proof = structuredClone(h.readset); proof.sources = [{ id: previous.id, conversationId: h.f.scope.conversationId, checksum: hash(previous.content) }];
    previous = h.append('普通连续聊天的正式消息 ' + index, proof); h.certify(previous.id);
    expect(h.generation()).toBe(initialGeneration);
  }
  const statements = observeReads(h);
  expect(readPublishedDependencyCut(h.db, h.message.id)).toBeDefined(); const first = statements.mock.calls.length;
  statements.mockClear(); expect(readPublishedDependencyCut(h.db, previous.id)).toBeDefined();
  expect(statements.mock.calls.length).toBe(first); expect(first).toBeLessThanOrEqual(8);
  expect(statements.mock.calls.some(([sql]) => /vcp_memory|companion_memory_history|WITH RECURSIVE|actions/u.test(sql))).toBe(false);
  statements.mockRestore();
});

it.each(['source', 'source-loop', 'membership', 'observer', 'block', 'prohibition', 'history', 'ancestor-history', 'history-body', 'history-source-index', 'history-dependency-index', 'version-alias', 'message-readset', 'message-loop', 'invalid-marker', 'artifact'] as const)(
  'an external SQLite %s mutation invalidates the cut before any old certificate can be reused', async kind => {
    const h = await fixture(), before = h.generation(), db = h.external;
    if (kind === 'source') db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('改写后的原始记录。', h.source.id);
    else if (kind === 'source-loop') db.prepare('INSERT INTO metadata VALUES(?,?)').run('message-loop/' + h.source.id, JSON.stringify({ status: 'running' }));
    else if (kind === 'membership') db.prepare('DELETE FROM conversation_members WHERE companion_id=? AND conversation_id=?').run('alice', h.f.scope.conversationId);
    else if (kind === 'observer') db.prepare('DELETE FROM vcp_source_observers WHERE companion_id=? AND message_id=?').run('alice', h.source.id);
    else if (kind === 'block') db.prepare('INSERT INTO vcp_source_blocks VALUES(?,?,?)').run(h.source.id, 'alice', new Date().toISOString());
    else if (kind === 'prohibition') db.prepare('INSERT INTO vcp_source_prohibitions VALUES(?,?,?,?,?,?)').run('new_forget', 'alice', h.f.scope.conversationId, '原始记录', h.source.sequence, 1);
    else if (kind === 'history' || kind === 'ancestor-history') db.prepare("UPDATE companion_memory_history_files SET state='retracted' WHERE note_id=?").run(kind === 'history' ? h.note.id : h.parent.id);
    else if (kind === 'history-body') db.prepare("UPDATE companion_memory_content_revisions SET data=json_set(data,'$.memory.content','篡改不可变修订') WHERE note_id=?").run(h.parent.id);
    else if (kind === 'history-source-index') db.prepare('DELETE FROM companion_memory_history_sources WHERE note_id=?').run(h.parent.id);
    else if (kind === 'history-dependency-index') db.prepare('DELETE FROM companion_memory_history_dependencies WHERE note_id=?').run(h.note.id);
    else if (kind === 'version-alias') db.prepare('UPDATE companion_memory_version_revisions SET content_revision=content_revision+1 WHERE note_id=? AND version=?').run(h.note.id, h.note.version);
    else if (kind === 'message-readset') db.prepare("UPDATE metadata SET value=json_set(value,'$.complete',json('false')) WHERE key=?").run('message-execution-readset/' + h.message.id);
    else if (kind === 'message-loop') db.prepare('INSERT INTO metadata VALUES(?,?)').run('message-loop/' + h.message.id, JSON.stringify({ status: 'running', sourceMessageId: h.source.id }));
    else if (kind === 'invalid-marker') db.prepare('INSERT INTO metadata VALUES(?,?)').run('execution-source-invalid/message/' + h.message.id, JSON.stringify({ invalidatedAt: new Date().toISOString() }));
    else db.prepare("UPDATE companion_artifacts SET state='revoked' WHERE owner_id=? AND artifact_id=?").run('alice', `history:${h.parent.id}:r${h.parent.contentRevision}`);
    expect(h.generation()).toBeGreaterThan(before); expect(readPublishedDependencyCut(h.db, h.message.id)).toBeUndefined();
    expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, h.certificate)).immediate()).toBe(false);
  });

it('does not let current canonical-file edits rewrite past statements or bypass the current real RAG byte gate', async () => {
  const h = await fixture(), before = h.generation();
  await writeFile(h.f.noteFile(h.note), '当前文件出现外部编辑。');
  expect(readPublishedDependencyCut(h.db, h.message.id)).toBeDefined(); expect(h.generation()).toBe(before);
  expect(await h.f.live.validate('alice', h.receipts)).toBe(false);
  h.f.store.request({ type: 'memory.forget', ...h.f.scope, sourceMessageIds: [h.source.id], persistent: true });
  expect(h.generation()).toBeGreaterThan(before); expect(readPublishedDependencyCut(h.db, h.message.id)).toBeUndefined();
});

it('does not dirty an established node for unrelated new memory, role growth, progress or world clock writes', async () => {
  const h = await fixture(), before = h.generation();
  const source = h.f.source('与旧发言无关的新事实。'); h.f.record('本轮新知识。', [source.id]); await h.f.publish();
  h.external.prepare('INSERT INTO metadata VALUES(?,?)').run('message-loop/unrelated_loop', JSON.stringify({ status: 'running', sourceMessageId: source.id, progress: { phase: 'context' } }));
  h.external.prepare('INSERT INTO metadata VALUES(?,?)').run('world-clock/example', JSON.stringify({ tick: 2 }));
  h.external.prepare("UPDATE companions SET data=json_set(data,'$.persona',?) WHERE id=?").run('新任务才会读取的SQL索引草稿。', 'alice');
  expect(h.generation()).toBe(before); expect(readPublishedDependencyCut(h.db, h.message.id)).toBeDefined();
});

it.each(['deletedAt', 'kind', 'participantIds'] as const)('tracks primary discussion %s authority but not its publication/progress counters', async field => {
  const h = await fixture();
  const topic = h.db.prepare('SELECT topic_id FROM companion_message_topics WHERE message_id=?').get(h.message.id) as { topic_id: string };
  const before = h.generation();
  h.external.prepare("UPDATE companion_topics SET data=json_set(data,'$.formalPublicationRevision',700,'$.updatedAt','later') WHERE id=?").run(topic.topic_id);
  expect(h.generation()).toBe(before); expect(readPublishedDependencyCut(h.db, h.message.id)).toBeDefined();
  if (field === 'deletedAt') h.external.prepare("UPDATE companion_topics SET data=json_set(data,'$.deletedAt','now') WHERE id=?").run(topic.topic_id);
  if (field === 'kind') h.external.prepare("UPDATE companion_topics SET data=json_set(data,'$.kind','game') WHERE id=?").run(topic.topic_id);
  if (field === 'participantIds') h.external.prepare("UPDATE companion_topics SET data=json_set(data,'$.participantIds',json('[]'),'$.invitedIds',json('[]')) WHERE id=?").run(topic.topic_id);
  expect(h.generation()).toBeGreaterThan(before); expect(readPublishedDependencyCut(h.db, h.message.id)).toBeUndefined();
  expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, h.certificate)).immediate()).toBe(false);
});

it('ignores a completed loop progress/context save while retaining its exact status and original-source authority', async () => {
  const h = await fixture();
  h.external.prepare('INSERT INTO metadata VALUES(?,?)').run('message-loop/' + h.message.id, JSON.stringify({ status: 'done', sourceMessageId: h.source.id, progress: { phase: 'completed' } }));
  h.certify(h.message.id); const before = h.generation();
  h.external.prepare("UPDATE metadata SET value=json_set(value,'$.progress.revision',200,'$.context.user','pure-runtime-progress') WHERE key=?").run('message-loop/' + h.message.id);
  expect(h.generation()).toBe(before); expect(readPublishedDependencyCut(h.db, h.message.id)).toBeDefined();
  h.external.prepare("UPDATE metadata SET value=json_set(value,'$.status','running') WHERE key=?").run('message-loop/' + h.message.id);
  expect(h.generation()).toBeGreaterThan(before); expect(readPublishedDependencyCut(h.db, h.message.id)).toBeUndefined();
});

it('retains an unaffected closed branch immediately after a rare authority change elsewhere and keeps recertification idempotent', async () => {
  const h = await fixture(), source = h.f.source('另一位伙伴的独立来源。', 'bob'), room = h.f.store.openPrivate('bob');
  const proof: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', complete: true, companionId: 'bob', conversationId: room.id,
    sources: [{ id: source.id, conversationId: room.id, checksum: hash(source.content) }], memories: [], contexts: [], knowledgeReads: [], topics: [] };
  const other = h.append('独立伙伴的既有正式结果。', proof); h.certify(other.id);
  h.external.prepare('INSERT INTO vcp_source_blocks VALUES(?,?,?)').run(source.id, 'bob', new Date().toISOString());
  expect(readPublishedDependencyCut(h.db, h.message.id)).toMatchObject({ certificate: h.certificate, assetOwners: ['alice'] });
  expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, h.certificate)).immediate()).toBe(true);
  expect(readPublishedDependencyCut(h.db, h.message.id)).toBeDefined(); expect(readPublishedDependencyCut(h.db, other.id)).toBeUndefined();
});

it('cuts a certified foreign author while keeping the current reader\'s own forgotten-source authority separate', async () => {
  const h = await fixture(), room = h.f.store.createConversation('真实双方通信', ['alice', 'bob']);
  const source = h.f.store.appendMessage({ conversationId: room.id, authorId: 'user', content: '这条最早的来源仅对某位读者撤回。' });
  const proof: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', complete: true, companionId: 'bob', conversationId: room.id,
    sources: [{ id: source.id, conversationId: room.id, checksum: hash(source.content) }], memories: [], contexts: [], knowledgeReads: [], topics: [] };
  const other = h.f.store.appendMessage({ conversationId: room.id, authorId: 'bob', content: '这是另一位作者的已发布叙述。', replyToId: source.id, executionReadset: proof }); h.certify(other.id);
  const child = h.append('读者基于那条正式叙述继续回答。', { ...proof, companionId: 'alice', sources: [{ id: other.id, conversationId: room.id, checksum: hash(other.content) }] });
  const candidate = h.f.store.request({ type: 'execution.sources', sourceMessageIds: [child.id] }).executionSources!.find(value => value.id === child.id)!.publicationCandidate!;
  const certificate = h.f.store.request({ type: 'execution.message.certify', messages: [{ ...candidate, mode: 'revalidated_historical' }] }).messagePublicationCertificates![0]!;
  expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, certificate)).immediate()).toBe(true);
  expect(readPublishedDependencyCut(h.db, child.id)?.assetOwners).toEqual(['alice', 'bob']);
  h.external.prepare('INSERT INTO vcp_source_blocks VALUES(?,?,?)').run(source.id, 'alice', new Date().toISOString());
  expect(readPublishedDependencyCut(h.db, child.id)).toBeUndefined();
  expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, certificate)).immediate()).toBe(false);
  expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, h.f.store.request({ type: 'execution.sources', sourceMessageIds: [other.id] }).executionSources!.find(value => value.id === other.id)!.publicationCertificate!)).immediate()).toBe(true);
});

async function foreignAncestry(withAction = false) {
  const h = await fixture(), privateRoom = h.f.store.openPrivate('bob'), shared = h.f.store.createConversation('正式双方通信', ['alice', 'bob']);
  const privateSource = h.f.source('只属于另一位伙伴私聊的真实原始依据。', 'bob');
  const bobScope = { companionId: 'bob', conversationId: privateRoom.id };
  const note = h.f.store.request({ type: 'memory.record', ...bobScope, candidate: h.f.candidate('另一位伙伴有其自己的准确历史记忆。', [privateSource.id]) }).memories![0]!;
  h.f.index(); await h.f.publish('bob');
  const receipts = (await h.f.live.materialize('bob', [note])).receipts; expect(await h.f.live.validate('bob', receipts)).toBe(true);
  const bobProof: CompanionExecutionReadset = { schema: 'worldlinebox.companion-execution-readset-v1', complete: true,
    companionId: 'bob', conversationId: shared.id, memories: [{ id: note.id, version: note.version }], sources: [], knowledgeReads: [], topics: [],
    memoryReads: [{ id: note.id, version: note.version, contentRevision: note.contentRevision!, sources: note.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum })) }],
    contexts: [{ revision: 'actual-foreign-owner-memory', profileKey: 'foreign-canonical-memory-files', fileReceiptOnly: true, fileReceipts: receipts }] };
  let action: CompanionAction | undefined;
  if (withAction) {
    const request = h.f.store.appendMessage({ conversationId: shared.id, authorId: 'user', content: '请另一位伙伴处理这项真实独立任务。' });
    action = h.f.store.request({ type: 'action.create', action: { companionId: 'bob', conversationId: shared.id, sourceMessageId: request.id, title: '另一位伙伴的实际DSH', status: 'queued' },
      checkpoint: { prompt: '另一位伙伴执行真实独立任务。', executionReadset: bobProof } }).action!;
    h.f.store.request({ type: 'action.update', id: action.id, patch: { status: 'succeeded', result: '另一位伙伴自己的已完成正式结果。' } });
    const card = h.f.store.messages({ conversationId: shared.id }).messages.find(message => message.actionId === action!.id)!;
    bobProof.sources = [{ id: card.id, conversationId: shared.id, checksum: hash(card.content) }];
  }
  const foreign = h.append('另一位伙伴只向共享会话发布其正式结论。', bobProof); h.certify(foreign.id);
  const ownProof = structuredClone(h.readset); ownProof.sources = [{ id: foreign.id, conversationId: shared.id, checksum: hash(foreign.content) }];
  const own = h.append('回到自己的私聊后引用那项正式结论。', ownProof), certificate = h.certify(own.id);
  return { ...h, privateRoom, privateSource, shared, bobProof, foreign, own, ownProof, ownCertificate: certificate, foreignNote: note, foreignAction: action };
}

it('keeps long ordinary private conversation bounded after actual peer communication and retains both owners without exposing private ancestors', async () => {
  const h = await foreignAncestry(), before = h.generation(); let previous = h.own;
  expect(() => h.f.store.request({ type: 'memory.sources.filter', companionId: 'alice', conversationId: h.privateRoom.id, ids: [h.privateSource.id] })).toThrow();
  const reads = observeReads(h);
  expect(readPublishedDependencyCut(h.db, previous.id)?.assetOwners).toEqual(['alice', 'bob']); const initialCount = reads.mock.calls.length; reads.mockRestore();
  for (let index = 0; index < 18; index++) {
    const proof = structuredClone(h.readset); proof.sources = [{ id: previous.id, conversationId: previous.conversationId, checksum: hash(previous.content) }];
    previous = h.append('伙伴通信后继续普通私聊 ' + index, proof); h.certify(previous.id);
    expect(readPublishedDependencyCut(h.db, previous.id)).toMatchObject({ assetOwners: ['alice', 'bob'], volatileActions: [] }); expect(h.generation()).toBe(before);
  }
  const finalReads = observeReads(h); expect(readPublishedDependencyCut(h.db, previous.id)?.assetOwners).toEqual(['alice', 'bob']);
  expect(finalReads.mock.calls.length).toBe(initialCount); expect(initialCount).toBeLessThanOrEqual(8); expect(finalReads.mock.calls.some(([sql]) => /vcp_memory|companion_memory_history|WITH RECURSIVE/u.test(sql))).toBe(false); finalReads.mockRestore();
  const returned = h.f.store.request({ type: 'execution.sources', sourceMessageIds: [previous.id] }).executionSources!;
  expect(returned.map(proof => proof.id)).toEqual([previous.id]);
  expect(returned[0]!.executionReadset!.sources.some(source => source.id === h.privateSource.id)).toBe(false);
});

it.each(['reader-membership', 'reader-observer', 'author-membership', 'author-observer', 'author-forget', 'author-history', 'author-deleted'] as const)(
  'retires a foreign-owner closure when its exact %s authority changes in external SQLite', async kind => {
    const h = await foreignAncestry(), before = h.generation();
    if (kind === 'reader-membership') h.external.prepare('DELETE FROM conversation_members WHERE companion_id=? AND conversation_id=?').run('alice', h.shared.id);
    if (kind === 'reader-observer') h.external.prepare('DELETE FROM vcp_source_observers WHERE companion_id=? AND message_id=?').run('alice', h.foreign.id);
    if (kind === 'author-membership') h.external.prepare('DELETE FROM conversation_members WHERE companion_id=? AND conversation_id=?').run('bob', h.privateRoom.id);
    if (kind === 'author-observer') h.external.prepare('DELETE FROM vcp_source_observers WHERE companion_id=? AND message_id=?').run('bob', h.privateSource.id);
    if (kind === 'author-forget') h.external.prepare('INSERT INTO vcp_source_blocks VALUES(?,?,?)').run(h.privateSource.id, 'bob', new Date().toISOString());
    if (kind === 'author-history') h.external.prepare("UPDATE companion_memory_history_files SET state='retracted' WHERE companion_id=? AND note_id=?").run('bob', h.foreignNote.id);
    if (kind === 'author-deleted') h.external.prepare('UPDATE companions SET deleted_at=? WHERE id=?').run(new Date().toISOString(), 'bob');
    expect(h.generation()).toBeGreaterThan(before); expect(readPublishedDependencyCut(h.db, h.own.id)).toBeUndefined();
    expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, h.ownCertificate)).immediate()).toBe(false);
  });

it('retains a foreign legacy action under its exact own room and owner, without requiring the reader to own that action', async () => {
  const h = await foreignAncestry(true), cut = readPublishedDependencyCut(h.db, h.own.id)!;
  expect(cut.assetOwners).toEqual(['alice', 'bob']); expect(cut.volatileActions).toHaveLength(1);
  expect(cut.volatileActions[0]).toMatchObject({ id: h.foreignAction!.id, companionId: 'bob', conversationId: h.shared.id });
  expect(readPublishedActionDependencyCut(h.db, h.foreignAction!.id)).toMatchObject({ assetOwners: ['bob'], binding: cut.volatileActions[0]!.actionBindingHash });
  expect(readPublishedDependencyCut(h.db, h.own.id, undefined, new Set(['action:' + h.foreignAction!.id]))).toBeUndefined();
  h.external.prepare("UPDATE actions SET data=json_set(data,'$.result','外部改写另一位伙伴的结果') WHERE id=?").run(h.foreignAction!.id);
  expect(readPublishedDependencyCut(h.db, h.own.id)).toBeUndefined();
});

it.each(['old-version', 'missing', 'empty', 'unsorted', 'duplicate', 'invalid', 'omitted-foreign'] as const)('never treats %s asset-owner metadata as an empty or weaker live-authority obligation', async kind => {
  const h = await foreignAncestry(), nodeKey = JSON.stringify(['message', h.own.id]), stored = h.db.prepare('SELECT data FROM companion_published_dependency_nodes WHERE node_key=?').get(nodeKey) as { data: string };
  const value = JSON.parse(stored.data) as { indexVersion?: number; assetOwners?: string[] };
  if (kind === 'old-version') { delete value.indexVersion; delete value.assetOwners; }
  if (kind === 'missing') delete value.assetOwners;
  if (kind === 'empty') value.assetOwners = [];
  if (kind === 'unsorted') value.assetOwners = ['bob', 'alice'];
  if (kind === 'duplicate') value.assetOwners = ['alice', 'alice', 'bob'];
  if (kind === 'invalid') value.assetOwners = ['alice', 'bad/owner'];
  if (kind === 'omitted-foreign') value.assetOwners = ['alice'];
  // Simulate an obsolete/internal corrupt derived row, not an external grant:
  // ordinary external writes are separately rejected by the private writer.
  h.db.function('companion_published_index_writing', { deterministic: false }, () => '1');
  h.db.prepare('UPDATE companion_published_dependency_nodes SET data=? WHERE node_key=?').run(JSON.stringify(value), nodeKey);
  initializePublishedDependencyIndex(h.db); expect(readPublishedDependencyCut(h.db, h.own.id)).toBeUndefined();
  if (kind === 'old-version') { expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, h.ownCertificate)).immediate()).toBe(true); expect(readPublishedDependencyCut(h.db, h.own.id)?.assetOwners).toEqual(['alice', 'bob']); }
});

async function legacyFrontier(bindMainActions = true) {
  const h = await fixture();
  const actions = ['第一项实际任务', '第二项实际任务'].map((title, index) => {
    const action = h.f.store.request({ type: 'action.create', action: { ...h.f.scope, sourceMessageId: h.source.id, title, status: 'queued' },
      checkpoint: { prompt: title, executionReadset: h.readset } }).action!;
    h.f.store.request({ type: 'action.update', id: action.id, patch: index ? { status: 'succeeded', result: '真实已存储的成功结果。' } : { status: 'failed', error: '真实已存储的失败。' } });
    const message = h.f.store.messages({ conversationId: h.f.scope.conversationId }).messages.find(message => message.actionId === action.id)!;
    expect(message).toBeDefined(); return { action: h.f.store.getAction(action.id), message };
  });
  const proof = structuredClone(h.readset); proof.sources = actions.map(({ message }) => ({ id: message.id, conversationId: message.conversationId, checksum: hash(message.content) }));
  const parent = h.append('两项实际工具结果都已被正式发言引用。', proof);
  const observed = h.f.store.request({ type: 'execution.sources', sourceMessageIds: [parent.id] }).executionSources!;
  const candidate = observed.find(value => value.id === parent.id)!.publicationCandidate!;
  const certificate = bindMainActions ? h.certify(parent.id) : h.f.store.request({ type: 'execution.message.certify',
    messages: [{ ...candidate, mode: 'revalidated_historical' }] }).messagePublicationCertificates![0]!;
  return { ...h, actions, parent, parentCertificate: certificate, proof };
}

it('cuts ordinary message ancestry while retaining two distinct exact legacy DSH Main obligations', async () => {
  const h = await legacyFrontier(), before = h.generation();
  let previous = h.parent;
  for (let index = 0; index < 12; index++) {
    const proof = structuredClone(h.readset); proof.sources = [{ id: previous.id, conversationId: previous.conversationId, checksum: hash(previous.content) }];
    previous = h.append('普通聊天延续 ' + index, proof); h.certify(previous.id);
    const cut = readPublishedDependencyCut(h.db, previous.id)!;
    expect(cut.volatileActions.map(action => action.id).sort()).toEqual(h.actions.map(({ action }) => action.id).sort());
    for (const obligation of cut.volatileActions) expect(readPublishedActionDependencyCut(h.db, obligation.id)).toMatchObject({ binding: obligation.actionBindingHash, readset: h.readset });
    expect(h.generation()).toBe(before);
  }
  const reads = observeReads(h);
  expect(readPublishedDependencyCut(h.db, previous.id)?.volatileActions).toHaveLength(2);
  expect(reads.mock.calls.length).toBeLessThanOrEqual(8); expect(reads.mock.calls.some(([sql]) => /FROM actions|task-checkpoint|WITH RECURSIVE/u.test(sql))).toBe(false);
  reads.mockRestore();
});

it('materializes each exact legacy action once for thirty-nine roots while preserving every root association and mutable wire isolation', async () => {
  const h = await legacyFrontier(), roots = [h.parent.id];
  for (let index = 0; index < 38; index++) {
    const message = h.append('各个实际发布根仍独立拥有相同两项执行义务 ' + index, plainReadset('alice', h.f.scope.conversationId,
      [{ id: h.parent.id, conversationId: h.parent.conversationId, checksum: hash(h.parent.content) }]));
    h.certify(message.id); roots.push(message.id);
  }
  const actionIds = new Set(h.actions.map(({ action }) => action.id)), clone = vi.spyOn(globalThis, 'structuredClone');
  let proofs: NonNullable<ReturnType<typeof h.f.store.request>['executionSources']>;
  try {
    proofs = h.f.store.request({ type: 'execution.sources', sourceMessageIds: roots }).executionSources!;
    const materialized = clone.mock.calls.flatMap(([value]) => value && typeof value === 'object' && 'id' in value
      && actionIds.has(String(value.id)) && ('readset' in value || 'executionReadset' in value) ? [String(value.id)] : []);
    expect(materialized.sort()).toEqual([...actionIds].sort());
    expect(proofs).toHaveLength(41);
    for (const action of proofs.filter(proof => proof.kind === 'action')) {
      expect([...action.sourceMessageIds].sort()).toEqual([...roots].sort());
      expect(action.executionReadset).toEqual(h.readset);
    }
    for (const message of proofs.filter(proof => proof.kind === 'message'))
      expect(message.publishedDependencyCut?.volatileActions.map(action => action.id).sort()).toEqual([...actionIds].sort());
  } finally { clone.mockRestore(); }
  const action = proofs.find(proof => proof.kind === 'action')!, message = proofs.find(proof => proof.kind === 'message')!;
  action.executionReadset!.complete = false; message.executionReadset!.complete = false;
  action.sourceMessageIds.length = 0; message.publishedDependencyCut!.assetOwners.length = 0;
  const fresh = h.f.store.request({ type: 'execution.sources', sourceMessageIds: roots }).executionSources!;
  expect(fresh.every(proof => proof.executionReadset?.complete)).toBe(true);
  expect(fresh.filter(proof => proof.kind === 'action').every(proof => proof.sourceMessageIds.length === 39)).toBe(true);
  expect(fresh.filter(proof => proof.kind === 'message').every(proof => proof.publishedDependencyCut?.assetOwners.includes('alice'))).toBe(true);
});

it('shares only immutable physical descriptions while keeping external expected bytes, active paths and public copies independent', async () => {
  const h = await legacyFrontier(), sources = new CompanionSourceAccess(h.db, id => h.f.store.getMessage(id)); sources.enablePublishedDependencyCuts();
  withPublishedDependencyReadWindow(h.db, () => {
    const observed = observePublishedDependencyCut(h.db, h.parent.id, h.proof)!, action = observePublishedActionDependencyCut(h.db, h.actions[0]!.action.id)!;
    expect(Object.isFrozen(observed.readset)).toBe(true); expect(Object.isFrozen(observed.readset.contexts)).toBe(true);
    expect(observed.typedReadsetDigest).toBe(hash(JSON.stringify(observed.readset)));
    expect(action.readsetDigest).toBe(hash(canonical(h.readset)));
    expect(() => { observed.readset.complete = false; }).toThrow();
    expect(sources.validatedMessageReadsetDigest(h.parent.id, observed.readset)).toBe(observed.typedReadsetDigest);
    const reordered = Object.fromEntries(Object.entries(h.proof).reverse()) as CompanionExecutionReadset;
    expect(observePublishedDependencyCut(h.db, h.parent.id, reordered)).toBeDefined();
    expect(sources.validatedMessageReadsetDigest(h.parent.id, reordered)).toBeUndefined();
    expect(observePublishedDependencyCut(h.db, h.parent.id, { ...h.proof, complete: false })).toBeUndefined();
    expect(observePublishedDependencyCut(h.db, h.parent.id, undefined, new Set(['action:' + action.id]))).toBeUndefined();
    expect(observePublishedActionDependencyCut(h.db, action.id, undefined, new Set(['action:' + action.id]))).toBeUndefined();
    const outward = readPublishedDependencyCut(h.db, h.parent.id)!; outward.readset.complete = false; outward.assetOwners.length = 0;
    expect(observePublishedDependencyCut(h.db, h.parent.id)?.readset).toBe(observed.readset);
    expect(observed.readset.complete).toBe(true); expect(observed.assetOwners).toEqual(['alice']);
    const clone = vi.spyOn(globalThis, 'structuredClone').mockImplementation(() => { throw new Error('Injected projection clone failure'); });
    try {
      expect(readPublishedDependencyCut(h.db, h.parent.id)).toBeUndefined();
      expect(readPublishedActionDependencyCut(h.db, action.id)).toBeUndefined();
      expect(observePublishedDependencyCut(h.db, h.parent.id)).toBeDefined();
    } finally { clone.mockRestore(); }
  });
});

it('keeps an old v1 certificate without Main action pins on the full path until a real bounded read supplies the exact frontier', async () => {
  const h = await legacyFrontier(false);
  expect(readPublishedMessageActionPins(h.db, h.parentCertificate)).toBeUndefined();
  expect(readPublishedDependencyCut(h.db, h.parent.id)).toBeUndefined();
  expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, h.parentCertificate)).immediate()).toBe(false);
  maintainPublishedDependencyIndex(h.db);
  expect(readPublishedMessageActionPins(h.db, h.parentCertificate)).toBeUndefined();
  expect(readPublishedDependencyCut(h.db, h.parent.id)).toBeUndefined();
  expect(readPublishedActionDependencyCut(h.db, h.actions[0]!.action.id)).toBeUndefined();
  expect(await h.f.live.validate('alice', h.receipts)).toBe(true);
  const certificate = h.certify(h.parent.id);
  expect(readPublishedMessageActionPins(h.db, certificate)).toHaveLength(2);
  expect(readPublishedDependencyCut(h.db, h.parent.id)?.volatileActions).toHaveLength(2);
});

it('refuses to first-pin an action result changed after the supplied real Main observation', async () => {
  const h = await legacyFrontier(false), observed = h.f.store.request({ type: 'execution.sources', sourceMessageIds: [h.parent.id] }).executionSources!;
  const candidate = observed.find(value => value.id === h.parent.id)!.publicationCandidate!;
  const bindings = observed.flatMap(proof => proof.storageActionBinding ? [proof.storageActionBinding] : []);
  expect(bindings).toHaveLength(2);
  h.external.prepare("UPDATE actions SET data=json_set(data,'$.error','Main观察后被改写的结果') WHERE id=?").run(h.actions[0]!.action.id);
  expect(() => h.f.store.request({ type: 'execution.message.certify', messages: [{ ...candidate, mode: 'revalidated_historical' }], actionBindings: bindings })).toThrow('Main');
  expect(readPublishedMessageActionPins(h.db, h.parentCertificate)).toBeUndefined(); expect(readPublishedDependencyCut(h.db, h.parent.id)).toBeUndefined();
});

it('never silently moves an existing immutable Main frontier pin to a newer terminal result', async () => {
  const h = await legacyFrontier(), original = readPublishedMessageActionPins(h.db, h.parentCertificate);
  h.external.prepare("UPDATE actions SET data=json_set(data,'$.error','同一旧发言不得自动采用的新结果') WHERE id=?").run(h.actions[0]!.action.id);
  const observed = h.f.store.request({ type: 'execution.sources', sourceMessageIds: [h.parent.id] }).executionSources!;
  const candidate = observed.find(value => value.id === h.parent.id)!.publicationCandidate!;
  h.f.store.request({ type: 'execution.message.certify', messages: [{ ...candidate, mode: 'revalidated_historical' }], actionBindings: observed.flatMap(proof => proof.storageActionBinding ? [proof.storageActionBinding] : []) });
  expect(readPublishedMessageActionPins(h.db, h.parentCertificate)).toEqual(original);
  expect(readPublishedDependencyCut(h.db, h.parent.id)).toBeUndefined();
});

it.each(['delete', 'update'] as const)('withdraws the SQL cut immediately after external Main frontier pin %s', async change => {
  const h = await legacyFrontier(), before = h.generation();
  if (change === 'delete') h.external.prepare('DELETE FROM companion_message_publication_action_pins WHERE message_id=?').run(h.parent.id);
  else h.external.prepare("UPDATE companion_message_publication_action_pins SET data=json_set(data,'$[0].actionBindingHash',?) WHERE message_id=?").run('0'.repeat(64), h.parent.id);
  expect(h.generation()).toBeGreaterThan(before); expect(readPublishedDependencyCut(h.db, h.parent.id)).toBeUndefined();
  expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, h.parentCertificate)).immediate()).toBe(false);
  const retainedPins = h.db.prepare('SELECT * FROM companion_message_publication_action_pins WHERE message_id=?').all(h.parent.id);
  maintainPublishedDependencyIndex(h.db);
  expect(readPublishedDependencyCut(h.db, h.parent.id)).toBeUndefined();
  expect(h.db.prepare('SELECT * FROM companion_message_publication_action_pins WHERE message_id=?').all(h.parent.id)).toEqual(retainedPins);
});

it.each(['result', 'checkpoint', 'status', 'grant', 'capability', 'thought', 'source', 'action-message-proof'] as const)('invalidates a folded message when its exact action %s authority changes', async kind => {
  const h = await legacyFrontier(), action = h.actions[0]!.action, before = h.generation();
  if (kind === 'checkpoint') h.external.prepare("UPDATE metadata SET value=json_set(value,'$.executionReadset.complete',json('false')) WHERE key=?").run('task-checkpoint/' + action.id);
  if (kind === 'result') h.external.prepare("UPDATE actions SET data=json_set(data,'$.error','已被改写的失败事实') WHERE id=?").run(action.id);
  if (kind === 'status') h.external.prepare("UPDATE actions SET status='running',data=json_set(data,'$.status','running') WHERE id=?").run(action.id);
  if (kind === 'grant') h.external.prepare("UPDATE actions SET data=json_set(data,'$.authorizationGrantId','new_unverified_grant') WHERE id=?").run(action.id);
  if (kind === 'capability') h.external.prepare("UPDATE actions SET data=json_set(data,'$.capability',json('{}')) WHERE id=?").run(action.id);
  if (kind === 'thought') h.external.prepare("UPDATE actions SET data=json_set(data,'$.thought',json('true')) WHERE id=?").run(action.id);
  if (kind === 'source') h.external.prepare('INSERT INTO vcp_source_blocks VALUES(?,?,?)').run(h.source.id, 'alice', new Date().toISOString());
  if (kind === 'action-message-proof') h.external.prepare('INSERT INTO metadata VALUES(?,?)').run('message-execution-readset/' + h.actions[0]!.message.id, JSON.stringify(h.readset));
  expect(h.generation()).toBeGreaterThan(before); expect(readPublishedDependencyCut(h.db, h.parent.id)).toBeUndefined(); expect(readPublishedActionDependencyCut(h.db, action.id)).toBeUndefined();
  expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, h.parentCertificate)).immediate()).toBe(false);
});

it.each(['insert', 'rebind'] as const)('does not hide an extra message proof when an action card is later %s', async operation => {
  const h = await legacyFrontier(), action = h.actions[0]!.action, pins = readPublishedMessageActionPins(h.db, h.parentCertificate);
  let id: string;
  if (operation === 'insert') {
    id = 'late_card_' + action.id;
    h.external.prepare('INSERT INTO messages(id,conversation_id,author_id,kind,content,created_at,status,action_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, h.f.scope.conversationId, 'alice', 'action', '结果卡另有一份准确输入证明。', new Date().toISOString(), 'sent', action.id);
  } else {
    const spare = h.f.source('原本不属于这个任务的实际记录。'); id = spare.id;
    h.external.prepare('UPDATE messages SET author_id=?,kind=?,action_id=? WHERE id=?').run('alice', 'action', action.id, id);
  }
  h.external.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('message-execution-readset/' + id, JSON.stringify(h.readset));
  expect(readPublishedDependencyCut(h.db, h.parent.id)).toBeUndefined(); expect(readPublishedActionDependencyCut(h.db, action.id)).toBeUndefined();
  expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, h.parentCertificate)).immediate()).toBe(false);
  expect(readPublishedMessageActionPins(h.db, h.parentCertificate)).toEqual(pins);
});

it('does not hide an active action cycle behind an ordinary published-message cut or discard its original proof', async () => {
  const h = await legacyFrontier(), id = h.actions[0]!.action.id;
  expect(readPublishedDependencyCut(h.db, h.parent.id, h.proof, new Set(['action:' + id]))).toBeUndefined();
  expect(readPublishedActionDependencyCut(h.db, id, h.readset, new Set(['action:' + id]))).toBeUndefined();
  expect(readPublishedDependencyCut(h.db, h.parent.id, h.proof, new Set(['message:' + h.parent.id]))).toBeUndefined();
  expect(h.f.store.checkpoint(id)?.executionReadset).toEqual(h.readset);
  expect(readPublishedDependencyCut(h.db, h.parent.id)?.volatileActions).toHaveLength(2);
});

it('ignores terminal action log/progress saves while preserving its unchanged SQL inputs and Main frontier', async () => {
  const h = await legacyFrontier(), id = h.actions[0]!.action.id, before = h.generation();
  h.external.prepare("UPDATE actions SET data=json_set(data,'$.stage','仅进度变化','$.events',json('[]')) WHERE id=?").run(id);
  h.external.prepare("UPDATE metadata SET value=json_set(value,'$.execution.progress','仅运行日志') WHERE key=?").run('task-checkpoint/' + id);
  expect(h.generation()).toBe(before); expect(readPublishedDependencyCut(h.db, h.parent.id)?.volatileActions).toHaveLength(2);
});

it.each(['source-artifact', 'edge-index', 'permission', 'extra-reference'] as const)('rechecks the registered historical closure after external SQL %s mutation', async kind => {
  const h = await fixture(), before = h.generation();
  const historyId = `history:${h.note.id}:r${h.note.contentRevision}`, sourceId = `source:${h.source.id}:r${h.source.revision ?? 1}`;
  if (kind === 'source-artifact') h.external.prepare("UPDATE companion_artifacts SET state='revoked',metadata=json_set(metadata,'$.publicationState','revoked') WHERE owner_id=? AND artifact_id=?").run('alice', sourceId);
  if (kind === 'edge-index') h.external.prepare('DELETE FROM companion_artifact_edges WHERE owner_id=? AND target_id=?').run('alice', historyId);
  if (kind === 'permission') h.external.prepare("UPDATE companion_artifacts SET metadata=json_set(metadata,'$.allowedConsumers',json('[\"source_verification\"]')) WHERE owner_id=? AND artifact_id=?").run('alice', sourceId);
  if (kind === 'extra-reference') h.external.prepare("UPDATE companion_artifacts SET metadata=json_set(metadata,'$.dependencyRefs',json(?)) WHERE owner_id=? AND artifact_id=?")
    .run(JSON.stringify([{ artifactId: 'unverified_learning_grant', contentRevision: 1, contentHash: '1'.repeat(64) }]), 'alice', historyId);
  expect(h.generation()).toBeGreaterThan(before); expect(readPublishedDependencyCut(h.db, h.message.id)).toBeUndefined();
  expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, h.certificate)).immediate()).toBe(false);
});

it('refuses an ordinary certified root when one of its ancestors still needs a knowledge or other Main authority gate', async () => {
  const h = await fixture(), proof = structuredClone(h.readset);
  proof.knowledgeReads = [{ id: 'cold_message_' + '1'.repeat(48), version: '1'.repeat(64), sourceType: 'message', sourceId: h.source.id,
    sourceVersion: `1:${hash(h.source.content)}`, sourceDigest: hash(h.source.content), conversationId: h.f.scope.conversationId }];
  const ancestor = h.append('这条发言仍有独立知识读取门。', proof);
  const candidate = h.f.store.request({ type: 'execution.sources', sourceMessageIds: [ancestor.id] }).executionSources!.find(value => value.id === ancestor.id)!.publicationCandidate!;
  const certificate = h.f.store.request({ type: 'execution.message.certify', messages: [{ ...candidate, mode: 'revalidated_historical' }] }).messagePublicationCertificates![0]!;
  expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, certificate)).immediate()).toBe(false);
  const childProof = structuredClone(h.readset); childProof.sources = [{ id: ancestor.id, conversationId: h.f.scope.conversationId, checksum: hash(ancestor.content) }];
  const child = h.append('不得借普通子节点隐藏祖先的知识授权。', childProof);
  const childCandidate = h.f.store.request({ type: 'execution.sources', sourceMessageIds: [child.id] }).executionSources!.find(value => value.id === child.id)!.publicationCandidate!;
  const childCertificate = h.f.store.request({ type: 'execution.message.certify', messages: [{ ...childCandidate, mode: 'revalidated_historical' }] }).messagePublicationCertificates![0]!;
  expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, childCertificate)).immediate()).toBe(false);
  expect(readPublishedDependencyCut(h.db, child.id)).toBeUndefined();
});

it('shares parsed publication tuples in one nested synchronous read window without sharing expected-readset or active-path eligibility', async () => {
  const h = await legacyFrontier(), reads = observeReads(h), action = h.actions[0]!.action;
  try {
    withPublishedDependencyReadWindow(h.db, () => {
      expect(readPublishedDependencyCut(h.db, h.parent.id, h.proof)).toBeDefined();
      expect(readPublishedActionDependencyCut(h.db, action.id, h.readset)).toBeDefined();
      withPublishedDependencyReadWindow(h.db, () => {
        expect(readPublishedDependencyCut(h.db, h.parent.id, h.proof)).toBeDefined();
        expect(readPublishedActionFrontier(h.db, action.id, h.readset)).toBeDefined();
      });
      expect(readPublishedDependencyCut(h.db, h.parent.id, { ...h.proof, complete: false })).toBeUndefined();
      expect(readPublishedActionDependencyCut(h.db, action.id, { ...h.readset, complete: false })).toBeUndefined();
      expect(readPublishedDependencyCut(h.db, h.parent.id, h.proof, new Set(['message:' + h.parent.id]))).toBeUndefined();
      expect(readPublishedDependencyCut(h.db, h.parent.id, h.proof, new Set(['action:' + action.id]))).toBeUndefined();
      expect(readPublishedDependencyCut(h.db, h.parent.id, h.proof, new Set(['message:' + h.message.id]))).toBeUndefined();
      expect(readPublishedActionDependencyCut(h.db, action.id, h.readset, new Set(['action:' + action.id]))).toBeUndefined();
      expect(readPublishedDependencyCut(h.db, h.parent.id, h.proof)).toBeDefined();
    });
    expect(reads.mock.calls.filter(([sql]) => sql === 'SELECT * FROM messages WHERE id=?')).toHaveLength(1);
    expect(reads.mock.calls.filter(([sql]) => sql.includes(' AS data FROM actions WHERE id=?'))).toHaveLength(1);
    expect(reads.mock.calls.filter(([sql]) => sql.includes(' AS proof,') && sql.includes('FROM metadata'))).toHaveLength(1);
    expect(reads.mock.calls.filter(([sql]) => sql.startsWith('SELECT * FROM companion_published_dependency_nodes'))).toHaveLength(2);
    expect(reads.mock.calls.filter(([sql]) => sql.startsWith('SELECT target_kind AS kind'))).toHaveLength(2);
  } finally { reads.mockRestore(); }
});

it('does not let mutable cut results alter cached SQL readsets, certificates or live obligation lists', async () => {
  const h = await legacyFrontier(), action = h.actions[0]!.action;
  withPublishedDependencyReadWindow(h.db, () => {
    const first = readPublishedDependencyCut(h.db, h.parent.id, h.proof)!;
    first.readset.complete = false; first.certificate.bodySHA = '0'.repeat(64); first.assetOwners.length = 0;
    first.volatileActions[0]!.actionBindingHash = '0'.repeat(64);
    expect(readPublishedDependencyCut(h.db, h.parent.id, h.proof)).toMatchObject({ certificate: h.parentCertificate, readset: h.proof, assetOwners: ['alice'] });
    const oldAction = readPublishedActionDependencyCut(h.db, action.id, h.readset)!;
    oldAction.readset.complete = false; oldAction.assetOwners.length = 0;
    expect(readPublishedActionDependencyCut(h.db, action.id, h.readset)).toMatchObject({ readset: h.readset, assetOwners: ['alice'] });
  });
});

it.each(['same-connection', 'other-connection'] as const)('drops cached SQL tuples after an otherwise unrelated %s mutation', async where => {
  const h = await fixture(), reads = observeReads(h), generation = h.generation();
  try {
    withPublishedDependencyReadWindow(h.db, () => {
      expect(readPublishedDependencyCut(h.db, h.message.id, h.readset)).toBeDefined();
      const writer = where === 'same-connection' ? h.db : h.external;
      writer.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('unrelated-read-window-marker', '1');
      expect(h.generation()).toBe(generation);
      expect(readPublishedDependencyCut(h.db, h.message.id, h.readset)).toBeDefined();
    });
    expect(reads.mock.calls.filter(([sql]) => sql === 'SELECT * FROM messages WHERE id=?')).toHaveLength(2);
  } finally { reads.mockRestore(); }
});

it.each(['local-source', 'external-action', 'index-generation'] as const)('rejects current publication authority changed by %s inside the same read window', async kind => {
  const h = await legacyFrontier();
  withPublishedDependencyReadWindow(h.db, () => {
    expect(readPublishedDependencyCut(h.db, h.parent.id, h.proof)).toBeDefined();
    expect(readPublishedActionDependencyCut(h.db, h.actions[0]!.action.id, h.readset)).toBeDefined();
    if (kind === 'local-source') h.db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('真实来源已改写。', h.source.id);
    if (kind === 'external-action') h.external.prepare("UPDATE actions SET data=json_set(data,'$.error','已改变的实际结果') WHERE id=?").run(h.actions[0]!.action.id);
    if (kind === 'index-generation') h.db.prepare('UPDATE companion_published_authority_generation SET generation=generation+1 WHERE id=1').run();
    expect(readPublishedDependencyCut(h.db, h.parent.id, h.proof)).toBeUndefined();
    expect(readPublishedActionDependencyCut(h.db, h.actions[0]!.action.id, h.readset)).toBeUndefined();
  });
});

it('rereads publication tuples for the next command, after exceptions and after an asynchronous continuation', async () => {
  const h = await fixture(), reads = observeReads(h);
  try {
    expect(() => withPublishedDependencyReadWindow(h.db, () => {
      expect(readPublishedDependencyCut(h.db, h.message.id)).toBeDefined(); throw new Error('end this command');
    })).toThrow('end this command');
    withPublishedDependencyReadWindow(h.db, () => expect(readPublishedDependencyCut(h.db, h.message.id)).toBeDefined());
    await withPublishedDependencyReadWindow(h.db, async () => {
      expect(readPublishedDependencyCut(h.db, h.message.id)).toBeDefined();
      await Promise.resolve();
      expect(readPublishedDependencyCut(h.db, h.message.id)).toBeDefined();
    });
    expect(reads.mock.calls.filter(([sql]) => sql === 'SELECT * FROM messages WHERE id=?')).toHaveLength(4);
  } finally { reads.mockRestore(); }
});

async function checkpointFixture() {
  const h = await fixture(), topicId = h.f.store.getMessage(h.source.id).topicId!;
  const first = h.f.store.request({ type: 'topic.update', readerId: 'alice', conversationId: h.f.scope.conversationId, topicId,
    expectedRevision: h.f.store.request({ type: 'topic.read', readerId: 'alice', conversationId: h.f.scope.conversationId, topicId }).topic!.revision,
    patch: { workingState: { summary: '第一个正式检查点。', sourceMessageIds: [h.source.id] } } }).topicState!.workingState!;
  const secondSource = h.f.source('这批后续真实来源也进入检查点。');
  const second = h.f.store.request({ type: 'topic.update', readerId: 'alice', conversationId: h.f.scope.conversationId, topicId, maintenance: true,
    expectedRevision: h.f.store.request({ type: 'topic.read', readerId: 'alice', conversationId: h.f.scope.conversationId, topicId }).topic!.revision,
    patch: { workingState: { summary: '按原宿主协议整合上一检查点。', sourceMessageIds: [secondSource.id] } },
    compaction: { previousWorkingEventId: first.sourceEventId, sharedEventId: null, sourceChecksums: { [secondSource.id]: hash(secondSource.content) } } }).topicState!.workingState!;
  expect(second.derivedFromEventIds).toEqual([first.sourceEventId]);
  const proof = structuredClone(h.readset);
  proof.topics = [{ topicId, conversationId: h.f.scope.conversationId, checkpointEventIds: [second.sourceEventId], sourceMessageIds: [secondSource.id] }];
  const message = h.append('基于实际primary discussion压缩检查点的正式回答。', proof), certificate = h.certify(message.id);
  const sourceRow = () => h.db.prepare('SELECT * FROM messages WHERE id=?').get(message.id) as Record<string, string | number | null>;
  return { ...h, topicId, first, second, secondSource, topicProof: proof, topicMessage: message, topicCertificate: certificate, sourceRow };
}

it('indexes a primary checkpoint with the actual compaction DAG and leaves later unrelated checkpoint updates independent', async () => {
  const h = await checkpointFixture(), before = h.generation();
  expect(readPublishedDependencyCut(h.db, h.topicMessage.id)?.readset).toEqual(h.topicProof);
  expect(currentPublishedSourceCutValid(h.db, h.sourceRow())).toBe(true);
  const edges = h.db.prepare("SELECT target_key FROM companion_published_dependency_edges WHERE parent_key=? AND target_kind='topic-event'")
    .all(canonical(['message', h.topicMessage.id])) as Array<{ target_key: string }>;
  expect(edges.map(value => value.target_key).sort()).toEqual([h.first.sourceEventId, h.second.sourceEventId].sort());
  h.f.store.request({ type: 'topic.update', readerId: 'alice', conversationId: h.f.scope.conversationId, topicId: h.topicId,
    expectedRevision: h.f.store.request({ type: 'topic.read', readerId: 'alice', conversationId: h.f.scope.conversationId, topicId: h.topicId }).topic!.revision,
    patch: { workingState: { summary: '之后另一次显式设置，不改写原检查点。', sourceMessageIds: [] } } });
  expect(h.generation()).toBe(before); expect(readPublishedDependencyCut(h.db, h.topicMessage.id)).toBeDefined();
  expect(currentPublishedSourceCutValid(h.db, h.sourceRow())).toBe(true);
});

it.each(['event-delete', 'event-content', 'event-reader', 'event-id', 'event-ordinal', 'checkpoint-state', 'checkpoint-owner-block', 'source-edit', 'source-forget', 'topic-deleted', 'membership'] as const)(
  'invalidates every primary checkpoint cut after an external %s authority change', async change => {
    const h = await checkpointFixture(), before = h.generation(), db = h.external;
    if (change === 'event-delete') db.prepare('DELETE FROM companion_topic_events WHERE id=?').run(h.first.sourceEventId);
    if (change === 'event-content') db.prepare("UPDATE companion_topic_events SET data=json_set(data,'$.summary','改写祖先检查点') WHERE id=?").run(h.first.sourceEventId);
    if (change === 'event-reader') db.prepare('UPDATE companion_topic_events SET reader_id=? WHERE id=?').run('bob', h.first.sourceEventId);
    if (change === 'event-id') db.prepare('UPDATE companion_topic_events SET id=? WHERE id=?').run('changed_checkpoint_id', h.first.sourceEventId);
    if (change === 'event-ordinal') db.prepare('UPDATE companion_topic_events SET rowid=rowid+10000 WHERE id=?').run(h.second.sourceEventId);
    if (change === 'checkpoint-state') db.prepare("UPDATE companion_topic_checkpoint_nodes SET state='event_changed' WHERE event_id=?").run(h.first.sourceEventId);
    if (change === 'checkpoint-owner-block') db.prepare('INSERT INTO companion_topic_checkpoint_owner_blocks VALUES(?,?)').run('alice', h.first.sourceEventId);
    if (change === 'source-edit') db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('改写原始正文。', h.source.id);
    if (change === 'source-forget') db.prepare('INSERT INTO vcp_source_blocks VALUES(?,?,?)').run(h.secondSource.id, 'alice', new Date().toISOString());
    if (change === 'topic-deleted') db.prepare("UPDATE companion_topics SET data=json_set(data,'$.deletedAt','withdrawn') WHERE id=?").run(h.topicId);
    if (change === 'membership') db.prepare('DELETE FROM conversation_members WHERE companion_id=? AND conversation_id=?').run('alice', h.f.scope.conversationId);
    expect(h.generation()).toBeGreaterThan(before);
    expect(readPublishedDependencyCut(h.db, h.topicMessage.id)).toBeUndefined();
    expect(currentPublishedSourceCutValid(h.db, h.sourceRow())).toBe(false);
    expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, h.topicCertificate)).immediate()).toBe(false);
  });

it('keeps a primary checkpoint reader without original observations on the full shared-checkpoint ACL path', async () => {
  const h = await checkpointFixture();
  h.external.prepare('DELETE FROM vcp_source_observers WHERE message_id=? AND companion_id=?').run(h.secondSource.id, 'alice');
  expect(h.f.store.request({ type: 'topic.sources.valid', readerId: 'alice', conversationId: h.f.scope.conversationId, topicId: h.topicId,
    sourceMessageIds: [h.secondSource.id], checkpointEventIds: [h.second.sourceEventId] }).topicSourcesValid).toBe(true);
  expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, h.topicCertificate)).immediate()).toBe(false);
  expect(readPublishedDependencyCut(h.db, h.topicMessage.id)).toBeUndefined();
  expect(currentPublishedSourceCutValid(h.db, h.sourceRow())).toBe(false);
  expect(h.f.store.request({ type: 'memory.sources.filter', ...h.f.scope, ids: [h.secondSource.id] }).memorySources).toEqual([]);
});

it.each(['self-cycle', 'forward-parent', 'unlisted-checksum', 'wrong-source-event', 'wrong-reader'] as const)(
  'does not build a primary checkpoint index with %s in its immutable DAG', async corruption => {
    const h = await checkpointFixture(), db = h.external;
    if (corruption === 'self-cycle') db.prepare("UPDATE companion_topic_events SET data=json_set(data,'$.derivedFromEventIds',json(?)) WHERE id=?").run(JSON.stringify([h.second.sourceEventId]), h.second.sourceEventId);
    if (corruption === 'forward-parent') db.prepare('UPDATE companion_topic_events SET rowid=rowid+10000 WHERE id=?').run(h.first.sourceEventId);
    if (corruption === 'unlisted-checksum') db.prepare("UPDATE companion_topic_events SET data=json_set(data,'$.sourceChecksums.not_a_real_source',?) WHERE id=?").run('0'.repeat(64), h.second.sourceEventId);
    if (corruption === 'wrong-source-event') db.prepare("UPDATE companion_topic_events SET data=json_set(data,'$.sourceEventId','unrelated_event') WHERE id=?").run(h.second.sourceEventId);
    if (corruption === 'wrong-reader') db.prepare('UPDATE companion_topic_events SET reader_id=? WHERE id=?').run('bob', h.second.sourceEventId);
    expect(h.f.store.request({ type: 'topic.sources.valid', readerId: 'alice', conversationId: h.f.scope.conversationId, topicId: h.topicId,
      sourceMessageIds: [h.secondSource.id], checkpointEventIds: [h.second.sourceEventId] }).topicSourcesValid).toBe(false);
    expect(h.db.transaction(() => certifyPublishedDependencyNode(h.db, h.topicCertificate)).immediate()).toBe(false);
  });

it('reads the formal publication projection without reading historical readset JSON and preserves all active frontier checks', async () => {
  const h = await legacyFrontier(), row = h.db.prepare('SELECT * FROM messages WHERE id=?').get(h.parent.id) as Record<string, string | number | null>;
  const reads = observeReads(h);
  expect(currentPublishedSourceCutValid(h.db, row)).toBe(true);
  expect(reads.mock.calls.some(([sql]) => /FROM metadata/u.test(sql))).toBe(false);
  for (const field of ['content', 'author_id', 'conversation_id', 'sequence', 'revision', 'status', 'kind', 'action_id', 'reply_to_id', 'request_fingerprint'] as const)
    expect(currentPublishedSourceCutValid(h.db, { ...row, [field]: field === 'revision' || field === 'sequence' ? Number(row[field]) + 1 : 'detached_old_value' })).toBe(false);
  expect(currentPublishedSourceCutValid(h.db, row, new Set(['message:' + h.parent.id]))).toBe(false);
  expect(currentPublishedSourceCutValid(h.db, row, new Set(['message:' + h.message.id]))).toBe(false);
  expect(currentPublishedSourceCutValid(h.db, row, new Set(['action:' + h.actions[0]!.action.id]))).toBe(false);
  expect(currentPublishedSourceCutValid(h.db, row)).toBe(true); reads.mockRestore();
});

it.each(['readset-bytes', 'pin-delete', 'certificate', 'body', 'revision'] as const)(
  'freshly rejects the formal publication projection after external %s changes', async change => {
    const h = await legacyFrontier(), row = h.db.prepare('SELECT * FROM messages WHERE id=?').get(h.parent.id) as Record<string, string | number | null>;
    expect(currentPublishedSourceCutValid(h.db, row)).toBe(true);
    if (change === 'readset-bytes') h.external.prepare("UPDATE metadata SET value=json_set(value,'$.complete',json('false')) WHERE key=?").run('message-execution-readset/' + h.parent.id);
    if (change === 'pin-delete') h.external.prepare('DELETE FROM companion_message_publication_action_pins WHERE message_id=?').run(h.parent.id);
    if (change === 'certificate') h.external.prepare("UPDATE companion_message_publication_certificates SET data=json_set(data,'$.bodySHA',?) WHERE message_id=?").run('0'.repeat(64), h.parent.id);
    if (change === 'body') h.external.prepare('UPDATE messages SET content=? WHERE id=?').run('同一ID被改写。', h.parent.id);
    if (change === 'revision') h.external.prepare('UPDATE messages SET revision=revision+1 WHERE id=?').run(h.parent.id);
    expect(currentPublishedSourceCutValid(h.db, row)).toBe(false);
  });

it.each(['missing-readset-edge', 'old-node', 'no-node'] as const)('does not let a certificate alone authorize the formal publication projection with %s', async change => {
  const h = await fixture(), row = h.db.prepare('SELECT * FROM messages WHERE id=?').get(h.message.id) as Record<string, string | number | null>, nodeKey = canonical(['message', h.message.id]);
  expect(currentPublishedSourceCutValid(h.db, row)).toBe(true);
  h.db.function('companion_published_index_writing', { deterministic: false }, () => '1');
  if (change === 'no-node') h.db.prepare('DELETE FROM companion_published_dependency_nodes WHERE node_key=?').run(nodeKey);
  else if (change === 'old-node') h.db.prepare("UPDATE companion_published_dependency_nodes SET data=json_set(data,'$.indexVersion',1) WHERE node_key=?").run(nodeKey);
  else {
    h.db.prepare("DELETE FROM companion_published_dependency_edges WHERE parent_key=? AND target_kind='metadata' AND target_key=?").run(nodeKey, 'message-execution-readset/' + h.message.id);
    const edges = h.db.prepare('SELECT target_kind AS kind,target_key AS key FROM companion_published_dependency_edges WHERE parent_key=? ORDER BY target_kind,target_key').all(nodeKey);
    h.db.prepare('UPDATE companion_published_dependency_nodes SET edges_hash=? WHERE node_key=?').run(hash(canonical(edges)), nodeKey);
  }
  expect(currentPublishedSourceCutValid(h.db, row)).toBe(false);
});

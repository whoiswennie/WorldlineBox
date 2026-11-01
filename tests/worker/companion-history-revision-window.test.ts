import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';
import { CompanionMemoryStore } from '../../src/companions/memory-store';
import { CompanionMemoryLedger } from '../../src/companions/memory-ledger';
import type { CompanionConnection } from '../../src/companions/store';
import type { CompanionMemory } from '../../src/shared/companions';
import type { CompanionSourceScope } from '../../src/companions/source-access';
import { companionSearchTokens, companionSearchFacet } from '../../src/shared/companion-search';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [], connections: CompanionConnection[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const db of connections.splice(0)) db.close(); for (const f of fixtures.splice(0)) await f.close(); });
async function fixture() {
  const f = managedMemoryFiles(); fixtures.push(f);
  const source = f.source('本次真实 SQL 历史验证的原始事实。');
  const notes: CompanionMemory[] = [];
  for (let index = 0; index < 6; index++) notes.push(f.record('准确的历史节点 ' + index, [source.id], index ? [notes[index - 1]!.id] : []));
  await f.publish();
  const db = new (BetterSqlite3 as { new(filename: string): CompanionConnection })(path.join(f.root, 'state.sqlite')); connections.push(db);
  db.function('companion_search_tokens', { deterministic: true }, companionSearchTokens); db.function('companion_search_facet', { deterministic: true }, companionSearchFacet);
  const memory = new CompanionMemoryStore(db, id => f.store.getMessage(id));
  const roots = [{ id: notes.at(-1)!.id, contentRevision: 1 }];
  const describe = () => memory.execute({ type: 'memory.revisions.describe', ...f.scope, roots })!;
  return { f, db, source, notes, memory, roots, describe };
}

it('walks shared historical SQL bodies once per descriptor command while preserving results and next-command freshness', async () => {
  const { f, notes, memory, describe } = await fixture();
  const expected = [...notes].reverse().map(note => memory.execute({ type: 'memory.revision.describe', ...f.scope, id: note.id, contentRevision: 1 })!.memoryHistoryDescriptor);
  const read = vi.spyOn(CompanionMemoryLedger.prototype, 'readBody');
  expect(describe().memoryHistoryDescriptors).toEqual(expected); expect(read).toHaveBeenCalledTimes(notes.length);
  expect(describe().memoryHistoryDescriptors).toEqual(expected); expect(read).toHaveBeenCalledTimes(notes.length * 2);
  read.mockClear();
  expect(memory.execute({ type: 'memory.revision.describe', ...f.scope, id: notes.at(-1)!.id, contentRevision: 1 })!.memoryHistoryDescriptor).toEqual(expected[0]);
  expect(read).toHaveBeenCalledTimes(notes.length);
  expect(memory.execute({ type: 'memory.revision.describe', ...f.scope, id: notes.at(-1)!.id, contentRevision: 1 })!.memoryHistoryDescriptor).toEqual(expected[0]);
  expect(read).toHaveBeenCalledTimes(notes.length * 2);
});

it('admits every root separately after a shared walk and binds exact owner, room and cursor', async () => {
  const { f, source, notes, memory } = await fixture(), later = f.source('更晚才出现的独立来源。');
  const late = f.record('晚于准确游标的独立历史节点。', [later.id]); await f.publish();
  const roots = [{ id: late.id, contentRevision: 1 }, { id: notes.at(-1)!.id, contentRevision: 1 }];
  expect(() => memory.execute({ type: 'memory.revisions.describe', ...f.scope, beforeSequence: source.sequence, roots })).toThrow('无权');
  expect(() => memory.execute({ type: 'memory.revisions.describe', companionId: 'bob', conversationId: f.store.openPrivate('bob').id, roots })).toThrow('无权');
  expect(() => memory.execute({ type: 'memory.revisions.describe', ...f.scope, conversationId: f.store.openPrivate('bob').id, roots })).toThrow('无权');
  expect(() => memory.execute({ type: 'memory.revisions.describe', ...f.scope, roots: [{ id: notes[0]!.id, contentRevision: 999 }] })).toThrow('无权');
});

it.each(['single', 'multiple'] as const)('drops completed physical results when a %s descriptor transaction changes before annotation projection', async mode => {
  const { f, db, source, notes, memory, describe } = await fixture();
  const original = Reflect.get(memory, 'project') as (note: CompanionMemory, scope: CompanionSourceScope) => CompanionMemory;
  let changed = false;
  Reflect.set(memory, 'project', function(this: CompanionMemoryStore, note: CompanionMemory, scope: CompanionSourceScope) {
    if (!changed) { changed = true; db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('事务中的准确来源已改变。', source.id); }
    return original.call(this, note, scope);
  });
  expect(() => mode === 'multiple' ? describe() : memory.execute({ type: 'memory.revision.describe', ...f.scope,
    id: notes.at(-1)!.id, contentRevision: 1 })).toThrow(mode === 'multiple' ? '无权' : '读取期间数据库已经变化'); expect(changed).toBe(true);
  expect(f.store.getMessage(source.id).content).toBe(source.content); // The failing describe transaction also rolls back this injected write.
});

it('rejects a real other-connection source edit and an explicit forget on the next independent SQL request', async () => {
  const { f, db, source, notes, memory, describe } = await fixture(); expect(describe().memoryHistoryDescriptors).toHaveLength(6);
  const single = () => memory.execute({ type: 'memory.revision.describe', ...f.scope, id: notes.at(-1)!.id, contentRevision: 1 });
  expect(single()!.memoryHistoryDescriptor?.id).toBe(notes.at(-1)!.id);
  db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('另一个连接提交了不同来源正文。', source.id);
  expect(() => f.store.request({ type: 'memory.revisions.describe', ...f.scope, roots: [{ id: notes.at(-1)!.id, contentRevision: 1 }] })).toThrow('无权');
  expect(() => describe()).toThrow('无权');
  expect(() => single()).toThrow('无权');
  f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [source.id], persistent: true }); expect(() => describe()).toThrow('无权');
  expect(() => single()).toThrow('无权');
});

it('rejects an earlier root changed during projection even when a later independent root can be freshly admitted', async () => {
  const { f, db, source, notes, memory } = await fixture();
  const independentSource = f.source('独立根仍然有权读取的原始事实。');
  const independent = f.record('本节点不依赖被修改的第一个根。', [independentSource.id]); await f.publish();
  const original = Reflect.get(memory, 'project') as (note: CompanionMemory, scope: CompanionSourceScope) => CompanionMemory;
  let changed = false, independentProjected = false;
  Reflect.set(memory, 'project', function(this: CompanionMemoryStore, note: CompanionMemory, scope: CompanionSourceScope) {
    if (note.id === notes[0]!.id && !changed) {
      changed = true; db.prepare('UPDATE messages SET content=?,revision=revision+1 WHERE id=?').run('第一个根的原始事实已改变。', source.id);
    }
    if (note.id === independent.id) independentProjected = true;
    return original.call(this, note, scope);
  });
  expect(() => memory.execute({ type: 'memory.revisions.describe', ...f.scope,
    roots: [{ id: independent.id, contentRevision: 1 }, { id: notes[0]!.id, contentRevision: 1 }] })).toThrow('读取期间数据库已经变化');
  expect(changed).toBe(true); expect(independentProjected).toBe(true);
  expect(f.store.getMessage(source.id).content).toBe(source.content);
});

it('keeps cached parsed bodies private when a same-window caller mutates its returned memory', async () => {
  const { f, notes, memory } = await fixture();
  const window = Reflect.get(memory, 'withRevisionReadWindow') as <T>(scope: CompanionSourceScope, operation: () => T) => T;
  const read = Reflect.get(memory, 'readRevision') as (scope: CompanionSourceScope, id: string, revision: number) => CompanionMemory;
  window.call(memory, f.scope, () => {
    const first = read.call(memory, f.scope, notes[0]!.id, 1); first.content = '不能污染私有缓存'; first.sources[0]!.checksum = '0'.repeat(64);
    const second = read.call(memory, f.scope, notes[0]!.id, 1);
    expect(second.content).toBe(notes[0]!.content); expect(second.sources).toEqual(notes[0]!.sources); expect(second).not.toBe(first);
  });
});

it('does not use a completed sibling to admit a cyclic historical dependency', async () => {
  const { f, db, notes, memory } = await fixture(), bad = notes.at(-1)!;
  db.prepare("UPDATE companion_memory_content_revisions SET data=json_set(data,'$.dependencies',json(?)) WHERE note_id=? AND content_revision=1")
    .run(JSON.stringify([{ id: bad.id, contentRevision: 1 }]), bad.id);
  expect(() => memory.execute({ type: 'memory.revisions.describe', ...f.scope,
    roots: [{ id: bad.id, contentRevision: 1 }, { id: notes[0]!.id, contentRevision: 1 }] })).toThrow('无权');
});

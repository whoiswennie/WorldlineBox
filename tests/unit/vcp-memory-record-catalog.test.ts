import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { VcpMemoryNote, VcpMemoryProjectionDescriptor, VcpMemoryProjectionInspection } from '../../src/main/vcp-memory/contracts';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';

type RecordData = VcpMemoryNote & { indexState: 'indexed'; recordedAt: string; rawPath?: string };
type Descriptor = { id: string; indexState: string; contentHash: string; contentBytes: number; noteFingerprint: string;
  hostProjection?: { timeZone: string }; metadata: { hostMemoryOwner?: object; hostMemoryVersion?: number; dream?: boolean } };
type Catalog = {
  size: number; set(id: string, record: RecordData): Catalog; get(id: string): Descriptor | undefined; delete(id: string): boolean; clear(): void;
  values(): IterableIterator<Descriptor>; read(id: string): Promise<RecordData | null>;
  cacheSnapshot(): { records: number; entries: number; bytes: number; maxEntries: number; maxBytes: number };
};
const require = createRequire(import.meta.url);
const { OwnedMemoryRecordCatalog } = require('../../src/main/vcp-memory/record-catalog.cjs') as {
  OwnedMemoryRecordCatalog: new(options: { recordPath(id: string): string; normalize(value: unknown): VcpMemoryNote; maxCachedRecords?: number; maxCacheBytes?: number }) => Catalog;
};
const { normalizeNote, renderNativeDiaryFileText, VcpMemoryRuntime } = require('../../src/main/vcp-memory/runtime.cjs') as {
  normalizeNote(input: unknown): VcpMemoryNote;
  renderNativeDiaryFileText(input: VcpMemoryNote): string;
  VcpMemoryRuntime: new() => { records: Catalog; recordsRoot: string; kb: unknown; notesRoot: string; requireReady(): void;
    peripherals: { invalidateCorpus(): void; close(): Promise<void> };
    notePaths: Map<string, string>; sourceIds: Map<string, string>; fileIds: Map<string, string>; bindNotePath(id: string, file: string): void;
    removeSources(files: string[]): Promise<void>; removeRecordNote(id: string): Promise<void>;
    paths(id: string): { record: string; note: string }; remember(note: VcpMemoryNote): Promise<unknown>; forget(id: string): Promise<unknown>;
    replace(notes: VcpMemoryNote[]): Promise<{ count: number }>; list(): Promise<VcpMemoryNote[]>; read(id: string): Promise<VcpMemoryNote | null>;
    inspectProjection(descriptors: VcpMemoryProjectionDescriptor[]): Promise<VcpMemoryProjectionInspection>;
    exportNotes(): Promise<VcpMemoryNote[]>; close(): Promise<void> };
};
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeOwnedDirectory(directory); });
async function root() { const directory = await mkdtemp(path.join(tmpdir(), 'worldline-record-catalog-')); directories.push(directory); return directory; }
const record = (id: string, content = '完整合成正文', version = 1): RecordData => ({ id, content, tags: ['测试'], diaryName: '资料', author: 'Alice',
  hostProjection: { timeZone: 'Asia/Shanghai' }, indexState: 'indexed', recordedAt: '2026-10-26T00:00:00Z',
  metadata: { hostMemoryOwner: { version: 2, companionId: 'alice', name: 'Alice', agentName: 'Alice' }, hostMemoryVersion: version,
    customPayload: '任意用户metadata也必须按需读取' } });

it('keeps the corpus directory body-free and enforces both cache budgets across large records and a restart', async () => {
  const directory = await root(), file = (id: string) => path.join(directory, id + '.json');
  let catalog = new OwnedMemoryRecordCatalog({ recordPath: file, normalize: normalizeNote });
  const count = 200, text = 'large-owned-record-body-sentinel-'.repeat(2000).slice(0, 60_000);
  for (let index = 0; index < count; index++) {
    const value = record(`record_${index}`, `${index}:${text}`);
    await writeFile(file(value.id), JSON.stringify(value)); catalog.set(value.id, value);
    expect(catalog.cacheSnapshot().bytes).toBeLessThanOrEqual(catalog.cacheSnapshot().maxBytes);
    expect(catalog.cacheSnapshot().entries).toBeLessThanOrEqual(catalog.cacheSnapshot().maxEntries);
  }
  const initial = catalog.cacheSnapshot(), descriptors = [...catalog.values()];
  expect(initial.records).toBe(count); expect(initial.entries).toBeGreaterThan(0); expect(initial.entries).toBeLessThan(count);
  expect(JSON.stringify(descriptors)).not.toContain('large-owned-record-body-sentinel');
  expect(JSON.stringify(descriptors)).not.toContain('customPayload');
  expect(descriptors.every(value => !('content' in value))).toBe(true);
  catalog.clear(); expect(catalog.cacheSnapshot()).toMatchObject({ records: 0, entries: 0, bytes: 0 });
  catalog = new OwnedMemoryRecordCatalog({ recordPath: file, normalize: normalizeNote });
  for (const entry of await readdir(directory)) { const value = JSON.parse(await readFile(path.join(directory, entry), 'utf8')) as RecordData; catalog.set(value.id, value); }
  expect((await catalog.read('record_0'))?.content).toBe(`0:${text}`);
  const afterRestart = catalog.cacheSnapshot();
  expect(afterRestart.records).toBe(count); expect(afterRestart.bytes).toBeLessThanOrEqual(initial.maxBytes);
  expect(afterRestart.entries).toBeLessThanOrEqual(initial.maxEntries);
  const output = path.resolve('artifacts/vcp-validation/runtime-record-catalog-pressure.json');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ syntheticFixtureOnly: true, realUserDataModified: false, records: count,
    fixtureBodyCharacters: count * text.length, descriptorCharacters: JSON.stringify(descriptors).length,
    initial, afterRestart, fullTextStoredInDirectory: false, arbitraryMetadataStoredInDirectory: false }, null, 2));
});

it('accounts arbitrary metadata in the body budget and returns fresh objects after bounded-cache reads', async () => {
  const directory = await root(), file = path.join(directory, 'one.json');
  const catalog = new OwnedMemoryRecordCatalog({ recordPath: () => file, normalize: normalizeNote, maxCachedRecords: 2, maxCacheBytes: 2048 });
  const large = record('one'); large.metadata = { ...large.metadata, customPayload: 'large metadata'.repeat(10_000) };
  await writeFile(file, JSON.stringify(large)); catalog.set('one', large);
  expect(catalog.cacheSnapshot()).toMatchObject({ records: 1, entries: 0, bytes: 0 });
  expect(catalog.get('one')?.metadata).toEqual({ hostMemoryOwner: large.metadata.hostMemoryOwner, hostMemoryVersion: 1 });
  expect((await catalog.read('one'))?.metadata?.customPayload).toBe(large.metadata.customPayload);
  expect(catalog.cacheSnapshot().bytes).toBe(0);
  const small = record('one', 'small'); await writeFile(file, JSON.stringify(small)); catalog.set('one', small);
  const first = await catalog.read('one'); first!.content = 'caller mutation';
  expect((await catalog.read('one'))?.content).toBe('small');
  catalog.delete('one'); expect(catalog.cacheSnapshot()).toMatchObject({ records: 0, entries: 0, bytes: 0 });
  expect(await catalog.read('one')).toBeNull();
});

it('rejects changed disk provenance after eviction instead of returning a catalog entry as a complete note', async () => {
  const directory = await root(), file = path.join(directory, 'one.json');
  const catalog = new OwnedMemoryRecordCatalog({ recordPath: () => file, normalize: normalizeNote, maxCachedRecords: 0 });
  const original = record('one'); await writeFile(file, JSON.stringify(original)); catalog.set('one', original);
  await writeFile(file, JSON.stringify(record('one', 'uncommitted replacement', 2)));
  await expect(catalog.read('one')).rejects.toThrow('outside its catalog transaction');
  await rm(file); expect(await catalog.read('one')).toBeNull();
});

it('removes path-directory entries as well as cached bodies when an indexed record is deleted', async () => {
  const directory = await root(), runtime = new VcpMemoryRuntime();
  runtime.recordsRoot = directory; runtime.notesRoot = path.join(directory, 'notes');
  const value = record('one'); await writeFile(runtime.paths('one').record, JSON.stringify(value));
  runtime.records.set('one', value); runtime.bindNotePath('one', path.join(runtime.notesRoot, 'owned.md'));
  const remove = vi.spyOn(runtime, 'removeSources').mockResolvedValue();
  await runtime.removeRecordNote('one');
  expect(remove).toHaveBeenCalledOnce();
  expect(runtime.records.cacheSnapshot()).toMatchObject({ records: 0, entries: 0, bytes: 0 });
  expect(runtime.notePaths.size).toBe(0); expect(runtime.sourceIds.size).toBe(0); expect(runtime.fileIds.size).toBe(0);
  await runtime.close();
});

it('performs frequent replacement, deletion, list/export and close without hydrating unchanged records for comparisons', async () => {
  const directory = await root(), runtime = new VcpMemoryRuntime();
  runtime.recordsRoot = directory; runtime.notesRoot = path.join(directory, 'notes');
  runtime.requireReady = () => undefined;
  runtime.kb = { shutdown: async () => undefined, nativeKnowledgeRuntime: { listIndexedFilePaths: async () => [] } };
  const remember = vi.spyOn(runtime, 'remember').mockImplementation(async note => {
    const value = { ...note, indexState: 'indexed' as const, recordedAt: '2026-10-26T00:00:00Z' };
    await writeFile(runtime.paths(note.id).record, JSON.stringify(value)); runtime.records.set(note.id, value);
  });
  const forget = vi.spyOn(runtime, 'forget').mockImplementation(async id => { runtime.records.delete(id); await rm(runtime.paths(id).record, { force: true }); });
  const read = vi.spyOn(runtime.records, 'read');
  let first = normalizeNote(record('one', 'first original')), second = normalizeNote(record('two', 'second original'));
  await runtime.replace([first, second]); expect(remember).toHaveBeenCalledTimes(2);
  await runtime.replace([first, second]); expect(remember).toHaveBeenCalledTimes(2); expect(read).not.toHaveBeenCalled();
  for (let version = 2; version < 12; version++) {
    first = normalizeNote(record('one', `first revised ${version}`, version));
    await runtime.replace([first, second]);
  }
  expect(remember).toHaveBeenCalledTimes(12); expect(read).not.toHaveBeenCalled();
  await runtime.replace([first]); expect(forget).toHaveBeenCalledExactlyOnceWith('two');
  expect(await runtime.read('one')).toMatchObject({ content: 'first revised 11', metadata: { customPayload: '任意用户metadata也必须按需读取', hostMemoryVersion: 11 } });
  expect(await runtime.list()).toEqual([first]);
  expect((await runtime.exportNotes())[0]).toMatchObject({ id: 'one', metadata: { customPayload: '任意用户metadata也必须按需读取' } });
  second = normalizeNote(record('two', 'second restored', 2)); await runtime.replace([first, second]);
  expect(await runtime.read('two')).toMatchObject({ content: 'second restored' });
  await runtime.close(); expect(runtime.records.cacheSnapshot()).toMatchObject({ records: 0, entries: 0, bytes: 0 });
});

it('inspects restored native records against exact host hashes and canonical annotations, with affected-only repair', async () => {
  const directory = await root(), runtime = new VcpMemoryRuntime();
  runtime.recordsRoot = directory; runtime.notesRoot = path.join(directory, 'notes'); runtime.requireReady = () => undefined;
  runtime.peripherals = { invalidateCorpus: () => undefined, close: async () => undefined };
  await mkdir(path.join(runtime.notesRoot, 'memories'), { recursive: true });
  runtime.kb = { shutdown: async () => undefined, nativeKnowledgeRuntime: {
    listIndexedFilePaths: async () => [...runtime.notePaths.values()].map(file => path.relative(runtime.notesRoot, file)) } };
  vi.spyOn(runtime, 'removeSources').mockResolvedValue();
  const first = normalizeNote({ ...record('first'), occurredAt: '2026-10-26T00:00:00Z' }), second = normalizeNote({ ...record('second'), occurredAt: '2026-10-26T00:00:00Z' });
  for (const note of [first, second]) {
    const rawPath = `memories/${note.id}.md`, file = path.join(runtime.notesRoot, rawPath);
    const stored = { ...note, rawPath, recordedAt: note.occurredAt!, indexState: 'indexed' as const };
    await writeFile(file, renderNativeDiaryFileText(note)); await writeFile(runtime.paths(note.id).record, JSON.stringify(stored));
    runtime.records.set(note.id, stored); runtime.bindNotePath(note.id, file);
  }
  const descriptors = [first, second].map(note => { const { content, ...annotations } = note;
    return { id: note.id, contentHash: createHash('sha256').update(content).digest('hex'), annotations }; });
  const remember = vi.spyOn(runtime, 'remember');
  expect(await runtime.inspectProjection(descriptors)).toEqual({ upsertIds: [], removedIds: [], reused: 2 });
  expect(remember).not.toHaveBeenCalled();
  await writeFile(runtime.paths('first').note, 'UNTRUSTED_DERIVED_BYTES');
  expect(await runtime.inspectProjection(descriptors)).toEqual({ upsertIds: ['first'], removedIds: [], reused: 1 });
  expect(runtime.records.get('first')).toBeUndefined(); expect(runtime.records.get('second')).toBeDefined();
  expect(await runtime.inspectProjection([])).toMatchObject({ upsertIds: [], removedIds: ['second'], reused: 0 });
  expect(runtime.records.size).toBe(0); await runtime.close();
});

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { companionMemorySourceArtifactId, companionMemorySourceFilePath } from '../../src/main/companions/memory-source-files';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
function fixture() { const f = managedMemoryFiles(); fixtures.push(f); const source = f.source('ACTUAL_RAW_SOURCE_摘要没有保留的条件、否定和细节。'), note = f.record('只是原文的短摘要。', [source.id]), reference = note.sources[0]!;
  return Object.assign(f, { sourceMessage: source, note, reference, sourceFile: f.file(companionMemorySourceFilePath({ sourceId: source.id, sourceRevision: reference.revision, sourceChecksum: reference.checksum })) }); }
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });

it('publishes the exact immutable host original under a typed identity without learning its directory or trusting sidecars', async () => {
  const f = fixture(); expect(await f.sources.flush('alice')).toMatchObject({ completed: 1, pending: false }); expect(readFileSync(f.sourceFile, 'utf8')).toBe(f.sourceMessage.content);
  const artifact = await (await f.artifacts('alice')).get(companionMemorySourceArtifactId(f.sourceMessage.id, 1)); expect(artifact).toMatchObject({ kind: 'source_evidence', contentHash: f.reference.checksum, allowedConsumers: ['source_verification', 'audit'] });
  const publicCommand = { type: 'memory.revision.read' as const, ...f.scope, id: f.note.id, contentRevision: 1 };
  expect(existsSync(f.sourceFile + '.meta.json')).toBe(false); expect(await f.sources.read(publicCommand, f.reference)).toBe(f.sourceMessage.content);
  const before = f.store.listMemory('alice').length; await f.library.sync(); expect(f.store.listMemory('alice')).toHaveLength(before); expect((await f.sources.flush('alice')).completed).toBe(0);
  await expect(f.sources.read({ companionId: 'bob', conversationId: f.store.openPrivate('bob').id }, f.reference)).rejects.toThrow();
});
it('withdraws only the exact registered source file through the durable outbox and does not scan another owner', async () => {
  const f = fixture(); await f.sources.flush('alice'); f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.sourceMessage.id] }); f.commands.length = 0;
  expect(await f.sources.flush('alice')).toMatchObject({ completed: 1 }); expect(existsSync(f.sourceFile)).toBe(false); await expect(f.sources.read(f.scope, f.reference)).rejects.toThrow();
  expect(f.commands.filter(command => 'companionId' in command && command.companionId).every(command => !('companionId' in command) || command.companionId === 'alice')).toBe(true);
});
it('rechecks the SQL lease after registry publication and removes exact bytes when authorization changes before acknowledgment', async () => {
  const f = fixture(); f.intercept(command => { if (command.type === 'memory.sources.outbox.complete') { f.intercept(); f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.sourceMessage.id] }); } });
  await f.sources.flush('alice'); expect(existsSync(f.sourceFile)).toBe(false); await expect(f.sources.read(f.scope, f.reference)).rejects.toThrow();
});
it('rejects edited or missing raw copies without falling back to SQL or manufacturing another source', async () => {
  const f = fixture(); await f.sources.flush('alice'); writeFileSync(f.sourceFile, 'FORGED_UNKNOWN_BYTES'); await expect(f.sources.read(f.scope, f.reference)).rejects.toThrow();
  expect(f.store.getMessage(f.sourceMessage.id).content).toBe(f.sourceMessage.content); await f.library.sync(); expect(readFileSync(f.sourceFile, 'utf8')).toBe('FORGED_UNKNOWN_BYTES');
  unlinkSync(f.sourceFile); f.restart(); await expect(f.sources.read(f.scope, f.reference)).rejects.toThrow(); expect(existsSync(f.sourceFile)).toBe(false);
});
it('does not delete unknown external bytes during source withdrawal, while immediately revoking their authority', async () => {
  const f = fixture(); await f.sources.flush('alice'); writeFileSync(f.sourceFile, 'UNKNOWN_EXTERNAL_REPLACEMENT'); f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.sourceMessage.id] });
  expect(await f.sources.flush('alice')).toMatchObject({ failed: 1, completed: 0 }); expect(readFileSync(f.sourceFile, 'utf8')).toBe('UNKNOWN_EXTERNAL_REPLACEMENT'); await expect(f.sources.read(f.scope, f.reference)).rejects.toThrow();
});
it('publishes and retracts for inactive owners without parsing or recreating a missing persona', async () => {
  const f = fixture(); f.store.request({ type: 'companion.set-active', id: 'alice', active: false }); expect(await f.sources.flushPending(f.request)).toMatchObject({ owners: 1, completed: 1 });
  writeFileSync(f.file('profile.md'), 'malformed profile cannot suspend source withdrawal'); f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [f.sourceMessage.id] });
  expect(await f.sources.flushPending(f.request)).toMatchObject({ owners: 1, completed: 1 }); expect(existsSync(f.sourceFile)).toBe(false); expect(readFileSync(f.file('profile.md'), 'utf8')).toBe('malformed profile cannot suspend source withdrawal');
});
it('recovers an outstanding claimed source publication when its isolated SQLite process reopens', async () => {
  const f = fixture(), claimed = f.store.request({ type: 'memory.sources.outbox.claim', companionId: 'alice', leaseMs: 600000 }).memorySourceOutbox!; expect(claimed.operation).toBe('publish');
  f.restart(); expect(await f.sources.flushPending(f.request)).toMatchObject({ owners: 1, completed: 1 }); expect(readFileSync(f.sourceFile, 'utf8')).toBe(f.sourceMessage.content);
  expect(() => f.store.request({ type: 'memory.sources.outbox.complete', id: claimed.id, leaseToken: claimed.leaseToken })).toThrow('租约');
});

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

const fixtures: ReturnType<typeof managedMemoryFiles>[] = [];
const fixture = () => { const f = managedMemoryFiles(); fixtures.push(f); return f; };
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });

it('never recreates a missing registered namespace through sync, reads, preparation or restart', async () => {
  const f = fixture(), note = f.record('文件缺失不能通过SQL重造。'); await f.publish();
  const owner = path.join(f.directory, 'alice'); if (path.dirname(owner) !== f.directory) throw new Error('Unsafe owned fixture path'); await removeOwnedDirectory(owner); f.restart();
  expect((await f.library.sync()).conflicts.some(conflict => conflict.companionId === 'alice')).toBe(true); await expect(f.live.materialize('alice', [note])).rejects.toThrow();
  await f.library.prepareOwnerFiles('alice'); await f.sources.flush('alice'); await f.history.flush('alice'); expect(existsSync(owner)).toBe(false); expect(existsSync(path.join(f.directory, 'bob'))).toBe(true);
});
it('does not discover unknown categories after restart and still withdraws sources when persona prose is malformed', async () => {
  const f = fixture(), source = f.source('稍后撤回的真实来源。'), note = f.record('有合法来源。', [source.id]); await f.publish();
  mkdirSync(f.file('资料'), { recursive: true }); writeFileSync(f.file('资料/unknown.md'), '复制的第一人称认识不产生新的认知权限。'); writeFileSync(f.file('profile.md'), 'broken profile'); f.restart();
  await f.library.sync(); expect(f.store.listMemory('alice')).toHaveLength(1); expect(f.store.listMemory('alice')[0]!.id).toBe(note.id);
  const sourceArtifact = await (await f.artifacts('alice')).get('source:' + source.id + ':r1'); f.store.request({ type: 'memory.forget', ...f.scope, sourceMessageIds: [source.id] }); await f.sources.flush('alice');
  expect(existsSync(f.file(sourceArtifact!.relativePath))).toBe(false); expect(readFileSync(f.file('profile.md'), 'utf8')).toBe('broken profile'); expect(readFileSync(f.file('资料/unknown.md'), 'utf8')).toContain('复制的第一人称');
});

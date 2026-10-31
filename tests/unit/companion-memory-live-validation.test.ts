import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { managedMemoryFiles } from '../fixtures/managed-memory-files';

it('reads a shared exact source once per gate and reads it again at the next admission', async () => {
  const fixture = managedMemoryFiles();
  try {
    const source = fixture.source('两篇记忆共同引用的原始依据。');
    const notes = [fixture.record('第一篇认识。', [source.id]), fixture.record('第二篇认识。', [source.id])];
    await fixture.publish();
    fixture.commands.length = 0;
    const { receipts } = await fixture.live.materialize('alice', notes);
    const sourceReads = () => fixture.commands.filter(command => command.type === 'cognition.registry.read'
      && ('artifactId' in command && command.artifactId?.startsWith('source:')
        || 'artifactIds' in command && command.artifactIds?.some(id => id.startsWith('source:'))));
    // Initial and post-read metadata plus the finite gate's final fresh fence.
    expect(sourceReads()).toHaveLength(3);
    fixture.commands.length = 0;
    expect(await fixture.live.validate('alice', receipts)).toBe(true);
    expect(sourceReads()).toHaveLength(3);
    fixture.commands.length = 0;
    expect(await fixture.live.validate('alice', receipts)).toBe(true);
    expect(sourceReads()).toHaveLength(3);
  } finally { await fixture.close(); }
});

it('checks each current body and guarded note once per file gate, without dropping source reads', async () => {
  const fixture = managedMemoryFiles();
  try {
    const notes = [fixture.record('记得第一件事。'), fixture.record('记得第二件事。')];
    await fixture.publish();
    const { receipts } = await fixture.live.materialize('alice', notes);
    fixture.commands.length = 0;
    expect(await fixture.live.validate('alice', receipts)).toBe(true);
    expect(fixture.commands.filter(command => command.type === 'memory.library.read')).toHaveLength(0);
    expect(fixture.commands.filter(command => command.type === 'memory.records.filter')).toHaveLength(2);
    const bodies = fixture.commands.filter(command => command.type === 'cognition.registry.read' && 'artifactIds' in command
      && notes.every(note => command.artifactIds?.includes(`memory:${note.id}`)));
    expect(bodies).toHaveLength(4);
    expect(fixture.commands.filter(command => command.type === 'cognition.registry.read'
      && ('artifactId' in command && command.artifactId?.startsWith('source:')
        || 'artifactIds' in command && command.artifactIds?.some(id => id.startsWith('source:')))).length).toBeGreaterThanOrEqual(2);
  } finally { await fixture.close(); }
});

it('never reuses file authority across gates, including the same caller validation window', async () => {
  const fixture = managedMemoryFiles();
  try {
    const note = fixture.record('只采用正式提交的正文。');
    await fixture.publish();
    const { receipts } = await fixture.live.materialize('alice', [note]), window = {};
    expect(await fixture.live.validate('alice', receipts, window)).toBe(true);
    await writeFile(fixture.noteFile(note), '外部修改的正文。', 'utf8');
    expect(await fixture.live.validate('alice', receipts, window)).toBe(false);
  } finally { await fixture.close(); }
});

it('rejects a withdrawn source after a successful gate', async () => {
  const fixture = managedMemoryFiles();
  try {
    const note = fixture.record('有实际来源的旧事。');
    await fixture.publish();
    const { receipts } = await fixture.live.materialize('alice', [note]);
    expect(await fixture.live.validate('alice', receipts)).toBe(true);
    fixture.store.request({ type: 'memory.forget', ...fixture.scope, id: note.id });
    expect(await fixture.live.validate('alice', receipts)).toBe(false);
  } finally { await fixture.close(); }
});

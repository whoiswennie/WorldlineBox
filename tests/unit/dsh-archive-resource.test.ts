import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as disk from '../../src/main/dsh/disk';
import { writeSealedArchive, extractSealedArchive } from '../../src/main/dsh/archive';
import { removeManaged } from '../../src/main/dsh/files';
import { OperationStore } from '../../src/main/dsh/operations';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await removeManaged(tmpdir(), root); });
async function temporary() { const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-dsh-archive-resources-')); roots.push(root); return root; }

it('exports a large file count with one source handle and restores all files', async () => {
  const root = await temporary(); const data = path.join(root, 'data'); await mkdir(data);
  const count = 1200;
  for (let offset = 0; offset < count; offset += 32) await Promise.all(Array.from({ length: Math.min(32, count - offset) }, (_, i) => writeFile(path.join(data, `${String(offset + i).padStart(5, '0')}.py`), 'small dependency file\n')));
  const original = disk.readChunks; let active = 0; let peak = 0;
  vi.spyOn(disk, 'readChunks').mockImplementation(async function* (file, signal) {
    active++; peak = Math.max(peak, active);
    try { yield* original(file, signal); } finally { active--; }
  });
  const archive = path.join(root, 'backup.dshbackup');
  await writeSealedArchive(data, archive, { kind: 'resource-probe' });
  expect(peak).toBe(1); expect(active).toBe(0);
  const restored = path.join(root, 'restored');
  await extractSealedArchive(archive, restored);
  expect(await readdir(restored)).toHaveLength(count);
});

it('turns an input EMFILE into an operation failure and removes the partial archive', async () => {
  const root = await temporary(); const data = path.join(root, 'data'); await mkdir(data);
  await writeFile(path.join(data, 'client.py'), 'small source');
  vi.spyOn(disk, 'readChunks').mockImplementation(async function* () {
    yield Buffer.from('');
    throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
  });
  const operations = new OperationStore(path.join(root, 'operations'), () => undefined); await operations.init();
  const target = path.join(root, 'failed.dshbackup');
  await operations.run('backup.export', 'Input failure', undefined, async op => { await writeSealedArchive(data, target, { kind: 'failure-probe' }, op.signal); });
  await operations.settle();
  expect(operations.list()[0]?.status).toBe('failed');
  expect(operations.list()[0]?.error).toContain('EMFILE');
  expect((await readdir(root)).filter(name => name.includes('dshbackup'))).toEqual([]);
});

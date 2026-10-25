import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalRuntimeEntryPaths } from '../../src/main/dsh/runtime-paths';
import { removeManaged } from '../../src/main/dsh/files';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(os.tmpdir(), root); });

describe.skipIf(process.platform !== 'win32')('canonical runtime entry identity', () => {
  it('uses actual on-disk casing for the executable and ASAR CLI, including aliased parent folders', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-runtime-case-')); roots.push(root);
    const directory = path.join(root, 'MiXeDProgram'); await mkdir(directory);
    await mkdir(path.join(directory, 'bin'), { recursive: true }); await mkdir(path.join(directory, 'dsh/node_modules/@deepseek-ai/dsh/lib'), { recursive: true });
    await writeFile(path.join(directory, 'bin/node.exe'), 'fixture'); await writeFile(path.join(directory, 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'), '// fixture');
    const entry = canonicalRuntimeEntryPaths(directory.toUpperCase());
    expect(entry.executable).toBe(path.join(realpathSync.native(directory), 'bin/node.exe'));
    expect(entry.cli).toBe(path.join(realpathSync.native(directory), 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'));
    expect(entry.cli).toContain('MiXeDProgram');
  });
});

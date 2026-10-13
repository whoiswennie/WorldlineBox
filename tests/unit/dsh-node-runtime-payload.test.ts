import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { nodeRuntimePayloadSha256 } from '../../src/main/dsh/node-runtime-payload';
import { removeManaged } from '../../src/main/dsh/files';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(os.tmpdir(), root); });
describe('Portable Node payload identity', () => {
  it('ignores only the four generated metadata files and rejects different SDK code or binaries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-runtime-payload-')); roots.push(root);
    const put = async (relative: string, data: string) => { const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, data); };
    await put('bin/node.exe', 'pinned-node'); await put('dsh/node_modules/example/index.js', 'authentic-sdk-code'); await put('dsh/node_modules/example/package.json', '{"version":"1"}');
    const original = await nodeRuntimePayloadSha256(root);
    for (const file of ['node-runtime.json', 'dsh/package.json', 'dsh/package-lock.json', 'dsh/node_modules/.package-lock.json']) await put(file, 'generated on another machine');
    expect(await nodeRuntimePayloadSha256(root)).toBe(original);
    await put('dsh/node_modules/example/index.js', 'different-code-with-same-claimed-version'); expect(await nodeRuntimePayloadSha256(root)).not.toBe(original);
    await put('dsh/node_modules/example/index.js', 'authentic-sdk-code'); await put('bin/node.exe', 'different-node'); expect(await nodeRuntimePayloadSha256(root)).not.toBe(original);
    await put('bin/node.exe', 'pinned-node'); await put('dsh/node_modules/example/package.json', '{"version":"2"}'); expect(await nodeRuntimePayloadSha256(root)).not.toBe(original);
  });
});

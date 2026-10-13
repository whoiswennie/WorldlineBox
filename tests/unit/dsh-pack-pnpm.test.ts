import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installPackPnpmMetadata, sealPackPnpmMetadata, validatePackPnpmMetadata } from '../../src/main/dsh/pack-pnpm-metadata';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(metadata: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-pack-pnpm-')); roots.push(root);
  const file = path.join(root, 'home/profiles/custom-profile/node_modules/.modules.yaml');
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, metadata);
  return { root, file };
}
describe('portable pnpm layout metadata', () => {
  it('preserves JSON layout fields while replacing author paths and resolving the new profile paths', async () => {
    const { root, file } = await fixture(JSON.stringify({ storeDir: 'C:\\author\\cache\\store\\v11', virtualStoreDir: 'C:\\author\\home\\profiles\\custom-profile\\node_modules\\.pnpm',
      nodeLinker: 'hoisted', layoutVersion: 5, packageManager: 'pnpm@11.7.0', hoistedLocations: { example: ['node_modules/example'] } }));
    await sealPackPnpmMetadata(root); await validatePackPnpmMetadata(root);
    const portable = await readFile(file, 'utf8'); expect(portable).not.toContain('author');
    await installPackPnpmMetadata(root);
    const installed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(installed.storeDir).toBe(path.join(root, 'cache/pnpm-store/v11'));
    expect(installed.virtualStoreDir).toBe(path.join(path.dirname(file), '.pnpm'));
    expect(installed.packageManager).toBe('pnpm@11.7.0');
    expect(installed.hoistedLocations).toEqual({ example: ['node_modules/example'] });
  });
  it('supports an older YAML manifest and keeps its store-version suffix', async () => {
    const { root, file } = await fixture('storeDir: C:/author/cache/store/v3\nvirtualStoreDir: .pnpm\nlayoutVersion: 5\nnodeLinker: isolated\n');
    await sealPackPnpmMetadata(root); await installPackPnpmMetadata(root);
    expect(JSON.parse(await readFile(file, 'utf8')).storeDir).toBe(path.join(root, 'cache/pnpm-store/v3'));
  });
  it('rejects raw author paths during import and external custom virtual stores during export', async () => {
    const { root } = await fixture(JSON.stringify({ storeDir: 'C:/author/store/v11', virtualStoreDir: 'C:/shared/global-modules' }));
    await expect(validatePackPnpmMetadata(root)).rejects.toThrow('source-instance');
    await expect(sealPackPnpmMetadata(root)).rejects.toThrow('external virtual');
  });
});

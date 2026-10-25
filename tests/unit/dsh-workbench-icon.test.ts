import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NativeImage } from 'electron';

const icons = vi.hoisted(() => ({ fromPath: vi.fn(), fromBuffer: vi.fn(), fallback: vi.fn() }));
vi.mock('electron', () => ({ nativeImage: { createFromPath: icons.fromPath, createFromBuffer: icons.fromBuffer } }));
vi.mock('../../src/main/app-icon', () => ({ appIconImage: icons.fallback }));
import { resolveDshWorkbenchIcon } from '../../src/main/dsh/workbench-icon';

const roots: string[] = [];
function image(empty = false): NativeImage { return { isEmpty: () => empty } as NativeImage; }
async function temporary(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-workbench-icon-')); roots.push(root); return root;
}
async function writeIcon(root: string, relative: string, value: string | Buffer): Promise<string> {
  const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); return file;
}
beforeEach(() => {
  vi.resetAllMocks(); icons.fromPath.mockReturnValue(image(true)); icons.fromBuffer.mockReturnValue(image(true)); icons.fallback.mockReturnValue(image());
});
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const absolute = path.resolve(root);
    if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('worldlinebox-workbench-icon-')) throw new Error('Unexpected icon fixture directory.');
    await rm(absolute, { recursive: true, force: true });
  }
});

describe('selected DSH workbench icon', () => {
  it('reads each selected runtime icon independently and leaves the official file unchanged', async () => {
    const root = await temporary(); const a = path.join(root, 'version-a'); const b = path.join(root, 'version-b');
    const aIcon = await writeIcon(a, 'resources/icon.png', 'official-a');
    const bIcon = await writeIcon(b, 'resources/icon.png', 'official-b');
    const first = image(); const second = image();
    icons.fromPath.mockImplementation((file: string) => readFileSync(file, 'utf8') === 'official-a' ? first : second);
    expect(await resolveDshWorkbenchIcon(a)).toBe(first);
    expect(await resolveDshWorkbenchIcon(b)).toBe(second);
    expect(icons.fromPath.mock.calls.map(call => call[0])).toEqual([aIcon, bIcon]);
    expect(await readFile(aIcon, 'utf8')).toBe('official-a'); expect(await readFile(bIcon, 'utf8')).toBe('official-b');
    expect(icons.fallback).not.toHaveBeenCalled();
  });

  it('skips oversized images and can decode a version-specific Windows ICO by its real path', async () => {
    const root = await temporary(); await writeIcon(root, 'resources/icon.png', Buffer.alloc(4 * 1024 * 1024 + 1));
    const ico = await writeIcon(root, 'resources/icon.ico', 'official-ico'); const official = image();
    icons.fromPath.mockReturnValue(official);
    expect(await resolveDshWorkbenchIcon(root)).toBe(official);
    expect(icons.fromPath).toHaveBeenCalledExactlyOnceWith(ico);
  });

  it('rejects linked resource directories instead of decoding icons outside the runtime', async () => {
    const root = await temporary(); const program = path.join(root, 'program'); const outside = path.join(root, 'outside');
    await mkdir(program); await writeIcon(outside, 'icon.png', 'outside-image');
    await symlink(outside, path.join(program, 'resources'), process.platform === 'win32' ? 'junction' : 'dir');
    const fallback = image(); icons.fallback.mockReturnValue(fallback);
    expect(await resolveDshWorkbenchIcon(program)).toBe(fallback);
    expect(icons.fromPath).not.toHaveBeenCalled(); expect(icons.fromBuffer).not.toHaveBeenCalled();
  });

  it('uses the existing app-icon resolver and refuses an undefined Electron default icon', async () => {
    const root = await temporary(); const fallback = image(); icons.fallback.mockReturnValue(fallback);
    expect(await resolveDshWorkbenchIcon(root)).toBe(fallback);
    icons.fallback.mockReturnValue(undefined);
    await expect(resolveDshWorkbenchIcon(root)).rejects.toThrow('No DSH or WorldlineBox window icon');
  });
});

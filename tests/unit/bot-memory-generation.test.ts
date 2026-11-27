import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openNativeMemoryGeneration } from '../../src/main/companion-bot/memory-generation';

it('retires the old index while preserving new diaries and the companion database across restarts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-vcp-upgrade-'));
  try {
    const companion = path.join(root, 'companion-bot-v2'), old = path.join(companion, 'memory');
    await mkdir(old, { recursive: true });
    await writeFile(path.join(old, 'old.sqlite'), 'demo');
    const cache = path.join(companion, 'memory-encoder', 'capture-results');
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, 'old.json'), 'old capture');
    await writeFile(path.join(companion, 'bot.sqlite'), 'chat');
    const first = openNativeMemoryGeneration(root), next = first.root;
    await mkdir(next);
    await writeFile(path.join(next, 'journal.txt'), 'new diary');
    await first.retirement;
    await expect(readFile(path.join(old, 'old.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(cache, 'old.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, 'after-upgrade.json'), 'created after retirement');
    const second = openNativeMemoryGeneration(root);
    expect(second.root).toBe(next);
    await second.retirement;
    expect(await readFile(path.join(next, 'journal.txt'), 'utf8')).toBe('new diary');
    expect(await readFile(path.join(companion, 'bot.sqlite'), 'utf8')).toBe('chat');
    expect(await readFile(path.join(cache, 'after-upgrade.json'), 'utf8')).toBe('created after retirement');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('opens the live home immediately even when the legacy location cannot be retired', async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'wlb-vcp-busy-upgrade-'));
  try {
    const parent = path.join(profile, 'companion-bot-v2'), old = path.join(parent, 'memory');
    await mkdir(parent);
    await writeFile(old, 'unexpected non-directory');
    const generation = openNativeMemoryGeneration(profile);
    expect(generation.root).toBe(path.join(parent, 'vcp-memory-v5'));
    const retirement = expect(generation.retirement).rejects.toThrow('实体目录');
    await mkdir(generation.root);
    await writeFile(path.join(generation.root, 'live.txt'), 'new memory');
    await retirement;
    expect(await readFile(old, 'utf8')).toBe('unexpected non-directory');
    await rm(old);
    await mkdir(old);
    await writeFile(path.join(old, 'old.sqlite'), 'demo');
    await openNativeMemoryGeneration(profile).retirement;
    await expect(readFile(path.join(old, 'old.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(generation.root, 'live.txt'), 'utf8')).toBe('new memory');
  } finally { await rm(profile, { recursive: true, force: true }); }
});

const indexMarker = '.vcp-v5-legacy-memory-retired';
const workMarker = '.vcp-v5-legacy-work-retired';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function put(filename: string, value: string): Promise<string> {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(path.toNamespacedPath(filename), value);
  return filename;
}
async function receipt(directory: string, eventId: string): Promise<string> {
  return put(path.join(directory, hash(eventId) + '.json'), JSON.stringify({ eventId }));
}
async function missing(filename: string) {
  await expect(lstat(path.toNamespacedPath(filename))).rejects.toMatchObject({ code: 'ENOENT' });
}

it.each([false, true])('commits the work migration independently and preserves new or unowned files, prior index marker=%s', async migrated => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'wlb-work-migration-'));
  try {
    const companion = path.join(profile, 'companion-bot-v2');
    if (migrated) await put(path.join(companion, indexMarker), 'original receipt');
    const index = await put(path.join(companion, 'memory', 'index.sqlite'), 'old or recreated index');
    const captureWork = path.join(companion, 'memory-encoder', '.worldlinebox-brain');
    const planWork = path.join(companion, 'memory-maintenance', hash('audience'), 'maintenance-' + hash('task'), '.worldlinebox-brain');
    const reviewWork = path.join(companion, 'memory-review', hash('review'), '.worldlinebox-brain');
    const owned = await Promise.all([receipt(captureWork, 'capture-memory-a'), receipt(captureWork, 'capture-v3-memory-b'),
      receipt(planWork, 'memory-maintenance-event'), receipt(reviewWork, 'memory-review-event')]);
    const unowned = [
      await put(path.join(planWork, 'keep.txt'), 'user file'),
      await put(path.join(planWork, hash('wrong') + '.json'), '{"eventId":"memory-maintenance-other"}'),
      await receipt(planWork, 'chat-companion-message'),
      await put(path.join(companion, 'memory-review', 'my-unrelated-folder', 'draft.txt'), 'review notes'),
      await receipt(path.join(companion, 'workspaces', 'chat', '.worldlinebox-brain'), 'memory-maintenance-event'),
      await receipt(path.join(companion, 'vcp-maintenance-v2', 'reviews', hash('review'), '.worldlinebox-brain'), 'memory-review-event'),
      await put(path.join(companion, 'vcp-memory-v5', 'owner', 'dailynote', 'diary.txt'), '正式日记'),
      await put(path.join(companion, 'bot.sqlite'), '聊天数据库'),
    ];
    const contents = await Promise.all(unowned.map(filename => readFile(path.toNamespacedPath(filename), 'utf8')));
    const first = openNativeMemoryGeneration(profile);
    await Promise.all([first.retirement, openNativeMemoryGeneration(profile).retirement]);
    for (const filename of owned) await missing(filename);
    await missing(path.join(companion, 'memory-encoder'));
    expect(await readFile(path.join(companion, workMarker), 'utf8')).toBe('');
    if (migrated) {
      expect(await readFile(path.join(companion, indexMarker), 'utf8')).toBe('original receipt');
      expect(await readFile(index, 'utf8')).toBe('old or recreated index');
    } else {
      await missing(index);
      expect(await readFile(path.join(companion, indexMarker), 'utf8')).toBe('');
    }
    for (const [index, filename] of unowned.entries()) expect(await readFile(path.toNamespacedPath(filename), 'utf8')).toBe(contents[index]);
    const recreated = await receipt(captureWork, 'capture-memory-recreated');
    await openNativeMemoryGeneration(profile).retirement;
    expect(await readFile(recreated, 'utf8')).toContain('capture-memory-recreated');
  } finally { await rm(path.toNamespacedPath(profile), { recursive: true, force: true }); }
});

it('refuses to follow an old work junction and retries that stage without reopening the index migration', async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'wlb-work-junction-'));
  try {
    const profile = path.join(sandbox, 'profile'), companion = path.join(profile, 'companion-bot-v2');
    const encoder = path.join(companion, 'memory-encoder'), external = path.join(sandbox, 'other-profile');
    const externalReceipt = await receipt(external, 'capture-v3-memory-external');
    await mkdir(encoder, { recursive: true });
    const cache = path.join(encoder, '.worldlinebox-brain');
    await symlink(external, cache, 'junction');
    const review = await receipt(path.join(companion, 'memory-review', hash('r'), '.worldlinebox-brain'), 'memory-review-unlocked');
    await expect(openNativeMemoryGeneration(profile).retirement).rejects.toThrow('实体目录');
    expect(await readFile(externalReceipt, 'utf8')).toContain('capture-v3-memory-external');
    expect((await lstat(path.join(companion, indexMarker))).isFile()).toBe(true);
    await missing(path.join(companion, workMarker)); await missing(review);
    const index = await put(path.join(companion, 'memory', 'recreated.sqlite'), 'new');
    await rm(cache); // Unlink the fixture junction itself.
    const own = await receipt(cache, 'capture-v3-memory-owned');
    await openNativeMemoryGeneration(profile).retirement;
    await missing(own);
    expect((await lstat(path.join(companion, workMarker))).isFile()).toBe(true);
    expect(await readFile(index, 'utf8')).toBe('new');
    expect(await readFile(externalReceipt, 'utf8')).toContain('capture-v3-memory-external');
  } finally { await rm(path.toNamespacedPath(sandbox), { recursive: true, force: true }); }
});

import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionObservationArtifacts, type ObservationArtifactValidation, type SaveObservationArtifacts } from '../../src/main/companions/observation-artifacts';

const temporary: string[] = [];
afterEach(async () => {
  for (const target of temporary.splice(0)) {
    const absolute = path.resolve(target);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('observation-artifacts-unit-')) throw new Error('Unexpected temporary fixture root');
    await rm(absolute, { recursive: true, force: true });
  }
});
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'observation-artifacts-unit-')); temporary.push(root);
  const directory = path.join(root, 'observations'), outside = path.join(root, 'outside'); await mkdir(directory); await mkdir(outside);
  const picture = await sharp({ create: { width: 4, height: 3, channels: 4, background: '#246a89' } }).png().toBuffer();
  const scope = { owner: 'alice', runId: 'run-one', grantId: 'grant-one', grantRevision: 3 };
  const state = { active: true, hook: undefined as ((input: ObservationArtifactValidation) => void | Promise<void>) | undefined };
  const validate = vi.fn(async (input: ObservationArtifactValidation) => { if (!state.active) throw new Error('grant revoked'); await state.hook?.(input); });
  const options = { directory: () => directory, validate }, store = new CompanionObservationArtifacts(options);
  const input: SaveObservationArtifacts = { ...scope, source: { id: 'window:123:0', title: '编辑器', displayId: 'display-1' },
    startedAt: '2026-10-29T01:00:00.000Z', endedAt: '2026-10-29T01:00:02.000Z',
    clip: { bytes: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 10, 20, 30, 40]), mime: 'video/webm', durationMs: 2000, width: 4, height: 3 },
    frames: [{ bytes: picture, offsetMs: 0 }, { bytes: picture, offsetMs: 1500 }], storyboard: { bytes: picture, mime: 'image/png' } };
  return { root, directory, outside, scope, state, validate, options, store, input, picture };
}
async function replace(target: string, bytes: string | Uint8Array) { await chmod(target, 0o600); await writeFile(target, bytes); }

it('persists the actual clip/ordered frames/storyboard and reads the same pixels after a native store restart', async () => {
  const f = await fixture(), saved = await f.store.save(f.input);
  expect(saved.observationId).toMatch(/^[a-f0-9-]{36}$/u); expect(saved.clip.path).toBe(path.join(f.directory, saved.observationId, 'clip.webm'));
  expect(saved.frames.map(frame => [frame.offsetMs, frame.observedAt])).toEqual([[0, f.input.startedAt], [1500, '2026-10-29T01:00:01.500Z']]);
  expect(saved.clip.sha256).toBe(sha(f.input.clip.bytes)); expect(saved.storyboard.sha256).toBe(sha(f.picture));
  expect(await readFile(saved.clip.path)).toEqual(Buffer.from(f.input.clip.bytes));
  const read = await new CompanionObservationArtifacts(f.options).readForThought({ ...f.scope, observationId: saved.observationId, expectedManifestSha256: saved.manifest.sha256 });
  expect(read.storyboard.bytes).toEqual(f.picture); expect(read.storyboard).toMatchObject({ width: 4, height: 3, mime: 'image/png' });
  expect(read).not.toHaveProperty('memory'); expect(read).not.toHaveProperty('attachments');
  expect(f.validate).toHaveBeenCalledWith(expect.objectContaining({ phase: 'read.complete', source: f.input.source, grantRevision: 3 }));
});

it.each(['owner', 'runId', 'grantId', 'grantRevision'] as const)('does not read a recording under another %s', async field => {
  const f = await fixture(), saved = await f.store.save(f.input);
  const different = { ...f.scope, [field]: field === 'grantRevision' ? 4 : 'another' };
  await expect(f.store.readForThought({ ...different, observationId: saved.observationId })).rejects.toThrow('不属于当前执行');
});

it.each(['clip', 'frame', 'storyboard', 'manifest'] as const)('rejects changed %s bytes instead of returning cached old pixels', async kind => {
  const f = await fixture(), saved = await f.store.save(f.input);
  const target = kind === 'clip' ? saved.clip.path : kind === 'frame' ? saved.frames[0]!.path : kind === 'storyboard' ? saved.storyboard.path : saved.manifest.path;
  const bytes = await readFile(target); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; await replace(target, bytes);
  await expect(f.store.readForThought({ ...f.scope, observationId: saved.observationId })).rejects.toThrow(/哈希|清单|变化/u);
});

it('rejects a rewritten manifest even with a rewritten sibling seal and never accepts a model path', async () => {
  const f = await fixture(), saved = await f.store.save(f.input), body = JSON.parse(await readFile(saved.manifest.path, 'utf8'));
  body.storyboard.file = '../outside/secret.png'; const changed = JSON.stringify(body) + '\n';
  await replace(saved.manifest.path, changed); await replace(path.join(path.dirname(saved.manifest.path), 'manifest.sha256'), sha(Buffer.from(changed)) + '\n');
  await expect(f.store.readForThought({ ...f.scope, observationId: saved.observationId })).rejects.toThrow('清单哈希');
  await expect(f.store.readForThought({ ...f.scope, observationId: '../outside/secret.png' })).rejects.toThrow('标识无效');
  await expect(new CompanionObservationArtifacts(f.options).readForThought({ ...f.scope, observationId: saved.observationId })).rejects.toThrow('不属于当前执行');
});

it('pins the trusted root identity and refuses root/recording directory junctions', async () => {
  const f = await fixture(), saved = await f.store.save(f.input), record = path.dirname(saved.manifest.path), moved = path.join(f.directory, 'moved-recording');
  await rename(record, moved); await symlink(f.outside, record, 'junction');
  await expect(f.store.readForThought({ ...f.scope, observationId: saved.observationId })).rejects.toThrow('受管目录');
  const alias = path.join(f.root, 'alias'); await symlink(f.outside, alias, 'junction');
  const linked = new CompanionObservationArtifacts({ ...f.options, directory: () => alias });
  await expect(linked.save(f.input)).rejects.toThrow('根目录包含链接');
  await rename(f.directory, path.join(f.root, 'old-root')); await mkdir(f.directory);
  await expect(f.store.save(f.input)).rejects.toThrow('根目录身份已变化');
});

it('rejects file hard links and changes made during the final authority validation', async () => {
  const f = await fixture(), saved = await f.store.save(f.input);
  await link(saved.storyboard.path, path.join(f.outside, 'linked.png'));
  await expect(f.store.readForThought({ ...f.scope, observationId: saved.observationId })).rejects.toThrow('身份或长度');
  const g = await fixture(), receipt = await g.store.save(g.input);
  g.state.hook = async input => { if (input.phase === 'read.complete') await replace(receipt.storyboard.path, g.picture); };
  await expect(g.store.readForThought({ ...g.scope, observationId: receipt.observationId })).rejects.toThrow('思考能力前已变化');
});

it.each(['save.clip', 'save.frame', 'save.storyboard', 'save.commit'] as const)('cleans only this new recording if authorization is lost at %s', async phase => {
  const f = await fixture(); await writeFile(path.join(f.outside, 'keep.txt'), '外部文件应保留');
  f.state.hook = input => { if (input.phase === phase) throw new Error('grant revoked'); };
  await expect(f.store.save(f.input)).rejects.toThrow('grant revoked');
  expect(await readdir(f.directory)).toEqual([]); expect(await readFile(path.join(f.outside, 'keep.txt'), 'utf8')).toBe('外部文件应保留');
});

it('honors cancellation before creation and during save/read while withholding all model pixels', async () => {
  const f = await fixture(), cancelled = new AbortController(); cancelled.abort();
  await expect(f.store.save({ ...f.input, signal: cancelled.signal })).rejects.toThrow(); expect(await readdir(f.directory)).toEqual([]);
  const during = new AbortController(); f.state.hook = input => { if (input.phase === 'save.frame') during.abort(); };
  await expect(f.store.save({ ...f.input, signal: during.signal })).rejects.toThrow(); expect(await readdir(f.directory)).toEqual([]);
  f.state.hook = undefined; const saved = await f.store.save(f.input);
  f.state.active = false; await expect(f.store.readForThought({ ...f.scope, observationId: saved.observationId })).rejects.toThrow('grant revoked');
  f.state.active = true; const read = new AbortController(); f.state.hook = input => { if (input.phase === 'read.complete') read.abort(); };
  await expect(f.store.readForThought({ ...f.scope, observationId: saved.observationId, signal: read.signal })).rejects.toThrow();
});

it('rejects malformed timing and non-PNG images, and copies caller bytes before asynchronous validation', async () => {
  const f = await fixture();
  await expect(f.store.save({ ...f.input, frames: [{ bytes: f.picture, offsetMs: 1500 }, { bytes: f.picture, offsetMs: 500 }] })).rejects.toThrow('实际时序');
  await expect(f.store.save({ ...f.input, storyboard: { bytes: Buffer.from('not an image'), mime: 'image/png' } })).rejects.toThrow(); expect(await readdir(f.directory)).toEqual([]);
  const before = Buffer.from(f.input.clip.bytes); f.state.hook = input => { if (input.phase === 'save.prepare') f.input.clip.bytes.fill(0); };
  const saved = await f.store.save(f.input); expect(await readFile(saved.clip.path)).toEqual(before);
  await expect(f.store.readForThought({ ...f.scope, observationId: saved.observationId, expectedManifestSha256: '0'.repeat(64) })).rejects.toThrow('清单哈希');
});

it('checks the current authorization again after the final file verification before returning pixels', async () => {
  const f = await fixture(), saved = await f.store.save(f.input);
  f.state.hook = input => { if (input.phase === 'read.complete') f.state.active = false; };
  await expect(f.store.readForThought({ ...f.scope, observationId: saved.observationId })).rejects.toThrow('grant revoked');
});

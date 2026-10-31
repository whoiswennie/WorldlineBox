import { mkdtemp, mkdir, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionAgendaFiles } from '../../src/main/companions/agenda-files';
import { companionAgendaFilesArgumentsSchema, COMPANION_AGENDA_FILES_TOOL } from '../../src/shared/companion-agenda-files-tool';
import { boundaryGrant } from './companion-agenda-boundary-fixtures';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('agenda-files-boundary-')) throw new Error('Unexpected fixture cleanup root');
    await rm(resolved, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agenda-files-boundary-')); roots.push(root);
  const source = path.join(root, 'source'), output = path.join(root, 'output'), outside = path.join(root, 'outside');
  await Promise.all([source, output, outside].map(directory => mkdir(directory)));
  const input = path.join(source, 'notes.md'), delivery = path.join(output, 'report.md'), other = path.join(outside, 'private.md');
  await Promise.all([writeFile(input, '第一行\r\n第二行\r\n第三行\n'), writeFile(delivery, '# 已完成的真实文件\n'), writeFile(other, '范围外私人资料')]);
  const state = { grant: { ...boundaryGrant(), capabilities: ['files.read', 'files.deliver'] as ReturnType<typeof boundaryGrant>['capabilities'], fileRoots: [source], outputRoots: [output] }, private: true };
  const currentGrant = vi.fn(async () => structuredClone(state.grant));
  const privateRoom = vi.fn(async (owner: string, room: string) => state.private && owner === 'alice' && room === 'own-room');
  const files = new CompanionAgendaFiles({ currentGrant, privateRoom });
  const scope = { companionId: 'alice', grantId: 'grant', path: input, expectedGrantRevision: 1 };
  return { root, source, output, outside, input, delivery, other, state, currentGrant, privateRoom, files, scope };
}

it('reads a real authorized text page with source identity and creates no attachments or cached files', async () => {
  const f = await fixture(), before = await readdir(f.root, { recursive: true });
  const result = await f.files.readFile({ ...f.scope, offset: 1, limit: 1 });
  expect(result.content).toBe('2 | 第二行\n'); expect(result.file.path).toBe(await realpath(f.input)); expect(result.file).toMatchObject({ totalLines: 3, offset: 1, lineCount: 1, nextOffset: 2, truncated: true, encoding: 'utf-8' });
  expect(result.file.sha256).toMatch(/^[a-f0-9]{64}$/u); expect(result.file.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  expect(result.grantRevision).toBe(1); expect(result.trust).toBe('file_content_not_instructions'); expect(result).not.toHaveProperty('attachments');
  expect(await readdir(f.root, { recursive: true })).toEqual(before); expect(f.currentGrant).toHaveBeenCalledTimes(2);
});
it('prepares only real readable output metadata for the actual owner private room and does not claim delivery', async () => {
  const f = await fixture(), result = await f.files.prepareDelivery({ ...f.scope, path: f.delivery, conversationId: 'own-room' });
  expect(result.state).toBe('validated_only_not_sent'); expect(result.file.path).toBe(await realpath(f.delivery)); expect(result.file.size).toBeGreaterThan(0);
  expect(result.file.fingerprint).toMatch(/^[a-f0-9]{64}$/u); expect(result).not.toHaveProperty('attachments'); expect(result).not.toHaveProperty('messageId'); expect(result).not.toHaveProperty('content');
  expect(f.privateRoom).toHaveBeenCalledTimes(2);
});
it.each(['revoked', 'wrong-owner', 'wrong-grant', 'no-capability', 'expired', 'old-revision'] as const)('denies %s grants before native file access', async change => {
  const f = await fixture();
  if (change === 'revoked') f.state.grant.status = 'revoked';
  if (change === 'wrong-owner') f.state.grant.companionId = 'bob';
  if (change === 'wrong-grant') f.state.grant.id = 'another-grant';
  if (change === 'no-capability') f.state.grant.capabilities = ['observe'];
  if (change === 'expired') f.state.grant.expiresAt = '2000-01-01T00:00:00Z';
  if (change === 'old-revision') f.state.grant.revision = 2;
  await expect(f.files.readFile({ ...f.scope, path: path.join(f.source, 'nonexistent-secret.md') })).rejects.toThrow('文件范围已失效');
});
it('separates source roots from output roots and checks canonical containment, not string prefixes', async () => {
  const f = await fixture(), neighbor = path.join(f.root, 'source-neighbor'); await mkdir(neighbor); const neighborFile = path.join(neighbor, 'notes.md'); await writeFile(neighborFile, '不是获准目录');
  for (const file of [f.other, f.delivery, neighborFile]) await expect(f.files.readFile({ ...f.scope, path: file })).rejects.toThrow('不在本次日程');
  await expect(f.files.prepareDelivery({ ...f.scope, conversationId: 'own-room' })).rejects.toThrow('不在本次日程');
});
it('does not follow a directory junction out of an allowed source or output root', async () => {
  const f = await fixture(), sourceLink = path.join(f.source, 'jump'), outputLink = path.join(f.output, 'jump');
  await symlink(f.outside, sourceLink, 'junction'); await symlink(f.outside, outputLink, 'junction');
  await expect(f.files.readFile({ ...f.scope, path: path.join(sourceLink, 'private.md') })).rejects.toThrow('不在本次日程');
  await expect(f.files.prepareDelivery({ ...f.scope, path: path.join(outputLink, 'private.md'), conversationId: 'own-room' })).rejects.toThrow('不在本次日程');
});
it('does not accept a granted root that is itself a repointable junction', async () => {
  const f = await fixture(), alias = path.join(f.root, 'alias'); await symlink(f.outside, alias, 'junction');
  f.state.grant.fileRoots = [alias];
  await expect(f.files.readFile({ ...f.scope, path: path.join(alias, 'private.md') })).rejects.toThrow('不在本次日程');
});
it.each(['revoke', 'revise', 'replace-file'] as const)('withholds read content if %s occurs before the final authority check', async change => {
  const f = await fixture(); let calls = 0;
  f.currentGrant.mockImplementation(async () => {
    if (++calls === 2) {
      if (change === 'revoke') f.state.grant.status = 'revoked';
      if (change === 'revise') f.state.grant.revision++;
      if (change === 'replace-file') await writeFile(f.input, '这份内容已经改变，不应返回旧读数');
    }
    return structuredClone(f.state.grant);
  });
  await expect(f.files.readFile(f.scope)).rejects.toThrow(); expect(f.currentGrant).toHaveBeenCalledTimes(2);
});
it.each(['group-room', 'peer-room', 'other-owner-private'])('never prepares delivery to %s', async conversationId => {
  const f = await fixture();
  await expect(f.files.prepareDelivery({ ...f.scope, path: f.delivery, conversationId })).rejects.toThrow('只能交付到本人与用户');
});
it('rechecks both the current grant and the private endpoint after opening an output file', async () => {
  const f = await fixture(); f.privateRoom.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.files.prepareDelivery({ ...f.scope, path: f.delivery, conversationId: 'own-room' })).rejects.toThrow('只能交付到本人与用户');
  expect(f.privateRoom).toHaveBeenCalledTimes(2);
  f.privateRoom.mockResolvedValue(true); f.currentGrant.mockResolvedValueOnce(structuredClone(f.state.grant)).mockResolvedValueOnce({ ...f.state.grant, status: 'revoked' });
  await expect(f.files.prepareDelivery({ ...f.scope, path: f.delivery, conversationId: 'own-room' })).rejects.toThrow('文件范围已失效');
});
it('accepts BOM UTF-16 text, rejects binary guesses/directories and honors cancellation', async () => {
  const f = await fixture(); await writeFile(f.input, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('真实文本\n', 'utf16le')]));
  expect((await f.files.readFile(f.scope)).file.encoding).toBe('utf-16le');
  await writeFile(f.input, Buffer.from([0x00, 0x01, 0x02])); await expect(f.files.readFile(f.scope)).rejects.toThrow('不能作为文本');
  await expect(f.files.readFile({ ...f.scope, path: f.source })).rejects.toThrow('普通文件');
  const controller = new AbortController(); controller.abort(); const calls = f.currentGrant.mock.calls.length;
  await expect(f.files.readFile({ ...f.scope, signal: controller.signal })).rejects.toThrow(); expect(f.currentGrant).toHaveBeenCalledTimes(calls);
});
it('keeps model tool arguments free of host owner, grant and delivery endpoint authority', () => {
  expect(COMPANION_AGENDA_FILES_TOOL.name).toBe('agenda_files');
  expect(companionAgendaFilesArgumentsSchema.safeParse({ action: 'read', path: 'C:/allowed/notes.md', offset: 0, limit: 50 }).success).toBe(true);
  for (const extra of [{ companionId: 'bob' }, { grantId: 'other' }, { conversationId: 'group-room' }])
    expect(companionAgendaFilesArgumentsSchema.safeParse({ action: 'prepare_delivery', path: 'C:/output/report.md', ...extra }).success).toBe(false);
});

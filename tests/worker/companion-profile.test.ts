import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import { companionStorageCommandSchema, companionStorageResponseSchema } from '../../src/shared/companion-storage';
import { companionsRequestSchema, companionsResponseSchema } from '../../src/shared/companions';
import { playerProfileDraftSchema } from '../../src/shared/companion-profile';

const seed: CompanionSeed = { id: 'alice', name: 'Alice', description: '', persona: '独立且尊重边界。', model: '', avatar: 'sister', proactive: false };
const roots: string[] = [], stores = new Set<CompanionsStore>();
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) { if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('companion-profile-')) throw new Error('Unexpected fixture root.'); rmSync(root, { recursive: true, force: true }); } });
function open(filename: string) { const store = new CompanionsStore(filename, [{ ...seed, active: true }]); stores.add(store); return store; }
function fixture() { const root = mkdtempSync(path.join(tmpdir(), 'companion-profile-')); roots.push(root); const filename = path.join(root, 'messages.sqlite'); return { filename, store: open(filename) }; }
function close(store: CompanionsStore) { store.close(); stores.delete(store); }
function image(store: CompanionsStore, id: string, mime = 'image/png') { store.request({ type: 'attachment.register', stored: { attachment: { id, name: id + '.png', mime, size: 128 }, relativePath: 'attachments/' + id + '.png' } }); }

it('creates one stable public player identity and validates the actual IPC get/state responses', () => {
  const { store, filename } = fixture(), response = store.request({ type: 'player.profile.get' });
  expect(response.playerProfile).toMatchObject({ id: 'user', name: '我', description: '', revision: 1 });
  expect(response.playerProfile!.contentHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(companionsResponseSchema.parse(response).playerProfile).toEqual(response.playerProfile);
  expect(companionStorageResponseSchema.parse(store.request({ type: 'state' })).state!.playerProfile).toEqual(response.playerProfile);
  close(store); expect(open(filename).request({ type: 'player.profile.get' }).playerProfile).toEqual(response.playerProfile);
});
it('persists imported public pictures, stable content hashes and explicit omission-based removal without chat evidence', () => {
  const { store, filename } = fixture(), original = store.getPlayerProfile(); image(store, 'player-avatar'); image(store, 'player-three-views');
  const update = { type: 'player.profile.update', expectedRevision: original.revision, profile: { name: '林澄', description: '喜欢天文学。\n这是我公开给伙伴的自我介绍。', avatarAttachmentId: 'player-avatar', appearanceAttachmentId: 'player-three-views' } } as const;
  expect(companionsRequestSchema.safeParse(update).success).toBe(true); expect(companionStorageCommandSchema.safeParse(update).success).toBe(true);
  const saved = store.request(update).playerProfile!; expect(saved.revision).toBe(2); expect(saved.contentHash).not.toBe(original.contentHash);
  expect(JSON.stringify(saved)).not.toContain('source-private'); expect(companionStorageResponseSchema.parse({ ok: true, playerProfile: saved }).playerProfile).toEqual(saved);
  close(store); const again = open(filename); expect(again.getPlayerProfile()).toEqual(saved);
  const noop = again.updatePlayerProfile(update.profile, saved.revision); expect(noop).toEqual(saved);
  const removed = again.request({ type: 'player.profile.update', expectedRevision: saved.revision, profile: { name: '我', description: '' } }).playerProfile!;
  expect(removed).toMatchObject({ name: '我', revision: 3, contentHash: original.contentHash }); expect(removed.avatarAttachmentId).toBeUndefined(); expect(removed.appearanceAttachmentId).toBeUndefined();
  expect(again.getAttachment('player-three-views').attachment.mime).toBe('image/png');
  const privateRoom = again.openPrivate('alice'); expect(again.request({ type: 'messages', conversationId: privateRoom.id }).messages).toEqual([]);
  close(again); expect(open(filename).getPlayerProfile()).toEqual(removed);
});
it('rejects arbitrary paths, unknown/non-image attachments and stale writers without partially changing the profile', () => {
  const { store } = fixture(); image(store, 'not-image', 'application/pdf'); const initial = store.getPlayerProfile();
  for (const field of ['avatarAttachmentId', 'appearanceAttachmentId'] as const) {
    expect(() => store.request({ type: 'player.profile.update', expectedRevision: initial.revision, profile: { name: '不要保存', description: '', [field]: 'missing' } })).toThrow('附件不存在');
    expect(() => store.request({ type: 'player.profile.update', expectedRevision: initial.revision, profile: { name: '不要保存', description: '', [field]: 'not-image' } })).toThrow('图片');
    expect(playerProfileDraftSchema.safeParse({ name: '路径注入', description: '', [field]: 'C:/secret/avatar.png' }).success).toBe(false);
  }
  expect(store.getPlayerProfile()).toEqual(initial);
  expect(playerProfileDraftSchema.safeParse({ name: '错误', description: '', path: 'C:/secret.png' }).success).toBe(false);
  expect(playerProfileDraftSchema.safeParse({ id: 'alice', name: '错误', description: '' }).success).toBe(false);
  const winner = store.updatePlayerProfile({ name: '先保存者', description: '当前公开介绍' }, initial.revision);
  expect(() => store.updatePlayerProfile({ name: '迟到覆盖', description: '' }, initial.revision)).toThrow('已经更新'); expect(store.getPlayerProfile()).toEqual(winner);
  expect(companionsRequestSchema.safeParse({ type: 'player.profile.update', profile: { name: '无修订', description: '' } }).success).toBe(false);
});
it('persists companion appearance sheets and checks data revisions before editing or clearing both public images', () => {
  const { store, filename } = fixture(); image(store, 'companion-avatar'); image(store, 'companion-three-views');
  const draft = { ...seed, name: '新伙伴', avatarAttachmentId: 'companion-avatar', appearanceAttachmentId: 'companion-three-views' };
  const created = store.createCompanion(draft); expect(created).toMatchObject({ revision: 1, appearanceAttachmentId: 'companion-three-views' });
  close(store); const again = open(filename), loaded = again.state().companions.find(companion => companion.id === created.id)!; expect(loaded).toMatchObject(created);
  const first = again.request({ type: 'companion.update', id: created.id, expectedRevision: loaded.revision, companion: { ...draft, name: '已编辑' } }).companion!;
  expect(first.revision).toBe(2);
  expect(() => again.request({ type: 'companion.update', id: created.id, expectedRevision: loaded.revision, companion: { ...draft, name: '旧窗口覆盖' } })).toThrow('已经更新');
  const cleared = again.request({ type: 'companion.update', id: created.id, expectedRevision: first.revision, companion: { ...seed, name: '已移除图片' } }).companion!;
  expect(cleared.revision).toBe(3); expect(cleared.avatarAttachmentId).toBeUndefined(); expect(cleared.appearanceAttachmentId).toBeUndefined();
  expect(companionStorageResponseSchema.safeParse({ ok: true, companion: cleared }).success).toBe(true);
  close(again); const reopened = open(filename).state().companions.find(companion => companion.id === created.id)!;
  expect(reopened).toEqual(JSON.parse(JSON.stringify(cleared))); expect(reopened.avatarAttachmentId).toBeUndefined(); expect(reopened.appearanceAttachmentId).toBeUndefined();
});
it('validates companion image ownership by registered ID, without affecting independent player identity revisions', () => {
  const { store } = fixture(), initial = store.getPlayerProfile(), companion = store.state().companions[0]!;
  image(store, 'document', 'application/pdf');
  expect(() => store.createCompanion({ ...seed, appearanceAttachmentId: 'missing' })).toThrow('附件不存在');
  expect(() => store.updateCompanion('alice', { ...seed, name: '不应保存', appearanceAttachmentId: 'document' }, companion.revision)).toThrow('公开三视图');
  expect(store.state().companions[0]).toEqual(companion);
  image(store, 'appearance'); const edited = store.updateCompanion('alice', { ...seed, appearanceAttachmentId: 'appearance' }, companion.revision);
  expect(edited.revision).toBe(2); expect(store.getPlayerProfile()).toEqual(initial);
  store.updatePlayerProfile({ name: '玩家甲', description: '' }, initial.revision);
  expect(store.state().companions[0]!.revision).toBe(2);
  expect(companionsRequestSchema.safeParse({ type: 'attachment.pick', kind: 'image', purpose: 'appearance' }).success).toBe(true);
});
it('rejects linked chat images as public player or companion pictures until they are imported as managed copies', () => {
  const { store } = fixture(), player = store.getPlayerProfile(), companion = store.state().companions[0]!;
  store.request({ type: 'attachment.register', stored: { attachment: { id: 'linked-photo', name: '普通聊天图片.png', mime: 'image/png', size: 128 }, relativePath: 'attachments/linked-photo.png', sourcePath: 'C:\\source-private\\photo.png' } });
  for (const field of ['avatarAttachmentId', 'appearanceAttachmentId'] as const) {
    expect(() => store.updatePlayerProfile({ name: '不要保存', description: '', [field]: 'linked-photo' }, player.revision)).toThrow('应用内图片副本');
    expect(() => store.createCompanion({ ...seed, [field]: 'linked-photo' })).toThrow('应用内图片副本');
    expect(() => store.updateCompanion('alice', { ...seed, name: '不要保存', [field]: 'linked-photo' }, companion.revision)).toThrow('应用内图片副本');
  }
  expect(store.getPlayerProfile()).toEqual(player); expect(store.state().companions).toEqual([companion]);
  image(store, 'managed-photo'); expect(store.updatePlayerProfile({ name: '我', description: '', appearanceAttachmentId: 'managed-photo' }, player.revision).appearanceAttachmentId).toBe('managed-photo');
});

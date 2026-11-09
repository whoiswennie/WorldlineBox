import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import NativeDatabase from 'better-sqlite3';
import { BotStore } from '../../src/main/companion-bot/store';
import type { BotMediaRef } from '../../src/shared/companion-bot-media';
import { botRequestSchema } from '../../src/shared/companion-bot';

interface TestDatabase {
  prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown; run(...args: unknown[]): unknown };
  exec(sql: string): void; close(): void; pragma(sql: string, options?: { simple?: boolean }): unknown;
  transaction<T>(work: () => T): () => T;
}
const Database = NativeDatabase as { new (filename: string, options?: { readonly: boolean }): TestDatabase };

let root: string, filename: string, store: BotStore | undefined;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'wlb-history-fts-')); filename = path.join(root, 'bot.sqlite'); store = new BotStore(filename);
  for (const id of ['alice', 'bob']) store.createCompanion({ id, name: id, persona: '可靠伙伴' });
});
afterEach(() => { store?.close(); rmSync(root, { recursive: true, force: true }); });
const media = (id: string, name: string, mimeType: string, kind: 'file' | 'sticker' = 'file'): BotMediaRef => ({ id, name, mimeType, kind, size: 10, url: `worldlinebox-media://${id}` });
function oldV13() {
  store!.close(); store = undefined;
  const db = new Database(filename);
  db.exec(`DROP TRIGGER bot_messages_search_insert; DROP TRIGGER bot_messages_search_update; DROP TRIGGER bot_messages_search_delete;
    DROP TABLE bot_message_search; ALTER TABLE bot_messages DROP COLUMN timing_json; PRAGMA user_version=13;`);
  return db;
}
it('uses real trigram postings for Chinese substrings and punctuation literals while short queries stay scoped', () => {
  const direct = store!.openDirect('alice'), other = store!.openDirect('bob');
  const add = (content: string, conversationId = direct.id) => store!.enqueue({ conversationId, senderId: 'user', recipientIds: [], content }).message;
  const chinese = add('请确认春樱计划的最终版本'), punctuation = add(String.raw`文件 C:\作品\draft%_done[1].md，正文 "OR" 只是文本`);
  const injection = add('literal " OR content:* -- 一切只是资料'); add('请确认春樱计划的最终版本，其他私聊', other.id);
  add('文件 C:作品draftanythingXdone1md');
  expect(store!.searchMessages(direct.id, { query: '春樱计划' }).items.map(item => item.id)).toEqual([chinese.id]);
  expect(store!.searchMessages(direct.id, { query: '春樱' }).items.map(item => item.id)).toEqual([chinese.id]);
  expect(store!.searchMessages(direct.id, { query: String.raw`draft%_done[1].md` }).items.map(item => item.id)).toEqual([punctuation.id]);
  expect(store!.searchMessages(direct.id, { query: '" OR content:* --' }).items.map(item => item.id)).toEqual([injection.id]);
  expect(store!.searchMessages(direct.id, { query: '" OR 1=1 --' }).items).toEqual([]);
  const db = new Database(filename, { readonly: true });
  try {
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='bot_message_search'").get()).toMatchObject({ sql: expect.stringContaining("tokenize='trigram'") });
    expect(db.prepare('SELECT rowid FROM bot_message_search WHERE bot_message_search MATCH ?').all('"春樱计划"')).toHaveLength(2);
  } finally { db.close(); }
  const hidden = store!.createGroup({ title: '仅伙伴的世界观察', kind: 'world', memberIds: ['alice'], includeUser: false });
  expect(() => store!.searchMessages(hidden.id, { query: '春樱' })).toThrow('不能查询');
  expect(() => store!.searchMessages(direct.id, { filter: 'invented' as 'all' })).toThrow('分类无效');
  expect(botRequestSchema.safeParse({ type: 'history.search', conversationId: direct.id, filter: 'media', query: '' }).success).toBe(true);
  expect(botRequestSchema.safeParse({ type: 'history.search', conversationId: direct.id, filter: 'invented' }).success).toBe(false);
});
it('keeps real draft updates and deletes synchronized and excludes all empty placeholders', () => {
  const direct = store!.openDirect('alice'), input = store!.enqueue({ conversationId: direct.id, senderId: 'user', content: '原始输入' });
  expect(store!.searchMessages(direct.id).items.map(item => item.id)).toEqual([input.message.id]);
  const claim = store!.claim({ workerId: 'draft' })!;
  expect(store!.searchMessages(direct.id).items).toHaveLength(1);
  store!.updateDraft(claim.event.id, claim.leaseToken, '正在校对星海计划');
  expect(store!.searchMessages(direct.id, { query: '星海计划' }).items.map(item => item.id)).toEqual([claim.event.replyMessageId]);
  store!.updateDraft(claim.event.id, claim.leaseToken, '改用月海计划');
  expect(store!.searchMessages(direct.id, { query: '星海计划' }).items).toEqual([]);
  expect(store!.searchMessages(direct.id, { query: '月海计划' }).items).toHaveLength(1);
  store!.settle({ eventId: claim.event.id, leaseToken: claim.leaseToken, status: 'done', content: '' });
  expect(store!.searchMessages(direct.id, { query: '月海计划' }).items).toEqual([]);
  const removed = store!.enqueue({ conversationId: direct.id, senderId: 'user', recipientIds: [], content: '删除索引锚点' }).message;
  const db = new Database(filename);
  try {
    db.transaction(() => { db.prepare('DELETE FROM bot_origins WHERE message_id=?').run(removed.id); db.prepare('DELETE FROM bot_history_projection WHERE message_id=?').run(removed.id); db.prepare('DELETE FROM bot_messages WHERE id=?').run(removed.id); })();
    expect(db.prepare('SELECT rowid FROM bot_message_search WHERE bot_message_search MATCH ?').all('"删除索引锚点"')).toEqual([]);
  } finally { db.close(); }
  expect(store!.searchMessages(direct.id, { query: '删除索引锚点' }).items).toEqual([]);
});
it('classifies ordinary media, stickers, non-media files and actual body links independently', () => {
  const direct = store!.openDirect('alice'), add = (content: string, attachments?: BotMediaRef[]) => store!.enqueue({ conversationId: direct.id, senderId: 'user', recipientIds: [], content, attachments }).message;
  const picture = add('', [media('image', '旅行图片.webp', 'image/webp')]), audio = add('', [media('audio', '音乐.m4a', 'application/mp4')]);
  const sticker = add('', [media('sticker', '辉夜好耶', 'image/webp', 'sticker')]), file = add('', [media('pdf', '出行计划.pdf', 'application/pdf')]);
  const mixed = add('混合附件', [media('video', '片段.mp4', 'video/mp4'), media('zip', '资料.zip', 'application/zip')]);
  const link = add('看看 HTTPS://example.com/path?x=1，以及 www.example.org。'), invalid = add('说明 https:// 还没有地址。');
  const fileNameLink = add('', [media('name-url', 'https://example.com.txt', 'text/plain')]);
  const ids = (filter: 'media' | 'stickers' | 'files' | 'links') => store!.searchMessages(direct.id, { filter }).items.map(item => item.id);
  expect(ids('media')).toEqual([mixed.id, audio.id, picture.id]); expect(ids('stickers')).toEqual([sticker.id]);
  expect(ids('files')).toEqual([fileNameLink.id, mixed.id, file.id]); expect(ids('links')).toEqual([link.id]);
  expect(store!.searchMessages(direct.id, { query: '出行计划', filter: 'files' }).items.map(item => item.id)).toEqual([file.id]);
  expect(store!.searchMessages(direct.id, { query: '出行计划', filter: 'media' }).items).toEqual([]);
  expect(store!.searchMessages(direct.id).items.map(item => item.id)).toContain(invalid.id);
});
it('atomically backfills a v13 database and successful Outbox timing without inventing old cancellation times', () => {
  const direct = store!.openDirect('alice');
  store!.enqueue({ conversationId: direct.id, senderId: 'user', content: '旧版春樱计划' });
  const done = store!.claim({ workerId: 'old' })!; store!.settle({ eventId: done.event.id, leaseToken: done.leaseToken, status: 'done', content: '旧版答复春樱计划' });
  const stopped = store!.enqueue({ conversationId: direct.id, senderId: 'user', content: '旧版取消' }); store!.cancelEvent(stopped.events[0]!.id);
  const db = oldV13();
  db.prepare('UPDATE bot_inbox SET received_at=? WHERE id=?').run('2026-11-03T00:00:00.000Z', done.event.id);
  db.prepare('UPDATE bot_outbox SET created_at=? WHERE message_id=?').run('2026-11-03T00:00:03.456Z', done.event.replyMessageId); db.close();
  store = new BotStore(filename);
  expect(store.searchMessages(direct.id, { query: '春樱计划' }).items).toHaveLength(2);
  expect(store.getMessage(done.event.replyMessageId)?.timing).toEqual({ elapsedMs: 3456 });
  expect(store.getMessage(stopped.events[0]!.replyMessageId)?.timing).toBeUndefined();
  const version = new Database(filename, { readonly: true }); try { expect(version.pragma('user_version', { simple: true })).toBe(21); } finally { version.close(); }
  store.close(); store = new BotStore(filename);
  expect(store.getMessage(done.event.replyMessageId)?.timing).toEqual({ elapsedMs: 3456 });
});
it('rolls back schema, index and version together when legacy data cannot be indexed', () => {
  const direct = store!.openDirect('alice'), message = store!.enqueue({ conversationId: direct.id, senderId: 'user', recipientIds: [], content: '坏数据不能半迁移' }).message;
  const old = oldV13(); old.prepare('UPDATE bot_messages SET attachments_json=? WHERE id=?').run('not-json', message.id); old.close();
  expect(() => { store = new BotStore(filename); }).toThrow('malformed JSON');
  const db = new Database(filename); try {
    expect(db.pragma('user_version', { simple: true })).toBe(13);
    expect(db.prepare('PRAGMA table_info(bot_messages)').all()).not.toContainEqual(expect.objectContaining({ name: 'timing_json' }));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='bot_message_search'").get()).toBeUndefined();
  } finally { db.close(); }
});

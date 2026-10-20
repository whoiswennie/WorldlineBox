import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CompanionsStore, type CompanionSeed } from '../../src/companions/store';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';

const seed: CompanionSeed = { id: 'alice', name: 'Alice', description: '', persona: '诚实表达。', model: '', avatar: 'sister', proactive: false };
const roots: string[] = [], stores = new Set<CompanionsStore>();
afterEach(() => {
  for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) { if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('worldlinebox-loop-files-')) throw new Error('Unexpected loop file cleanup.'); rmSync(root, { recursive: true, force: true }); }
});
function open(file: string) { const store = new CompanionsStore(file, [{ ...seed, active: true }]); stores.add(store); return store; }
it('attaches real registered tool snapshots to one durable bubble, idempotently across restart', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-loop-files-')); roots.push(root);
  const filename = path.join(root, 'messages.sqlite'), store = open(filename), room = store.openPrivate('alice');
  const source = store.appendMessage({ conversationId: room.id, authorId: 'user', content: '看看这份文字和图。' });
  const bubble = store.appendMessage({ conversationId: room.id, authorId: 'alice', content: '', loopStep: 0, replyToId: source.id });
  for (const id of ['text-snapshot', 'image-snapshot']) store.request({ type: 'attachment.register', stored: { attachment: { id, name: id + '.txt', mime: 'text/plain', size: 24 }, relativePath: `attachments/${id}.txt` } });
  const checkpoint: CompanionLoopCheckpoint = { conversationId: room.id, companionId: 'alice', sourceMessageId: source.id, messageId: bubble.id, status: 'running', supplements: [],
    turns: [{ text: '我正在查看。', rawText: '我正在查看。', calls: [{ id: 'read-text', name: 'read_file', arguments: '{}' }, { id: 'read-picture', name: 'read_image', arguments: '{}' }], results: [
      { callId: 'read-text', content: '真实文字窗口。', attachmentIds: ['text-snapshot'] },
      { callId: 'read-picture', content: '图像快照已解码。', attachmentIds: ['image-snapshot'], images: [{ attachmentId: 'image-snapshot', sha256: 'a'.repeat(64), mime: 'image/jpeg', width: 64, height: 64, path: path.join(root, 'image.jpg') }] },
    ] }] };
  store.request({ type: 'loop.save', checkpoint }); store.request({ type: 'loop.save', checkpoint });
  expect(store.getMessage(bubble.id).attachments.map(file => file.id)).toEqual(['text-snapshot', 'image-snapshot']);
  const bad = structuredClone(checkpoint); bad.turns[0]!.results![0]!.attachmentIds = ['not-registered'];
  expect(() => store.request({ type: 'loop.save', checkpoint: bad })).toThrow('附件不存在');
  expect(store.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'alice' }).loop).toEqual(checkpoint);
  expect(store.getMessage(bubble.id).attachments.map(file => file.id)).toEqual(['text-snapshot', 'image-snapshot']);
  const overflow = structuredClone(checkpoint);
  const extra = Array.from({ length: 9 }, (_, index) => 'cap-' + index);
  for (const id of extra) store.request({ type: 'attachment.register', stored: { attachment: { id, name: id, mime: 'text/plain', size: 1 }, relativePath: 'attachments/' + id + '.txt' } });
  overflow.turns[0]!.results![0]!.attachmentIds = ['text-snapshot', ...extra.slice(0, 8)];
  overflow.turns.push({ text: '', rawText: '', calls: [{ id: 'overflow', name: 'send_file', arguments: '{}' }], results: [{ callId: 'overflow', content: '{}', attachmentIds: [extra[8]!] }] });
  expect(() => store.request({ type: 'loop.save', checkpoint: overflow })).toThrow('最多展示十个附件');
  expect(store.getMessage(bubble.id).attachments.map(file => file.id)).toEqual(['text-snapshot', 'image-snapshot']);
  checkpoint.status = 'done'; store.request({ type: 'loop.save', checkpoint }); store.close(); stores.delete(store);
  const restarted = open(filename);
  expect(restarted.getMessage(bubble.id).attachments.map(file => file.id)).toEqual(['text-snapshot', 'image-snapshot']);
  expect(JSON.stringify(restarted.request({ type: 'loop.get', sourceMessageId: source.id, companionId: 'alice' }).loop)).not.toContain('base64');
});

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, open, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DshTaskRecordStore } from '../../src/main/dsh/task-record-store';
import { DSH_RECORD_LIMITS, dshRecordQuerySchema } from '../../src/shared/dsh-task-record';
import { companionDshReceipt } from '../../src/shared/companion-dsh-receipt';
import { removeManaged } from '../../src/main/dsh/files';
import type { DshTaskEvent } from '../../src/shared/dsh-tasks';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeManaged(tmpdir(), root); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-task-record-')); roots.push(root);
  const store = new DshTaskRecordStore(root), id = randomUUID();
  const owner = { companionId: 'one', conversationId: 'room', sourceMessageId: 'source', actionId: randomUUID() };
  await store.begin(id, '查询资料', owner);
  const event = (sequence: number, patch: Partial<DshTaskEvent> = {}): DshTaskEvent => ({ taskId: id, sequence, type: 'status', receivedAt: new Date().toISOString(), ...patch });
  return { root, store, id, owner, event };
}
describe('Indexed DSH execution records', () => {
  it('archives real reports by owner, local start date and action title while retaining complete indexed steps', async () => {
    const f = await fixture();
    const text = '实际执行器最终正文。'.repeat(1000);
    f.store.execution(f.id, { sessionId: 'native-session-one', artifacts: [{ path: '/actual/result.txt', description: '实际产物' }],
      startup: { preparationMs: 12, bootMs: 3, reusedWorker: true } });
    f.store.append(f.id, f.event(0, { stage: 'step_start' }));
    f.store.append(f.id, f.event(1, { type: 'final', text }));
    await f.store.finish(f.id, 'succeeded');
    const overview = (await f.store.read({ recordId: f.id })).overview;
    const started = new Date(overview.createdAt), day = `${started.getFullYear()}-${String(started.getMonth() + 1).padStart(2, '0')}-${String(started.getDate()).padStart(2, '0')}`;
    expect(overview.archivePath).toBe(path.join(f.root, 'by-owner', 'one', day, '查询资料--' + f.id));
    const report = await readFile(overview.reportPath!, 'utf8');
    expect(report).toContain(text); expect(report).toContain('native-session-one'); expect(report).toContain('实际产物');
    expect(report).toContain('复用预热进程'); expect(report).toContain(path.join(f.root, f.id, 'events.jsonl'));
    const manifest = JSON.parse(await readFile(path.join(overview.archivePath!, 'session.json'), 'utf8'));
    expect(manifest.scope).toEqual(f.owner); expect(manifest.overview.status).toBe('succeeded');
    expect((await new DshTaskRecordStore(f.root).read({ recordId: f.id, start: 2, end: 2 })).entries[0]?.event.text).toBe(text.slice(0, 2000));
  });
  it('keeps cancelled and failed same-title sessions separate and cleans only their exact owner archives', async () => {
    const f = await fixture(), second = randomUUID(), other = randomUUID();
    await f.store.begin(second, '查询资料', f.owner);
    await f.store.begin(other, '../unsafe:*title', { ...f.owner, companionId: 'two' });
    await f.store.finish(f.id, 'cancelled'); await f.store.finish(second, 'failed', undefined, '实际失败');
    await f.store.finish(other, 'succeeded');
    const first = (await f.store.read({ recordId: f.id })).overview, failed = (await f.store.read({ recordId: second })).overview;
    expect(first.archivePath).not.toBe(failed.archivePath); expect(await readFile(first.reportPath!, 'utf8')).toContain('已取消');
    expect(await readFile(failed.reportPath!, 'utf8')).toContain('实际失败');
    await f.store.removeOwner('one'); expect(await readdir(path.join(f.root, 'by-owner'))).toEqual(['two']);
    const remaining = (await f.store.read({ recordId: other })).overview;
    expect(path.relative(path.join(f.root, 'by-owner', 'two'), remaining.reportPath!)).not.toMatch(/^\.\./u);
    expect(await readFile(remaining.reportPath!, 'utf8')).toContain('已成功');
  });
  it('returns overview only by default, with exact host counters and a resumable final reply', async () => {
    const f = await fixture();
    f.store.append(f.id, f.event(0, { stage: 'turn_start' }));
    f.store.append(f.id, f.event(1, { stage: 'step_start' }));
    f.store.append(f.id, f.event(2, { type: 'tool_call', stage: 'tool_start', toolName: 'web_search', text: 'query' }));
    f.store.append(f.id, f.event(3, { type: 'thinking', text: 'must-never-be-stored' }));
    const text = '最终回复'.repeat(3000);
    f.store.append(f.id, f.event(4, { type: 'final', stage: 'completed', text }));
    await f.store.finish(f.id, 'succeeded');
    const record = await f.store.read({ recordId: f.id });
    expect(record.entries).toEqual([]);
    expect(record.overview).toMatchObject({ turns: 1, steps: 1, toolCalls: 1, recordCount: 4, finalReplyChars: text.length, finalReplyTruncated: true, finalRecord: 4, complete: true });
    expect(record.overview.finalReply).toHaveLength(DSH_RECORD_LIMITS.finalChars);
    expect(await readFile(path.join(f.root, f.id, 'events.jsonl'), 'utf8')).not.toContain('must-never');
    let actual = '', offset = 0;
    do {
      const page = await f.store.read({ recordId: f.id, start: 4, end: 4, textOffset: offset });
      actual += page.entries[0]!.event.text; offset = page.entries[0]!.nextTextOffset ?? 0;
    } while (offset);
    expect(actual).toBe(text);
    const receipt = companionDshReceipt({ id: f.owner.actionId, companionId: 'one', conversationId: 'room', sourceMessageId: 'source', title: '查询', status: 'succeeded',
      createdAt: record.overview.createdAt, updatedAt: record.overview.finishedAt!, executionSummary: record.overview, events: [{ sequence: 0, type: 'tool_start', summary: 'private event body', receivedAt: '' }] });
    expect(receipt.statistics).toMatchObject({ turns: 1, steps: 1, toolCalls: 1, recordCount: 4 });
    expect(JSON.stringify(receipt)).not.toContain('private event body'); expect(receipt.recordId).toBe(f.id);
  });
  it('reads old and late ranges after restart without retaining an in-memory transcript', async () => {
    const f = await fixture();
    for (let i = 0; i < 1200; i++) f.store.append(f.id, f.event(i, { stage: 'step_start', text: 'item-' + i }));
    await f.store.finish(f.id, 'succeeded');
    const reopened = new DshTaskRecordStore(f.root);
    const first = await reopened.read({ recordId: f.id, start: 1, end: 3 });
    expect(first.entries.map(entry => entry.event.text)).toEqual(['item-0', 'item-1', 'item-2']);
    const data = await open(path.join(f.root, f.id, 'events.jsonl'), 'r+');
    try { await data.write(Buffer.from('BROKEN'), 0, 6, 0); } finally { await data.close(); }
    // A late page must not parse/scan earlier records.
    const late = await reopened.read({ recordId: f.id, start: 1199, end: 1200 });
    expect(late.entries.map(entry => entry.event.text)).toEqual(['item-1198', 'item-1199']);
    expect(late.hasMore).toBe(false); expect(first.nextStart).toBe(4);
  });
  it('keeps a 20 MiB transcript paged and applies then releases write backpressure', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-task-record-')); roots.push(root);
    const pressure: boolean[] = [], store = new DshTaskRecordStore(root, undefined, (_id, paused) => pressure.push(paused));
    const recordId = randomUUID(); await store.begin(recordId, 'large transcript');
    for (let batch = 0; batch < 10; batch++) {
      for (let i = 0; i < 1000; i++) store.append(recordId, { taskId: recordId, sequence: batch * 1000 + i, type: 'tool_result', receivedAt: new Date().toISOString(), text: '大记录'.repeat(700) });
      // Respect the producer's pressure boundary before admitting the next batch.
      await store.read({ recordId });
    }
    await store.finish(recordId, 'succeeded');
    const record = await store.read({ recordId, start: 9990, end: 10000 });
    expect(record.overview.recordCount).toBe(10000); expect(record.overview.storedBytes).toBeGreaterThan(20 * 1024 ** 2);
    expect(record.entries.length).toBeLessThanOrEqual(11);
    expect(JSON.stringify(record.entries).length).toBeLessThanOrEqual(DSH_RECORD_LIMITS.pageChars + 51);
    expect(pressure).toContain(true); expect(pressure.at(-1)).toBe(false);
  });
  it('bounds escaped text by the entire serialized page-entry budget and reports every continuation', async () => {
    const f = await fixture();
    for (let i = 0; i < 50; i++) f.store.append(f.id, f.event(i, { text: '\u0000'.repeat(10000) }));
    await f.store.finish(f.id, 'succeeded');
    const page = await f.store.read({ recordId: f.id, start: 1, end: 50, entryChars: 4000 });
    expect(JSON.stringify(page.entries).length).toBeLessThanOrEqual(DSH_RECORD_LIMITS.pageChars + 51);
    expect(page.entries[0]!.truncated).toBe(true); expect(page.entries[0]!.nextTextOffset).toBeGreaterThan(0);
    expect(page.hasMore).toBe(true); expect(page.nextStart).toBe(page.entries.at(-1)!.number + 1);
  });
  it('keeps live range snapshots stable when new events arrive', async () => {
    const f = await fixture();
    for (let i = 0; i < 30; i++) f.store.append(f.id, f.event(i));
    const overview = await f.store.read({ recordId: f.id });
    f.store.append(f.id, f.event(30));
    const fixed = await f.store.read({ recordId: f.id, start: 25, snapshot: overview.snapshot });
    expect(fixed.entries.at(-1)?.number).toBe(30); expect(fixed.hasMore).toBe(false);
    expect((await f.store.read({ recordId: f.id })).snapshot).toBe(31);
    await f.store.finish(f.id, 'cancelled');
  });
  it('marks crashed records partial and rejects a corrupt byte index', async () => {
    const f = await fixture(); for (let i = 0; i < 32; i++) f.store.append(f.id, f.event(i));
    await f.store.read({ recordId: f.id });
    const reopened = new DshTaskRecordStore(f.root);
    expect((await reopened.read({ recordId: f.id })).overview).toMatchObject({ status: 'interrupted', complete: false, recordCount: 32 });
    await writeFile(path.join(f.root, f.id, 'events.idx'), Buffer.alloc(12, 255));
    await expect(reopened.read({ recordId: f.id, start: 1 })).rejects.toThrow('索引');
    await f.store.finish(f.id, 'interrupted');
  });
  it('stream-cleans only an exact owner and preserves other companions records', async () => {
    const f = await fixture(), other = randomUUID();
    await f.store.begin(other, 'other', { ...f.owner, companionId: 'two' });
    await expect(f.store.removeOwner('one')).rejects.toThrow('运行中');
    await f.store.finish(f.id, 'cancelled'); await f.store.finish(other, 'succeeded');
    await writeFile(path.join(f.root, f.id, `metadata.json.${randomUUID()}.tmp`), 'interrupted atomic write');
    await f.store.removeOwner('one');
    await expect(f.store.read({ recordId: f.id })).rejects.toThrow();
    expect((await f.store.read({ recordId: other })).overview.title).toBe('other');
  });
  it('rejects oversized ranges, traversal, reversed ranges and ambiguous text continuations', () => {
    const recordId = randomUUID();
    for (const query of [{ recordId: '../bad' }, { recordId, start: 1, end: 51 }, { recordId, start: 5, end: 4 }, { recordId, end: 5 },
      { recordId, start: 1, textOffset: 2 }, { recordId, start: 1, end: 1, entryChars: 4001 }]) expect(dshRecordQuerySchema.safeParse(query).success).toBe(false);
    expect(dshRecordQuerySchema.parse({ recordId, start: 1, end: 50 }).entryChars).toBe(2000);
  });
});

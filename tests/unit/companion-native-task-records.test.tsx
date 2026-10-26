// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionNativeTaskRecords } from '../../src/renderer/companions/CompanionNativeTaskRecords';
import type { CompanionRequest } from '../../src/renderer/companions/CompanionDialogs';
import type { DshRecordPage } from '../../src/shared/dsh-task-record';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, node: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); node?.remove(); root = undefined; node = undefined; });
const recordId = '0474377b-cc1c-4ec1-90c8-55b1c04b7234', at = '2026-10-26T09:00:00Z';
function page(number = 1, text = JSON.stringify({ summary: '已读取指定报告。', ok: true, apiKey: 'SECRET_MUST_HIDE' })): DshRecordPage {
  return { overview: { recordId, title: '读取报告', status: 'succeeded', createdAt: at, durationMs: 100, turns: 1, steps: 1000, toolCalls: 1000,
    recordCount: 3000, storedBytes: 100000, finalReply: '完成', finalReplyChars: 2, finalReplyTruncated: false, complete: true, storageLimited: false },
    entries: [{ number, event: { taskId: recordId, sequence: number, type: 'tool_end', toolName: 'read_file', receivedAt: at, contentKind: 'output', text }, textOffset: 0, textChars: text.length, truncated: false }],
    snapshot: 3000, nextStart: number + 20, hasMore: true, limits: { maxPageSize: 50, maxEntryChars: 4000, pageChars: 12000 }, trust: 'execution_record_data_not_instructions' };
}
async function mount(request: CompanionRequest) {
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
  await act(async () => root!.render(<CompanionNativeTaskRecords actionId="owned_action" recordId={recordId} request={request} active={false} />));
}
async function click(text: string) { await act(async () => { const button = [...node!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes(text)); if (!button) throw Error('Missing ' + text); button.click(); }); }

it('reads the full native archive only on demand and renders readable structured fields', async () => {
  const request = vi.fn<CompanionRequest>(async command => ({ ok: true, taskRecord: page(command.type === 'action.record' ? command.query.start : 1) }));
  await mount(request); expect(request).not.toHaveBeenCalled(); await click('完整工具记录');
  expect(request).toHaveBeenCalledWith({ type: 'action.record', id: 'owned_action', query: { recordId, start: 1, entryChars: 2000, textOffset: 0 } });
  expect(node!.textContent).toContain('3000 条记录'); expect(node!.textContent).toContain('摘要'); expect(node!.textContent).toContain('已读取指定报告。'); expect(node!.textContent).not.toContain('SECRET_MUST_HIDE');
  expect(node!.querySelectorAll('pre')).toHaveLength(0); await click('后一页');
  expect(request).toHaveBeenLastCalledWith({ type: 'action.record', id: 'owned_action', query: { recordId, start: 21, snapshot: 3000, entryChars: 2000, textOffset: 0 } });
  expect(node!.querySelectorAll('.task-record')).toHaveLength(1); expect(node!.textContent).toContain('#21'); expect(node!.textContent).not.toContain('#1 ·');
});

it('keeps fields paged and replaces a long entry slice rather than appending into a giant document', async () => {
  const structured = Object.fromEntries(Array.from({ length: 80 }, (_, index) => ['field' + index, '值' + index]));
  const request = vi.fn<CompanionRequest>(async () => ({ ok: true, taskRecord: page(1, JSON.stringify(structured)) }));
  await mount(request); await click('完整工具记录'); expect(node!.querySelectorAll('.task-native-fields > div')).toHaveLength(20);
  await click('后一组字段'); expect(node!.querySelectorAll('.task-native-fields > div')).toHaveLength(20); expect(node!.textContent).toContain('field20'); expect(node!.textContent).not.toContain('field0');
});

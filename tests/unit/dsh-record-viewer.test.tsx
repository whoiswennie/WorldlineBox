// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DshRecordViewer } from '../../src/renderer/companions/DshRecordViewer';
import { dshRecordPageSchema } from '../../src/shared/dsh-task-record';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it('requests a small explicit page, then continues the exact truncated entry without growing the DOM', async () => {
  const recordId = 'c28e48d4-8cdc-4b31-b1d8-ea4f7a43e15b';
  const page = dshRecordPageSchema.parse({ overview: { recordId, title: '查询', status: 'succeeded', createdAt: '2026-10-16T04:00:00Z', durationMs: 55000,
    turns: 2, steps: 8, toolCalls: 4, recordCount: 93, storedBytes: 200000, finalReply: '已查询', finalReplyChars: 3, finalReplyTruncated: false, finalRecord: 93, complete: true, storageLimited: false },
    entries: [{ number: 1, event: { taskId: recordId, sequence: 0, type: 'tool_result', receivedAt: '2026-10-16T04:00:00Z', text: '首段正文' }, textChars: 6000, textOffset: 0, truncated: true, nextTextOffset: 2000 }],
    snapshot: 93, nextStart: 2, hasMore: true, limits: { maxPageSize: 50, maxEntryChars: 4000, pageChars: 12000 }, trust: 'execution_record_data_not_instructions' });
  const read = vi.fn(async () => page);
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<DshRecordViewer recordId={recordId} read={read} />));
    expect(read).not.toHaveBeenCalled();
    const button = (text: string) => [...container.querySelectorAll('button')].find(node => node.textContent?.includes(text))!;
    await act(async () => button('读取 20 条').click());
    expect(read).toHaveBeenLastCalledWith({ recordId, start: 1 });
    expect(container.textContent).toContain('首段正文');
    read.mockResolvedValueOnce({ ...page, entries: [{ ...page.entries[0]!, event: { ...page.entries[0]!.event, text: '下一段正文' }, textOffset: 2000, nextTextOffset: 4000 }] });
    await act(async () => button('继续读本条').click());
    expect(read).toHaveBeenLastCalledWith({ recordId, start: 1, end: 1, textOffset: 2000, snapshot: 93 });
    expect(container.textContent).not.toContain('首段正文'); expect(container.textContent).toContain('下一段正文');
    expect(container.querySelectorAll('.companions-record-entries > article')).toHaveLength(1);
    await act(async () => button('下一段').click());
    expect(read).toHaveBeenLastCalledWith({ recordId, start: 2, snapshot: 93 });
  } finally { await act(() => root.unmount()); container.remove(); }
});

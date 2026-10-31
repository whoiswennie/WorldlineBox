// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { CompanionAction, CompanionsRequest, CompanionsResponse } from '../../src/shared/companions';
import { CompanionCapabilityLink } from '../../src/renderer/companions/CompanionCapabilityLink';
import { CompanionTaskMonitor } from '../../src/renderer/companions/CompanionTaskMonitor';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement | undefined;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root = undefined; host = undefined; });
const action: CompanionAction = { id: 'observe-call', companionId: 'alice', conversationId: 'owner-private', title: 'observe.screen', status: 'succeeded', createdAt: '2026-10-29T01:00:00Z', updatedAt: '2026-10-29T01:00:01Z',
  capability: { name: 'observe', callId: 'call-1', invocationId: 'inv-1', inputHash: 'a'.repeat(64) }, stage: '已经查看获准的编辑器窗口', result: '只返回了实际获准的画面。',
  events: [{ sequence: 0, type: 'tool_input', toolName: 'observe', contentKind: 'input', content: '{"action":"screen"}', summary: '查看所选窗口', receivedAt: '2026-10-29T01:00:00Z' },
    { sequence: 1, type: 'tool_output', toolName: 'observe', contentKind: 'output', content: '真实观察结果', summary: '观察已返回', receivedAt: '2026-10-29T01:00:01Z' }] };
async function mount(node: React.ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(node)); }

it('shows a human observation title and actual stage in the same chat capability card', async () => {
  const open = vi.fn(); await mount(<CompanionCapabilityLink action={action} actionId={action.id} now={Date.parse(action.updatedAt)} onOpen={open} />);
  expect(host!.textContent).toContain('看看你正在忙什么'); expect(host!.textContent).toContain(action.stage);
  await act(async () => host!.querySelector('button')!.click()); expect(open).toHaveBeenCalledWith(action.id);
});

it('opens only this actual capability input/output without a task workbench or native DSH read/resume', async () => {
  const request = vi.fn(async () => ({ ok: true, action }));
  await mount(<CompanionTaskMonitor actions={[action]} companions={[]} conversationId={action.conversationId} request={request} initialActionId={action.id} now={Date.parse(action.updatedAt)} onClose={vi.fn()} onStop={vi.fn()} onGuide={vi.fn()} onResume={vi.fn()} onOpenUrl={vi.fn()} />);
  expect(host!.querySelector('[role="dialog"][aria-label="能力调用详情"]')).not.toBeNull();
  expect(host!.textContent).toContain('看看你正在忙什么'); expect(host!.textContent).toContain('{"action":"screen"}'); expect(host!.textContent).toContain('真实观察结果');
  expect(host!.querySelector('.companions-task-history,.companions-record-details,.companions-task-controls')).toBeNull();
  expect(request.mock.calls).toHaveLength(1);
});

it('summarizes a structured argument failure in the action strip while preserving the full original diagnostic in details', async () => {
  const diagnostic = JSON.stringify({ ok: false, error: '能力参数无效；请按argumentIssues和example修正。', argumentIssues: [{ path: 'file', message: '缺少文件路径。' }], example: { file: '原始示例' } });
  const failed: CompanionAction = { ...action, status: 'failed', stage: diagnostic, error: diagnostic, result: diagnostic };
  await mount(<CompanionCapabilityLink action={failed} actionId={failed.id} now={Date.parse(failed.updatedAt)} onOpen={vi.fn()} />);
  expect(host!.textContent).toContain('这次操作未能开始，伙伴需要先补全调用参数。');
  expect(host!.textContent).not.toContain('argumentIssues');
  expect(host!.querySelector('button')!.title).not.toContain('argumentIssues');
  await act(async () => root!.render(<CompanionTaskMonitor actions={[failed]} companions={[]} conversationId={failed.conversationId} request={async () => ({ ok: true, action: failed })} initialActionId={failed.id} now={Date.parse(failed.updatedAt)} onClose={vi.fn()} onStop={vi.fn()} onGuide={vi.fn()} onOpenUrl={vi.fn()} />));
  expect(host!.querySelector('.companions-action-error')!.textContent).not.toContain('argumentIssues');
  const raw = [...host!.querySelectorAll('details')].find(element => element.querySelector('summary')?.textContent === '原始错误信息');
  expect(raw?.querySelector('pre')?.textContent).toBe(diagnostic);
});

it('shows native pending approval as waiting for the user and clears that state after the actual decision', async () => {
  const pending: CompanionAction = { ...action, status: 'running', stage: 'running', events: [{ sequence: 0, type: 'approval_required', summary: '等待权限确认', content: JSON.stringify({ requestId: 'approval-1', reason: '读取指定资料目录' }), receivedAt: action.createdAt }] };
  const render = (value: CompanionAction) => <CompanionCapabilityLink action={value} actionId={value.id} now={Date.parse(value.updatedAt)} onOpen={vi.fn()} />;
  await mount(render(pending));
  expect(host!.querySelector('.companions-capability-state')?.textContent).toContain('等待确认权限');
  expect(host!.textContent).toContain('等待你在 DSH 中确认权限');
  await act(async () => root!.render(render({ ...pending, events: [...pending.events!, { sequence: 1, type: 'approval_decided', summary: '权限已确认', content: JSON.stringify({ requestId: 'approval-1', outcome: 'allowed-once' }), receivedAt: action.updatedAt }] })));
  expect(host!.querySelector('.companions-capability-state')?.textContent).toContain('进行中');
  expect(host!.textContent).not.toContain('等待确认权限');
});

it('offers a cold native record for a real think task while keeping observation and native controls separate', async () => {
  const taskId = '76222ef7-9f6f-4cbb-8ab9-dd08f984bca2';
  const thought: CompanionAction = { ...action, id: 'think-call', taskId, capability: { ...action.capability!, name: 'think' }, canResume: true, pid: 123, title: '深入理解刚才的观察', stage: '已完成实际原生思考' };
  const request = vi.fn(async (input: CompanionsRequest): Promise<CompanionsResponse> => input.type === 'action.get' ? { ok: true, action: input.id === thought.id ? thought : action }
    : input.type === 'action.record' ? { ok: true, taskRecord: { overview: { recordId: taskId, title: thought.title, status: 'succeeded', createdAt: thought.createdAt, durationMs: 1000, turns: 1, steps: 1, toolCalls: 0, recordCount: 0, storedBytes: 0, finalReply: '', finalReplyChars: 0, finalReplyTruncated: false, complete: true, storageLimited: false }, entries: [], snapshot: 0, hasMore: false, limits: { maxPageSize: 50, maxEntryChars: 2000, pageChars: 40000 }, trust: 'execution_record_data_not_instructions' } } : { ok: true });
  const render = (selected: CompanionAction) => <CompanionTaskMonitor key={selected.id} actions={[selected]} companions={[]} conversationId={selected.conversationId} request={request} initialActionId={selected.id} now={Date.parse(selected.updatedAt)} onClose={vi.fn()} onStop={vi.fn()} onGuide={vi.fn()} onResume={vi.fn()} onTerminate={vi.fn()} onOpenUrl={vi.fn()} />;
  await mount(render(thought));
  expect(host!.querySelector('.companions-record-details')?.textContent).toContain('按段查看完整记录');
  expect(host!.querySelector('.companions-task-controls,.companions-guide-task')).toBeNull();
  await act(async () => [...host!.querySelectorAll('button')].find(node => node.textContent === '查看记录概览')!.click());
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'action.record', id: thought.id, query: expect.objectContaining({ recordId: taskId }) }));
  await act(async () => root!.render(render(action)));
  expect(host!.querySelector('.companions-record-details')).toBeNull();
});

import { expect, it } from 'vitest';
import { normalizeCompanionCapabilityCall, companionCapabilityArgumentFeedback, companionDshCapabilitySchema, COMPANION_DSH_CAPABILITY_TOOL } from '../../src/shared/companion-capability-tools';
import { companionDshControlSchema } from '../../src/shared/companion-dsh-background';

const call = (value: unknown) => ({ id: 'actual_wait_call', name: 'dsh', arguments: JSON.stringify(value) });
it('accepts the actual wait request with a bounded explanatory reason without resubmitting a run', () => {
  const original = call({ operation: 'wait', actionIds: ['959fc7ad-a773-43fd-a133-a7bf44cfa02f'], timeoutMs: 180000, reason: '等待视频重看任务进展' });
  const normalized = normalizeCompanionCapabilityCall(original);
  expect(normalized).toEqual({ ...original, name: 'dsh_control', arguments: JSON.stringify({ operation: 'wait', actionIds: ['959fc7ad-a773-43fd-a133-a7bf44cfa02f'], after: 0, timeoutMs: 180000 }) });
  expect(companionDshControlSchema.parse(JSON.parse(normalized.arguments)).operation).toBe('wait');
  expect(JSON.parse(original.arguments).reason).toBe('等待视频重看任务进展');
  expect(JSON.stringify(COMPANION_DSH_CAPABILITY_TOOL.parameters)).toContain('reason');
});
it.each(['status', 'wait', 'send', 'cancel'] as const)('keeps %s optional reason explanatory and still rejects invalid or unknown execution fields', operation => {
  const value = operation === 'status' || operation === 'wait' ? { operation, actionIds: ['actual_action'] }
    : { operation, actionId: 'actual_action', ...(operation === 'send' ? { message: '核对真实结果。' } : {}) };
  const valid = call({ ...value, reason: '协调当前工作。' });
  expect(JSON.parse(normalizeCompanionCapabilityCall(valid).arguments)).not.toHaveProperty('reason');
  expect(() => normalizeCompanionCapabilityCall(call({ ...value, reason: 1 }))).toThrow();
  expect(() => normalizeCompanionCapabilityCall(call({ ...value, command: 'start another task' }))).toThrow();
});
it('returns operation-specific fields and a usable wait shape instead of errors from the run union branch', () => {
  const invalid = call({ operation: 'wait', taskId: 'actual_task', timeoutMs: 180000 });
  let error: unknown; try { normalizeCompanionCapabilityCall(invalid); } catch (caught) { error = caught; }
  const feedback = companionCapabilityArgumentFeedback(invalid, error);
  expect(feedback.ok).toBe(false); expect(feedback.argumentIssues.some(issue => issue.path === 'actionIds')).toBe(true);
  expect(feedback.argumentIssues.some(issue => issue.path === 'tasks')).toBe(false);
  expect(feedback.minimumExample).toMatchObject({ operation: 'wait', actionIds: ['action_id_from_run_receipt'] });
  expect(feedback.guidance).toContain('不能填taskId');
});
it.each([
  { operation: 'run', tasks: [{ title: '查看文件夹中的表情包并挑选展示', prompt: '只读当前获准目录，按实际像素选择并交付文件。',
    session: { mode: 'new' }, delivery: { format: 'text' }, workspace: { mode: 'managed' } }] },
  { operation: 'record', query: { recordId: '12345678-1234-4123-8123-123456789abc' } },
  { operation: 'capabilities', query: { kind: 'overview' } },
  ...['read_file', 'read_image', 'send_file'].map(operation => ({ operation, parameters: { path: 'C:\\fixture\\allowed.png' } })),
])('accepts the advertised explanatory reason for $operation and strips it from the actual operation', value => {
  const input = { ...value, reason: '查看用户指定文件夹并挑选多张展示' };
  expect(companionDshCapabilitySchema.safeParse(input).success).toBe(true);
  const actual = normalizeCompanionCapabilityCall(call(input));
  expect(JSON.parse(actual.arguments)).not.toHaveProperty('reason');
  expect(() => normalizeCompanionCapabilityCall(call({ ...value, reason: 'x'.repeat(2001) }))).toThrow();
  expect(() => normalizeCompanionCapabilityCall(call({ ...value, accessMode: 'danger-full-access' }))).toThrow();
});

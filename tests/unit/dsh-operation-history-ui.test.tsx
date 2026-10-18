// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { DshLauncherState, DshOperation } from '../../src/shared/dsh-launcher';
import { LocaleProvider } from '../../src/renderer/i18n';
import { LauncherOperationsPage, OPERATIONS_PAGE_SIZE } from '../../src/renderer/launcher/LauncherOperationsPage';
import type { LauncherRunRequest } from '../../src/renderer/launcher/DshLauncher';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const run = vi.fn<LauncherRunRequest>(async () => ({ ok: true }));
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; run.mockClear(); });

function operation(index: number, extra: Partial<DshOperation> = {}): DshOperation {
  return { id: `operation-${index}`, kind: 'runtime.verify', label: `校验运行版本 ${index}`, status: 'succeeded', phase: 'completed', startedAt: '2026-10-18T00:00:00Z', ...extra };
}
function state(operations: DshOperation[]): DshLauncherState {
  return { supported: true, rootPath: 'C:\\managed', runtimes: [], snapshots: [], packs: [], operations,
    instances: [{ id: 'alpha', name: '绘画环境', runtimeId: 'runtime-a', profile: 'web', status: 'stopped', homePath: '', agentsPath: '', workspacePath: '', browserPartition: 'persist:alpha', isDefault: true, createdAt: '', updatedAt: '' }] };
}
async function render(value: DshLauncherState) {
  if (!container) { container = document.createElement('div'); document.body.append(container); root = createRoot(container); }
  await act(() => root!.render(<LocaleProvider initialPreference="zh-CN"><LauncherOperationsPage state={value} disabled={false} run={run} /></LocaleProvider>));
}
function rows() { return [...container!.querySelectorAll<HTMLElement>('[data-dsh-operation]')]; }
function button(label: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll('button')].find(item => item.textContent === label); if (!found) throw Error('Missing button: ' + label); return found;
}
async function click(label: string) { await act(() => button(label).click()); }
async function search(value: string) {
  const field = container!.querySelector<HTMLInputElement>('input[aria-label="搜索操作记录"]')!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function filter(value: string) {
  const field = container!.querySelector<HTMLSelectElement>('select[aria-label="操作状态"]')!;
  await act(() => { field.value = value; field.dispatchEvent(new Event('change', { bubbles: true })); });
}

it('renders a bounded page of history and navigates every retained operation', async () => {
  await render(state(Array.from({ length: 53 }, (_, index) => operation(index))));
  expect(rows()).toHaveLength(OPERATIONS_PAGE_SIZE); expect(rows()[0]!.dataset.dshOperation).toBe('operation-0');
  expect(button('上一页').disabled).toBe(true);
  await click('下一页'); expect(rows()).toHaveLength(20); expect(rows()[0]!.dataset.dshOperation).toBe('operation-20');
  await click('下一页'); expect(rows()).toHaveLength(13); expect(rows().at(-1)!.dataset.dshOperation).toBe('operation-52');
  expect(button('下一页').disabled).toBe(true); expect(container!.textContent).toContain('第 41–53 条 / 匹配 53 条');
  await click('上一页'); expect(rows()[0]!.dataset.dshOperation).toBe('operation-20');
});

it('searches title, raw type, instance, error and translated status across all pages', async () => {
  const needle = operation(42, { kind: 'instance.plugin', label: '安装素材工具', instanceId: 'alpha', status: 'failed', phase: 'failed', error: 'TLS certificate mismatch' });
  await render(state([...Array.from({ length: 42 }, (_, index) => operation(index)), needle]));
  for (const query of ['素材工具', 'INSTANCE.PLUGIN', '绘画环境', 'alpha', 'CERTIFICATE', '失败', 'failed', '绘画环境 certificate']) {
    await search(query); expect(rows()).toHaveLength(1); expect(rows()[0]!.dataset.dshOperation).toBe(needle.id);
  }
  await search('unmatched query'); expect(rows()).toHaveLength(0); expect(container!.textContent).toContain('没有匹配的操作记录');
  await click('清除筛选'); expect(rows()).toHaveLength(20); expect(rows()[0]!.dataset.dshOperation).toBe('operation-0');
  await filter('failed'); expect(rows()).toHaveLength(1); expect(rows()[0]!.dataset.dshOperation).toBe(needle.id);
  await search('runtime'); expect(rows()).toHaveLength(0);
  await click('清除筛选'); expect(container!.querySelector<HTMLSelectElement>('select')!.value).toBe('all'); expect(rows()).toHaveLength(20);
});

it('corrects removed last pages and resets the page when filters change', async () => {
  const initial = Array.from({ length: 43 }, (_, index) => operation(index)); await render(state(initial));
  await click('下一页'); await click('下一页'); expect(rows()).toHaveLength(3);
  await render(state(initial.slice(0, 21))); expect(rows()).toHaveLength(1); expect(rows()[0]!.dataset.dshOperation).toBe('operation-20');
  await render(state(initial)); expect(rows()[0]!.dataset.dshOperation).toBe('operation-20');
  await search('校验运行版本'); expect(rows()[0]!.dataset.dshOperation).toBe('operation-0');
  await click('下一页'); await filter('succeeded'); expect(rows()[0]!.dataset.dshOperation).toBe('operation-0');
  await render(state([])); expect(rows()).toHaveLength(0); expect(container!.textContent).toContain('暂无操作记录');
  expect(button('清理已结束记录').disabled).toBe(true);
});

it('keeps live controls, escaped failure details and global clear-finished behavior under filters', async () => {
  const live = operation(0, { status: 'running', phase: 'downloading', progress: 45, download: { transferredBytes: 200, speedBytesPerSecond: 20, paused: false, canPause: true } });
  const failed = operation(1, { label: '失败下载', status: 'failed', phase: 'failed', error: '<script>unsafe text</script>', retryRequest: { type: 'runtime.install', version: '0.2.1' } });
  const value = state([live, failed]); await render(value);
  await click('暂停下载'); expect(run).toHaveBeenCalledWith({ type: 'operation.pause', operationId: live.id });
  await click('取消操作'); expect(run).toHaveBeenCalledWith({ type: 'operation.cancel', operationId: live.id });
  await filter('failed'); expect(rows()[0]!.textContent).toContain('<script>unsafe text</script>'); expect(rows()[0]!.querySelector('script')).toBeNull();
  await click('重新下载'); expect(run).toHaveBeenCalledWith({ type: 'operation.retry', operationId: failed.id });
  await search('unmatched'); expect(rows()).toHaveLength(0); expect(button('清理已结束记录').disabled).toBe(false);
  await click('清理已结束记录'); expect(run).toHaveBeenCalledWith({ type: 'operation.clear-finished' });
  await render(state([live])); expect(button('清理已结束记录').disabled).toBe(true);
});

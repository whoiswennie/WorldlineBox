// @vitest-environment happy-dom
import { Activity, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import type { DshInstance, DshLauncherRequest, DshLauncherResponse, DshLauncherState, DshRuntime, DshOperation, WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { DshLauncher } from '../../src/renderer/launcher/DshLauncher';
import { LocaleProvider } from '../../src/renderer/i18n';
import { dshCompatibilityCheckIds } from '../../src/shared/dsh-runtime-compatibility';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(async () => {
  await act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.useRealTimers();
});

function runtime(id: string, version: string): DshRuntime {
  return { id, version, nodeVersion: '24.15.0', electronVersion: '42.2.0', platform: 'win32-x64', adapter: 'desktop-cli-web-v1', source: 'official', sourceSha256: 'a'.repeat(64), contentSha256: 'b'.repeat(64), installedAt: '2026-10-12T00:00:00Z', fileCount: 500, byteLength: 5000 };
}

function instance(id: string, name: string): DshInstance {
  return { id, name, runtimeId: 'runtime-a', profile: 'web', status: 'stopped', homePath: `C:\\managed\\${id}\\home`, agentsPath: `C:\\managed\\${id}\\agents`, workspacePath: `C:\\managed\\${id}\\workspace`, browserPartition: `persist:dsh-${id}`, isDefault: id === 'instance-a', createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z' };
}

function fixture(operations: DshOperation[] = [], extra: Partial<DshLauncherState> = {}) {
  let state: DshLauncherState = { supported: true, rootPath: 'C:\\managed', runtimes: [runtime('runtime-a', '0.9.0'), runtime('runtime-b', '0.10.0')], instances: [instance('instance-a', '环境 A'), instance('instance-b', '环境 B')], snapshots: [], packs: [], operations, ...extra };
  let listener: ((state: DshLauncherState) => void) | undefined;
  const unsubscribe = vi.fn();
  const request = vi.fn(async (input: DshLauncherRequest): Promise<DshLauncherResponse> => {
    if (input.type === 'state') return { ok: true, state };
    if (input.type === 'instance.logs') return { ok: true, text: 'instance log: <script>not executable</script>' };
    if (input.type === 'operation.clear-finished') {
      const count = state.operations.filter(operation => operation.status !== 'running').length;
      state = { ...state, operations: state.operations.filter(operation => operation.status === 'running') };
      return { ok: true, state, removedOperations: count };
    }
    if (input.type === 'cli.select') {
      state = { ...state, cli: { ...state.cli!, selectedInstanceId: input.instanceId } };
      return { ok: true, state };
    }
    if (input.type === 'terminal.input') return { ok: true };
    if (input.type === 'terminal.open') {
      state = { ...state, cli: { ...state.cli!, terminal: { id: 'private-terminal', instanceId: state.cli!.selectedInstanceId!, runtimeVersion: '0.9.0', status: 'running', cwd: 'C:\\managed\\shared\\workspace' } } };
      return { ok: true, state };
    }
    if (input.type === 'terminal.close') {
      state = { ...state, cli: { ...state.cli!, terminal: { ...state.cli!.terminal!, status: 'stopped' } } };
      return { ok: true, state };
    }
    return { ok: true, operationId: 'operation-a' };
  });
  const api: WorldlineBoxDshLauncherApi = {
    request,
    onChanged: vi.fn((next) => { listener = next; return unsubscribe; }),
  };
  return { api, request, unsubscribe, state: () => state, async publish(next: DshLauncherState) { state = next; await act(() => listener?.(next)); } };
}

async function mount(api: WorldlineBoxDshLauncherApi) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() => root!.render(<LocaleProvider initialPreference="zh-CN"><DshLauncher api={api} /></LocaleProvider>));
}

function button(text: string, scope: ParentNode = document): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.getAttribute('aria-label') === text || item.textContent === text || item.querySelector('span')?.textContent === text);
  if (!found) throw new Error(`Button missing: ${text}`);
  return found;
}

async function click(text: string, scope?: ParentNode) { await act(() => button(text, scope).click()); }

it('shows the selected instance immediately, coalesces preparation and keeps navigation responsive', async () => {
  const subject = fixture([], { cli: { selectedInstanceId: 'instance-a', commandPath: '', binPath: '', pathEnabled: false, output: '', terminals: [] } });
  const original = subject.request.getMockImplementation()!;
  let finish!: () => void;
  const preparation = new Promise<void>(resolve => { finish = resolve; });
  subject.request.mockImplementation(async request => {
    if (request.type === 'cli.select') await preparation;
    return original(request);
  });
  await mount(subject.api);
  const itemA = container!.querySelector<HTMLButtonElement>('[data-dsh-instance="instance-a"]')!;
  const itemB = container!.querySelector<HTMLButtonElement>('[data-dsh-instance="instance-b"]')!;
  await act(() => itemA.click());
  expect(subject.request.mock.calls.filter(([request]) => request.type === 'cli.select')).toHaveLength(0);
  await act(() => { itemB.click(); itemB.click(); });
  expect(container!.querySelector('.launcher-instance-details h1')!.textContent).toBe('环境 B');
  expect(itemA.disabled).toBe(false); expect(itemB.disabled).toBe(false);
  expect(button('启动实例').disabled).toBe(false);
  expect(subject.request.mock.calls.filter(([request]) => request.type === 'cli.select')).toHaveLength(0);
  const selectCli = button('设为当前 CLI');
  await act(() => { selectCli.click(); selectCli.click(); });
  expect(subject.request.mock.calls.filter(([request]) => request.type === 'cli.select')).toHaveLength(1);
  expect(container!.querySelector('[data-dsh-notification]')!.textContent).toContain('正在准备 CLI 环境');
  await click('运行版本', container!.querySelector('.launcher-navigation')!);
  expect(container!.querySelector('[data-dsh-official-versions]')).toBeNull();
  expect(container!.querySelector('[data-dsh-notification]')).toBeNull();
  await act(() => finish());
  expect(container!.querySelector('[data-dsh-notification]')).toBeNull();
  expect(subject.state().cli?.selectedInstanceId).toBe('instance-b');
});

async function fill(value: string) {
  const field = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it('switches between same-runtime instances and uses independent instance identities', async () => {
  const f = fixture();
  await mount(f.api);
  expect(container!.textContent).toContain('C:\\managed\\instance-a\\home');
  await act(() => container!.querySelector<HTMLButtonElement>('[data-dsh-instance="instance-b"]')!.click());
  expect(container!.textContent).toContain('C:\\managed\\instance-b\\home');
  expect(container!.textContent).not.toContain('C:\\managed\\instance-a\\home');
  await click('启动实例');
  expect(f.request).toHaveBeenCalledWith({ type: 'instance.start', instanceId: 'instance-b' });
  await f.publish({ ...f.state(), instances: f.state().instances.map((item) => item.id === 'instance-b' ? { ...item, status: 'running', pid: 120, port: 4321 } : item) });
  expect(button('复制实例').disabled).toBe(true);
  expect(button('停止实例').disabled).toBe(false);
  await click('打开 / 返回工作台');
  expect(f.request).toHaveBeenCalledWith({ type: 'instance.open', instanceId: 'instance-b' });
});

const cliFixture = (running = false): NonNullable<DshLauncherState['cli']> => ({
  commandPath: 'C:\\managed\\bin\\dsh.cmd', binPath: 'C:\\managed\\bin', pathEnabled: false,
  selectedInstanceId: 'instance-a', output: 'Ready for commands',
  ...(running ? { terminal: { id: 'private-terminal', instanceId: 'instance-a', runtimeVersion: '0.9.0', status: 'running' as const, cwd: 'C:\\managed\\shared\\workspace' } } : {}),
});

async function terminalInput(value: string) {
  const field = container!.querySelector<HTMLInputElement>('.launcher-terminal-input input')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return field;
}

it('selects a CLI context without starting its workbench and locks selection while the terminal runs', async () => {
  const f = fixture([], { cli: cliFixture() });
  await mount(f.api); await click('实时终端', container!.querySelector('.launcher-navigation')!);
  const select = container!.querySelector<HTMLSelectElement>('.launcher-cli-context select')!;
  expect(select.disabled).toBe(false);
  await act(() => { select.value = 'instance-b'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(f.request).toHaveBeenCalledWith({ type: 'cli.select', instanceId: 'instance-b' });
  expect(f.request.mock.calls.some(([input]) => input.type === 'instance.start')).toBe(false);
  expect(f.state().instances.every(value => value.status === 'stopped')).toBe(true);
  await click('打开终端');
  expect(select.disabled).toBe(true);
  expect(button('打开终端').disabled).toBe(true);
  expect(button('关闭终端').disabled).toBe(false);
  expect(container!.textContent).toContain('请先关闭终端');
  await click('关闭终端');
  expect(select.disabled).toBe(false);
});

it('preserves scrolled terminal output until the user returns to its bottom', async () => {
  const f = fixture([], { cli: cliFixture(true) });
  await mount(f.api); await click('实时终端', container!.querySelector('.launcher-navigation')!);
  const output = container!.querySelector<HTMLPreElement>('[data-dsh-terminal-output]')!;
  Object.defineProperties(output, { scrollHeight: { configurable: true, value: 1_000 }, clientHeight: { configurable: true, value: 200 } });
  await act(() => { output.scrollTop = 200; output.dispatchEvent(new Event('scroll')); });
  await f.publish({ ...f.state(), cli: { ...f.state().cli!, output: 'Ready for commands\nFirst streamed line' } });
  expect(container!.querySelector('[data-dsh-terminal-output]')).toBe(output);
  expect(output.textContent).toContain('First streamed line');
  expect(output.scrollTop).toBe(200);
  await act(() => { output.scrollTop = 790; output.dispatchEvent(new Event('scroll')); });
  Object.defineProperty(output, 'scrollHeight', { configurable: true, value: 1_100 });
  await f.publish({ ...f.state(), cli: { ...f.state().cli!, output: 'Ready for commands\nFirst streamed line\nSecond line' } });
  expect(output.scrollTop).toBe(1_100);
});

it('sends line input and reuses history without creating success notifications or replacing the workspace', async () => {
  const f = fixture([], { cli: cliFixture(true) });
  await mount(f.api); await click('实时终端', container!.querySelector('.launcher-navigation')!);
  const main = container!.querySelector<HTMLElement>('.launcher-main')!;
  const heading = main.querySelector('.launcher-page-heading');
  const card = main.querySelector('.launcher-terminal-card');
  main.scrollTop = 90;
  const field = await terminalInput('dsh --help');
  await click('发送', container!.querySelector('.launcher-terminal-input')!);
  expect(f.request).toHaveBeenCalledWith({ type: 'terminal.input', text: 'dsh --help\n' });
  expect(field.value).toBe('');
  expect(container!.querySelector('[data-dsh-notification]')).toBeNull();
  expect(main.querySelector('.launcher-page-heading')).toBe(heading);
  expect(main.querySelector('.launcher-terminal-card')).toBe(card);
  expect(main.scrollTop).toBe(90);
  await act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })));
  expect(field.value).toBe('dsh --help');
  await click('发送', container!.querySelector('.launcher-terminal-input')!);
  expect(f.request.mock.calls.filter(([input]) => input.type === 'terminal.input')).toHaveLength(2);
  expect(container!.querySelector('[data-dsh-notification]')).toBeNull();
});

it('does not replace a composing terminal prompt with command history', async () => {
  const f = fixture([], { cli: cliFixture(true) });
  await mount(f.api); await click('实时终端', container!.querySelector('.launcher-navigation')!);
  await terminalInput('dsh --help');
  await click('发送', container!.querySelector('.launcher-terminal-input')!);
  const field = await terminalInput('中文待选');
  await act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', isComposing: true, bubbles: true, cancelable: true })));
  expect(field.value).toBe('中文待选');
  await act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', keyCode: 229, bubbles: true, cancelable: true })));
  expect(field.value).toBe('中文待选');
  await act(() => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })));
  expect(field.value).toBe('dsh --help');
});

it('creates a named instance with an explicit pinned runtime', async () => {
  const f = fixture();
  await mount(f.api);
  await click('创建实例');
  expect(document.querySelectorAll('[role="dialog"] select')).toHaveLength(1);
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('共享会话');
  await fill('新的共享实例');
  await click('保存', document.querySelector('[role="dialog"]')!);
  expect(f.request).toHaveBeenCalledWith({ type: 'instance.create', name: '新的共享实例', runtimeId: 'runtime-a' });
  expect(f.state().instances).toHaveLength(2);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('has no save-mode switch for either verified or unchecked versions', async () => {
  const verified = runtime('runtime-a', '0.2.0-rc.2');
  verified.compatibility = { runtimeId: verified.id, contentSha256: verified.contentSha256, contract: 'fixture', status: 'passed', startedAt: '', peers: [], checks: dshCompatibilityCheckIds.map(id => ({ id, status: 'passed', detail: 'fixture' })) };
  const f = fixture([], { runtimes: [verified, runtime('runtime-b', '0.2.0-rc.1')] });
  await mount(f.api); await click('创建实例');
  expect(document.querySelectorAll('[role="dialog"] select')).toHaveLength(1);
  await click('保存', document.querySelector('[role="dialog"]')!);
  expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ type: 'instance.create', runtimeId: 'runtime-a' }));
  await click('创建实例');
  const runtimeField = document.querySelector<HTMLSelectElement>('[role="dialog"] select')!;
  await act(() => { runtimeField.value = 'runtime-b'; runtimeField.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(document.querySelectorAll('[role="dialog"] select')).toHaveLength(1);
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('独立存档');
});

it('selects a new default CLI context immediately and requires an explicit Web workbench switch', async () => {
  const a = { ...instance('instance-a', '环境 A'), status: 'running' as const };
  const f = fixture([], { instances: [a, instance('instance-b', '环境 B')], cli: cliFixture() });
  await mount(f.api);
  await act(() => container!.querySelector<HTMLButtonElement>('[data-dsh-instance="instance-b"]')!.click());
  expect(f.request.mock.calls.some(([request]) => request.type === 'cli.select')).toBe(false);
  await click('设为当前 CLI');
  expect(f.request).toHaveBeenCalledWith({ type: 'cli.select', instanceId: 'instance-b' });
  expect(f.request.mock.calls.some(([request]) => request.type === 'instance.stop' || request.type === 'instance.switch-start')).toBe(false);
  expect(button('切换并启动').disabled).toBe(false);
  await click('切换并启动');
  expect(f.request).toHaveBeenCalledWith({ type: 'instance.switch-start', instanceId: 'instance-b' });
});

it('requests an upgrade copy without changing the source runtime', async () => {
  const f = fixture();
  await mount(f.api);
  await click('创建升级副本');
  await fill('升级验证');
  const select = document.querySelector<HTMLSelectElement>('[role="dialog"] select')!;
  await act(() => { select.value = 'runtime-b'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('保存', document.querySelector('[role="dialog"]')!);
  expect(f.request).toHaveBeenCalledWith({ type: 'instance.clone', instanceId: 'instance-a', name: '升级验证', runtimeId: 'runtime-b' });
  expect(f.state().instances[0]!.runtimeId).toBe('runtime-a');
});

it('requires a concrete credentials notice before exporting a full backup', async () => {
  const f = fixture();
  await mount(f.api);
  await click('快照与备份');
  await click('导出完整备份');
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('没有自动脱敏');
  expect(f.request.mock.calls.some(([input]) => input.type === 'backup.export')).toBe(false);
  await click('我了解，选择导出位置');
  expect(f.request).toHaveBeenCalledWith({ type: 'backup.export', instanceId: 'instance-a' });
});

it('creates a pack with a fixed version and installs packs into a named new instance', async () => {
  const f = fixture();
  await mount(f.api);
  await click('快照与备份');
  await click('生成整合包');
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('凭据');
  await fill('角色工具环境');
  await click('保存', document.querySelector('[role="dialog"]')!);
  expect(f.request).toHaveBeenCalledWith({ type: 'pack.create', instanceId: 'instance-a', name: '角色工具环境', version: '1.0.0' });
  await f.publish({ ...f.state(), packs: [{ id: 'pack-a', name: '角色工具环境', version: '1.0.0', runtimeId: 'runtime-a', runtimeVersion: '0.9.0', contentSha256: 'b'.repeat(64), createdAt: '2026-10-12T00:00:00Z', fileCount: 500, byteLength: 5000 }] });
  await click('整合包', container!.querySelector('.launcher-navigation')!);
  await click('安装为新实例');
  await fill('独立的整合包实例');
  await click('保存', document.querySelector('[role="dialog"]')!);
  expect(f.request).toHaveBeenCalledWith({ type: 'pack.install', packId: 'pack-a', name: '独立的整合包实例' });
});

it('shows asynchronous failures and suspends subscriptions and log polling when hidden', async () => {
  const f = fixture();
  await mount(f.api);
  await f.publish({ ...f.state(), operations: [{ id: 'operation-a', kind: 'instance.start', label: '启动 环境 A', instanceId: 'instance-a', status: 'failed', phase: 'failed', error: 'Port unavailable', startedAt: '2026-10-12T00:00:00Z' }] });
  expect(container!.querySelector('[role="alert"]')!.textContent).toContain('Port unavailable');
  await click('操作记录');
  expect(container!.textContent).toContain('Port unavailable');
  await click('实例', container!.querySelector('.launcher-navigation')!);
  await click('运行日志');
  expect(container!.querySelector('[data-dsh-logs]')!.textContent).toContain('<script>not executable</script>');
  expect(container!.querySelector('[data-dsh-logs] script')).toBeNull();
  await act(() => root!.render(<LocaleProvider initialPreference="zh-CN"><Activity mode="hidden"><DshLauncher api={f.api} /></Activity></LocaleProvider>));
  expect(f.unsubscribe).toHaveBeenCalled();
});

it('keeps startup failures in history and does not re-alert dismissed or retried failures', async () => {
  const old: DshOperation = { id: 'old-download', kind: 'runtime.download', label: '旧下载', status: 'failed', phase: 'failed', error: 'Invalid URL', startedAt: '2026-10-12T00:00:00Z' };
  const f = fixture([old]);
  await mount(f.api);
  expect(container!.querySelector('[role="alert"]')).toBeNull();
  await click('操作记录');
  expect(container!.querySelector('[data-dsh-operation="old-download"]')!.textContent).toContain('Invalid URL');
  const failure = { ...old, id: 'new-download', error: 'Current network error' };
  await f.publish({ ...f.state(), operations: [failure, old] });
  await click('关闭', container!.querySelector('[role="alert"]')!);
  await click('刷新');
  expect(container!.querySelector('[role="alert"]')).toBeNull();
  const retryFailure = { ...failure, kind: 'runtime.verify', id: 'retry-verify', error: 'Current import error' };
  await f.publish({ ...f.state(), operations: [retryFailure, failure, old] });
  expect(container!.querySelector('[role="alert"]')!.textContent).toContain('Current import error');
  await click('运行版本', container!.querySelector('.launcher-navigation')!);
  await click('校验运行文件', container!.querySelector('[data-dsh-runtime="runtime-a"]')!);
  expect(container!.querySelector('[role="alert"]')).toBeNull();
  await click('刷新');
  expect(container!.querySelector('[role="alert"]')).toBeNull();
});

it('clears finished history through the typed API while retaining ongoing operations', async () => {
  const failed: DshOperation = { id: 'failed-download', kind: 'runtime.download', label: '旧下载', status: 'failed', phase: 'failed', error: 'Invalid URL', startedAt: '2026-10-12T00:00:00Z' };
  const active = { ...failed, id: 'active-download', label: '当前下载', status: 'running' as const, phase: 'downloading', error: undefined };
  const f = fixture([active, failed]); await mount(f.api); await click('操作记录');
  expect(button('清理已结束记录').disabled).toBe(false);
  await click('清理已结束记录');
  expect(f.request).toHaveBeenCalledWith({ type: 'operation.clear-finished' });
  expect(container!.querySelector('[data-dsh-operation="failed-download"]')).toBeNull();
  expect(container!.querySelector('[data-dsh-operation="active-download"]')).not.toBeNull();
  expect(button('清理已结束记录').disabled).toBe(true);
  expect(container!.querySelector('[role="status"]')!.textContent).toContain('已清理 1 条');
  expect(container!.querySelector('.launcher-main [role="status"]')).toBeNull();
  expect(container!.querySelector('[role="status"]')!.closest('[data-dsh-notification]')).not.toBeNull();
});

it('expires success feedback while preserving the workspace nodes and scroll position', async () => {
  vi.useFakeTimers();
  const finished: DshOperation = { id: 'finished', kind: 'runtime.verify', label: '已完成校验', status: 'succeeded', phase: 'completed', startedAt: '2026-10-12T00:00:00Z' };
  const f = fixture([finished]); await mount(f.api); await click('操作记录');
  const main = container!.querySelector<HTMLElement>('.launcher-main')!;
  const heading = main.querySelector('.launcher-page-heading');
  main.scrollTop = 80;
  await click('清理已结束记录');
  expect(main.querySelector('.launcher-page-heading')).toBe(heading);
  expect(main.scrollTop).toBe(80);
  expect(main.querySelector('[role="status"]')).toBeNull();
  expect(container!.querySelector('[data-dsh-notification]')).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(5_001));
  expect(container!.querySelector('[data-dsh-notification]')).toBeNull();
  expect(main.querySelector('.launcher-page-heading')).toBe(heading);
  expect(main.scrollTop).toBe(80);
});

it('keeps errors floating with readable details and explicitly routes to operation history', async () => {
  const f = fixture(); await mount(f.api);
  const main = container!.querySelector<HTMLElement>('.launcher-main')!;
  const card = main.querySelector('.launcher-card');
  main.scrollTop = 150;
  await f.publish({ ...f.state(), operations: [{ id: 'new-failure', kind: 'runtime.verify', label: '校验失败', status: 'failed', phase: 'failed', error: 'A long failure message with diagnostic detail', startedAt: '2026-10-12T00:00:00Z' }] });
  expect(main.querySelector('[role="alert"]')).toBeNull();
  expect(main.querySelector('.launcher-card')).toBe(card);
  expect(main.scrollTop).toBe(150);
  await click('详细信息', container!.querySelector('[data-dsh-notification]')!);
  expect(container!.querySelector('.launcher-notice-details')!.textContent).toContain('diagnostic detail');
  expect(main.querySelector('.launcher-card')).toBe(card);
  expect(main.scrollTop).toBe(150);
  await click('查看操作详情', container!.querySelector('[data-dsh-notification]')!);
  expect(container!.querySelector('[data-dsh-operation="new-failure"]')).not.toBeNull();
  expect(container!.querySelector('[data-dsh-notification]')).toBeNull();
});

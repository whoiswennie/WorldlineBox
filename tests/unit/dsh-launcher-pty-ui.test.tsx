// @vitest-environment happy-dom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { DshLauncherState, DshTerminal } from '../../src/shared/dsh-launcher';
import { LocaleProvider } from '../../src/renderer/i18n';
import { LauncherTerminal } from '../../src/renderer/launcher/LauncherTerminal';
import type { LauncherRunRequest } from '../../src/renderer/launcher/DshLauncher';
import type { TerminalSurfaceHandle } from '../../src/renderer/launcher/TerminalSurface';

const surfaces = vi.hoisted(() => ({ values: new Map<string, { onInput(data: string): void; onResize(cols: number, rows: number): void; readOnly: boolean }>(), search: vi.fn() }));
vi.mock('../../src/renderer/launcher/TerminalSurface', () => ({
  connectTerminalOutput: vi.fn(), retainTerminalViews: vi.fn(),
  TerminalSurface: (props: { sessionId: string; active: boolean; readOnly: boolean; onInput(data: string): void; onResize(cols: number, rows: number): void; onReady?(view?: TerminalSurfaceHandle): void }) => {
    surfaces.values.set(props.sessionId, props);
    useEffect(() => {
      props.onReady?.({ focus() {}, follow() {}, clear() {}, selection: () => '', text: () => 'terminal text', paste: text => props.onInput(text), search: surfaces.search });
      return () => props.onReady?.();
    }, [props]);
    return <div data-dsh-terminal-output data-terminal-session={props.sessionId} data-readonly={String(props.readOnly)} />;
  },
}));

let root: Root | undefined; let container: HTMLDivElement | undefined;
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); root = undefined; container = undefined; surfaces.values.clear(); surfaces.search.mockReset(); });
function state(): DshLauncherState {
  const terminal = (id: string, instanceId: string, status: DshTerminal['status']): DshTerminal => ({ id, instanceId, status, runtimeVersion: '0.2.1-alpha.2', cwd: 'C:\\managed\\shared\\workspace', output: 'PS> ', outputOffset: 0, outputRevision: 0, cols: 80, rows: 24, transport: 'conpty' });
  return { supported: true, rootPath: 'C:\\managed', runtimes: [], snapshots: [], packs: [], operations: [],
    instances: ['a', 'b'].map(id => ({ id: `instance-${id}`, name: `环境 ${id.toUpperCase()}`, runtimeId: 'runtime-a', createdAt: '', updatedAt: '', profile: 'web', status: 'stopped', homePath: '', agentsPath: '', workspacePath: '', browserPartition: '', isDefault: id === 'a' })),
    cli: { selectedInstanceId: 'instance-b', commandPath: 'C:\\managed\\cli\\bin\\dsh.cmd', binPath: '', pathEnabled: false, output: '', activeTerminalId: 'terminal-a', terminals: [terminal('terminal-a', 'instance-a', 'running'), terminal('terminal-b', 'instance-b', 'stopped')] } };
}
async function mount(value: DshLauncherState, run: LauncherRunRequest) {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(() => root!.render(<LocaleProvider initialPreference="zh-CN"><LauncherTerminal state={value} run={run} busy={false} /></LocaleProvider>));
}
function button(label: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label);
  if (!found) throw new Error(`Missing button ${label}`); return found;
}

it('changes the default CLI instance without closing existing terminals and opens a targeted new session', async () => {
  const run = vi.fn<LauncherRunRequest>().mockResolvedValue({ ok: true });
  await mount(state(), run);
  const select = container!.querySelector<HTMLSelectElement>('.launcher-cli-context select')!;
  expect(select.disabled).toBe(false);
  await act(() => button('新建终端').click());
  expect(run).toHaveBeenCalledWith({ type: 'terminal.open', instanceId: 'instance-b' });
  await act(() => { select.value = 'instance-a'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(run).toHaveBeenCalledWith({ type: 'cli.select', instanceId: 'instance-a' });
  expect(run.mock.calls.some(([request]) => request.type === 'terminal.close' || request.type === 'instance.start')).toBe(false);
  expect(container!.querySelectorAll('[role="tab"]')).toHaveLength(2);
});

it('sends raw input and interrupt bytes to the owning session, with independent readonly ended sessions', async () => {
  const run = vi.fn<LauncherRunRequest>().mockResolvedValue({ ok: true });
  await mount(state(), run);
  await act(() => surfaces.values.get('terminal-a')!.onInput('x'));
  expect(run).toHaveBeenCalledWith({ type: 'terminal.input', terminalId: 'terminal-a', text: 'x' });
  await act(() => button('中断命令').click());
  expect(run).toHaveBeenCalledWith({ type: 'terminal.input', terminalId: 'terminal-a', text: '\u0003' });
  await act(() => surfaces.values.get('terminal-a')!.onResize(95, 30));
  expect(run).toHaveBeenCalledWith({ type: 'terminal.resize', terminalId: 'terminal-a', cols: 95, rows: 30 });
  expect(surfaces.values.get('terminal-b')!.readOnly).toBe(true);
  expect(container!.querySelector('.launcher-terminal-input')).toBeNull();
});

it('searches terminal output and exports only the selected session log', async () => {
  const run = vi.fn<LauncherRunRequest>().mockResolvedValue({ ok: true }); surfaces.search.mockReturnValue(false);
  await mount(state(), run);
  await act(() => button('查找').click());
  const field = container!.querySelector<HTMLInputElement>('.launcher-terminal-search input')!;
  await act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'needle'); field.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(() => button('下一处').click());
  expect(surfaces.search).toHaveBeenCalledWith('needle', false);
  expect(container!.textContent).toContain('没有匹配结果');
  await act(() => button('导出日志').click());
  expect(run).toHaveBeenCalledWith({ type: 'terminal.export', terminalId: 'terminal-a' });
  await act(() => button('环境 B').click());
  expect(run).toHaveBeenCalledWith({ type: 'terminal.select', terminalId: 'terminal-b' });
});

it('navigates terminal tabs by keyboard without treating IME composition as navigation and removes an ended tab', async () => {
  const run = vi.fn<LauncherRunRequest>().mockResolvedValue({ ok: true });
  const value = state(); await mount(value, run);
  const first = container!.querySelector<HTMLButtonElement>('#terminal-tab-terminal-a')!;
  await act(() => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', isComposing: true, bubbles: true })));
  expect(run).not.toHaveBeenCalled();
  await act(() => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(run).toHaveBeenCalledWith({ type: 'terminal.select', terminalId: 'terminal-b' });
  expect(document.activeElement?.id).toBe('terminal-tab-terminal-b');
  await act(() => root!.render(<LocaleProvider initialPreference="zh-CN"><LauncherTerminal state={{ ...value, cli: { ...value.cli!, activeTerminalId: 'terminal-b' } }} run={run} busy={false} /></LocaleProvider>));
  await act(() => button('关闭标签页').click());
  expect(run).toHaveBeenCalledWith({ type: 'terminal.remove', terminalId: 'terminal-b' });
});

it('closes a running tab once, waits for process cleanup, then removes only that tab', async () => {
  let stopped!: (result: { ok: true }) => void;
  const waitForStop = new Promise<{ ok: true }>(resolve => { stopped = resolve; });
  const run = vi.fn<LauncherRunRequest>().mockImplementation(request => request.type === 'terminal.close' ? waitForStop : Promise.resolve({ ok: true }));
  await mount(state(), run);
  const close = button('关闭终端：环境 A');
  await act(() => { close.click(); close.click(); });
  expect(run.mock.calls.filter(([request]) => request.type === 'terminal.close')).toHaveLength(1);
  expect(run).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal.remove' }));
  expect(close.disabled).toBe(true);
  expect(button('新建终端').disabled).toBe(false);
  expect(button('关闭终端：环境 B').disabled).toBe(false);
  await act(() => stopped({ ok: true }));
  expect(run).toHaveBeenCalledWith({ type: 'terminal.remove', terminalId: 'terminal-a' });
  expect(run).not.toHaveBeenCalledWith({ type: 'terminal.close', terminalId: 'terminal-b' });
});

it('keeps the output tab if owned process shutdown fails', async () => {
  const run = vi.fn<LauncherRunRequest>().mockResolvedValue({ ok: false, error: 'Could not finish owned process cleanup.' });
  await mount(state(), run);
  await act(() => button('关闭终端：环境 A').click());
  expect(run).toHaveBeenCalledWith({ type: 'terminal.close', terminalId: 'terminal-a' });
  expect(run).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal.remove' }));
  expect(button('关闭终端：环境 A').disabled).toBe(false);
});

// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BotDiagnostics, BotErrorNotice } from '../../src/renderer/companion-bot/BotErrorNotice';
import { botUiSharedLauncher } from '../fixtures/bot-ui-shared-launcher';
import type { DshLauncherRequest, DshLauncherResponse } from '../../src/shared/dsh-launcher';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
afterEach(async () => { await act(() => root.unmount()); document.body.replaceChildren(); });
async function mount(message: string, toast = false) {
  const fixture = await botUiSharedLauncher().request({ type: 'state' });
  if (!fixture.ok || !fixture.state) throw Error('Expected launcher state');
  const state = fixture.state;
  state.instances.push({ ...state.instances[0]!, id: 'previous', name: '之前的实例', isDefault: false });
  const request = vi.fn(async (input: DshLauncherRequest): Promise<DshLauncherResponse> => input.type === 'instance.logs'
    ? { ok: true, text: 'started\nAuthorization: Bearer sample-credential\nrecord' } : { ok: true });
  const openModelSettings = vi.fn();
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(() => root.render(<BotDiagnostics.Provider value={{ api: { request, onChanged: () => () => undefined }, state, openModelSettings }}>
    <BotErrorNotice message={message} zh toast={toast} /></BotDiagnostics.Provider>));
  return { request, openModelSettings };
}

it('summarizes a DSH send failure in a toast while preserving its log and full detail', async () => {
  const message = '内置 DSH 正在更新，本次消息未发送。请在电脑启动器确认共享 DSH 已就绪后重新发送。';
  const { request } = await mount(message, true);
  expect(document.querySelector('.bot-error-toast-title')?.textContent).toBe('消息未发送');
  expect(document.querySelector('.bot-error-notice > p')?.textContent).toContain('内置 DSH 正在更新');
  await click('查看当前实例日志');
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: 'instance.logs' }));
  await click('关闭');
  await click('错误详情');
  expect(document.querySelector('dialog pre')?.textContent).toBe(message);
});
async function click(text: string) {
  const button = Array.from(document.querySelectorAll('button')).find(node => node.textContent === text || node.getAttribute('aria-label') === text);
  expect(button).toBeDefined();
  await act(() => button!.click());
}

it('opens the recorded instance log, refreshes it and reveals only its managed folder', async () => {
  const { request } = await mount('DSH 启动超时，请查看 D:/old profile/dsh/instances/previous/logs/host.log');
  expect(request).not.toHaveBeenCalled();
  await click('查看实例日志');
  expect(request).toHaveBeenLastCalledWith({ type: 'instance.logs', instanceId: 'previous' });
  expect(document.querySelector('dialog pre')?.textContent).toBe('started\nAuthorization: Bearer [redacted]\nrecord');
  await click('刷新');
  expect(request).toHaveBeenCalledTimes(2);
  await click('打开日志文件夹');
  expect(request).toHaveBeenLastCalledWith({ type: 'instance.folder', instanceId: 'previous', scope: 'logs' });
  await click('关闭');
  await click('错误详情');
  expect(document.querySelector('dialog pre')?.textContent).toContain('previous/logs/host.log');
});
it('keeps details for a removed instance without attributing its log to the new default', async () => {
  const { request } = await mount('DSH 启动超时 D:/dsh/instances/deleted/logs/host.log');
  expect(document.querySelector('.bot-diagnostic-actions')?.textContent).not.toContain('实例日志');
  await click('错误详情');
  expect(request).not.toHaveBeenCalled();
});
it.each([
  ['401 invalid_api_key sk-sample-12345', '身份验证', true],
  ['429 insufficient_quota', '额度不足', true],
  ['403 Forbidden', '访问权限', true],
  ['429 rate_limit_exceeded', '请求频率', false],
  ['400 context_length_exceeded', '压缩当前话题', false],
  ['LlmError: Request timed out.: Connect Timeout Error (attempted address: api.deepseek.com:443, timeout: 10000ms) (UND_ERR_CONNECT_TIMEOUT)', '模型请求超时', false],
  ['Disk read failed', 'Disk read failed', false],
])('explains %s and preserves the redacted original detail', async (message, hint, settings) => {
  const { openModelSettings } = await mount(message);
  expect(document.querySelector('.bot-error-notice > p')?.textContent).toContain(hint);
  if (settings) { await click('打开模型设置'); expect(openModelSettings).toHaveBeenCalledOnce(); }
  await click('错误详情');
  expect(document.querySelector('pre')?.textContent).toBe(message.replace('sk-sample-12345', '[redacted]'));
});

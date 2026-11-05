// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotMessage, BotReplyProgress } from '../../src/shared/companion-bot';
import { BotReplyProgressIndicator } from '../../src/renderer/companion-bot/BotReplyProgress';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, host: HTMLDivElement;
const createdAt = '2026-11-03T10:00:00Z';
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(Date.parse(createdAt) + 2500);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
async function render(status: BotMessage['status'], progress?: BotReplyProgress, onStop = vi.fn(), timestamp = createdAt, locale: 'zh-CN' | 'en' = 'zh-CN') {
  await act(() => root.render(<BotReplyProgressIndicator message={{ status, progress, createdAt: timestamp }} locale={locale} onStop={onStop} />));
}

it('shows every actual phase and safe tool labels, including unknown tools without exposing provider detail', async () => {
  const labels: [BotReplyProgress['phase'], string][] = [
    ['memory-starting', '正在唤醒伙伴记忆'], ['memory-verifying', '正在校验内置记忆引擎'], ['memory-indexing', '正在同步记忆索引'],
    ['queued', '等待处理'], ['recalling-memory', '正在检索记忆'], ['preparing-context', '准备上下文'],
    ['compacting-context', '正在整理长对话'], ['waiting-runtime', '等待运行环境'], ['waiting-model', '等待模型响应'],
    ['generating', '正在生成回复'], ['retrying', '正在恢复连接'], ['reconciling', '正在核实先前操作'],
  ];
  for (const [phase, label] of labels) {
    await render('running', { phase }); expect(host.querySelector('[role=status]')?.textContent).toBe(label);
  }
  await render('running', { phase: 'using-tool', toolName: 'dsh_task', detail: '{ "goal": "private reasoning" }' });
  expect(host.textContent).toContain('提交执行任务'); expect(host.textContent).not.toContain('private');
  await render('running', { phase: 'using-tool', toolName: 'unknown_secret_tool' });
  expect(host.querySelector('[role=status]')?.textContent).toBe('正在使用工具'); expect(host.textContent).not.toContain('secret');
});

it('distinguishes receipt reconciliation from reconnecting in both languages without exposing provider detail', async () => {
  const stop = vi.fn(), progress: BotReplyProgress = { phase: 'reconciling', toolName: 'dsh_task', detail: 'private provider arguments and reasoning' };
  await render('running', progress, stop);
  expect(host.querySelector('[role=status]')?.textContent).toBe('正在核实先前操作');
  expect(host.querySelector('.bot-reply-progress')?.getAttribute('data-phase')).toBe('reconciling');
  expect(host.textContent).not.toContain('正在恢复连接'); expect(host.textContent).not.toContain('private');
  await act(() => vi.advanceTimersByTime(1000)); expect(host.textContent).toContain('已用 3 秒');
  await render('running', progress, stop, createdAt, 'en');
  expect(host.querySelector('[role=status]')?.textContent).toBe('Checking prior actions');
  expect(host.textContent).not.toContain('Reconnecting'); expect(host.textContent).not.toContain('private');
  await act(() => host.querySelector<HTMLButtonElement>('button')!.click()); expect(stop).toHaveBeenCalledOnce();
  await render('cancelled', progress); expect(host.textContent).toBe(''); expect(vi.getTimerCount()).toBe(0);
});

it('keeps the elapsed clock across phases, cancels through the real handler and disposes timers on terminal states', async () => {
  const stop = vi.fn(); await render('running', { phase: 'recalling-memory' }, stop);
  expect(host.textContent).toContain('已用 2 秒'); expect(vi.getTimerCount()).toBe(1);
  await act(() => vi.advanceTimersByTime(3000)); expect(host.textContent).toContain('已用 5 秒');
  await render('running', { phase: 'using-tool', toolName: 'chat_list_stickers' }, stop);
  expect(host.textContent).toContain('挑选表情'); expect(host.textContent).toContain('已用 5 秒'); expect(vi.getTimerCount()).toBe(1);
  await act(() => host.querySelector<HTMLButtonElement>('button')!.click()); expect(stop).toHaveBeenCalledOnce();
  await render('cancelled'); expect(host.textContent).toBe(''); expect(vi.getTimerCount()).toBe(0);
  await render('running', { phase: 'waiting-model' }); expect(vi.getTimerCount()).toBe(1);
  await render('sent'); expect(host.textContent).toBe(''); expect(vi.getTimerCount()).toBe(0);
});

it('does not invent an elapsed time for an invalid timestamp', async () => {
  await render('running', { phase: 'waiting-model' }, vi.fn(), 'invalid');
  expect(host.textContent).toContain('等待模型响应'); expect(host.querySelector('.bot-reply-progress-elapsed')).toBeNull();
});

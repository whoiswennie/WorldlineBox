// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BotCompanionEditor } from '../../src/renderer/companion-bot/BotCompanionEditor';
import { BotCompanionAppearance } from '../../src/renderer/companion-bot/BotCompanionAppearance';
import { readBotCallPreferences, saveBotCallPreferences } from '../../src/renderer/companion-bot/call-preferences';
import { LocaleProvider } from '../../src/renderer/i18n';
import type { BotCompanion, BotRequest, BotResponse, WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import { BotCompanionSchedules } from '../../src/renderer/companion-bot/BotCompanionSchedules';
import type { CompanionSchedule } from '../../src/shared/companion-schedule';
import { cabinSchedulePresets } from '../../src/shared/companion-schedule';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
const companion: BotCompanion = { id: 'settings-owner', name: '星海伙伴', persona: '独立的相处方式', createdAt: '2026-11-06T00:00:00.000Z' };
beforeEach(() => { localStorage.clear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(() => root?.unmount()); host.remove(); localStorage.clear(); });
async function click(text: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)!;
  expect(button, text).toBeTruthy(); await act(() => button.click());
}
async function fill(selector: string, value: string) {
  const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  await act(() => { Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function mount(save = vi.fn(async (): Promise<BotResponse> => ({ ok: true })), launcherApi?: WorldlineBoxDshLauncherApi) {
  const calls: BotRequest[] = [];
  const persona = { id: 'default', name: '默认人格', prompt: companion.persona, builtin: false, isDefault: true, modified: false, charCount: companion.persona.length, updatedAt: companion.createdAt };
  const api: WorldlineBoxBotApi = { request: async request => {
    calls.push(request);
    if (request.type === 'companion.personas.list' || request.type === 'companion.personas.get') return { ok: true, personas: { items: [persona], activeId: persona.id, limit: 64 }, ...(request.type === 'companion.personas.get' ? { persona } : {}) };
    if (request.type === 'companion.schedule') return { ok: true, schedule: { enabled: false, items: cabinSchedulePresets.map((preset, index) => ({ ...preset, id: `cabin-preset-${index}`, enabled: false, nextAt: 0 })) } };
    return { ok: true };
  }, onEvent: () => () => undefined };
  await act(() => root!.render(<LocaleProvider initialPreference="zh-CN"><BotCompanionEditor api={api} launcherApi={launcherApi} kind="companion" companion={companion} companions={[companion]} locale="zh-CN" onSave={save} onCancel={() => undefined} /></LocaleProvider>));
  return { save, calls };
}

it('keeps persona, profile and task drafts across settings sections and saves the chosen concurrency with profile without overwriting the persona', async () => {
  const f = await mount();
  expect(host.querySelector('[role=dialog]')?.getAttribute('aria-label')).toBe('角色卡 · 星海伙伴');
  await fill('textarea[name=persona]', '尚未保存的人格草稿');
  await fill('[name=name]', '新的伙伴名字');
  expect(host.querySelector<HTMLInputElement>('[name=workerConcurrency]')?.value).toBe('5');
  await fill('[name=workerConcurrency]', '8'); await click('形象与表演'); await click('资料与人格');
  expect(host.querySelector<HTMLTextAreaElement>('textarea[name=persona]')?.value).toBe('尚未保存的人格草稿');
  expect(host.querySelector<HTMLInputElement>('[name=name]')?.value).toBe('新的伙伴名字');
  await act(() => host.querySelector<HTMLFormElement>('.bot-editor-basics')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(f.save).toHaveBeenCalledExactlyOnceWith({ name: '新的伙伴名字', workerConcurrency: 8, members: [], groupMode: 'automatic' });
  expect(f.calls.some(request => request.type === 'companion.personas.save')).toBe(false);
});

it('rejects invalid concurrency, preserves a failed-save draft and retries without losing edits', async () => {
  const save = vi.fn(async (): Promise<BotResponse> => ({ ok: false, error: '暂时无法保存' })); await mount(save);
  for (const value of ['', '0', '1.5', '33']) {
    await fill('[name=workerConcurrency]', value);
    await act(() => host.querySelector<HTMLFormElement>('.bot-editor-basics')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(save).not.toHaveBeenCalled(); expect(host.querySelector<HTMLInputElement>('[name=workerConcurrency]')?.getAttribute('aria-invalid')).toBe('true');
  }
  await fill('[name=workerConcurrency]', '3');
  await act(() => host.querySelector<HTMLFormElement>('.bot-editor-basics')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(host.querySelector('.bot-editor-basics [role=alert]')?.textContent).toContain('暂时无法保存');
  await click('日程'); await click('资料与人格'); expect(host.querySelector<HTMLInputElement>('[name=workerConcurrency]')?.value).toBe('3');
  save.mockResolvedValueOnce({ ok: true });
  await act(() => host.querySelector<HTMLFormElement>('.bot-editor-basics')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(save).toHaveBeenCalledTimes(2); expect(save.mock.calls[0]).toEqual(save.mock.calls[1]);
});

it('keeps native environment management outside the character card', async () => {
  const request = vi.fn(async () => ({ ok: false as const, error: '未配置 DSH 运行环境' }));
  await mount(undefined, { request, onChanged: () => () => undefined } as WorldlineBoxDshLauncherApi);
  expect(request).not.toHaveBeenCalled();
  expect([...host.querySelectorAll('.bot-editor-tabs button')].some(button => button.textContent?.includes('能力档案'))).toBe(false);
  expect(host.querySelectorAll('[role=dialog]')).toHaveLength(1);
  expect(host.querySelector('[data-companion-capabilities]')).toBeNull();
  expect(host.querySelector<HTMLTextAreaElement>('textarea[name=persona]')?.value).toBe(companion.persona);
});

it('saves appearance immediately for this companion, preserving another companion and leaving server settings untouched', async () => {
  const f = await mount(); await click('形象与表演');
  expect(host.querySelector('[aria-label="自动朗读伙伴回复"]')).toBeNull();
  await act(() => host.querySelector<HTMLInputElement>('[aria-label="视线跟随鼠标"]')!.click());
  expect(readBotCallPreferences(companion.id)).toMatchObject({ gazeEnabled: true, idleEnabled: true });
  expect(readBotCallPreferences('another-owner')).toMatchObject({ gazeEnabled: false });
  expect(f.save).not.toHaveBeenCalled();
});

it('edits a Cabin World preset through the same schedule form', async () => {
  const fixture = await mount();
  await click('日程');
  const item = [...host.querySelectorAll('.bot-schedule-item')].find(row => row.textContent?.includes('定时照顾小鱼'))!;
  await act(async () => [...item.querySelectorAll('button')].find(button => button.textContent === '编辑')!.click());
  await act(() => host.querySelector<HTMLFormElement>('.bot-schedule-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(fixture.calls).toContainEqual({ type: 'companion.schedule', companionId: companion.id, command: {
    operation: 'save', id: 'cabin-preset-2', draft: { title: '定时照顾小鱼', prompt: expect.stringContaining('小屋世界'), recurrence: { kind: 'interval', minutes: 180 }, enabled: false, cabinWorld: true },
  } });
});

it('paginates many schedules, searches prompt text and opens the full prompt for editing', async () => {
  const items: CompanionSchedule[] = Array.from({ length: 26 }, (_, index) => ({ id: String(index), title: `日程 ${index + 1}`, enabled: true,
    nextAt: 1_800_000_000_000 + index * 60000, recurrence: index % 2 ? { kind: 'daily', time: '20:00' } : { kind: 'interval', minutes: 60 },
    prompt: index === 25 ? `${'完整提示词。'.repeat(50)}特定检索词` : '检查游戏状态。' }));
  const calls: BotRequest[] = [];
  const api: WorldlineBoxBotApi = { request: async request => { calls.push(request); return { ok: true, schedule: { enabled: true, items } }; }, onEvent: () => () => undefined };
  await act(async () => root!.render(<BotCompanionSchedules api={api} companionId={companion.id} locale="zh-CN" />));
  expect(host.querySelectorAll('.bot-schedule-item')).toHaveLength(8);
  await click('下一页');
  expect(host.querySelector('.bot-schedule-item strong')?.textContent).toBe('日程 9');
  await fill('input[type=search]', '特定检索词');
  expect(host.querySelectorAll('.bot-schedule-item')).toHaveLength(1);
  expect(host.querySelector('.bot-schedule-preview')?.textContent).not.toContain('特定检索词');
  await act(async () => host.querySelector<HTMLButtonElement>('.bot-schedule-summary')!.click());
  expect(host.querySelector('.bot-schedule-prompt')?.textContent).toBe(items[25]!.prompt);
  await click('编辑');
  expect(host.querySelector<HTMLTextAreaElement>('.bot-schedule-form textarea')?.value).toBe(items[25]!.prompt);
  await fill('.bot-schedule-form textarea', '更新后的任务提示词');
  await act(async () => host.querySelector<HTMLFormElement>('.bot-schedule-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(calls.at(-1)).toMatchObject({ type: 'companion.schedule', command: { operation: 'save', id: '25', draft: { prompt: '更新后的任务提示词' } } });
});

it('reloads meeting preferences when returning to the character card without remounting the editor', async () => {
  const render = async (active: boolean) => act(() => root!.render(<BotCompanionAppearance companion={companion} locale="zh-CN" active={active} />));
  await render(true);
  expect(host.querySelector<HTMLInputElement>('[aria-label="视线跟随鼠标"]')?.checked).toBe(false);
  await render(false); saveBotCallPreferences(companion.id, { gazeEnabled: true });
  await render(true);
  expect(host.querySelector<HTMLInputElement>('[aria-label="视线跟随鼠标"]')?.checked).toBe(true);
});

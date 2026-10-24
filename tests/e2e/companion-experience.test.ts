import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { Companion, CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionExperienceEntry } from '../../src/shared/companion-experience';
import { THEME_PREF_KEY } from '../../src/renderer/theme/theme-preferences';
import { electronLaunchEnv, ensureCompanionTestWorkspace, preparePackagedCompanionLaunch,
  removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';
import { openCompanionWorldWindow } from './companion-world-window-helpers';

async function request(page: Page, input: CompanionsRequest) {
  const result = await page.evaluate(value => (window as unknown as { worldlinebox: { companions: WorldlineBoxCompanionsApi } })
    .worldlinebox.companions.request(value), input);
  expect(result.ok, result.error).toBe(true);
  return result;
}
async function localDay(page: Page, at?: string, timeZone?: string) {
  return page.evaluate(input => {
    const parts = new Intl.DateTimeFormat('en-CA', { ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(input.at ? new Date(input.at) : new Date());
    return ['year', 'month', 'day'].map(kind => parts.find(part => part.type === kind)!.value).join('-');
  }, { at, timeZone });
}
async function openExperiences(page: Page, owner: Pick<Companion, 'id' | 'name'>) {
  await page.getByRole('navigation', { name: '伙伴导航', exact: true }).getByRole('button', { name: '联系人', exact: true }).click();
  await page.locator(`[data-companion-contact="${owner.id}"]`).click();
  await page.getByRole('button', { name: '查看经历', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `${owner.name}的每日经历`, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
function cleanup(directory: string) {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-experience-e2e-')) throw new Error('Unexpected experience fixture cleanup path.');
  removeCompanionTestDirectory(resolved);
}

// This checks normal producer-to-archive-to-UI wiring. Reminders use the real
// scheduler and real world movement; no LLM responses or experience rows are seeded.
// eslint-disable-next-line no-empty-pattern
test('archives real daily experiences, opens details, preserves names and isolates owners with real-time settings', async ({}, testInfo) => {
  test.setTimeout(150_000);
  const directory = mkdtempSync(path.join(tmpdir(), 'worldlinebox-experience-e2e-')), profile = path.join(directory, 'profile');
  let application: ElectronApplication | undefined;
  const errors: string[] = [];
  const evidence = process.env.WORLDLINEBOX_EXPERIENCE_UI_EVIDENCE_DIR;
  if (evidence) mkdirSync(evidence, { recursive: true });
  try {
    application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({
      WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_CREATE_PARENT_PATH: directory,
    }, { gpu: 'software' }) });
    await preparePackagedCompanionLaunch(application, profile);
    const page = await application.firstWindow(), native = await application.browserWindow(page);
    await native.evaluate(win => {
      win.unmaximize(); win.setSize(1440, 960); win.setFocusable(false); win.setOpacity(0);
      win.webContents.setBackgroundThrottling(false); win.showInactive();
    });
    page.on('pageerror', error => errors.push(error.message));
    await ensureCompanionTestWorkspace(page);
    await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ version: 1, theme: 'light' })), THEME_PREF_KEY);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.locator('[data-application-module="companions"]').click();
    const owners = (await request(page, { type: 'state' })).state!.companions.slice(0, 2);
    expect(owners).toHaveLength(2);
    const records: Array<{ owner: Companion; entry: CompanionExperienceEntry; prompt: string }> = [];
    for (const [index, owner] of owners.entries()) {
      if (owner.active === false) await request(page, { type: 'companion.set-active', id: owner.id, active: true, expectedRevision: owner.revision });
      const conversationId = (await request(page, { type: 'conversation.open', companionId: owner.id })).conversation!.id;
      const scope = { companionId: owner.id, conversationId };
      const world = (await request(page, { type: 'world.snapshot' })).world!;
      expect(world.settings).toMatchObject({ mode: 'realtime', dayDurationMinutes: 1440 });
      expect(world.clock.speed).toBe(1);
      expect(world.clock.virtualNow).toBe(world.clock.realNow);
      const hour = Math.floor(world.clock.hour), hourText = (value: number) => String((value + 24) % 24).padStart(2, '0') + ':00';
      const routine = (await request(page, { type: 'routine.get', ...scope })).routine!;
      await request(page, { type: 'routine.configure', ...scope, expectedRevision: routine.revision,
        patch: { timeZone: world.settings.timeZone, wakeAt: hourText(hour - 6), sleepAt: hourText(hour + 6), meals: [], habits: [] } });
      const prompt = `经历界面真实日程 ${index + 1} ${randomUUID()}`;
      const schedule = (await request(page, { type: 'schedule.create', ...scope, clientId: 'experience_schedule_' + randomUUID(), entries: [{
        title: `经历验收提醒${index + 1}`, prompt, kind: 'reminder', runAt: new Date(Date.now() + 86400000).toISOString(),
        timeZone: world.settings.timeZone, recurrence: 'once', flexible: false,
      }] })).schedules![0]!;
      const occurrence = (await request(page, { type: 'schedule.run-now', ...scope, id: schedule.id, expectedRevision: schedule.revision })).scheduleOccurrence!;
      expect(occurrence).toBeDefined();
      await expect.poll(async () => (await request(page, { type: 'schedule.list', ...scope, includeHistory: true, limit: 100 }))
        .scheduleOccurrences?.find(item => item.id === occurrence.id)?.status, { timeout: 60_000 }).toBe('done');
      const messages = (await request(page, { type: 'messages', conversationId, limit: 100 })).messages!;
      const delivered = messages.find(message => message.authorId === owner.id && message.content.includes(prompt));
      expect(delivered, 'The actual scheduler must publish its reminder before UI acceptance.').toBeDefined();
      const day = await localDay(page, delivered!.createdAt);
      await expect.poll(async () => (await request(page, { type: 'experience.list', companionId: owner.id, day, limit: 30 }))
        .experiencePage?.items.some(item => item.source.kind === 'schedule' && item.source.id === occurrence.id), { timeout: 15_000 }).toBe(true);
      const entries = (await request(page, { type: 'experience.list', companionId: owner.id, day, limit: 30 })).experiencePage!.items;
      const entry = entries.find(item => item.source.kind === 'schedule' && item.source.id === occurrence.id)!;
      expect(entry).toMatchObject({ companionId: owner.id, day, kind: 'schedule', origin: 'system', status: 'completed' });
      expect(entry.day).toBe(await localDay(page, entry.occurredAt, entry.timeZone));
      expect(entry.archiveRelativePath).toBe(`experiences/${owner.id}/${entry.day}/${entry.id}`);
      expect(entries.some(item => item.source.kind === 'world_event'), 'Real scheduler movement must also reach the daily life archive.').toBe(true);
      records.push({ owner, entry, prompt });
    }
    const [first, second] = records;
    let dialog = await openExperiences(page, first!.owner);
    await expect(dialog.getByLabel('经历日期', { exact: true })).toHaveValue(await localDay(page));
    await dialog.getByLabel('经历日期', { exact: true }).fill(first!.entry.day);
    const row = dialog.locator(`[data-experience-id="${first!.entry.id}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator('time')).toHaveAttribute('datetime', first!.entry.occurredAt);
    await row.getByRole('button').click();
    const detail = dialog.getByRole('complementary', { name: '经历详情', exact: true });
    await expect(detail).toContainText(first!.prompt);
    await expect(detail).toContainText('已完成');
    await detail.getByRole('button', { name: '为这段经历命名', exact: true }).click();
    const renamed = `我记得的这一天 ${randomUUID().slice(0, 8)}`;
    await detail.getByLabel('经历名称', { exact: true }).fill(renamed);
    await detail.getByRole('button', { name: '保存名称', exact: true }).click();
    await expect(detail.getByRole('heading', { level: 3 })).toHaveText(renamed);
    const saved = (await request(page, { type: 'experience.read', companionId: first!.owner.id, id: first!.entry.id })).experienceDetail!;
    expect(saved.entry).toMatchObject({ id: first!.entry.id, title: renamed, day: first!.entry.day, source: first!.entry.source });
    expect(saved.sections.some(section => section.text.includes(first!.prompt))).toBe(true);
    const dimensions = await dialog.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, height: element.clientHeight, scrollHeight: element.scrollHeight }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
    expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height + 1);
    await page.screenshot({ path: evidence ? path.join(evidence, 'daily-experiences-light.png') : testInfo.outputPath('daily-experiences-light.png') });
    await dialog.getByRole('button', { name: '关闭经历窗口', exact: true }).click();
    dialog = await openExperiences(page, second!.owner);
    await dialog.getByLabel('经历日期', { exact: true }).fill(second!.entry.day);
    await expect(dialog.locator(`[data-experience-id="${second!.entry.id}"]`)).toBeVisible();
    await expect(dialog.locator(`[data-experience-id="${first!.entry.id}"]`)).toHaveCount(0);
    await expect(dialog).not.toContainText(renamed);
    await dialog.locator(`[data-experience-id="${second!.entry.id}"]`).getByRole('button').click();
    await expect(dialog.getByRole('complementary', { name: '经历详情', exact: true })).toContainText(second!.prompt);
    await expect(dialog).not.toContainText(first!.prompt);
    await dialog.getByRole('button', { name: '关闭经历窗口', exact: true }).click();

    await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ version: 1, theme: 'dark' })), THEME_PREF_KEY);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.locator('[data-application-module="companions"]').click();
    dialog = await openExperiences(page, first!.owner);
    await dialog.getByLabel('经历日期', { exact: true }).fill(first!.entry.day);
    await dialog.locator(`[data-experience-id="${first!.entry.id}"]`).getByRole('button').click();
    await expect(dialog.getByRole('complementary', { name: '经历详情', exact: true }).getByRole('heading', { level: 3 })).toHaveText(renamed);
    await expect(dialog).not.toContainText(second!.prompt);
    await page.screenshot({ path: evidence ? path.join(evidence, 'daily-experiences-dark.png') : testInfo.outputPath('daily-experiences-dark.png') });
    await dialog.getByRole('button', { name: '关闭经历窗口', exact: true }).click();
    const observer = await openCompanionWorldWindow(application, page);
    const world = observer.getByRole('region', { name: '伙伴世界', exact: true });
    await world.getByRole('button', { name: '世界设置', exact: true }).click();
    const settings = world.getByRole('form', { name: '世界时间设置', exact: true });
    await expect(settings).toContainText('相同的现实日期与时间');
    await expect(settings.getByRole('textbox', { name: '世界时区', exact: true })).toBeVisible();
    await expect(settings.locator('input[type="radio"],input[type="number"]')).toHaveCount(0);
    await expect(settings).not.toContainText('加速');
    expect(errors).toEqual([]);
  } finally {
    await application?.close().catch(() => undefined);
    cleanup(directory);
  }
});

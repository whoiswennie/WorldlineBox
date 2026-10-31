import { mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import { removeCompanionTestDirectory, ensureCompanionTestWorkspace, electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi } };
async function request(page: Page, input: CompanionsRequest) { const result = await page.evaluate(value => (window as unknown as Bridge).worldlinebox.companions.request(value), input); expect(result.ok, result.error).toBe(true); return result; }
function cleanup(root: string) { const absolute = path.resolve(root); if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('worldlinebox-retire-e2e-')) throw new Error('Unexpected retirement fixture cleanup.'); removeCompanionTestDirectory(absolute); }

test('retires an identity through the actual UI and explicitly creates a different identity that survives restart', async () => {
  test.setTimeout(120000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-retire-e2e-')), profile = path.join(root, 'profile');
  let application: ElectronApplication | undefined;
  const launch = async () => {
    const app = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }, { gpu: 'software' }) });
    const page = await app.firstWindow();
    await (await app.browserWindow(page)).evaluate(window => { window.hide(); window.setSize(1440, 1100); window.webContents.setBackgroundThrottling(false); });
    await ensureCompanionTestWorkspace(page); return { app, page };
  };
  const draft = { name: '待删除的伙伴', description: '创建时的公开简介', persona: '创建时给出的起点，需要从真实经历形成新认识。', model: '', avatar: 'sister' as const, proactive: false, active: false };
  try {
    const first = await launch(); application = first.app; let page = first.page;
    const owner = (await request(page, { type: 'companion.create', operationId: randomUUID(), companionId: randomUUID(), companion: draft })).companion!;
    const denied = await page.evaluate(value => (window as unknown as Bridge).worldlinebox.companions.request(value),
      { type: 'companion.update' as const, id: owner.id, expectedRevision: owner.revision, companion: { ...draft, persona: '不能在创建后手工改写的人设' } });
    expect(denied.ok).toBe(false); expect(denied.error).toContain('只读');
    await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '联系人', exact: true }).click();
    await page.locator(`[data-companion-contact="${owner.id}"]`).click();
    await page.locator('.companion-contact-more > summary').click(); await page.getByRole('button', { name: '删除伙伴及个人记录', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '删除伙伴及个人记录', exact: true });
    await expect(dialog.getByRole('button', { name: '确认删除', exact: true })).toBeDisabled();
    await dialog.getByLabel('确认删除的伙伴名字', { exact: true }).fill(owner.name); await dialog.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect.poll(async () => (await request(page, { type: 'companion.retire.status', id: owner.id })).reset?.status, { timeout: 60000 }).toBe('completed');
    await expect(dialog).toContainText('删除完成'); await dialog.getByRole('button', { name: '完成', exact: true }).click();
    expect((await request(page, { type: 'state' })).state!.companions.some(item => item.id === owner.id)).toBe(false);
    const replacement = (await request(page, { type: 'companion.create', operationId: randomUUID(), companionId: randomUUID(), companion: draft })).companion!;
    expect(replacement.id).not.toBe(owner.id); expect(replacement.persona).toBe(draft.persona);
    await application.close(); application = undefined;
    const next = await launch(); application = next.app; page = next.page;
    const state = (await request(page, { type: 'state' })).state!;
    expect(state.companions.some(item => item.id === owner.id)).toBe(false); expect(state.companions.find(item => item.id === replacement.id)?.persona).toBe(draft.persona);
  } finally { await application?.close(); cleanup(root); }
});

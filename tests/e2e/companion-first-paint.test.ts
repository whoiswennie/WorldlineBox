import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import { companionSearchFacet, companionSearchTokens } from '../../src/shared/companion-search';
import { companionTestDataRoot, electronLaunchEnv, ensureCompanionTestWorkspace, preparePackagedCompanionLaunch, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';

type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi } };
const small = 'deepseek-flash', big = 'deepseek-sister', each = 25_000;

// Seed an offline disposable ledger with ordinary historical messages. The UI,
// IPC, SQLite reader, source guards and file catalogue remain production code.
// No model, embedding, browser provider or real user directory is involved.
// eslint-disable-next-line no-empty-pattern
test('paints bounded recent messages and a persistent notebook with fifty thousand historical messages', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-first-paint-')), profile = path.join(root, 'profile');
  let application: ElectronApplication | undefined;
  try {
    let launched = await launch(profile); application = launched.application; let page = launched.page;
    await ensureCompanionTestWorkspace(page);
    for (const id of [small, big]) {
      await request(page, { type: 'companion.set-active', id, active: false });
      await request(page, { type: 'conversation.open', companionId: id });
    }
    await application.close(); application = undefined;
    const selected = JSON.parse(readFileSync(path.join(profile, 'companion-library.json'), 'utf8')) as { libraryPath: string };
    const db = new DatabaseSync(path.join(companionTestDataRoot(profile), 'messages.sqlite'));
    try {
      db.function('companion_search_tokens', { deterministic: true }, value => companionSearchTokens(String(value)));
      db.function('companion_search_facet', { deterministic: true }, value => companionSearchFacet(String(value)));
      db.exec('BEGIN IMMEDIATE');
      const insert = db.prepare("INSERT INTO messages(id,conversation_id,author_id,kind,content,created_at,status) VALUES(?,?,?,'text',?,?,'sent')");
      for (const id of [small, big]) {
        for (let index = 1; index <= each; index++) insert.run(`history_${id}_${index}`, 'private-' + id, index % 2 ? 'user' : id,
          `历史记录 ${index}：已经确认并保存在本机的简短聊天内容。`, new Date(Date.UTC(2026, 8, 1) + index * 60_000).toISOString());
        db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(new Date(Date.UTC(2026, 8, 1) + each * 60_000).toISOString(), 'private-' + id);
        const directory = path.join(selected.libraryPath, '伙伴记忆', id, '资料'); mkdirSync(directory, { recursive: true });
        for (let index = 0; index < 80; index++) writeFileSync(path.join(directory, `浏览性能笔记-${String(index).padStart(3, '0')}.md`), `# 浏览性能笔记 ${index}\n\n这是独立验收资料，只用于检查目录首屏和按需阅读。`, 'utf8');
      }
      db.exec('COMMIT');
    } finally { db.close(); }
    launched = await launch(profile); application = launched.application; page = launched.page;
    const metrics: Record<string, number> = {};
    const coldStart = performance.now();
    await request(page, { type: 'state' });
    metrics.coldStorageReady = performance.now() - coldStart;
    await page.locator('[data-application-module="companions"]').click();
    for (const [key, id] of [['firstSmall', small], ['firstBig', big], ['returnSmall', small]] as const) {
      const started = performance.now();
      await page.locator(`[data-companion-conversation="private-${id}"]`).click();
      await expect(page.locator(`[data-companion-message="history_${id}_${each}"]`)).toBeVisible();
      metrics[key] = performance.now() - started;
      if (key === 'firstSmall') metrics.coldFirstConversation = performance.now() - coldStart;
      expect(Number(await page.locator('[data-companion-messages]').getAttribute('data-window-count'))).toBeLessThanOrEqual(50);
    }
    // The native bridge also proves an older page remains bounded and ordered.
    const previous = await request(page, { type: 'messages', conversationId: 'private-' + small, before: each - 49, limit: 50 });
    expect(previous.messages).toHaveLength(50); expect(previous.hasMore).toBe(true);
    const memory = page.getByRole('region', { name: '共同记忆管理', exact: true });
    let started = performance.now();
    await page.getByRole('navigation', { name: '伙伴导航', exact: true }).getByRole('button', { name: '打开伙伴记忆库', exact: true }).click();
    await expect(memory.locator('[data-memory-document]').first()).toBeVisible({ timeout: 15_000 });
    metrics.firstNotebook = performance.now() - started;
    await expect.poll(() => memory.locator('[data-memory-document]').count()).toBeGreaterThan(16);
    expect(await memory.locator('[data-memory-document]').count()).toBeLessThanOrEqual(64);
    await page.getByRole('navigation', { name: '伙伴导航', exact: true }).getByRole('button', { name: '消息', exact: true }).click();
    started = performance.now();
    await page.getByRole('navigation', { name: '伙伴导航', exact: true }).getByRole('button', { name: '打开伙伴记忆库', exact: true }).click();
    await expect(memory.locator('[data-memory-document]').first()).toBeVisible(); metrics.returnNotebook = performance.now() - started;
    const evidence = path.resolve('artifacts/vcp-validation'); mkdirSync(evidence, { recursive: true });
    const report = { historicalMessages: each * 2, documentsPerOwner: 80, latestPage: 50, directoryPage: 64, milliseconds: metrics,
      boundary: 'Offline synthetic history; actual Electron renderer, IPC, SQLite and document file reader; no model or derived execution DAG.' };
    writeFileSync(path.join(evidence, 'companion-first-paint.json'), JSON.stringify(report, null, 2));
    await testInfo.attach('first-paint-measurements', { body: JSON.stringify(report), contentType: 'application/json' });
    // Keep the measurements even if a latency regression fails acceptance.
    for (const key of ['firstSmall', 'firstBig', 'returnSmall', 'returnNotebook']) expect(metrics[key], key).toBeLessThan(2000);
  } finally {
    await application?.close().catch(() => undefined);
    cleanup(root);
  }
});

async function launch(profile: string) {
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_CREATE_PARENT_PATH: path.dirname(profile) }) });
  await preparePackagedCompanionLaunch(application, profile);
  const page = await application.firstWindow(), native = await application.browserWindow(page);
  await native.evaluate(win => { win.unmaximize(); win.setContentSize(1440, 960); win.setFocusable(false); win.setOpacity(0); win.webContents.setBackgroundThrottling(false); win.hide(); win.showInactive(); });
  await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
  return { application, page };
}
async function request(page: Page, input: CompanionsRequest) {
  const result = await page.evaluate(command => (window as unknown as Bridge).worldlinebox.companions.request(command), input);
  expect(result.ok, result.error).toBe(true); return result;
}
function cleanup(root: string) {
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('worldlinebox-first-paint-')) throw new Error('Unexpected fixture cleanup path.');
  removeCompanionTestDirectory(root);
}

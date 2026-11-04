import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { WorldlineBoxLibraryApi } from '../../src/shared/library-api';
import {
  assetCard, electronLaunchEnv, openLinkedFolderImportMenu, removeCompanionTestDirectory,
  resolveElectronExecutablePath, waitForLibraryLoadingToFinish,
} from './electron-test-helpers';

async function snapshot(window: Page) {
  return window.evaluate(async () => {
    const api = (globalThis as typeof globalThis & {
      worldlinebox: { library: WorldlineBoxLibraryApi };
    }).worldlinebox.library;
    const libraries = await api.listOpen();
    if (!libraries.ok || !libraries.value[0]) throw new Error('Expected the fixture library.');
    const libraryId = libraries.value[0].libraryId;
    const result = await api.listAssets({ libraryId, recursive: true });
    if (!result.ok || result.value.length !== 1) throw new Error('Expected one linked asset.');
    return result.value[0]!;
  });
}

test('edits linked text through the viewer and saves to the original without a managed copy', async () => {
  test.setTimeout(120_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-linked-text-'));
  const sourceRoot = path.join(root, 'source');
  mkdirSync(sourceRoot);
  const sourcePath = path.join(sourceRoot, 'note.txt');
  writeFileSync(sourcePath, 'Original linked text.\n', 'utf8');
  const libraryName = 'LinkedTextWriteback';
  const libraryPath = path.join(root, libraryName);
  const applicationDirectory = process.env.WORLDLINEBOX_E2E_APP_DIRECTORY ?? process.cwd();
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      args: [applicationDirectory], cwd: applicationDirectory,
      executablePath: resolveElectronExecutablePath(),
      env: electronLaunchEnv({
        WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1',
        WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'profile'),
        WORLDLINEBOX_E2E_CREATE_PARENT_PATH: root,
        WORLDLINEBOX_E2E_LINKED_SOURCE: sourceRoot,
      }),
    });
    const window = await application.firstWindow();
    await window.locator('[data-application-module="assets"]').click();
    await window.getByRole('button', { name: '创建资源库' }).click();
    await window.getByRole('textbox', { name: '名称' }).fill(libraryName);
    await window.getByRole('button', { name: '创建', exact: true }).click();
    await waitForLibraryLoadingToFinish(window);
    await openLinkedFolderImportMenu(application, window);
    await window.getByRole('button', { name: 'source', exact: true }).first().click({ timeout: 30_000 });
    await expect(assetCard(window, 'note.txt')).toBeVisible();
    const before = await snapshot(window);
    expect(before.locationKind).toBe('linked');
    await assetCard(window, 'note.txt').click();
    await window.keyboard.press('Space');
    const viewer = window.getByRole('region', { name: 'note.txt 查看页面' });
    const editor = viewer.locator('textarea.preview-text-input');
    await expect(editor).toHaveValue('Original linked text.\n');
    await expect(editor).toBeEditable();
    const saved = '链接文本已写回原文件。\nEdited in WorldlineBox.\n';
    await editor.fill(saved);
    await viewer.getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(() => readFileSync(sourcePath, 'utf8')).toBe(saved);
    await expect(viewer.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await viewer.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(viewer).toHaveCount(0);
    const after = await snapshot(window);
    expect(after.assetId).toBe(before.assetId);
    expect(after.locationKind).toBe('linked');
    expect(after.currentRevisionId).not.toBe(before.currentRevisionId);
    expect(readdirSync(sourceRoot)).toEqual(['note.txt']);
    expect(readdirSync(path.join(libraryPath, 'Assets'), { recursive: true })).toEqual([]);
    // A new viewer session resolves the updated source instead of a detached edit buffer.
    await assetCard(window, 'note.txt').click();
    await window.keyboard.press('Space');
    await expect(editor).toHaveValue(saved);
    await viewer.getByRole('button', { name: '关闭', exact: true }).click();
    expect(readFileSync(sourcePath, 'utf8')).toBe(saved);
  } finally {
    if (application) await application.close();
    removeCompanionTestDirectory(root);
  }
});

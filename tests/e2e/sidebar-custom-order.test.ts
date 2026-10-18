import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test';

import type { WorldlineBoxLibraryApi } from '../../src/shared/library-api';
import {
  electronLaunchEnv,
  resolveElectronAppPath,
  resolveElectronExecutablePath,
  waitForLibraryLoadingToFinish,
} from './electron-test-helpers';

test.describe.configure({ timeout: 180_000 });

function row(window: Page, kind: 'folder' | 'collection', id: string) {
  return window.locator(`.navigation-pane button.nav-row[data-nav-${kind}-id="${id}"]`);
}

async function dragToBand(window: Page, source: Locator, target: Locator, edge: 'before' | 'after', accepted = true) {
  await source.evaluate((element) => {
    const scope = globalThis as typeof globalThis & {
      __sidebarDragObserver?: { started: boolean; ended: boolean; dispose: () => void };
    };
    scope.__sidebarDragObserver?.dispose();
    const state = { started: false, ended: false, events: [] as unknown[], dispose: () => undefined as void };
    const dragSource = element.closest('[draggable="true"]') ?? element;
    const start = () => { state.started = true; };
    const end = () => { state.ended = true; };
    // The collection subtree can be reparented before dragend. Observe its
    // actual source too, so removing it from document does not lose that event.
    dragSource.addEventListener('dragstart', start, true);
    dragSource.addEventListener('dragend', end, true);
    const observe = (event: DragEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.nav-row, .collection-drop-target') : null;
      const rect = target?.getBoundingClientRect();
      const sample = {
        type: event.type,
        target: target?.dataset.navFolderId ?? target?.dataset.navCollectionId ?? target?.className,
        label: target?.getAttribute('data-hover-tip'),
        y: event.clientY,
        top: rect?.top,
        height: rect?.height,
        types: Array.from(event.dataTransfer?.types ?? []),
        selected: Array.from(document.querySelectorAll<HTMLElement>('.nav-row.is-multi-selected')).map(row => row.dataset.navFolderId ?? row.dataset.navCollectionId),
        defaultPrevented: false,
        insert: null as string | null | undefined,
      };
      queueMicrotask(() => {
        sample.types = Array.from(event.dataTransfer?.types ?? []);
        sample.defaultPrevented = event.defaultPrevented;
        sample.insert = target?.closest('.nav-tree-row')?.getAttribute('data-insert-edge');
      });
      if (state.events.length < 80) state.events.push(sample);
    };
    const eventTypes = ['dragstart', 'dragenter', 'dragover', 'dragleave', 'drop', 'dragend'] as const;
    for (const type of eventTypes) document.addEventListener(type, observe, true);
    state.dispose = () => {
      dragSource.removeEventListener('dragstart', start, true);
      dragSource.removeEventListener('dragend', end, true);
      for (const type of eventTypes) document.removeEventListener(type, observe, true);
    };
    scope.__sidebarDragObserver = state;
  });
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('Expected two visible sidebar rows');
  const treeRow = target.locator('..');
  try {
    await window.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await window.mouse.down();
    // Cross Chromium's native drag threshold before entering the target band.
    await window.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2, { steps: 4 });
    await expect.poll(() => window.evaluate(() => (globalThis as typeof globalThis & {
      __sidebarDragObserver?: { started: boolean };
    }).__sidebarDragObserver?.started)).toBe(true);
    const targetX = to.x + to.width / 2;
    const targetY = to.y + to.height * (edge === 'before' ? 0.12 : 0.88);
    await window.mouse.move(targetX, targetY, { steps: 8 });
    // Chromium can use the final move only to enter a new element. Move
    // again inside the same band to deliver the native dragover it needs.
    await window.mouse.move(targetX + 1, targetY);
    await window.mouse.move(targetX, targetY);
    const targetId = await target.getAttribute('data-nav-folder-id')
      ?? await target.getAttribute('data-nav-collection-id');
    await expect.poll(() => window.evaluate((id) => (globalThis as typeof globalThis & {
      __sidebarDragObserver?: { events: Array<{ type: string; target?: string }> };
    }).__sidebarDragObserver?.events.some(event => event.type === 'dragover' && event.target === id), targetId)).toBe(true);
    if (accepted) await expect(treeRow).toHaveAttribute('data-insert-edge', edge);
    else await expect(treeRow).not.toHaveAttribute('data-insert-edge');
  } catch (error) {
    console.log('SIDEBAR_NATIVE_DRAG_DIAGNOSTIC', JSON.stringify(await window.evaluate(() => {
      const state = (globalThis as typeof globalThis & {
        __sidebarDragObserver?: { started: boolean; ended: boolean; events: unknown[] };
      }).__sidebarDragObserver;
      return { started: state?.started, ended: state?.ended, events: state?.events };
    })));
    throw error;
  } finally {
    await window.mouse.up();
    try {
      const started = await window.evaluate(() => (globalThis as typeof globalThis & {
        __sidebarDragObserver?: { started: boolean };
      }).__sidebarDragObserver?.started);
      // A rejected native drop can finish after mouse.up resolves. Starting
      // the next gesture early otherwise leaves its predecessor's drag alive.
      if (started) await expect.poll(() => window.evaluate(() => (globalThis as typeof globalThis & {
        __sidebarDragObserver?: { ended: boolean };
      }).__sidebarDragObserver?.ended)).toBe(true);
    } finally {
      await window.evaluate(() => {
        const scope = globalThis as typeof globalThis & {
          __sidebarDragObserver?: { dispose: () => void };
        };
        scope.__sidebarDragObserver?.dispose();
        delete scope.__sidebarDragObserver;
      });
    }
  }
}

async function order(window: Page, kind: 'folder' | 'collection') {
  return window.locator(`.navigation-pane button.nav-row[data-nav-${kind}-id]`)
    .evaluateAll((nodes, attribute) => nodes.map((node) => node.getAttribute(attribute)), `data-nav-${kind}-id`);
}

test('custom sidebar order survives reload and reparents folders and collections without cycles', async () => {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'worldlinebox-sidebar-order-'));
  const applicationDirectory = resolveElectronAppPath();
  const application = await electron.launch({
    args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [applicationDirectory],
    cwd: applicationDirectory,
    executablePath: resolveElectronExecutablePath(),
    env: electronLaunchEnv({
      WORLDLINEBOX_E2E: '1',
      WORLDLINEBOX_E2E_CREATE_PARENT_PATH: temporaryRoot,
      WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(temporaryRoot, 'profile'),
    }),
  });
  try {
    await application.evaluate(({ dialog }, root) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] });
    }, temporaryRoot);
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const window = await application.firstWindow();
    await window.locator('[data-application-module="assets"]').click();
    await window.getByRole('button', { name: '创建资源库' }).click();
    await window.getByRole('textbox', { name: '名称' }).fill('自定义排序验收');
    await window.getByRole('button', { name: '创建', exact: true }).click();
    await waitForLibraryLoadingToFinish(window);

    const fixture = await window.evaluate(async () => {
      const api = (globalThis as typeof globalThis & { worldlinebox: { library: WorldlineBoxLibraryApi } }).worldlinebox.library;
      const open = await api.listOpen();
      if (!open.ok || !open.value[0]) throw new Error('Expected one open library');
      const libraryId = open.value[0].libraryId;
      const folderIds: string[] = [];
      const collectionIds: string[] = [];
      for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta']) {
        const folder = await api.createFolder({ libraryId, name, ...(name === 'Delta' ? { parentFolderId: folderIds[1] } : {}) });
        const collection = await api.createCollection({ libraryId, name: `合集 ${name}`, ...(name === 'Delta' ? { parentId: collectionIds[1] } : {}) });
        if (!folder.ok || !collection.ok) throw new Error('Could not create sidebar fixtures');
        folderIds.push(folder.value.folderId);
        collectionIds.push(collection.value.collectionId);
      }
      return { libraryId, folderIds, collectionIds };
    });
    await window.getByRole('button', { name: '刷新磁盘变化' }).click();
    await expect(row(window, 'folder', fixture.folderIds[3]!)).toBeVisible();
    await expect(row(window, 'collection', fixture.collectionIds[3]!)).toBeVisible();

    for (const [kind, ids] of [['folder', fixture.folderIds], ['collection', fixture.collectionIds]] as const) {
      const [alpha, beta, gamma, delta] = ids as [string, string, string, string];
      await expect.poll(() => order(window, kind)).toEqual([alpha, beta, delta, gamma]);

      await dragToBand(window, row(window, kind, gamma), row(window, kind, alpha), 'before');
      await expect.poll(() => order(window, kind)).toEqual([gamma, alpha, beta, delta]);

      // Inserting a parent beside its own child would make it its own parent.
      await dragToBand(window, row(window, kind, beta), row(window, kind, delta), 'before', false);
      await expect.poll(() => order(window, kind)).toEqual([gamma, alpha, beta, delta]);

      // Cross-level insertion enters the hovered row's parent, preserving the band.
      await dragToBand(window, row(window, kind, gamma), row(window, kind, delta), 'before');
      await expect.poll(() => order(window, kind)).toEqual([alpha, beta, gamma, delta]);
      await dragToBand(window, row(window, kind, delta), row(window, kind, alpha), 'before');
      await expect.poll(() => order(window, kind)).toEqual([delta, alpha, beta, gamma]);
    }

    const persisted = await window.evaluate(async (fixture) => {
      const api = (globalThis as typeof globalThis & { worldlinebox: { library: WorldlineBoxLibraryApi } }).worldlinebox.library;
      const folders = await api.listFolders({ libraryId: fixture.libraryId });
      const collections = await api.listCollections({ libraryId: fixture.libraryId });
      if (!folders.ok || !collections.ok) throw new Error('Could not verify persistent hierarchy');
      return {
        folderParents: fixture.folderIds.map((id) => folders.value.find((folder) => folder.folderId === id)?.parentFolderId),
        collectionParents: fixture.collectionIds.map((id) => collections.value.find((collection) => collection.collectionId === id)?.parentId),
        orderKeys: Object.keys(localStorage).filter((key) => key.includes('custom-order.v1.')),
      };
    }, fixture);
    expect(persisted.folderParents).toEqual([null, null, fixture.folderIds[1], null]);
    expect(persisted.collectionParents).toEqual([null, null, fixture.collectionIds[1], null]);
    expect(persisted.orderKeys.sort()).toEqual([
      `worldlinebox.collection-custom-order.v1.${fixture.libraryId}`,
      `worldlinebox.folder-custom-order.v1.${fixture.libraryId}`,
    ]);

    await window.reload();
    await window.locator('[data-application-module="assets"]').click();
    await expect(window.getByRole('button', { name: '当前资源库 自定义排序验收' })).toBeVisible({ timeout: 30_000 });
    await waitForLibraryLoadingToFinish(window);
    for (const [kind, ids] of [['folder', fixture.folderIds], ['collection', fixture.collectionIds]] as const) {
      await expect.poll(() => order(window, kind)).toEqual([ids[3], ids[0], ids[1], ids[2]]);
    }
  } finally {
    await application.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

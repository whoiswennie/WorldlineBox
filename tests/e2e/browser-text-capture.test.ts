import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test';
import type { WorldlineBoxLibraryApi } from '../../src/shared/library-api';
import type { BrowserRequest, WorldlineBoxBrowserApi } from '../../src/shared/browser';
import type { BrowserCaptureJob, BrowserCaptureRequest } from '../../src/shared/browser-capture';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type Bridge = { worldlinebox: { library: WorldlineBoxLibraryApi; browser: WorldlineBoxBrowserApi } };
type Draft = { id: string; text: string; title: string; pageTitle: string; sourcePageUrl: string };
const PAGE_TITLE = 'Entire webpage title must not replace the selected passage';
const PASSAGE = 'Selected passage about careful browser capture.\nA second selected line remains part of this excerpt.';
const EXCLUDED = 'UNSELECTED_PAGE_BODY_MUST_NOT_BE_CAPTURED';
const CROSS_PASSAGE = 'Cross origin iframe selected words only.';
const SAME_PASSAGE = 'Same origin iframe selected words only.';
const TEXTAREA_PASSAGE = 'Selected textarea words only';
const INPUT_PASSAGE = 'Selected input words only';
const KEYBOARD_PASSAGE = 'Native keyboard selected line only';
const CONTEXT_PASSAGE = 'Context menu selected words at the time of the right click.';

async function capture(page: Page, input: BrowserCaptureRequest) {
  return page.evaluate(input => (globalThis as unknown as Bridge).worldlinebox.browser.capture(input), input);
}
async function browserRequest(page: Page, input: BrowserRequest) {
  const result = await page.evaluate(input => (globalThis as unknown as Bridge).worldlinebox.browser.request(input), input);
  if (!result.ok) throw Error(result.error); return result.state;
}
async function jobs(page: Page) {
  const result = await capture(page, { type: 'state' });
  if (!result.ok) throw Error(result.error); return result.state.jobs;
}
async function selectText(locator: Locator) {
  return locator.evaluate(element => {
    element.ownerDocument.defaultView?.focus();
    element.setAttribute('tabindex', '-1'); (element as HTMLElement).focus();
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    return String(selection);
  });
}
async function selectInput(locator: Locator, text: string) {
  await locator.evaluate((element, selected) => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw Error('Expected real editable control');
    element.ownerDocument.defaultView?.focus(); element.focus();
    const start = element.value.indexOf(selected); if (start < 0) throw Error('Missing selected input fixture');
    element.setSelectionRange(start, start + selected.length);
  }, text);
}
async function clearSelections(web: Page) {
  for (const frame of web.frames()) await frame.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    for (const element of document.querySelectorAll('input,textarea')) {
      if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.selectionStart !== null) element.setSelectionRange(0, 0);
    }
  });
  await web.locator('h1').click();
}
function cleanup(root: string) {
  const target = path.resolve(root);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('worldlinebox-browser-text-')) throw Error('Unexpected browser text fixture cleanup');
  rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

// This exercises the production native WebContentsView, Main's real selected
// frame/input extraction, the sidebar editor and Worker-managed text import.
// Only the native library directory chooser is supplied by the fixture.
// eslint-disable-next-line no-empty-pattern
test('selected browser text is previewed, edited and saved without page-title substitution or stale selections', async ({}, testInfo) => {
  test.setTimeout(240000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-browser-text-'));
  const libraryName = 'Selected text captures', libraryPath = path.join(root, libraryName), profile = path.join(root, 'profile');
  const crossServer = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><html><head><title>Cross frame title</title></head><body><p id="cross-selection">' + CROSS_PASSAGE + '</p><p>' + EXCLUDED + ' cross frame</p></body></html>');
  });
  await new Promise<void>(resolve => crossServer.listen(0, '127.0.0.1', resolve));
  const crossAddress = crossServer.address(); if (!crossAddress || typeof crossAddress === 'string') throw Error('Missing cross-origin fixture port');
  const crossOrigin = 'http://127.0.0.1:' + crossAddress.port;
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    if (request.url === '/same-frame') {
      response.end('<!doctype html><html><head><title>Same frame title</title></head><body><p id="same-selection">' + SAME_PASSAGE + '</p><p>' + EXCLUDED + ' same frame</p></body></html>'); return;
    }
    if (request.url === '/other') {
      response.end('<!doctype html><html><head><title>Different page title</title></head><body><h1>A different page</h1><p id="other-selection">A separate page with no inherited selection.</p></body></html>'); return;
    }
    response.end('<!doctype html><html><head><title>' + PAGE_TITLE + '</title></head><body style="font:16px/1.5 Segoe UI;padding:18px"><h1>Selected text capture fixture</h1><p id="passage" style="white-space:pre-line">' + PASSAGE + '</p><p id="excluded">' + EXCLUDED + '</p><p id="context-selection">' + CONTEXT_PASSAGE + '</p><textarea id="textarea" rows="2">prefix ' + TEXTAREA_PASSAGE + ' suffix</textarea><input id="input" value="prefix ' + INPUT_PASSAGE + ' suffix"><textarea id="native-textarea" rows="3" cols="50">Unselected keyboard prefix\n' + KEYBOARD_PASSAGE + '\nUnselected keyboard suffix</textarea><input id="password" type="password" value="PASSWORD_MUST_NEVER_BE_CAPTURED"><iframe id="same-frame" title="Same origin selected text" src="/same-frame"></iframe><iframe id="cross-frame" title="Cross origin selected text" src="' + crossOrigin + '/cross-frame"></iframe></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing browser selection fixture port');
  const origin = 'http://127.0.0.1:' + address.port, sourceUrl = origin + '/selection';
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let stderr = '', failed = false, cleanupFailure: unknown;
  const savedCases: string[] = [];
  try {
    application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE ? [] : [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
      env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_HIDE_WINDOW: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_CREATE_PARENT_PATH: root }) });
    application.process().stderr?.on('data', chunk => { stderr += String(chunk); });
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    await application.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, root);
    const shell = await application.firstWindow(); const native = await application.browserWindow(shell);
    await native.evaluate(window => { window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
    await shell.locator('[data-application-module="assets"]').click();
    await shell.getByRole('button', { name: '创建资源库', exact: true }).click();
    await shell.getByRole('textbox', { name: '名称', exact: true }).fill(libraryName);
    await shell.getByRole('button', { name: '创建', exact: true }).click();
    await expect(shell.getByRole('button', { name: '当前资源库 ' + libraryName })).toBeVisible({ timeout: 30000 });
    await expect(shell.locator('.library-loading-backdrop')).toBeHidden({ timeout: 30000 });
    const libraryId = await shell.evaluate(async () => {
      const opened = await (globalThis as unknown as Bridge).worldlinebox.library.listOpen();
      if (!opened.ok || !opened.value[0]) throw Error('No real opened text capture library'); return opened.value[0].libraryId;
    });
    await shell.locator('[data-application-module="browser"]').click();
    const addressBox = shell.getByRole('textbox', { name: '搜索或输入网址' }); await addressBox.fill(sourceUrl); await addressBox.press('Enter');
    await expect.poll(() => application!.context().pages().some(candidate => candidate.url() === sourceUrl)).toBe(true);
    const web = application.context().pages().find(candidate => candidate.url() === sourceUrl)!;
    await expect(web.locator('#passage')).toHaveText(PASSAGE);
    await expect(web.frameLocator('#same-frame').locator('#same-selection')).toHaveText(SAME_PASSAGE);
    await expect(web.frameLocator('#cross-frame').locator('#cross-selection')).toHaveText(CROSS_PASSAGE);
    const preferences = await capture(shell, { type: 'preferences.save', preferences: { notificationsEnabled: false, focusAppAfterSave: false, revealInLibrary: false, dragRadialMenuEnabled: true } });
    expect(preferences.ok).toBe(true); expect((await capture(shell, { type: 'target.set', target: { libraryId, folderId: null } })).ok).toBe(true);
    await shell.getByRole('button', { name: '保存到资产库', exact: true }).click();
    const panel = shell.locator('[data-browser-capture]'); const preview = panel.getByRole('region', { name: '选中文字预览', exact: true });
    const titleInput = preview.getByRole('textbox', { name: '文字标题', exact: true }), bodyInput = preview.getByRole('textbox', { name: '文字内容', exact: true });
    async function prepare(expectedText: string) {
      await panel.getByRole('button', { name: '保存选中文字', exact: true }).click();
      await expect(preview).toBeVisible(); await expect(bodyInput).toHaveValue(expectedText);
      const title = await titleInput.inputValue(); expect(title).toBeTruthy(); expect(title).not.toBe(PAGE_TITLE);
      expect(title).toContain(expectedText.split('\n')[0]!.slice(0, 20));
      return title;
    }
    async function verifySaved(job: BrowserCaptureJob, expectedText: string, expectedTitle: string, expectedSource: string) {
      expect(job.status, job.message).toBe('saved'); expect(job.kind).toBe('text'); expect(job.filename).toBe(expectedTitle + '.txt');
      const actual = await shell.evaluate(async input => {
        const api = (globalThis as unknown as Bridge).worldlinebox.library;
        const body = await api.readTextAsset(input), metadata = await api.getAssetMetadata(input), assets = await api.listAssets({ libraryId: input.libraryId, recursive: true });
        if (!body.ok) throw Error(body.error.message); if (!metadata.ok) throw Error(metadata.error.message); if (!assets.ok) throw Error(assets.error.message);
        return { content: body.value.content, source: metadata.value.sourcePageUrl, asset: assets.value.find(asset => asset.assetId === input.assetId) };
      }, { libraryId, assetId: job.assetId! });
      expect(actual.content).toBe(expectedText); expect(actual.content).not.toContain(EXCLUDED); expect(actual.content).not.toContain(PAGE_TITLE);
      expect(actual.source).toBe(expectedSource); expect(actual.asset?.relativeFilePath).toBe(expectedTitle + '.txt');
      expect(readFileSync(path.join(libraryPath, 'Assets', actual.asset!.relativeFilePath), 'utf8')).toBe(expectedText);
      savedCases.push(expectedTitle);
    }
    async function confirm(expectedText: string, filename: string, expectedSource = sourceUrl) {
      await titleInput.fill(filename); await bodyInput.fill(expectedText);
      const before = new Set((await jobs(shell)).map(job => job.id));
      await preview.getByRole('button', { name: '保存文字', exact: true }).click();
      await expect(preview).toBeHidden();
      await expect.poll(async () => (await jobs(shell)).find(job => !before.has(job.id) && job.kind === 'text')?.status, { timeout: 30000 }).toBe('saved');
      const job = (await jobs(shell)).find(job => !before.has(job.id) && job.kind === 'text')!;
      await verifySaved(job, expectedText, filename, expectedSource);
    }

    expect(await selectText(web.locator('#passage'))).toBe(PASSAGE); await prepare(PASSAGE);
    await expect(preview).toContainText(PAGE_TITLE); await expect(preview).toContainText(sourceUrl);
    expect(await jobs(shell)).toHaveLength(0); // Preview itself must never import.
    const editedText = PASSAGE + '\nEdited by the user before saving.';
    await titleInput.fill('Edited selected excerpt'); await bodyInput.fill(editedText);
    const encoded = await native.evaluate(async window => (await window.webContents.capturePage()).toPNG().toString('base64'));
    writeFileSync('.tools/test-output/browser-text-capture-preview.png', Buffer.from(encoded, 'base64'));
    await confirm(editedText, 'Edited selected excerpt');

    // Selecting in the focused child frame must not fall back to the outer page.
    for (const frameCase of [
      { id: '#same-frame', selector: '#same-selection', text: SAME_PASSAGE, title: 'Same origin excerpt', url: origin + '/same-frame' },
      { id: '#cross-frame', selector: '#cross-selection', text: CROSS_PASSAGE, title: 'Cross origin excerpt', url: crossOrigin + '/cross-frame' },
    ]) {
      await clearSelections(web); await selectText(web.frameLocator(frameCase.id).locator(frameCase.selector));
      await prepare(frameCase.text); await confirm(frameCase.text, frameCase.title, frameCase.url);
    }
    for (const inputCase of [
      { selector: '#textarea', text: TEXTAREA_PASSAGE, title: 'Textarea excerpt' },
      { selector: '#input', text: INPUT_PASSAGE, title: 'Input excerpt' },
    ]) {
      await clearSelections(web); await selectInput(web.locator(inputCase.selector), inputCase.text);
      await prepare(inputCase.text); await confirm(inputCase.text, inputCase.title);
    }

    // Exercise trusted Chromium input events as well as the precise DOM-based
    // frame fixtures above. No script sets this control's selection range.
    await clearSelections(web);
    const keyboardInput = web.locator('#native-textarea'); await keyboardInput.click();
    await keyboardInput.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
    await keyboardInput.press('ArrowDown'); await keyboardInput.press('Home'); await keyboardInput.press('Shift+End');
    expect(await keyboardInput.evaluate((element: HTMLTextAreaElement) => element.value.slice(element.selectionStart, element.selectionEnd))).toBe(KEYBOARD_PASSAGE);
    await prepare(KEYBOARD_PASSAGE); await confirm(KEYBOARD_PASSAGE, 'Native keyboard excerpt');

    // Failed reads retain neither a previous successful selection nor a title-only asset.
    for (const password of [false, true]) {
      await clearSelections(web);
      if (password) await selectInput(web.locator('#password'), 'PASSWORD_MUST_NEVER_BE_CAPTURED');
      const before = (await jobs(shell)).length;
      await panel.getByRole('button', { name: '保存选中文字', exact: true }).click();
      await expect(preview).toBeHidden();
      await expect(panel.getByRole('alert').first()).toContainText(/选中|选择|密码/);
      expect(await jobs(shell)).toHaveLength(before);
    }

    // A user can edit the draft without a background DOM selection replacing it.
    await clearSelections(web); await selectText(web.locator('#passage')); await prepare(PASSAGE);
    await bodyInput.fill('Temporary user edit to preserve until explicitly reread.');
    await selectText(web.locator('#context-selection'));
    await expect(bodyInput).toHaveValue('Temporary user edit to preserve until explicitly reread.');
    await preview.getByRole('button', { name: '重新读取选区', exact: true }).click();
    await expect(bodyInput).toHaveValue(CONTEXT_PASSAGE);
    await preview.getByRole('button', { name: '取消', exact: true }).click(); await expect(preview).toBeHidden();

    // Switching tabs and navigation invalidate Main's capability as well as the UI draft.
    await selectText(web.locator('#passage')); await prepare(PASSAGE);
    const prepared = await capture(shell, { type: 'text.prepare' });
    if (!prepared.ok || !prepared.textDraft) throw Error('Missing privileged text draft');
    const draft: Draft = prepared.textDraft;
    const originalTab = (await browserRequest(shell, { type: 'state' }))!.activeTabId!;
    await browserRequest(shell, { type: 'tab.new', url: origin + '/other' });
    await expect.poll(() => application!.context().pages().some(candidate => candidate.url() === origin + '/other')).toBe(true);
    await expect(preview).toBeHidden();
    const staleTab = await capture(shell, { type: 'text.save', draftId: draft.id, title: 'Forbidden stale tab', text: draft.text });
    expect(staleTab.ok).toBe(false); if (!staleTab.ok) expect(staleTab.error).toMatch(/失效|切换|重新|跳转/);
    await browserRequest(shell, { type: 'tab.select', id: originalTab });
    await clearSelections(web); await selectText(web.locator('#passage')); await prepare(PASSAGE);
    const toNavigate = await capture(shell, { type: 'text.prepare' });
    if (!toNavigate.ok || !toNavigate.textDraft) throw Error('Missing navigation-bound text draft');
    await addressBox.fill(origin + '/other'); await addressBox.press('Enter'); await expect(web).toHaveURL(origin + '/other');
    await expect(preview).toBeHidden();
    const staleNavigation = await capture(shell, { type: 'text.save', draftId: toNavigate.textDraft.id, title: 'Forbidden stale navigation', text: toNavigate.textDraft.text });
    expect(staleNavigation.ok).toBe(false); if (!staleNavigation.ok) expect(staleNavigation.error).toMatch(/失效|切换|重新|跳转/);
    const count = (await jobs(shell)).length;
    await panel.getByRole('button', { name: '保存选中文字', exact: true }).click();
    await expect(preview).toBeHidden(); expect(await jobs(shell)).toHaveLength(count);

    // Keep the native menu callback pending, then change selection. Saving must
    // use Chromium's right-click snapshot, rather than the later DOM selection.
    await addressBox.fill(sourceUrl); await addressBox.press('Enter'); await expect(web).toHaveURL(sourceUrl);
    await expect(web.locator('#context-selection')).toHaveText(CONTEXT_PASSAGE);
    async function holdContextMenu() {
      await selectText(web.locator('#context-selection'));
      await application!.evaluate(({ Menu }) => {
        const prototype = Menu.prototype, popup = prototype.popup;
        const probe: { ready: boolean; action?: Electron.MenuItem; restore(): void } = { ready: false, restore: () => { prototype.popup = popup; } };
        (globalThis as typeof globalThis & { __browserTextMenu?: typeof probe }).__browserTextMenu = probe;
        prototype.popup = function(options) {
          const action = this.items.find(item => item.label === '保存选中文字到资产库');
          if (action) { probe.action = action; probe.ready = true; prototype.popup = popup; } else popup.call(this, options);
        };
      });
      const contextBounds = await web.locator('#context-selection').boundingBox(); if (!contextBounds) throw Error('Missing text context-menu target');
      await web.mouse.click(contextBounds.x + 12, contextBounds.y + contextBounds.height / 2, { button: 'right' });
      await expect.poll(() => application!.evaluate(() => (globalThis as typeof globalThis & { __browserTextMenu?: { ready: boolean } }).__browserTextMenu?.ready)).toBe(true);
    }
    async function clickHeldContextAction() {
      await application!.evaluate(() => {
        const root = globalThis as typeof globalThis & { __browserTextMenu?: { action?: Electron.MenuItem; restore(): void } };
        const action = root.__browserTextMenu?.action; if (!action) throw Error('Missing real text context-menu action');
        root.__browserTextMenu?.restore(); delete root.__browserTextMenu; action.click(action, undefined, undefined);
      });
    }
    await holdContextMenu();
    await selectText(web.locator('#excluded')); const beforeContext = new Set((await jobs(shell)).map(job => job.id));
    await clickHeldContextAction();
    await expect.poll(async () => (await jobs(shell)).find(job => !beforeContext.has(job.id) && job.kind === 'text')?.status, { timeout: 30000 }).toBe('saved');
    const contextJob = (await jobs(shell)).find(job => !beforeContext.has(job.id) && job.kind === 'text')!;
    await verifySaved(contextJob, CONTEXT_PASSAGE, contextJob.filename!.replace(/\.txt$/, ''), sourceUrl);
    expect(contextJob.filename).toContain('Context menu selected words');
    expect(await jobs(shell)).toHaveLength(7);

    // Returning to the original tab must not resurrect an old source capability.
    // This catches version checks that compare only the active tab at save time.
    await holdContextMenu();
    const otherTab = (await browserRequest(shell, { type: 'state' }))!.tabs.find(tab => tab.id !== originalTab)!;
    await browserRequest(shell, { type: 'tab.select', id: otherTab.id });
    await browserRequest(shell, { type: 'tab.select', id: originalTab });
    // browser.request(state) intentionally clears BrowserService.error on entry.
    // Observe the real push event instead, so diagnostics cannot be erased by
    // the polling mechanism or the next native-view layout update.
    await shell.evaluate(() => {
      const errors: string[] = [];
      const stop = (globalThis as unknown as Bridge).worldlinebox.browser.onChanged(state => { if (state.error) errors.push(state.error); });
      (globalThis as typeof globalThis & { __staleTextErrors?: { errors: string[]; stop(): void } }).__staleTextErrors = { errors, stop };
    });
    await clickHeldContextAction();
    await expect.poll(() => shell.evaluate(() => (globalThis as typeof globalThis & { __staleTextErrors?: { errors: string[] } }).__staleTextErrors?.errors.join('\n') ?? '')).toMatch(/切换|跳转|重新/);
    await shell.evaluate(() => {
      const root = globalThis as typeof globalThis & { __staleTextErrors?: { stop(): void } }; root.__staleTextErrors?.stop(); delete root.__staleTextErrors;
    });
    expect(await jobs(shell)).toHaveLength(7);
    const finalAssets = await shell.evaluate(libraryId => (globalThis as unknown as Bridge).worldlinebox.library.listAssets({ libraryId, recursive: true }), libraryId);
    expect(finalAssets.ok).toBe(true); if (finalAssets.ok) expect(finalAssets.value).toHaveLength(7);
    console.log('BROWSER_TEXT_CAPTURE_E2E_RESULT', JSON.stringify({ actualWorkerTextFiles: savedCases, editedPreview: true, selectionSummaryFilename: true,
      sameOriginIframe: true, crossOriginIframe: true, textarea: true, input: true, nativeKeyboardSelection: true, emptyAndPasswordRejected: true, explicitRereadPreservesEdits: true,
      tabAndNavigationDraftsInvalidated: true, roundTripTabDoesNotResurrectSelection: true, contextMenuSelectionSnapshot: true, wholePageNotCollected: true }));
  } catch (cause) { failed = true; throw cause; }
  finally {
    await application?.close().catch(cause => { if (!failed) cleanupFailure = cause; });
    server.closeAllConnections(); crossServer.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => crossServer.close(() => resolve()))]);
    if (failed) {
      await testInfo.attach('browser-text-capture-stderr', { body: stderr, contentType: 'text/plain' });
      const logs = path.join(profile, 'logs');
      if (existsSync(logs)) for (const file of readdirSync(logs)) if (file.endsWith('.log')) await testInfo.attach(file, { body: readFileSync(path.join(logs, file)), contentType: 'text/plain' });
    }
    try { cleanup(root); } catch (cause) { if (!failed && !cleanupFailure) cleanupFailure = cause; }
  }
  if (cleanupFailure) throw cleanupFailure;
});

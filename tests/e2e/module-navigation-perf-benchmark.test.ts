/** Actual packaged module navigation on an explicitly supplied private library copy. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchBenchmarkApp, seedRecentLibraries, writeBenchReport } from './perf-bench-helpers';
import { COMPANIONS_CHANNEL } from '../../src/shared/companions';
import { COMPANION_WORKSPACE_CHANNEL } from '../../src/shared/companion-workspace';

const library = process.env.WORLDLINEBOX_NAV_BENCH_LIBRARY;
const packaged = process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE;
test.skip(!library || !packaged, 'Supply the private real-library copy and current packaged executable.');
test.setTimeout(180000);

test('packaged real library modules become usable after cold and return navigation', async () => {
  const root = process.env.WORLDLINEBOX_NAV_BENCH_PROFILE
    ?? mkdtempSync(path.join(tmpdir(), 'wlb-packaged-module-nav-'));
  mkdirSync(root, { recursive: true });
  seedRecentLibraries(root, [library!], library!);
  const selectionFile = process.env.WORLDLINEBOX_NAV_BENCH_COMPANION_SELECTION;
  if (!selectionFile) throw new Error('Real companion journeys require the copied production library selection.');
  const selection = JSON.parse(readFileSync(selectionFile, 'utf8')) as { libraryId: string; displayName: string; libraryPath: string };
  if (!/^[a-f0-9-]{36}$/iu.test(selection.libraryId) || path.resolve(selection.libraryPath) !== path.resolve(library!)) {
    throw new Error('Companion selection must point to the explicitly supplied private library.');
  }
  writeFileSync(path.join(root, 'companion-library.json'), JSON.stringify(selection));
  const budgetMs = Number(process.env.WORLDLINEBOX_NAV_BENCH_PAGE_BUDGET_MS ?? 5000);
  if (!Number.isFinite(budgetMs) || budgetMs < 100 || budgetMs > 60000) throw new Error('Invalid navigation budget.');
  const started = Date.now();
  const app = await launchBenchmarkApp({ userDataPath: root });
  const window: Page = app.window;
  const native = await app.application.browserWindow(window);
  await native.evaluate(value => { value.hide(); value.webContents.setBackgroundThrottling(false); });
  const samples: Array<{ module: string; phase: string; clickToReadyMs: number; automationToReadyMs: number;
    lastClickToReadyMs?: number; actualClickCount?: number; withinBudget: boolean; rows?: number; errorName?: string }> = [];
  const pageErrors: Array<{ name: string; messageHash: string }> = [];
  let firstMessageEntries: Array<{ phase: string; enteredAtEpochMs: number; contentReadyMs: number }>;
  window.on('pageerror', error => pageErrors.push({ name: error.name, messageHash: createHash('sha256').update(error.message).digest('hex') }));
  const idleAfterProfile: Array<{ phase: string; commands: Record<string, number>; events: Record<string, number>; progressRefreshExercised: boolean }> = [];
  await window.evaluate(() => {
    const api = Reflect.get(window, 'worldlinebox') as { companions: { onChanged: (callback: (event?: { kind?: string }) => void) => () => void } };
    const events: Record<string, number> = { progress: 0, full: 0 };
    Reflect.set(window, '__navigationCompanionEvents', events);
    api.companions.onChanged(event => { const kind = event?.kind === 'progress' ? 'progress' : 'full'; events[kind] = (events[kind] ?? 0) + 1; });
  });
  await app.application.evaluate(({ ipcMain }, channels) => {
    const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<string, (event: unknown, command: unknown) => unknown>;
    const counters: Record<string, number> = {};
    const spans: Array<{ type: string; startedAtEpochMs: number; durationMs: number; succeeded: boolean }> = [];
    Reflect.set(globalThis, '__navigationCompanionCommands', counters);
    Reflect.set(globalThis, '__navigationMainSpans', spans);
    for (const channel of channels) {
      const original = handlers.get(channel);
      if (!original) throw new Error('The actual companion request handler is unavailable.');
      handlers.set(channel, (event, command) => {
        const type = typeof command === 'object' && command !== null && 'type' in command ? String(command.type) : 'unknown';
        const start = performance.now(), startedAtEpochMs = Date.now();
        counters[type] = (counters[type] ?? 0) + 1;
        const record = (succeeded: boolean) => { if (spans.length < 5000) spans.push({ type, startedAtEpochMs, durationMs: Math.round(performance.now() - start), succeeded }); };
        return Promise.resolve(original(event, command)).then(result => {
          record(!(typeof result === 'object' && result !== null && 'ok' in result && result.ok === false));
          return result;
        }, error => { record(false); throw error; });
      });
    }
  }, [COMPANIONS_CHANNEL, COMPANION_WORKSPACE_CHANNEL]).catch(async error => { await app.application.close(); throw error; });
  const waitOptions = { timeout: 30000 };
  const rail = (id: string) => window.locator(`[data-application-module="${id}"]`);
  const journey = async (module: string, phase: string, click: () => Promise<unknown>, ready: () => Promise<number | void>) => {
    await window.evaluate(({ module, phase }) => {
      const timing = { first: 0, last: 0, count: 0, module, phase };
      Reflect.set(window, '__navigationClickTiming', timing);
      if (Reflect.get(window, '__navigationClickListener')) return;
      Reflect.set(window, '__navigationClickListener', true);
      const messageEntries: Array<{ phase: string; enteredAtEpochMs: number; contentReadyMs: number }> = [];
      Reflect.set(globalThis, '__navigationFirstMessageEntries', messageEntries);
      let pendingEntry: { phase: string; at: number } | undefined;
      const checkMessages = () => {
        if (!pendingEntry) return;
        const container = document.querySelector('[data-companion-messages]');
        const row = container?.querySelector('[data-companion-message]');
        if (!row?.getClientRects().length || document.querySelector('.companions-message-loading')) return;
        messageEntries.push({ phase: pendingEntry.phase, enteredAtEpochMs: performance.timeOrigin + pendingEntry.at,
          contentReadyMs: Math.round(performance.now() - pendingEntry.at) });
        pendingEntry = undefined;
      };
      new MutationObserver(checkMessages).observe(document.body, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['hidden', 'class', 'aria-busy'] });
      const conditions = { documentHidden: document.hidden, visibilityState: document.visibilityState, twoFrameIntervalMs: null as number | null };
      Reflect.set(globalThis, '__navigationRendererConditions', conditions);
      requestAnimationFrame(first => requestAnimationFrame(second => { conditions.twoFrameIntervalMs = Math.round(second - first); }));
      globalThis.addEventListener('click', event => {
        const current = Reflect.get(window, '__navigationClickTiming') as typeof timing;
        const at = performance.now(); if (!current.count) current.first = at; current.last = at; current.count++;
        if (current.module === 'companions' && event.target instanceof Element
          && event.target.closest('[data-application-module="companions"]')) pendingEntry = { phase: current.phase, at };
      }, { capture: true });
    }, { module, phase });
    const before = Date.now();
    try {
      await click();
      const rows = await ready();
      const automationMs = Date.now() - before;
      const actual = await window.evaluate(() => {
        const timing = Reflect.get(window, '__navigationClickTiming') as { first: number; last: number; count: number };
        return { first: performance.now() - timing.first, last: performance.now() - timing.last, count: timing.count };
      });
      if (!actual.count) throw new Error('The journey did not produce a real DOM click.');
      samples.push({ module, phase, clickToReadyMs: Math.round(actual.first), automationToReadyMs: automationMs,
        lastClickToReadyMs: Math.round(actual.last), actualClickCount: actual.count, withinBudget: actual.first <= budgetMs,
        ...(typeof rows === 'number' ? { rows } : {}) });
    } catch (error) {
      samples.push({ module, phase, clickToReadyMs: Date.now() - before, automationToReadyMs: Date.now() - before,
        withinBudget: false, errorName: error instanceof Error ? error.name : 'Unknown' });
      const diagnostic = await window.evaluate(() => ({ bodyText: document.body.innerText,
        activeModule: document.querySelector('[data-application-module][aria-current="page"]')?.getAttribute('data-application-module') }));
      writeFileSync(path.join(root, `private-${phase}-${module}-failure.json`), JSON.stringify(diagnostic));
    }
    console.info(`MODULE_NAV_PHASE ${JSON.stringify(samples.at(-1))}`);
  };
  let startupToAssetReadyMs: number | undefined;
  try {
    for (const phase of ['cold', 'return']) {
      await journey('assets', phase, () => rail('assets').click(), async () => {
        await expect(window.locator('.asset-card').first()).toBeVisible(waitOptions);
        return window.locator('.asset-card').count();
      });
      if (phase === 'cold') startupToAssetReadyMs = Date.now() - started;
      await journey('browser', phase, () => rail('browser').click(), async () => {
        await expect(window.locator('.web-browser')).toBeVisible(waitOptions);
        await expect(window.locator('.browser-address input')).toBeEnabled(waitOptions);
      });
      await journey('companions', phase, () => rail('companions').click(), async () => {
        await expect(window.locator('[data-companions]')).toBeVisible(waitOptions);
        await expect(window.locator('.companions-conversation').first()).toBeVisible(waitOptions);
        return window.locator('.companions-conversation').count();
      });
      if (samples.at(-1)?.errorName) break;
      await journey('messages', phase, () => window.locator('.companions-conversation').first().click(), async () => {
        await expect(window.locator('[data-companion-messages] [data-companion-message]').first()).toBeVisible(waitOptions);
        await expect(window.locator('.companions-message-loading')).toHaveCount(0, waitOptions);
        return window.locator('[data-companion-messages] [data-companion-message]').count();
      });
      await journey('contacts', phase, () => window.getByRole('navigation', { name: '伙伴导航' }).getByRole('button', { name: '联系人', exact: true }).click(), async () => {
        await expect(window.locator('.companions-contact').first()).toBeVisible(waitOptions);
        await expect(window.locator('.companion-contact-groups')).toHaveAttribute('aria-busy', 'false', waitOptions);
        return window.locator('.companions-contact').count();
      });
      await journey('memory', phase, async () => {
        await window.getByRole('button', { name: '打开伙伴记忆库', exact: true }).click();
        // Memory intentionally remembers the last subpage (such as profile).
        const tabs = window.locator('.companion-instance-tabs button');
        if (await tabs.count()) await tabs.nth(2).click();
      }, async () => {
        await expect(window.locator('[aria-label="伙伴记忆库"]')).toBeVisible(waitOptions);
        await expect(window.locator('.memory-library-file-scroll')).toBeVisible(waitOptions);
        await expect(window.locator('.memory-library-file, .memory-library-empty-list').first()).toBeVisible(waitOptions);
        return window.locator('.memory-library-file').count();
      });
      await journey('profile', phase, () => window.getByRole('button', { name: '认知档案', exact: true }).click(), async () => {
        const profile = window.getByRole('region', { name: '伙伴认知档案', exact: true });
        await expect(profile).toBeVisible(waitOptions);
        // The dossier displays the persona in a collapsed disclosure. Its real
        // registered text must be loaded; expanding a disclosure is a separate action.
        await expect(profile.locator('pre').first()).toBeAttached(waitOptions);
        await expect(profile.locator('pre').first()).not.toHaveText('', waitOptions);
        await expect(profile.locator('.instance-loading')).toHaveCount(0, waitOptions);
      });
      await window.getByRole('navigation', { name: '伙伴导航' }).getByRole('button', { name: '消息', exact: true }).click();
      const before = await app.application.evaluate(() => ({ ...Reflect.get(globalThis, '__navigationCompanionCommands') as Record<string, number> }));
      const eventsBefore = await window.evaluate(() => ({ ...Reflect.get(window, '__navigationCompanionEvents') as Record<string, number> }));
      // An explicit idle observation, excluded from every click-to-ready sample.
      await window.waitForTimeout(5000);
      const after = await app.application.evaluate(() => ({ ...Reflect.get(globalThis, '__navigationCompanionCommands') as Record<string, number> }));
      const eventsAfter = await window.evaluate(() => ({ ...Reflect.get(window, '__navigationCompanionEvents') as Record<string, number> }));
      const events = Object.fromEntries(Object.entries(eventsAfter).map(([key, value]) => [key, value - (eventsBefore[key] ?? 0)]));
      idleAfterProfile.push({ phase, commands: Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - (before[key] ?? 0)])), events, progressRefreshExercised: (events.progress ?? 0) > 0 });
    }
  } finally {
    const rendererConditions = await window.evaluate(() => Reflect.get(globalThis, '__navigationRendererConditions')).catch(() => undefined);
    firstMessageEntries = await window.evaluate(() => Reflect.get(globalThis, '__navigationFirstMessageEntries') as
      Array<{ phase: string; enteredAtEpochMs: number; contentReadyMs: number }>).catch(() => []);
    const mainCommandSpans = await app.application.evaluate(() => Reflect.get(globalThis, '__navigationMainSpans') as
      Array<{ type: string; startedAtEpochMs: number; durationMs: number; succeeded: boolean }>).catch(() => []);
    await app.application.close();
    const report = { suite: 'packaged-real-module-navigation', packaged: true, budgetMs,
      compiledAsarSha256: process.env.WORLDLINEBOX_NAV_BENCH_ASAR_SHA256,
      timingDefinition: 'actual-first-DOM-click-to-observed-real-content; automation duration and final target click are separate',
      coldDefinition: 'first visit in a fresh app process; existing filesystem and library caches are retained',
      libraryPathHash: createHash('sha256').update(path.resolve(library!)).digest('hex'),
      startupToAssetReadyMs, samples, firstMessageEntries, rendererConditions, idleAfterProfile, mainCommandSpans, pageErrors,
      completed: samples.length === 14 && samples.every(sample => sample.withinBudget)
        && firstMessageEntries.length === 2 && firstMessageEntries.every(entry => entry.contentReadyMs <= budgetMs) && !pageErrors.length };
    writeBenchReport(process.env.WORLDLINEBOX_NAV_BENCH_OUT ?? path.join(root, 'module-navigation-result.json'), report);
    console.info(`MODULE_NAV_SUMMARY ${JSON.stringify({ ...report, mainCommandSpans: { count: mainCommandSpans.length,
      slowest: [...mainCommandSpans].sort((a, b) => b.durationMs - a.durationMs).slice(0, 6) } })}`);
  }
  expect(samples, 'Every actual page must become usable within the navigation budget.').toHaveLength(14);
  expect(samples.filter(sample => !sample.withinBudget).map(sample => `${sample.phase}:${sample.module}`)).toEqual([]);
  expect(firstMessageEntries, 'The actual first message must appear after each real companion rail click.').toHaveLength(2);
  expect(firstMessageEntries.filter(entry => entry.contentReadyMs > budgetMs).map(entry => entry.phase)).toEqual([]);
  expect(pageErrors).toEqual([]);
});

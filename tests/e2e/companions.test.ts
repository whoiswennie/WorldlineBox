import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

import type { CompanionMessage, CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import type { WorldlineBoxLibraryApi } from '../../src/shared/library-api';
import { removeCompanionTestDirectory, electronLaunchEnv, preparePackagedCompanionLaunch, resolveElectronExecutablePath, resolveElectronLaunchOptions } from './electron-test-helpers';

type CompanionBridgeWindow = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; llm: WorldlineBoxLlmApi } };
interface ProviderRequest {
  path: string; headers: IncomingHttpHeaders; model: string; companionId: string; latestUser: string;
  memories: unknown[]; reply: string; processedMemory?: { text: string; revision: string; profileKey: string };
  stateRevision?: number; toolResults?: string[];
}
interface ProviderFixture { baseUrl: string; requests: ProviderRequest[]; memoryRequests: Array<{ purpose: string; companionId: string; sourceIds: string[] }>; socialReviews: Array<{ proposedText: string; facts: unknown[]; nativeActions: unknown[] }>; streamStarts: Array<{ userText: string; step: number; first: string; second: string }>; releaseStream(userText: string, step?: number): void; release(): void; close(): Promise<void> }

// Electron supplies the window; no Playwright browser fixture is needed.
// eslint-disable-next-line no-empty-pattern
test('automatically records ordinary conversation, exposes sources and progress, rejects stale edits and forgets across restart', async ({}, testInfo) => {
  test.setTimeout(420_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-memory-'));
  const profile = path.join(root, 'profile'), provider = await providerFixture();
  let application: ElectronApplication | undefined;
  const diagnostics: string[] = [];
  try {
    let started = await launch(profile, false); application = started.application; let page = started.page;
    application.process().stderr?.on('data', chunk => diagnostics.push(String(chunk)));
    await setGlobal(page, { apiFormat: 'openai_chat', baseUrl: provider.baseUrl, model: 'fixture-memory', apiKey: 'fixture-memory-key' });
    await page.locator('[data-application-module="companions"]').click();
    expect((await request(page, { type: 'state' })).state!.conversations).toHaveLength(0);
    await page.getByRole('button', { name: '发起聊天', exact: true }).click();
    const chooser = page.getByRole('dialog', { name: '发起聊天' });
    await chooser.locator('.companions-start-chat-list button').filter({ has: page.getByText('大肥鱼', { exact: true }) }).click();
    const conversationId = 'private-deepseek-sister', companionId = 'deepseek-sister';
    await expect(chooser).toHaveCount(0);
    await ensureAwakeRoutine(page, companionId, conversationId);
    await sendUi(page, conversationId, '我喜欢看海', [companionId]);
    const source = (await messages(page, conversationId)).find(message => message.authorId === 'user' && message.content === '我喜欢看海')!;
    const browse = () => request(page, { type: 'memory.browse', companionId, conversationId, query: '', tags: [], limit: 20 });
    let lastCaptureStatus = '';
    await expect.poll(async () => {
      const page = await browse();
      const status = (await request(started.page, { type: 'memory.status', companionId, conversationId })).memoryStatus;
      const signature = JSON.stringify({ status, notes: page.memoryPage?.items.map(hit => ({ id: hit.memory.id, status: hit.memory.status })) });
      if (signature !== lastCaptureStatus) { lastCaptureStatus = signature; console.log('VCP_CAPTURE_STATUS', signature); }
      return page.memoryPage?.items.some(hit => hit.memory.status === 'indexed' && hit.memory.content === '用户喜欢看海。');
    }, { timeout: 90_000 }).toBe(true);
    const learned = (await browse()).memoryPage!.items.find(hit => hit.memory.content === '用户喜欢看海。')!.memory;
    expect(learned).toMatchObject({ origin: 'user', captureMethod: 'automatic', status: 'indexed', diaryName: '生活日记', sourceMessageId: source.id });
    expect(learned.tags).toEqual(['用户', '看海']);
    expect(provider.memoryRequests.some(item => item.purpose === 'vcp_experience_journal' && item.sourceIds.includes(source.id))).toBe(true);
    // Only the external model provider is a fixture. Inspect the actual host's
    // committed capture receipt before an edit changes this note's version.
    const captureTrace = (await request(page, { type: 'memory.trace.inspect', companionId, kind: 'journal', id: learned.id, stage: 'capture', limit: 10 })).memoryTrace!;
    expect(captureTrace).toMatchObject({ companionId, root: { id: learned.id, redacted: false, version: learned.version } });
    const captureReceipt = captureTrace.stages.find(stage => stage.kind === 'capture')?.records.find(record => record.sourceMessageId === source.id);
    expect(captureReceipt).toBeDefined();
    expect(captureReceipt).toMatchObject({ kind: 'capture', status: 'done', relation: 'batch_output', confidence: 'exact', outputCount: 1,
      outputs: [{ noteId: learned.id, version: learned.version }] });
    expect(captureReceipt!.captureBatchId).toMatch(/^[a-zA-Z0-9_-]{1,100}$/u);
    await testInfo.attach('capture-batch-receipt-before-edit', { body: JSON.stringify({
      actualPackagedApplication: await application.evaluate(({ app }) => app.isPackaged),
      providerBoundary: 'Deterministic local chat/journal provider; actual application capture, receipt, SQLite, bundled embedding and VCP pipeline.',
      companionId, sourceMessageId: source.id, noteId: learned.id, noteVersion: learned.version,
      recordId: captureReceipt!.id, captureBatchId: captureReceipt!.captureBatchId, relation: captureReceipt!.relation,
      confidence: captureReceipt!.confidence, outputCount: captureReceipt!.outputCount, outputs: captureReceipt!.outputs,
    }, null, 2), contentType: 'application/json' });
    const recalled = await request(page, { type: 'memory.search', companionId, conversationId, query: '用户喜欢什么休闲活动？', tags: [], limit: 20 });
    const nativeHit = recalled.memoryPage!.items.find(hit => hit.memory.id === learned.id)!;
    expect(nativeHit).toBeDefined(); expect(nativeHit.score).toEqual(expect.any(Number));
    expect(nativeHit.reasons).toContain('VCP river');
    expect(nativeHit.scoreDetails).toMatchObject({ engine: 'river', rank: expect.any(Number), finalScore: nativeHit.score });
    expect(recalled.memoryContext?.text).toContain('用户喜欢看海');
    expect(recalled.memoryContext).toMatchObject({ revision: expect.any(String), profileKey: expect.any(String) });
    await expect.poll(async () => (await request(page, { type: 'memory.status', companionId })).memoryStatus?.pending, { timeout: 35_000 }).toBe(0);
    const status = (await request(page, { type: 'memory.status', companionId })).memoryStatus!;
    expect(status.failed).toBe(0); expect(status.captureWatermark).toBe(status.messageWatermark); expect(status.pendingIndex).toBe(0); expect(status.indexed).toBe(1);

    // The next reply receives automatically recalled evidence without a memory tool or manual prompt.
    await sendUi(page, conversationId, '你还记得我喜欢什么吗？', [companionId]);
    expect(provider.socialReviews).toEqual(expect.arrayContaining([
      { proposedText: '好呀，我记住你喜欢看海了。周末可以留些时间慢慢逛。', facts: [], nativeActions: [] },
      { proposedText: '记得，你喜欢看海。', facts: [], nativeActions: [] },
    ]));
    expect(provider.requests.at(-1)!.memories).toEqual([]);
    expect(provider.requests.at(-1)!.processedMemory).toMatchObject({ text: expect.stringContaining('用户喜欢看海') });
    expect(provider.memoryRequests.some(item => item.purpose === 'vcp_aimemo')).toBe(true);
    await expect(page.locator('[data-companion-messages]').getByText('记得，你喜欢看海。', { exact: true })).toBeVisible();
    const recalledBubble = page.locator('[data-companion-message]').filter({ has: page.getByText('记得，你喜欢看海。', { exact: true }) }).last();
    await recalledBubble.locator('.companions-bubble-memory > summary').click();
    const recalledDetails = recalledBubble.getByLabel('本轮回忆详情', { exact: true });
    await expect(recalledDetails.locator('[data-reply-memory-context]')).toContainText('用户喜欢看海');
    await recalledDetails.locator('.reply-memory-candidates > summary').click();
    await expect(recalledDetails.locator('[data-recall-candidate="' + learned.id + '"]')).toContainText('用户喜欢看海');
    await testInfo.attach('actual-reply-vcp-context', { body: JSON.stringify(await request(page, { type: 'reply.memory.inspect', companionId, conversationId,
      messageId: (await recalledBubble.getAttribute('data-companion-message'))!, contextOffset: 0, contextLimit: 8192 }), null, 2), contentType: 'application/json' });
    const recallArtifacts = path.resolve('artifacts/vcp-validation/owner-memory-ui'); mkdirSync(recallArtifacts, { recursive: true });
    const badge = await page.locator('.companions-chat-header .companion-status-badge').evaluate(element => ({ height: element.getBoundingClientRect().height,
      font: Number.parseFloat(getComputedStyle(element).fontSize), background: getComputedStyle(element).backgroundColor }));
    expect(badge.height).toBeLessThanOrEqual(16); expect(badge.font).toBeLessThanOrEqual(11); expect(badge.background).toBe('rgba(0, 0, 0, 0)');
    await page.screenshot({ path: path.join(recallArtifacts, 'actual-injected-context.png') });
    await recalledBubble.locator('.companions-bubble-memory > summary').click();
    expect(provider.memoryRequests.some(item => ['memory_extraction', 'memory_query', 'memory_maintenance'].includes(item.purpose))).toBe(false);
    await expect.poll(async () => (await request(page, { type: 'memory.status', companionId, conversationId })).memoryStatus?.pending, { timeout: 90_000 }).toBe(0);
    await page.getByRole('button', { name: '我们之间', exact: true }).click();
    const journal = page.getByRole('complementary', { name: '伙伴手帐' });
    await expect(journal).toBeVisible();
    expect(await journal.locator('.companions-memory-panel').count()).toBe(0);
    const geometry = await journal.evaluate(element => ({ width: element.getBoundingClientRect().width, client: element.clientWidth, scroll: element.scrollWidth }));
    expect(geometry.width).toBe(320); expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
    await journal.getByRole('button', { name: '管理共同记忆', exact: true }).click();
    const manager = page.getByRole('region', { name: '共同记忆管理', exact: true, includeHidden: true });
    const panel = manager.getByRole('region', { name: '伙伴记忆库' });
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: '学习与成长', exact: true }).click();
    const growth = manager.getByRole('region', { name: '伙伴学习与成长', exact: true });
    await expect(growth).toBeVisible();
    await growth.getByRole('button', { name: '新建学习目标', exact: true }).click();
    await growth.getByRole('textbox', { name: '持续学习目标', exact: true }).fill('持续学习近岸海洋生态，每轮聚焦一个问题。用实际阅读的材料支持结论，留下未理解之处，并通过真实回忆进行自测。');
    const growthArtifacts = path.resolve('artifacts/vcp-validation/concurrent-learning-ui'); mkdirSync(growthArtifacts, { recursive: true });
    await page.screenshot({ path: path.join(growthArtifacts, 'learning-goal-editor-light.png') });
    await growth.getByRole('button', { name: '创建持续学习目标', exact: true }).click();
    await expect(growth.getByRole('button', { name: '暂停学习', exact: true })).toBeVisible();
    await expect(growth).toContainText('请添加学习材料，或允许探索公开网页', { timeout: 30000 });
    await page.screenshot({ path: path.join(growthArtifacts, 'learning-goal-waiting-light.png') });
    await growth.getByRole('button', { name: '暂停学习', exact: true }).click();
    await expect(growth.getByRole('button', { name: '恢复学习', exact: true })).toBeVisible();
    await theme(page, '暗色');
    const growthWindow = await application.browserWindow(page); await growthWindow.evaluate(window => window.setSize(1040, 900));
    const growthGeometry = await growth.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    expect(growthGeometry.scroll).toBeLessThanOrEqual(growthGeometry.width + 1);
    await page.screenshot({ path: path.join(growthArtifacts, 'learning-goal-paused-dark-1040.png') });
    await growthWindow.evaluate(window => window.setSize(1440, 900)); await theme(page, '亮色');
    await growth.getByRole('button', { name: '返回记忆库', exact: true }).click();
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: '回忆', exact: true }).click();
    const probe = manager.getByRole('region', { name: '伙伴回忆', exact: true });
    await expect(probe).toBeVisible();
    await probe.getByRole('textbox', { name: '想回忆的事', exact: true }).fill('用户喜欢什么休闲活动？');
    await probe.getByRole('button', { name: '开始回忆', exact: true }).click();
    await expect(probe.getByLabel('回忆来源正文', { exact: true })).toContainText('用户喜欢看海');
    const flow = probe.getByLabel('本次回忆的处理过程', { exact: true });
    await expect(flow.locator('[data-retrieval-stage]')).toHaveCount(6);
    await flow.locator('[data-retrieval-stage="ranking"]').click();
    await expect(flow.locator('[data-retrieval-memory="' + learned.id + '"]')).toContainText('用户喜欢看海');
    await expect(probe.locator('.memory-probe-native-rank')).toContainText('VCP 最终分');
    await page.screenshot({ path: path.join(recallArtifacts, 'memory-probe-active.png') });
    await probe.locator('.memory-probe-inspector').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(recallArtifacts, 'memory-recall-source-cards-light.png') });
    await probe.locator('.memory-probe-scroll').evaluate(element => { element.scrollTop = 0; });
    const activeProbe = await request(page, { type: 'memory.recall.test', companionId, query: '用户喜欢什么休闲活动？', mode: 'active', limit: 8 });
    expect(activeProbe.memoryProbe?.memoryRetrieval?.stages.map(stage => stage.id)).toEqual(['scope', 'embedding', 'sensing', 'candidates', 'ranking', 'context']);
    expect(activeProbe.memoryProbe?.memories.find(hit => hit.memory.id === learned.id)?.scoreDetails?.finalScore).toEqual(expect.any(Number));
    await testInfo.attach('actual-native-recall-flow', { body: JSON.stringify(activeProbe.memoryProbe, null, 2), contentType: 'application/json' });
    await probe.getByRole('tab', { name: '被动回忆', exact: false }).click();
    await probe.getByRole('button', { name: '开始回忆', exact: true }).click();
    await expect(probe.getByLabel('VCP上下文原文', { exact: true })).toContainText('用户喜欢看海');
    await page.screenshot({ path: path.join(recallArtifacts, 'memory-probe-passive.png') });
    await probe.locator('[data-probe-note="' + learned.id + '"]').click();
    // Passive candidates are formatter/model-input observations. Numerical
    // ranks belong to the explicit active native query above.
    await expect(probe.locator('.memory-probe-score-evidence')).toHaveCount(0);
    await probe.getByRole('tab', { name: '主动回忆', exact: false }).click();
    await probe.getByRole('button', { name: '开始回忆', exact: true }).click();
    await probe.locator('[data-probe-note="' + learned.id + '"]').click();
    await probe.locator('.memory-probe-score-evidence > summary').click();
    await expect(probe.getByLabel('原生VCP评分', { exact: true })).toContainText('拓扑增益');
    await page.screenshot({ path: path.join(recallArtifacts, 'memory-recall-evidence-light.png') });
    await theme(page, '暗色');
    await page.screenshot({ path: path.join(recallArtifacts, 'memory-recall-evidence-dark.png') });
    const nativeWindow = await application.browserWindow(page);
    await nativeWindow.evaluate(window => window.setSize(1040, 900));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1040);
    const recallGeometry = await probe.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    expect(recallGeometry.scroll).toBeLessThanOrEqual(recallGeometry.width + 1);
    await page.screenshot({ path: path.join(recallArtifacts, 'memory-recall-evidence-dark-1040.png') });
    await nativeWindow.evaluate(window => window.setSize(1440, 900));
    await theme(page, '亮色');
    await flow.locator('[data-retrieval-stage="ranking"]').click();
    await flow.locator('[data-retrieval-memory="' + learned.id + '"]').getByRole('button', { name: '查看文档', exact: false }).click();
    await expect(panel).toBeVisible();
    await expect(panel.locator('.memory-library-paper')).toContainText('用户喜欢看海');
    await panel.locator('[data-memory-note="' + learned.id + '"]').click();
    await expect(panel.locator('.memory-library-paper')).toContainText('用户喜欢看海。');
    await expect(panel.locator('.memory-library-document-tags button')).toContainText(['用户', '看海']);
    await panel.getByRole('button', { name: `查看记忆来源 ${learned.id}`, exact: true }).click();
    await expect(panel.locator('.memory-library-inspector')).toContainText('生活日记');
    await expect(panel.locator('.memory-library-inspector')).toContainText('已收录');
    await expect(panel.locator('.memory-library-source')).toContainText('我喜欢看海');
    await panel.locator('.memory-library-source summary').click();
    await panel.getByRole('button', { name: '收录与记录规则', exact: true }).click();
    await expect(panel.locator('.memory-library-maintenance')).toContainText('等待索引 / 可供回忆');
    await expect(panel.locator('.memory-library-maintenance')).toContainText('需要重试');
    await panel.getByRole('button', { name: '关闭记忆维护', exact: true }).click();
    const workspaceGeometry = await manager.evaluate(element => ({ width: element.getBoundingClientRect().width, client: element.clientWidth, scroll: element.scrollWidth }));
    expect(workspaceGeometry.width).toBeGreaterThan(1000); expect(workspaceGeometry.scroll).toBeLessThanOrEqual(workspaceGeometry.client + 1);
    const columns = await panel.locator('.memory-library-body').evaluate(element => [...element.children].map(child => ({ left: child.getBoundingClientRect().left, width: child.getBoundingClientRect().width })));
    expect(columns).toHaveLength(3); expect(columns[1]!.left).toBeGreaterThanOrEqual(columns[0]!.left + columns[0]!.width); expect(columns[2]!.width).toBeGreaterThan(500);
    const artifacts = path.resolve('.tools/test-output/companions'); mkdirSync(artifacts, { recursive: true });
    for (const [mode, name] of [['亮色', 'verified-memory-system.png'], ['暗色', 'verified-memory-system-dark.png']] as const) {
      await manager.getByRole('button', { name: '关闭共同记忆管理', exact: true }).click();
      await theme(page, mode);
      await journal.getByRole('button', { name: '管理共同记忆', exact: true }).click();
      await panel.locator('[data-memory-note="' + learned.id + '"]').click();
      const sourceButton = panel.getByRole('button', { name: `查看记忆来源 ${learned.id}`, exact: true });
      if (await sourceButton.getAttribute('aria-expanded') !== 'true') await sourceButton.click();
      if (await panel.locator('.memory-library-source').getAttribute('open') === null) await panel.locator('.memory-library-source summary').click();
      await page.screenshot({ path: path.join(artifacts, name) });
    }
    await panel.getByRole('button', { name: `编辑记忆 ${learned.id}`, exact: true }).click();
    await panel.getByRole('textbox', { name: '共同记忆内容', exact: true }).fill('用户现在喜欢看森林。');
    const concurrentWrite = await page.evaluate(async ({ owner, noteId }) => {
      const api = (window as unknown as CompanionBridgeWindow).worldlinebox.companions;
      const document = (await api.workspace!({ type: 'memory.documents.list', companionId: owner, directory: '', limit: 64 })).documents!.items.find(item => item.noteId === noteId)!;
      return api.workspace!({ type: 'memory.documents.save', companionId: owner, path: document.path, expectedRevision: document.revision, content: '用户现在喜欢看山。' });
    }, { owner: companionId, noteId: learned.id });
    expect(concurrentWrite.ok, concurrentWrite.error).toBe(true);
    await panel.getByRole('button', { name: '保存修正', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('文件或宿主日记已发生变化');
    await expect(panel.getByRole('textbox', { name: '共同记忆内容', exact: true })).toHaveValue('用户现在喜欢看森林。');
    const concurrent = (await browse()).memoryPage!.items.find(hit => hit.memory.id === learned.id)!.memory;
    expect(concurrent.content).toBe('用户现在喜欢看山。');
    await expect(panel.locator('[data-memory-note="' + learned.id + '"]')).toContainText('用户现在喜欢看山。');
    await panel.getByRole('button', { name: '取消编辑', exact: true }).click();
    await panel.getByRole('button', { name: '放弃修改并离开', exact: true }).click();
    await panel.getByRole('button', { name: `编辑记忆 ${learned.id}`, exact: true }).click();
    await panel.getByRole('textbox', { name: '共同记忆内容', exact: true }).fill('用户现在喜欢看森林。');
    await panel.getByRole('button', { name: '保存修正', exact: true }).click();
    await expect.poll(async () => (await browse()).memoryPage?.items.find(hit => hit.memory.id === learned.id)?.memory.content).toBe('用户现在喜欢看森林。');
    expect((await browse()).memoryPage!.items.find(hit => hit.memory.id === learned.id)!.memory.version).toBe(concurrent.version! + 1);
    await panel.getByRole('button', { name: `删除记忆 ${learned.id}`, exact: true }).click();
    await expect(panel.getByText('这篇文档及其旧来源的衍生记忆将退出召回，原始聊天仍保留。此操作不会删除其他日记。', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '确认遗忘', exact: true }).click();
    await expect.poll(async () => (await browse()).memoryPage?.items.length).toBe(0);
    expect((await request(page, { type: 'memory.status', companionId, conversationId })).memoryStatus?.forgotten).toBeGreaterThan(0);
    await expect(panel.locator('[data-memory-note="' + learned.id + '"]')).toHaveCount(0);
    await expect(panel).not.toContainText('用户现在喜欢看森林。');
    expect((await messages(page, conversationId)).some(message => message.id === source.id)).toBe(true);
    await application.close(); application = undefined;
    started = await launch(profile, false); application = started.application; page = started.page;
    expect((await browse()).memoryPage!.items).toHaveLength(0);
    expect((await request(page, { type: 'memory.status', companionId, conversationId })).memoryStatus?.forgotten).toBeGreaterThan(0);
    expect((await request(page, { type: 'memory.search', companionId, conversationId, query: '看海 看山 看森林', tags: [], limit: 20 })).memoryPage!.items).toHaveLength(0);
    expect((await request(page, { type: 'memory.sources.filter', companionId, conversationId, ids: [source.id] })).memorySources).toEqual([]);
    expect((await messages(page, conversationId)).some(message => message.id === source.id && message.content === '我喜欢看海')).toBe(true);
    const forgottenTrace = (await request(page, { type: 'memory.trace.inspect', companionId, kind: 'journal', id: learned.id, stage: 'capture', limit: 10 })).memoryTrace!;
    expect(forgottenTrace).toMatchObject({ companionId, root: { id: learned.id, status: 'forgotten', redacted: true } });
    expect(forgottenTrace.stages).toEqual([]);
    await testInfo.attach('capture-trace-redacted-after-restart', { body: JSON.stringify({ companionId, noteId: learned.id,
      status: forgottenTrace.root.status, redacted: forgottenTrace.root.redacted, stages: forgottenTrace.stages }, null, 2), contentType: 'application/json' });
  } catch (error) {
    if (application) {
      const live = await application.windows()[0]?.evaluate(async () => {
        const api = (window as unknown as CompanionBridgeWindow).worldlinebox.companions;
        return { status: await api.request({ type: 'memory.status', companionId: 'deepseek-sister' }),
          processing: await api.request({ type: 'memory.processing.status', companionId: 'deepseek-sister', filter: 'all', limit: 50 }),
          state: await api.request({ type: 'state' }) };
      }).catch(() => undefined);
      diagnostics.push(JSON.stringify(live));
    }
    await application?.windows()[0]?.screenshot({ path: testInfo.outputPath('memory-failure.png') }).catch(() => undefined);
    const logs = path.join(profile, 'logs');
    if (existsSync(logs)) for (const file of readdirSync(logs).filter(file => file.endsWith('.log'))) diagnostics.push(readFileSync(path.join(logs, file), 'utf8'));
    mkdirSync(path.resolve('artifacts/vcp-validation'), { recursive: true });
    const diagnosticPath = path.resolve('artifacts/vcp-validation/memory-application-diagnostics.log');
    await import('node:fs/promises').then(fs => fs.writeFile(diagnosticPath, diagnostics.join('\n').replaceAll('fixture-memory-key', '[fixture key]'), 'utf8'));
    await testInfo.attach('companion-application-diagnostics', { body: diagnostics.join('\n').replaceAll('fixture-memory-key', '[fixture key]'), contentType: 'text/plain' });
    throw error;
  } finally { if (application) await application.close(); await provider.close(); cleanup(root); }
});

// eslint-disable-next-line no-empty-pattern
test('journal uses live state and calendar plans, reminder runs once, and spacious managers work in both themes', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-journal-'));
  const profile = path.join(root, 'profile'), provider = await providerFixture();
  let application: ElectronApplication | undefined;
  const diagnostics: string[] = [];
  try {
    const started = await launch(profile, false); application = started.application; const page = started.page;
    application.process().stderr?.on('data', chunk => diagnostics.push(String(chunk)));
    await setGlobal(page, { apiFormat: 'openai_chat', baseUrl: provider.baseUrl, model: 'fixture-memory', apiKey: 'fixture-memory-key' });
    await page.locator('[data-application-module="companions"]').click();
    await page.getByRole('button', { name: '发起聊天', exact: true }).click();
    await page.getByRole('dialog', { name: '发起聊天' }).locator('.companions-start-chat-list button').filter({ has: page.getByText('大肥鱼', { exact: true }) }).click();
    const conversationId = 'private-deepseek-sister', companionId = 'deepseek-sister';
    await ensureAwakeRoutine(page, companionId, conversationId);
    const before = (await request(page, { type: 'state.get', companionId, conversationId })).runtimeState!;
    await sendUi(page, conversationId, '谢谢你一直陪我，我相信你，也会支持你。', [companionId]);
    await expect.poll(async () => (await request(page, { type: 'state.get', companionId, conversationId })).runtimeState!.relationship.affinity, { timeout: 35_000 }).toBeGreaterThan(before.relationship.affinity);
    await expect.poll(() => provider.requests.some(item => item.toolResults?.some(text => {
      try {
        const result = JSON.parse(text) as { ok?: boolean; stateObservation?: { status?: string; revision?: number } };
        return result.ok === true && result.stateObservation?.status === 'historical' && (result.stateObservation.revision ?? 0) > before.revision;
      } catch { return false; }
    }))).toBe(true);
    const after = (await request(page, { type: 'state.get', companionId, conversationId })).runtimeState!;
    expect(after.affect.pleasure).toBeGreaterThan(before.affect.pleasure);
    await page.getByRole('button', { name: '我们之间', exact: true }).click();
    const journal = page.getByRole('complementary', { name: '伙伴手帐' });
    await expect(journal.getByRole('progressbar', { name: '伙伴精力' })).toBeVisible();
    await expect(journal.getByRole('button', { name: '查看当前伙伴状态详情', exact: true })).toContainText('好感 ' + Math.round(after.relationship.affinity));
    await journal.getByRole('button', { name: '查看当前伙伴状态详情', exact: true }).click();
    await expect(journal.getByRole('dialog', { name: '伙伴当前状态' })).toContainText('用户表达了陪伴的感谢与信任。');
    await expect(journal.locator('meter')).toHaveCount(6);
    await journal.getByRole('button', { name: '关闭当前状态详情', exact: true }).click();
    await journal.getByRole('button', { name: '管理伙伴日程', exact: true }).click();
    const manager = page.getByRole('dialog', { name: '伙伴日程', exact: true });
    await manager.getByRole('button', { name: '添加安排', exact: true }).click();
    await manager.getByRole('textbox', { name: '安排标题', exact: true }).fill('记得喝一杯温水');
    const reminder = '现在休息一下，喝一杯温水。';
    await manager.getByRole('textbox', { name: '安排内容', exact: true }).fill(reminder);
    const local = (value: number) => { const date = new Date(value), pad = (part: number) => String(part).padStart(2, '0'); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}${date.getSeconds() ? ':' + pad(date.getSeconds()) : ''}`; };
    await manager.getByLabel('首次执行时间', { exact: true }).fill(local(Date.now() + 7000));
    await manager.getByRole('button', { name: '保存安排', exact: true }).click();
    await expect(manager.locator('.companions-schedule-row')).toContainText('记得喝一杯温水');
    const created = (await request(page, { type: 'schedule.list', companionId, conversationId, includeHistory: true, limit: 100 })).schedules!.find(schedule => schedule.title === '记得喝一杯温水')!;
    expect(created.kind).toBe('reminder'); expect(created.flexible).toBe(false);
    await manager.getByRole('button', { name: '关闭伙伴日程', exact: true }).click();
    await expect.poll(async () => (await messages(page, conversationId)).filter(message => message.authorId === companionId && message.content.includes(reminder)).length, { timeout: 30_000 }).toBe(1);
    await expect(page.locator('[data-companion-messages]')).toContainText(reminder);
    await expect(page.locator('[data-companion-messages]')).not.toContainText('首次时间：');
    await expect.poll(async () => (await request(page, { type: 'schedule.list', companionId, conversationId, includeHistory: true, limit: 100 })).scheduleOccurrences!.filter(item => item.scheduleId === created.id && item.status === 'done').length).toBe(1);
    await journal.getByRole('button', { name: '管理伙伴日程', exact: true }).click();
    await manager.getByRole('button', { name: '添加安排', exact: true }).click();
    await manager.getByRole('textbox', { name: '安排标题', exact: true }).fill('周末一起整理旅行照片');
    await manager.getByRole('textbox', { name: '安排内容', exact: true }).fill('把上周旅行的照片整理成目录，保留原文件。');
    await manager.getByLabel('首次执行时间', { exact: true }).fill(local(Date.now() + 86_400_000));
    await manager.getByLabel('安排类型', { exact: true }).selectOption('task');
    await manager.getByLabel('时间可调整', { exact: true }).check();
    await manager.getByRole('button', { name: '保存安排', exact: true }).click();
    await expect(manager.locator('.companions-schedule-row')).toContainText('周末一起整理旅行照片');
    await manager.getByRole('button', { name: '作息与习惯', exact: true }).click();
    await expect(manager.getByLabel('伙伴睡觉时间', { exact: true })).toBeVisible();
    await manager.getByLabel('伙伴睡觉时间', { exact: true }).fill('22:45');
    await manager.getByRole('button', { name: '添加习惯', exact: true }).click();
    await manager.getByLabel('习惯 1 名称', { exact: true }).fill('晚间读二十分钟书');
    await manager.getByLabel('习惯 1 时间', { exact: true }).fill('20:30');
    await manager.getByLabel('习惯 1 类型', { exact: true }).selectOption('study');
    await manager.getByRole('button', { name: '保存作息与习惯', exact: true }).click();
    await expect.poll(async () => (await request(page, { type: 'routine.get', companionId, conversationId })).routine?.config.sleepAt).toBe('22:45');
    const routine = (await request(page, { type: 'routine.get', companionId, conversationId })).routine!;
    expect(routine.config.habits.some(habit => habit.title === '晚间读二十分钟书' && habit.kind === 'study')).toBe(true);
    await manager.getByRole('button', { name: '关闭伙伴日程', exact: true }).click();
    await expect(journal.locator('[data-schedule-note]')).toContainText('周末一起整理旅行照片');
    const artifacts = path.resolve('.tools/test-output/companions'); mkdirSync(artifacts, { recursive: true });
    for (const [label, name] of [['亮色', 'light'], ['暗色', 'dark']] as const) {
      await theme(page, label);
      const geometry = await journal.evaluate(element => ({ width: element.getBoundingClientRect().width, client: element.clientWidth, scroll: element.scrollWidth }));
      expect(geometry.width).toBe(320); expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
      await page.screenshot({ path: path.join(artifacts, `verified-companion-journal-${name}.png`) });
      await journal.getByRole('button', { name: '管理伙伴日程', exact: true }).click();
      await manager.locator('.companions-schedule-row').filter({ hasText: '周末一起整理旅行照片' }).getByRole('button', { name: '编辑', exact: true }).click();
      await expect(manager.getByRole('textbox', { name: '安排内容', exact: true })).toHaveValue('把上周旅行的照片整理成目录，保留原文件。');
      const scheduleGeometry = await manager.evaluate(element => ({ width: element.getBoundingClientRect().width, client: element.clientWidth, scroll: element.scrollWidth }));
      expect(scheduleGeometry.width).toBeGreaterThan(1000); expect(scheduleGeometry.scroll).toBeLessThanOrEqual(scheduleGeometry.client + 1);
      await page.screenshot({ path: path.join(artifacts, `verified-companion-schedules-${name}.png`) });
      await manager.getByRole('button', { name: '作息与习惯', exact: true }).click();
      await expect(manager.getByLabel('伙伴睡觉时间', { exact: true })).toHaveValue('22:45');
      await page.screenshot({ path: path.join(artifacts, `verified-companion-routine-${name}.png`) });
      await manager.getByRole('button', { name: '关闭伙伴日程', exact: true }).click();
    }
    await journal.getByRole('button', { name: '查看伙伴资料', exact: true }).click();
    const profileHeading = page.locator('.companions-contact-profile h2');
    await expect.poll(() => profileHeading.evaluate(element => [...element.childNodes]
      .filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent ?? '').join('').trim())).toBe('大肥鱼');
    await expect(profileHeading.locator('.companion-status-badge')).toBeVisible();
    await page.locator('.companions-persona-details summary').click();
    const persona = (await request(page, { type: 'state' })).state!.companions.find(companion => companion.id === companionId)!.persona;
    await expect(page.locator('.companions-persona')).toHaveText(persona);
    expect((await messages(page, conversationId)).filter(message => message.authorId === companionId && message.content.includes(reminder))).toHaveLength(1);
  } catch (error) {
    await application?.windows()[0]?.screenshot({ path: testInfo.outputPath('journal-failure.png') }).catch(() => undefined);
    const failedPage = application?.windows()[0];
    if (failedPage) diagnostics.push(JSON.stringify({ runtimeState: (await request(failedPage, { type: 'state.get', companionId: 'deepseek-sister', conversationId: 'private-deepseek-sister' })).runtimeState, memoryStatus: (await request(failedPage, { type: 'memory.status', companionId: 'deepseek-sister', conversationId: 'private-deepseek-sister' })).memoryStatus, providerRequests: provider.requests.slice(-5), memoryRequests: provider.memoryRequests }));
    const logs = path.join(profile, 'logs');
    if (existsSync(logs)) for (const file of readdirSync(logs).filter(file => file.endsWith('.log'))) diagnostics.push(readFileSync(path.join(logs, file), 'utf8'));
    await testInfo.attach('journal-application-diagnostics', { body: diagnostics.join('\n').replaceAll('fixture-memory-key', '[fixture key]'), contentType: 'text/plain' }); throw error;
  } finally { if (application) await application.close(); await provider.close(); cleanup(root); }
});

// eslint-disable-next-line no-empty-pattern
test('renders real SSE text before completion, continues after a tool, stops on cancel and recovers a persisted draft after restart', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-stream-'));
  const profile = path.join(root, 'profile'), provider = await providerFixture();
  let application: ElectronApplication | undefined, page: Page | undefined;
  let succeeded = false;
  const diagnostics: string[] = [], companionId = 'deepseek-sister', conversationId = 'private-deepseek-sister';
  const firstTokenMilestones: Array<{ userText: string; elapsedMs: number; replyId: string }> = [];
  try {
    let started = await launch(profile, false); application = started.application; page = started.page;
    application.process().stderr?.on('data', chunk => diagnostics.push(String(chunk)));
    await setGlobal(page, { apiFormat: 'openai_chat', baseUrl: provider.baseUrl, model: 'fixture-stream', apiKey: 'fixture-stream-key' });
    await page.locator('[data-application-module="companions"]').click();
    await page.getByRole('button', { name: '发起聊天', exact: true }).click();
    await page.getByRole('dialog', { name: '发起聊天' }).locator('.companions-start-chat-list button').filter({ has: page.getByText('大肥鱼', { exact: true }) }).click();
    await ensureAwakeRoutine(page, companionId, conversationId);
    async function begin(text: string) {
      const startedAt = Date.now();
      await page!.getByRole('textbox', { name: '输入消息', exact: true }).fill(text);
      await page!.getByRole('button', { name: '发送', exact: true }).click();
      let source: CompanionMessage | undefined;
      await expect.poll(async () => { source = (await messages(page!, conversationId)).find(message => message.authorId === 'user' && message.content === text); return source?.id; }).toBeTruthy();
      const sourceId = source!.id;
      await expect.poll(async () => (await messages(page!, conversationId)).find(message => message.replyToId === sourceId && message.authorId === companionId)?.id).toBeTruthy();
      const reply = (await messages(page!, conversationId)).find(message => message.replyToId === sourceId && message.authorId === companionId)!;
      const body = page!.locator(`[data-companion-message="${reply.id}"]`);
      await expect(body.getByRole('status', { name: '本条回复进度', exact: true })).toBeVisible();
      // The real first passive recall includes verifying the bundled model. Its
      // own bubble must already exist while that work precedes the SSE request.
      await expect.poll(() => provider.streamStarts.some(start => start.userText === text && start.step === 0), { timeout: 60_000 }).toBe(true);
      const milestone = { userText: text, elapsedMs: Date.now() - startedAt, replyId: reply.id };
      firstTokenMilestones.push(milestone); diagnostics.push(JSON.stringify({ milestone: 'first-stream-token', ...milestone }));
      const first = provider.streamStarts.find(start => start.userText === text && start.step === 0)!;
      await expect(body.locator('[data-reply-phase="streaming"]')).toContainText(first.first);
      await expect(body).not.toContainText(first.second);
      return { reply, body, first };
    }
    async function completed(id: string, expected: string) {
      await expect.poll(async () => (await messages(page!, conversationId)).find(message => message.id === id)?.content).toBe(expected);
      await expect.poll(async () => (await messages(page!, conversationId)).find(message => message.id === id)?.isReplyDraft).not.toBe(true);
      await expect(page!.locator(`[data-companion-message="${id}"] [aria-label="伙伴正在输出"]`)).toHaveCount(0);
    }
    const plainText = '流式验收：普通聊天', plain = await begin(plainText);
    const artifacts = path.resolve('.tools/test-output/companions'); mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'verified-companion-streaming.png') });
    provider.releaseStream(plainText); await completed(plain.reply.id, plain.first.first + plain.first.second);
    const toolText = '流式验收：工具后接着说', tool = await begin(toolText);
    provider.releaseStream(toolText);
    await expect.poll(() => provider.streamStarts.some(start => start.userText === toolText && start.step === 1)).toBe(true);
    const afterTool = provider.streamStarts.find(start => start.userText === toolText && start.step === 1)!;
    await expect(tool.body.locator('[data-reply-phase="streaming"]')).toContainText(afterTool.first);
    await expect(tool.body).toContainText(tool.first.first + tool.first.second);
    await expect(tool.body).not.toContainText(afterTool.second);
    expect(provider.requests.some(item => item.latestUser === toolText && item.toolResults?.some(text => text.includes('runtimeState')))).toBe(true);
    provider.releaseStream(toolText, 1);
    await completed(tool.reply.id, tool.first.first + tool.first.second + '\n\n' + afterTool.first + afterTool.second);
    expect((await messages(page, conversationId)).find(message => message.id === tool.reply.id)!.segments).toHaveLength(2);
    const cancelText = '流式验收：取消', cancelled = await begin(cancelText);
    await cancelled.body.getByRole('button', { name: '取消这条回复', exact: true }).click();
    await expect(cancelled.body).toContainText('已取消'); await expect(cancelled.body).toContainText(cancelled.first.first);
    provider.releaseStream(cancelText);
    await expect(cancelled.body).not.toContainText(cancelled.first.second);
    await expect.poll(async () => (await messages(page!, conversationId)).find(message => message.id === cancelled.reply.id)?.replyDraft?.text).toBe(cancelled.first.first);
    const resumeText = '流式验收：重启恢复', interrupted = await begin(resumeText);
    await expect.poll(async () => (await messages(page!, conversationId)).find(message => message.id === interrupted.reply.id)?.replyDraft?.text, { timeout: 10_000 }).toBe(interrupted.first.first);
    await application.close(); application = undefined;
    started = await launch(profile, false); application = started.application; page = started.page;
    application.process().stderr?.on('data', chunk => diagnostics.push(String(chunk)));
    await page.locator('[data-application-module="companions"]').click();
    const restored = page.locator(`[data-companion-message="${interrupted.reply.id}"]`);
    await expect(restored).toContainText(interrupted.first.first, { timeout: 30_000 }); await expect(restored).toContainText('回复中断');
    expect(provider.streamStarts.filter(start => start.userText === resumeText)).toHaveLength(1);
    await restored.getByRole('button', { name: '重试这条回复', exact: true }).click();
    await expect.poll(() => provider.streamStarts.filter(start => start.userText === resumeText).length).toBe(2);
    await expect(restored.locator('[data-reply-phase="streaming"]')).toContainText(interrupted.first.first);
    provider.releaseStream(resumeText);
    await completed(interrupted.reply.id, interrupted.first.first + interrupted.first.second);
    expect((await messages(page, conversationId)).find(message => message.id === interrupted.reply.id)!.content.match(/重启前已经出现的正文/gu)).toHaveLength(1);
    await expect(restored).not.toContainText('回复已中断');
    expect((await messages(page, conversationId)).find(message => message.id === cancelled.reply.id)!.content).not.toContain(cancelled.first.second);
    const evidence = path.resolve('artifacts/vcp-validation/parallel-reply-progress'); mkdirSync(evidence, { recursive: true });
    writeFileSync(path.join(evidence, 'reply-stream-restart-proof.json'), JSON.stringify({ firstTokenMilestones,
      resumedMessageId: interrupted.reply.id, attemptsAfterRestart: provider.streamStarts.filter(start => start.userText === resumeText).length,
      cancelledMessageId: cancelled.reply.id, targetedCancellation: true, draftSurvivedWholeApplicationRestart: true }, null, 2));
    succeeded = true;
  } catch (error) {
    await page?.screenshot({ path: testInfo.outputPath('streaming-failure.png') }).catch(() => undefined);
    diagnostics.push(JSON.stringify({ starts: provider.streamStarts, requests: provider.requests.slice(-6) }));
    const logs = path.join(profile, 'logs'); if (existsSync(logs)) for (const file of readdirSync(logs).filter(file => file.endsWith('.log'))) diagnostics.push(readFileSync(path.join(logs, file), 'utf8'));
    const diagnosticRoot = path.resolve('artifacts/vcp-validation/reply-restart-diagnostics'); mkdirSync(diagnosticRoot, { recursive: true });
    writeFileSync(path.join(diagnosticRoot, 'latest.txt'), 'retained fixture: ' + root + '\n' + diagnostics.join('\n').replaceAll('fixture-stream-key', '[fixture key]'));
    await testInfo.attach('streaming-application-diagnostics', { body: diagnostics.join('\n').replaceAll('fixture-stream-key', '[fixture key]'), contentType: 'text/plain' }); throw error;
  } finally { if (application) await application.close(); await provider.close(); if (succeeded) cleanup(root); else console.log('RETAINED_STREAM_FIXTURE', root); }
});

test('starts empty, bounds long history, searches with filters and context, and deletes or dissolves chats', async () => {
  test.setTimeout(120_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-paging-'));
  const profile = path.join(root, 'profile'); let application: ElectronApplication | undefined;
  try {
    let started = await launch(profile, false); application = started.application; let page = started.page;
    await page.locator('[data-application-module="companions"]').click();
    expect((await request(page, { type: 'state' })).state!.conversations).toHaveLength(0);
    await expect(page.locator('[data-companion-conversation]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '添加联系人', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '发起聊天', exact: true }).click();
    const chooser = page.getByRole('dialog', { name: '发起聊天' });
    await chooser.locator('.companions-start-chat-list button').filter({ has: page.getByText('GPT', { exact: true }) }).click();
    await expect(chooser).toHaveCount(0); await expect(page.locator('[data-companion-conversation="private-gpt"]')).toBeVisible();
    expect(await messages(page, 'private-gpt')).toHaveLength(0);
    await expect(page.locator('[data-presence-trigger] .companion-avatar-presence')).toHaveAttribute('data-status', 'offline');
    await expect(page.locator('.companions-config-hint')).toHaveCount(0);
    await page.getByRole('button', { name: '查看伙伴状态', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '伙伴状态' })).toContainText('离线');
    await page.getByRole('button', { name: '关闭伙伴状态', exact: true }).click();
    await setGlobal(page, { apiFormat: 'openai_chat', baseUrl: 'https://example.invalid', model: 'presence-fixture', apiKey: 'fixture-presence-key' });
    await expect(page.locator('[data-presence-trigger] .companion-avatar-presence')).toHaveAttribute('data-status', 'ready');
    await application.close(); application = undefined;
    const script = `const db=new (require('better-sqlite3'))(process.argv[1]);
      db.function('companion_search_tokens',{deterministic:true},s=>Array.from(s.normalize('NFKC').toLowerCase(),c=>'u'+c.codePointAt(0).toString(16)).join(' '));
      db.function('companion_search_facet',{deterministic:true},s=>Array.from(s,c=>c.codePointAt(0).toString(16)).join('x'));
      const insert=db.prepare("INSERT INTO messages(id,conversation_id,author_id,kind,content,created_at,status) VALUES(?,'private-gpt',?,'text',?,?,'sent')");
      db.transaction(()=>{for(let i=1;i<=1800;i++)insert.run('history_'+i,i%2?'user':'gpt','历史编号 '+i+'：一起讨论小说、图片和生活。'+(i%10===0?' 星海合同':'')+' 这是一段足够长的聊天内容，验证连续滚动的阅读位置。',new Date(Date.UTC(2026,0,1)+Math.floor(i/50)*86400000).toISOString());})();db.close();`;
    const seeded = spawnSync(resolveElectronExecutablePath(), ['-e', script, path.join(companionDataRoot(profile), 'messages.sqlite')], { cwd: process.cwd(), env: { ...electronLaunchEnv(), ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true });
    expect(seeded.status, seeded.stderr).toBe(0);
    started = await launch(profile, false); application = started.application; page = started.page;
    await page.locator('[data-application-module="companions"]').click(); await page.locator('[data-companion-conversation="private-gpt"]').click();
    const pane = page.locator('[data-companion-messages]'); await expect(pane).toHaveAttribute('data-window-count', '50');
    for (let turn = 0; turn < 18; turn++) {
      const first = await pane.locator('[data-companion-message]').first().getAttribute('data-companion-message');
      await pane.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
      await expect.poll(() => pane.locator('[data-companion-message]').first().getAttribute('data-companion-message')).not.toBe(first);
      expect(Number(await pane.getAttribute('data-window-count'))).toBeLessThanOrEqual(200);
    }
    await expect(page.getByRole('button', { name: '回到最新消息', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
    await expect(pane).toHaveAttribute('data-window-count', '50'); await expect(pane.locator('[data-companion-message="history_1800"]')).toBeVisible();
    await page.getByRole('button', { name: '搜索聊天记录', exact: true }).click();
    const search = page.getByRole('dialog', { name: '查找聊天记录' });
    await search.getByRole('textbox', { name: '搜索聊天内容' }).fill('合同');
    await expect(search.locator('[data-search-message]')).toHaveCount(30);
    await search.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(search.locator('footer')).toContainText('第 2 页'); await expect(search.locator('[data-search-message]')).toHaveCount(30);
    await search.getByLabel('搜索发送者', { exact: true }).selectOption('gpt');
    await search.getByLabel('开始日期', { exact: true }).fill('2026-01-02'); await search.getByLabel('结束日期', { exact: true }).fill('2026-01-03');
    await expect(search.locator('[data-search-message]')).toHaveCount(10);
    await expect(search.locator('mark').first()).toHaveText('合同');
    await expect(search.locator('time').first()).toHaveText(/2026-01-03 08:00:00\.000/);
    mkdirSync(path.resolve('.tools/test-output/companions'), { recursive: true }); await page.screenshot({ path: path.resolve('.tools/test-output/companions/verified-history-search.png') });
    const hit = await search.locator('[data-search-message]').first().getAttribute('data-search-message');
    await search.locator('[data-search-message]').first().click(); await expect(search).toHaveCount(0);
    await expect(pane.locator('[data-companion-message="' + hit + '"]')).toBeVisible();
    await expect(pane.locator('[data-companion-message="' + hit + '"]')).toHaveClass(/is-highlighted/);
    await expect(page.locator('.companions-history-banner')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '正在查看历史消息', exact: true })).toBeVisible();
    await expect(pane.locator('[data-companion-message="history_1800"]')).toHaveCount(0);
    const bubbleGeometry = await pane.locator('[data-companion-message="' + hit + '"]').evaluate(element => {
      const bubble = element.querySelector('.companions-message-bubble')!;
      return { rowBackground: getComputedStyle(element).backgroundColor, bubbleBackground: getComputedStyle(bubble).backgroundColor,
        bubbleWidth: bubble.getBoundingClientRect().width, rowWidth: element.getBoundingClientRect().width };
    });
    expect(bubbleGeometry.rowBackground).toBe('rgba(0, 0, 0, 0)'); expect(bubbleGeometry.bubbleBackground).not.toBe('rgba(0, 0, 0, 0)');
    expect(bubbleGeometry.bubbleWidth).toBeLessThan(bubbleGeometry.rowWidth * .8);
    await page.screenshot({ path: path.resolve('.tools/test-output/companions/verified-history-context.png') });
    await page.getByRole('button', { name: '回到最新消息', exact: true }).click(); await expect(pane.locator('[data-companion-message="history_1800"]')).toBeVisible();
    await page.getByRole('button', { name: '删除聊天', exact: true }).click(); await page.getByRole('dialog', { name: '删除聊天' }).getByRole('button', { name: '删除聊天', exact: true }).click();
    await expect(page.locator('[data-companion-conversation]')).toHaveCount(0);
    await request(page, { type: 'conversation.open', companionId: 'gpt' }); await expect(page.locator('[data-companion-conversation="private-gpt"]')).toBeVisible();
    expect((await messages(page, 'private-gpt')).at(-1)?.id).toBe('history_1800');
    const group = (await request(page, { type: 'conversation.create-group', title: '', memberIds: ['gpt', 'kimi'] })).conversation!;
    await page.locator('[data-companion-conversation="' + group.id + '"]').click(); await page.getByRole('button', { name: '管理群聊', exact: true }).click();
    await page.getByRole('dialog', { name: '管理群聊' }).getByRole('button', { name: '解散群聊', exact: true }).click();
    await page.getByRole('dialog', { name: '管理群聊' }).getByRole('button', { name: '确认解散群聊', exact: true }).click();
    await expect(page.locator('[data-companion-conversation="' + group.id + '"]')).toHaveCount(0);
    const recreated = (await request(page, { type: 'conversation.create-group', title: '', memberIds: ['kimi', 'gpt'] })).conversation!;
    expect(recreated.id).not.toBe(group.id);
    await application.close(); application = undefined;
    started = await launch(profile, false); application = started.application;
    const final = (await request(started.page, { type: 'state' })).state!;
    expect(final.conversations.map(room => room.id)).not.toContain(group.id); expect(final.conversations.map(room => room.id)).toContain(recreated.id);
  } finally { if (application) await application.close(); cleanup(root); }
});

test('loads every portrait, preserves edited built-ins and chats privately and in a mixed-role group', async () => {
  // Each of thirteen distinct residents physically walks to its own computer.
  test.setTimeout(300_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-catalogue-'));
  const profile = path.join(root, 'profile'); const provider = await providerFixture();
  let application: ElectronApplication | undefined;
  try {
    let started = await launch(profile); application = started.application; let page = started.page;
    await setGlobal(page, { apiFormat: 'openai_chat', baseUrl: provider.baseUrl, model: 'one-shared-fixture-model', apiKey: 'fixture-catalogue-key' });
    await page.locator('[data-application-module="companions"]').click();
    const state = (await request(page, { type: 'state' })).state!;
    expect(state.companions).toHaveLength(15);
    const additions = state.companions.filter(item => !item.id.startsWith('deepseek-'));
    expect(additions).toHaveLength(13);
    await page.getByRole('button', { name: '联系人', exact: true }).click();
    await expect(page.locator('[data-companion-contact]')).toHaveCount(15);
    await page.getByRole('button', { name: '添加联系人', exact: true }).click();
    const catalogue = page.getByRole('dialog', { name: '添加联系人', exact: true });
    await expect(catalogue.locator('[data-builtin-template]')).toHaveCount(15);
    const decoded = await catalogue.locator('.has-square-image').evaluateAll(async elements => Promise.all(elements.map(async element => {
      const url = getComputedStyle(element).backgroundImage.slice(5, -2);
      const image = new Image(); image.src = url; await image.decode();
      return image.naturalWidth > 0 && image.naturalHeight === image.naturalWidth;
    })));
    expect(decoded).toHaveLength(15); expect(decoded.every(Boolean)).toBe(true);
    await catalogue.getByRole('button', { name: '原创角色', exact: true }).click();
    await expect(catalogue.locator('[data-builtin-template]')).toHaveCount(2);
    mkdirSync(path.resolve('.tools/test-output/companions'), { recursive: true });
    await page.screenshot({ path: path.resolve('.tools/test-output/companions/verified-catalogue-originals.png') });
    await catalogue.getByRole('button', { name: '社区伙伴', exact: true }).click();
    await expect(catalogue.locator('[data-builtin-template]')).toHaveCount(5);
    await page.screenshot({ path: path.resolve('.tools/test-output/companions/verified-catalogue-community.png') });
    await catalogue.getByRole('button', { name: '全部', exact: true }).click();
    await catalogue.getByRole('textbox', { name: '搜索内置角色', exact: true }).fill('白龙');
    await expect(catalogue.locator('[data-builtin-template]')).toHaveCount(1);
    await catalogue.locator('[data-builtin-template="gpt"]').getByRole('button').click();
    await expect(page.locator('.companions-chat-header .companions-chat-name')).toHaveText('GPT');
    // Independent residents can walk to their own desks at the same time. The
    // host still advances every route and gates each subsequent model request.
    await Promise.all(additions.map(role => prepareReplyAuthors(page, [role.id])));
    for (const role of additions) {
      const source = await sendBridge(page, 'private-' + role.id, '迁移私聊验收：请回应这条消息。', [role.id]);
      const replies = (await messages(page, 'private-' + role.id)).filter(item => item.replyToId === source.id);
      expect(replies).toHaveLength(1); expect(replies[0]!.authorId).toBe(role.id); expect(replies[0]!.segments).toHaveLength(1);
    }
    const group = (await request(page, { type: 'conversation.create-group', title: '', memberIds: ['huan-white', 'gpt', 'doro'] })).conversation!;
    const groupSource = await sendBridge(page, group.id, '迁移群聊验收：每位伙伴各说一句。', group.memberIds);
    expect((await messages(page, group.id)).filter(item => item.replyToId === groupSource.id)).toHaveLength(3);
    expect(provider.requests.every(item => item.model === 'one-shared-fixture-model' && item.headers.authorization === 'Bearer fixture-catalogue-key')).toBe(true);
    const gpt = state.companions.find(item => item.id === 'gpt')!;
    await request(page, { type: 'companion.update', id: gpt.id, companion: { name: '小白龙', description: '我的白龙签名', persona: '用户编辑的白龙人设', avatar: gpt.avatar, model: '', proactive: false } });
    const rejectedDelete = await page.evaluate(id => (window as unknown as CompanionBridgeWindow).worldlinebox.companions.request({ type: 'companion.delete', id }), gpt.id);
    expect(rejectedDelete.ok).toBe(false); expect(rejectedDelete.error).toContain('内置伙伴不能删除');
    await application.close(); application = undefined;
    started = await launch(profile); application = started.application; page = started.page;
    expect((await request(page, { type: 'state' })).state!.companions.some(item => item.id === 'gpt')).toBe(true);
    const restored = (await request(page, { type: 'companion.add-builtin', templateId: 'gpt' })).companion!;
    expect(restored).toMatchObject({ id: 'gpt', name: '小白龙', description: '我的白龙签名', persona: '用户编辑的白龙人设' });
    expect((await messages(page, 'private-gpt')).filter(item => item.kind === 'notice')).toHaveLength(0);
    await page.locator('[data-application-module="companions"]').click();
    await page.getByRole('button', { name: '联系人', exact: true }).click();
    await page.locator('[data-companion-contact="gpt"]').click();
    await expect(page.locator('.companions-character-art img')).toBeVisible();
    await page.screenshot({ path: path.resolve('.tools/test-output/companions/verified-catalogue-profile.png') });
  } finally { if (application) await application.close(); await provider.close(); cleanup(root); }
});
test('shows a durable FIFO inbox after the fifth private reply and resumes unstarted messages automatically', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-queue-'));
  const profile = path.join(root, 'profile');
  const provider = await providerFixture({ roleId: 'deepseek-flash', userText: '队列验收' });
  let application: ElectronApplication | undefined;
  try {
    let started = await launch(profile); application = started.application;
    await started.page.evaluate(config => (window as unknown as CompanionBridgeWindow).worldlinebox.llm.setConfig(config),
      { apiFormat: 'openai_chat' as const, baseUrl: provider.baseUrl, model: 'fixture-queue', apiKey: 'fixture-queue-key' });
    await started.page.locator('[data-application-module="companions"]').click();
    await started.page.locator('[data-companion-conversation="private-deepseek-flash"]').click();
    const sources: string[] = [];
    for (let index = 0; index < 6; index++) sources.push((await request(started.page, { type: 'message.send', conversationId: 'private-deepseek-flash', content: '队列验收', clientId: randomUUID() })).message!.id);
    await expect.poll(() => provider.requests.length).toBe(5);
    await expect(started.page.getByRole('complementary', { name: '待发消息队列' })).toBeVisible();
    await expect(started.page.getByRole('button', { name: '消息模式' })).toHaveCount(0);
    await started.page.getByRole('button', { name: '立即引导', exact: true }).click();
    const chooser = started.page.getByRole('dialog', { name: '选择要引导的回复' });
    await expect(chooser).toBeVisible();
    await expect(chooser.locator('.companions-guide-target')).toHaveCount(5);
    await chooser.getByRole('button', { name: '关闭引导选择' }).click();
    await application.close(); application = undefined; provider.release();
    started = await launch(profile); application = started.application;
    await expect.poll(() => provider.requests.length).toBe(6);
    await expect.poll(async () => (await request(started.page, { type: 'messages', conversationId: 'private-deepseek-flash' })).messages
      ?.filter(message => message.authorId === 'deepseek-flash' && message.replyToId === sources[5] && message.content)).toHaveLength(1);
    const state = (await request(started.page, { type: 'state' })).state!;
    expect(state.queue?.filter(work => work.status === 'queued')).toHaveLength(0);
    expect(state.queue?.filter(work => work.status === 'interrupted')).toHaveLength(5);
  } finally { if (application) await application.close(); await provider.close(); cleanup(root); }
});
const richReply = ['## 格式示例', '', '**重点**与~~删除线~~，行内公式 $E=mc^2$。', '', '- [x] 已完成', '- [ ] 待办', '',
  '| 类型 | 状态 |', '| --- | :---: |', '| 代码 | 可复制 |', '', '~~~ts', 'const answer: number = 42;', '~~~', '',
  '$$', '\\int_0^1 x^2\\,dx = \\frac{1}{3}', '$$', '', '~~~mermaid', 'flowchart LR', ' A[需求] --> B[执行]', ' B --> C[结果]', '~~~',
  '', '[参考链接](https://example.test/reference)'].join('\n');

test('renders rich messages and diagrams, has no composer delivery-mode menu, and reuses a group with the same members', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-rich-'));
  const provider = await providerFixture(); let application: ElectronApplication | undefined;
  try {
    const started = await launch(path.join(root, 'profile')); application = started.application; const page = started.page;
    await setGlobal(page, { apiFormat: 'openai_chat', baseUrl: provider.baseUrl, model: 'fixture-global', apiKey: 'fixture-rich-test-key' });
    await page.locator('[data-application-module="companions"]').click();
    await sendUi(page, 'private-deepseek-sister', '格式验收', ['deepseek-sister']);
    await expect(page.locator('.companions-message-content .hljs-keyword')).toHaveCount(1);
    await expect(page.locator('.companions-message-content .katex-display')).toHaveCount(1);
    await expect(page.locator('.companions-diagram-svg svg')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.companions-diagram-svg')).toContainText('需求');
    await expect(page.locator('.companions-diagram-svg script, .companions-diagram-svg foreignObject')).toHaveCount(0);
    await expect(page.locator('.companions-delivery')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '消息模式' })).toHaveCount(0);
    const first = await request(page, { type: 'conversation.create-group', title: '', memberIds: ['deepseek-sister', 'deepseek-flash'] });
    expect(first.conversation?.title).toBe('我、大肥鱼和小肥鱼的群聊');
    const again = await request(page, { type: 'conversation.create-group', title: '另一个名字', memberIds: ['deepseek-flash', 'deepseek-sister'] });
    expect(again.conversation?.id).toBe(first.conversation?.id);
    expect((await request(page, { type: 'state' })).state?.conversations.filter(conversation => conversation.kind === 'group')).toHaveLength(1);
    await page.screenshot({ path: path.resolve('.tools/test-output/companions/verified-rich-messages.png') });
  } finally { if (application) await application.close(); await provider.close(); cleanup(root); }
});

test('reopening recovers an unfinished group reply without repeating the speaker already committed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-recovery-')), profile = path.join(root, 'profile');
  const provider = await providerFixture({ roleId: 'deepseek-flash', userText: '恢复聊天验证' });
  let application: ElectronApplication | undefined;
  try {
    let started = await launch(profile); application = started.application;
    await setGlobal(started.page, { apiFormat: 'openai_chat', baseUrl: provider.baseUrl, model: 'fixture-recovery', apiKey: 'fixture-recovery-key' });
    const group = (await request(started.page, { type: 'conversation.create-group', title: '', memberIds: ['deepseek-sister', 'deepseek-flash'] })).conversation!;
    await request(started.page, { type: 'message.send', conversationId: group.id, content: '恢复聊天验证', clientId: randomUUID(), delivery: 'chat' });
    await expect.poll(() => provider.requests.filter(item => item.latestUser === '恢复聊天验证').length).toBe(2);
    expect((await request(started.page, { type: 'messages', conversationId: group.id })).messages?.filter(message => message.authorId === 'deepseek-sister')).toHaveLength(1);
    await application.close(); application = undefined; provider.release();
    started = await launch(profile); application = started.application;
    await started.page.locator('[data-application-module="companions"]').click();
    await started.page.locator('[data-companion-conversation="' + group.id + '"]').click();
    await expect(started.page.getByRole('button', { name: '继续上次回复', exact: true })).toBeVisible();
    await started.page.getByRole('button', { name: '继续上次回复', exact: true }).click();
    await expect.poll(async () => (await request(started.page, { type: 'messages', conversationId: group.id })).messages?.filter(message => message.authorId === 'deepseek-flash').length).toBe(1);
    const messages = (await request(started.page, { type: 'messages', conversationId: group.id })).messages!;
    expect(messages.filter(message => message.authorId === 'deepseek-sister')).toHaveLength(1);
    expect(messages.filter(message => message.authorId === 'user')).toHaveLength(1);
    await expect(started.page.getByRole('button', { name: '继续上次回复', exact: true })).toHaveCount(0);
  } finally { if (application) await application.close(); await provider.close(); cleanup(root); }
});

test('task monitor pages durable role history and shows complete local timestamps', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-history-'));
  const profile = path.join(root, 'profile');
  let application: ElectronApplication | undefined;
  try {
    let started = await launch(profile); application = started.application;
    const group = (await request(started.page, { type: 'conversation.create-group', memberIds: ['deepseek-sister', 'deepseek-flash'], title: '' })).conversation!;
    const source = (await request(started.page, { type: 'message.send', conversationId: group.id, content: '任务历史来源', clientId: randomUUID() })).message!;
    await application.close(); application = undefined;
    // Offline fixture: the app and its database owner are closed during seeding.
    const data = Array.from({ length: 45 }, (_, index) => {
      const created = Date.UTC(2026, 9, 13, 2, index, 5, 123);
      return { id: 'history-' + String(index).padStart(3, '0'), conversationId: group.id, companionId: index % 2 ? 'deepseek-flash' : 'deepseek-sister', sourceMessageId: source.id, title: '历史任务 ' + index, status: 'succeeded',
        createdAt: new Date(created).toISOString(), startedAt: new Date(created + 333).toISOString(), finishedAt: new Date(created + 2345).toISOString(), updatedAt: new Date(created + 2345).toISOString(),
        result: '已核验任务 ' + index, events: [{ sequence: 1, type: 'tool_end', summary: '工具实际返回结果', contentKind: 'output', content: '原始工具输出 ' + index, receivedAt: new Date(created + 1234).toISOString() }] };
    });
    const sourceCode = `const Database=require('better-sqlite3');const db=new Database(process.argv[1]);const data=JSON.parse(process.argv[2]);db.transaction(()=>{for(const row of data)db.prepare('INSERT INTO actions(id,conversation_id,companion_id,status,data) VALUES(?,?,?,?,?)').run(row.id,row.conversationId,row.companionId,row.status,JSON.stringify(row))})();db.close();`;
    const seeded = spawnSync(resolveElectronExecutablePath(), ['-e', sourceCode, path.join(companionDataRoot(profile), 'messages.sqlite'), JSON.stringify(data)], { cwd: process.cwd(), env: { ...electronLaunchEnv(), ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true });
    expect(seeded.status, seeded.stderr).toBe(0);
    started = await launch(profile); application = started.application; const page = started.page;
    await page.locator('[data-application-module="companions"]').click();
    await page.locator('[data-companion-conversation="' + group.id + '"]').click();
    await page.getByRole('button', { name: '查看伙伴任务', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '伙伴实时任务' });
    const history = modal.getByRole('navigation', { name: '选择伙伴任务' });
    await expect(history.getByRole('button')).toHaveCount(20);
    await expect(history.getByRole('button').first()).toContainText('历史任务 44');
    await expect(history.locator('time').first()).toHaveAttribute('datetime', data[44]!.createdAt);
    await expect(history.locator('time').first()).toHaveText(/2026-10-13 \d{2}:44:05\.123/);
    await expect(modal.locator('.companions-task-times')).toContainText('结束时间');
    await expect(modal.locator('.companions-task-times')).toContainText('UTC+');
    await expect(modal.locator('.companions-live-output')).toContainText('原始工具输出 44');
    await modal.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(modal).toContainText('第 2 页');
    await expect(history.getByRole('button').first()).toContainText('历史任务 24');
    await modal.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(history.getByRole('button')).toHaveCount(5);
    await expect(modal).toContainText('共 45 条');
    await modal.getByLabel('按伙伴查看').selectOption('deepseek-flash');
    await expect(modal).toContainText('共 22 条');
    await expect(modal).toContainText('第 1 页');
    await expect(history).not.toContainText('大肥鱼');
    await modal.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(history.getByRole('button')).toHaveCount(2);
    await expect(modal.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
    await modal.getByLabel('按伙伴查看').selectOption('');
    await expect(history.getByRole('button')).toHaveCount(20);
    await page.screenshot({ path: path.resolve('.tools/test-output/companions/verified-task-monitor.png') });
  } finally { if (application) await application.close(); cleanup(root); }
});

// eslint-disable-next-line no-empty-pattern
test('pages complete persisted activity steps through the real renderer and keeps each group owner separate', async ({}, testInfo) => {
  test.setTimeout(150_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-activity-history-')), profile = path.join(root, 'profile');
  let application: ElectronApplication | undefined;
  try {
    let started = await launch(profile); application = started.application;
    const group = (await request(started.page, { type: 'conversation.create-group', memberIds: ['deepseek-sister', 'deepseek-flash'], title: '行动记录分页验收' })).conversation!;
    const source = (await request(started.page, { type: 'message.send', conversationId: group.id, content: '请分别完成自己的虚拟行动，保留每一步真实记录。', clientId: randomUUID() })).message!;
    await application.close(); application = undefined;
    // Only the closed, isolated fixture database is seeded. The UI and all
    // subsequent paging use production Main/preload/SQLite without replacement.
    const sourceChecksum = createHash('sha256').update(source.content).digest('hex');
    const data = ['deepseek-sister', 'deepseek-flash'].map((companionId, owner) => ({
      id: 'activity_history_owner_' + owner, companionId, conversationId: group.id, sourceMessageId: source.id, sourceChecksum,
      clientId: 'activity_history_fixture_' + owner, title: owner ? '妹妹自己的行动记录' : '姐姐自己的行动记录', goal: source.content,
      status: 'succeeded', step: 72, attempts: 0, createdAt: source.createdAt, updatedAt: source.createdAt,
      deadline: new Date(Date.parse(source.createdAt) + 3600000).toISOString(), stage: '本轮历史展示夹具已结束', nextAt: 0,
      history: Array.from({ length: 72 }, (_, index) => ({ step: index + 1, at: source.createdAt,
        action: 'observe', result: `OWNER_${owner}_ACTIVITY_STEP_${String(index + 1).padStart(3, '0')}`, ok: true })),
    }));
    const script = `const Database=require('better-sqlite3');const db=new Database(process.argv[1]);const rows=JSON.parse(process.argv[2]);db.transaction(()=>{for(const row of rows)db.prepare('INSERT INTO companion_activity_tasks(id,companion_id,conversation_id,source_message_id,status,next_at,client_id,data) VALUES(?,?,?,?,?,?,?,?)').run(row.id,row.companionId,row.conversationId,row.sourceMessageId,row.status,row.nextAt,row.clientId,JSON.stringify(row))})();db.close();`;
    const seeded = spawnSync(resolveElectronExecutablePath(), ['-e', script, path.join(companionDataRoot(profile), 'messages.sqlite'), JSON.stringify(data)],
      { cwd: process.cwd(), env: { ...electronLaunchEnv(), ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true });
    expect(seeded.status, seeded.stderr).toBe(0);
    started = await launch(profile); application = started.application; const page = started.page;
    await page.locator('[data-application-module="companions"]').click();
    await page.locator(`[data-companion-conversation="${group.id}"]`).click();
    await page.getByRole('button', { name: '我们之间', exact: true }).click();
    const planner = page.getByRole('complementary', { name: '伙伴手帐', exact: true });
    await planner.getByRole('combobox', { name: '待办所属伙伴', exact: true }).selectOption('deepseek-sister');
    const panel = page.getByRole('region', { name: '持续行动任务', exact: true });
    const task = panel.locator('[data-activity-task="activity_history_owner_0"]');
    await expect(task).toBeVisible(); await task.locator('summary').click();
    await expect(task.locator('li')).toHaveCount(32);
    await expect(task).toContainText('OWNER_0_ACTIVITY_STEP_041'); await expect(task).not.toContainText('OWNER_0_ACTIVITY_STEP_001');
    await task.getByRole('button', { name: '查看更早步骤', exact: true }).click();
    await expect(task.locator('li')).toHaveCount(64);
    await task.getByRole('button', { name: '查看更早步骤', exact: true }).click();
    await expect(task.locator('li')).toHaveCount(72);
    expect(await task.locator('li span').allTextContents()).toEqual(data[0]!.history.map(step => step.result));
    await expect(task.getByRole('button', { name: '查看更早步骤', exact: true })).toHaveCount(0);
    await planner.getByRole('combobox', { name: '待办所属伙伴', exact: true }).selectOption('deepseek-flash');
    const second = panel.locator('[data-activity-task="activity_history_owner_1"]');
    await expect(second).toBeVisible(); await second.locator('summary').click();
    await expect(second.locator('li')).toHaveCount(32); await expect(panel).not.toContainText('OWNER_0_ACTIVITY_STEP_');
    await expect(second).toContainText('OWNER_1_ACTIVITY_STEP_072');
    const artifacts = path.resolve('artifacts/vcp-validation/activity-history-ui'); mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, 'owner-separated-activity-history.png') });
    await testInfo.attach('activity-history-pagination', { body: JSON.stringify({ totalStepsPerOwner: 72, pageSizes: [32, 64, 72],
      realMainAndStorage: true, isolatedClosedDatabaseSeed: true, ownerSwitchIsolated: true }), contentType: 'application/json' });
  } finally { await application?.close(); cleanup(root); }
});

test('keeps capability entries and quoted messages compact and opens the linked task in its monitor', async () => {
  test.setTimeout(90_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-entries-'));
  const profile = path.join(root, 'profile'); let application: ElectronApplication | undefined;
  try {
    let started = await launch(profile); application = started.application;
    const room = (await request(started.page, { type: 'conversation.open', companionId: 'deepseek-sister' })).conversation!;
    await application.close(); application = undefined;
    // A closed, isolated fixture database supplies saved loop steps and a legacy quote; no real model or files are used.
    const sourceCode = `const db=new (require('better-sqlite3'))(process.argv[1]),room=process.argv[2],stamp='2026-10-14T01:39:00.000Z';
      db.function('companion_search_tokens',{deterministic:true},s=>Array.from(s.normalize('NFKC').toLowerCase(),c=>'u'+c.codePointAt(0).toString(16)).join(' '));
      db.function('companion_search_facet',{deterministic:true},s=>Array.from(s,c=>c.codePointAt(0).toString(16)).join('x'));
      const insert=db.prepare("INSERT INTO messages(id,conversation_id,author_id,kind,content,created_at,status,reply_to_id,action_id) VALUES(?,?,?,?,?,?,'sent',?,?)");
      db.transaction(()=>{
        insert.run('weather-source',room,'user','text','看看上海现在天气如何',stamp,null,null);
        insert.run('weather-reply',room,'deepseek-sister','text','我看看上海的实况，再告诉你出门怎么穿。\\n\\n上海多云，23°C。出门带件薄外套就好。',stamp,'weather-source',null);
        insert.run('clock-source',room,'user','text','现在几点了？',stamp,null,null);
        insert.run('clock-reply',room,'deepseek-sister','text','',stamp,'clock-source',null);
        insert.run('quoted-source',room,'user','text','周末去海边散步，记得带相机。',stamp,null,null);
        insert.run('quoted-reply',room,'deepseek-sister','text','好呀，给你留一个慢慢看海的下午。',stamp,'quoted-source',null);
        const turns=[{text:'我看看上海的实况，再告诉你出门怎么穿。',rawText:'',calls:[]},{text:'上海多云，23°C。出门带件薄外套就好。',rawText:'',calls:[]}];
        const checkpoint={conversationId:room,sourceMessageId:'weather-source',companionId:'deepseek-sister',messageId:'weather-reply',status:'done',turns,supplements:[]};
        db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('message-loop/weather-reply',JSON.stringify(checkpoint));
        db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('message-loop/clock-reply',JSON.stringify({...checkpoint,sourceMessageId:'clock-source',messageId:'clock-reply',turns:[{text:'',rawText:'',calls:[]}]}));
        for(const [id,parent,title,source] of [['weather-task','weather-reply','查询上海实时天气','weather-source'],['clock-task','clock-reply','读取系统时间','clock-source']]){
          const action={id,parentMessageId:parent,loopStep:0,conversationId:room,companionId:'deepseek-sister',sourceMessageId:source,title,status:'succeeded',createdAt:stamp,updatedAt:stamp,result:id==='weather-task'?'天气的独立结果':'时间的独立结果',events:[{sequence:1,type:'tool_end',toolName:id==='weather-task'?'web_search':'pwsh',summary:'工具实际返回结果',contentKind:'output',content:id==='weather-task'?'天气的原始工具输出':'时间的原始工具输出',receivedAt:stamp}]};
          db.prepare('INSERT INTO actions(id,conversation_id,companion_id,status,data) VALUES(?,?,?,?,?)').run(id,room,'deepseek-sister','succeeded',JSON.stringify(action));
        }
      })();db.close();`;
    const seeded = spawnSync(resolveElectronExecutablePath(), ['-e', sourceCode, path.join(companionDataRoot(profile), 'messages.sqlite'), room.id], { cwd: process.cwd(), env: { ...electronLaunchEnv(), ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true });
    expect(seeded.status, seeded.stderr).toBe(0);
    started = await launch(profile); application = started.application; const page = started.page;
    await page.locator('[data-application-module="companions"]').click();
    await page.locator(`[data-companion-conversation="${room.id}"]`).click();
    const timeline = page.locator('[data-companion-messages]');
    await expect(timeline.locator('.companions-capability-link')).toHaveCount(2);
    await expect(timeline.locator('.companions-action-card')).toHaveCount(0);
    await expect(timeline.locator('.companions-capability-fold')).toHaveCount(0);
    await expect(timeline.locator('[data-companion-message="clock-reply"] .is-capability-only')).toBeVisible();
    const entrySize = await timeline.locator('[data-loop-action="clock-task"] .companions-capability-title').evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      return { text: range.getBoundingClientRect().width, available: element.getBoundingClientRect().width,
        parents: [element, element.parentElement!, element.parentElement!.parentElement!, element.closest('.companions-message-bubble')!, element.closest('.companions-message-body')!].map(node => ({ width: node.getBoundingClientRect().width, scroll: node.scrollWidth, css: getComputedStyle(node).width })) };
    });
    expect(entrySize.text <= entrySize.available + 1, JSON.stringify(entrySize)).toBe(true);
    await expect(timeline.locator('.companions-reply-quote')).toHaveCount(1);
    await expect(timeline.locator('.companions-reply-quote-excerpt')).toHaveText('周末去海边散步，记得带相机。');
    await page.screenshot({ path: path.resolve('.tools/test-output/companions/verified-capability-entries.png') });
    await page.getByRole('button', { name: '查看任务进度 读取系统时间', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '伙伴实时任务' });
    await expect(modal.locator('main')).toContainText('时间的原始工具输出');
    await expect(modal.locator('main')).not.toContainText('天气的原始工具输出');
    await page.screenshot({ path: path.resolve('.tools/test-output/companions/verified-linked-task.png') });
    await modal.getByRole('button', { name: '关闭任务监视', exact: true }).click();
    await page.getByRole('button', { name: '查看引用消息 quoted-source', exact: true }).click();
    await expect(timeline.locator('[data-companion-message="quoted-source"]')).toHaveClass(/is-highlighted/);
  } finally { if (application) await application.close(); cleanup(root); }
});

// eslint-disable-next-line no-empty-pattern
test('renders an actual goal reading, indexed VCP self-test and linked memory in the learning workspace', async ({}, testInfo) => {
  test.setTimeout(180000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-goal-'));
  const provider = await providerFixture(); let application: ElectronApplication | undefined;
  try {
    const started = await launch(path.join(root, 'profile')); application = started.application; const { page } = started;
    await setGlobal(page, { apiFormat: 'openai_chat', baseUrl: provider.baseUrl, model: 'fixture-learning', apiKey: 'fixture-learning-key' });
    await page.locator('[data-application-module="companions"]').click();
    await page.getByRole('button', { name: '发起聊天', exact: true }).click();
    await page.getByRole('dialog', { name: '发起聊天' }).locator('.companions-start-chat-list button').filter({ has: page.getByText('大肥鱼', { exact: true }) }).click();
    await ensureAwakeRoutine(page, 'deepseek-sister', 'private-deepseek-sister');
    const textbook = path.join(root, '青岚借阅规则.md');
    writeFileSync(textbook, '# 合成教材\n普通读者最多同时借三本书，每本借期十四天。续借需要在到期前申请，若已有其他读者预约则不能续借。', 'utf8');
    await application.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, textbook);
    await page.getByRole('button', { name: '我们之间', exact: true }).click();
    await page.getByRole('complementary', { name: '伙伴手帐' }).getByRole('button', { name: '管理共同记忆', exact: true }).click();
    const manager = page.getByRole('region', { name: '共同记忆管理', exact: true, includeHidden: true });
    await manager.getByRole('button', { name: '学习与成长', exact: true }).click();
    const growth = manager.getByRole('region', { name: '伙伴学习与成长', exact: true });
    await growth.getByRole('button', { name: '新建学习目标', exact: true }).click();
    await growth.getByRole('textbox', { name: '持续学习目标', exact: true }).fill('持续学习青岚借阅规则，用真实材料与VCP回忆核实理解，每轮保留不足及下一步计划。');
    await growth.getByRole('button', { name: '选择本地文件', exact: true }).click();
    await expect(growth).toContainText('青岚借阅规则.md');
    await growth.getByRole('button', { name: '创建持续学习目标', exact: true }).click();
    const detail = growth.getByRole('article', { name: '第 1 轮学习详情', exact: true });
    await expect(detail.locator('.learning-round-integration')).toContainText('新的学习记忆', { timeout: 90000 });
    await expect(detail).toContainText('自评有材料支持 1 项', { timeout: 90000 });
    await detail.getByRole('button', { name: '青岚借阅规则.md', exact: true }).click();
    await expect(detail.locator('.learning-round-read-detail')).toContainText('每本借期十四天');
    await detail.locator('summary').filter({ hasText: '道自测题与回答' }).click();
    await expect(detail.locator('.learning-round-questions')).toContainText('最多同时借三本书，每本借期十四天。');
    const artifacts = path.resolve('artifacts/vcp-validation/concurrent-learning-ui'); mkdirSync(artifacts, { recursive: true });
    await detail.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(artifacts, 'learning-actual-round-light.png') });
    await theme(page, '暗色'); await page.screenshot({ path: path.join(artifacts, 'learning-actual-round-dark.png') });
    const goals = await page.evaluate(() => (window as unknown as CompanionBridgeWindow).worldlinebox.companions.workspace!({ type: 'memory.learning.goals.list', companionId: 'deepseek-sister', cursor: 0, limit: 20 }));
    const goal = goals.learningGoals!.items[0]!; expect(goal.state).toBe('active'); expect(goal.totalRounds).toBe(1);
    await testInfo.attach('actual-learning-round', { body: JSON.stringify(await page.evaluate(id => (window as unknown as CompanionBridgeWindow).worldlinebox.companions.workspace!({ type: 'memory.learning.goals.rounds', companionId: 'deepseek-sister', id, cursor: 0, limit: 10 }), goal.id)), contentType: 'application/json' });
    await detail.getByRole('button', { name: '查看记忆 1', exact: true }).click();
    await expect(manager.getByRole('region', { name: '伙伴记忆库' }).locator('.memory-library-paper')).toContainText('普通读者最多同时借三本书');
  } catch (error) {
    const page = application ? await application.firstWindow().catch(() => undefined) : undefined;
    if (page) await testInfo.attach('learning-failure-state', { body: JSON.stringify(await page.evaluate(async () => {
      const api = (window as unknown as CompanionBridgeWindow).worldlinebox.companions;
      const goals = await api.workspace!({ type: 'memory.learning.goals.list', companionId: 'deepseek-sister', cursor: 0, limit: 20 });
      return { goals, rounds: goals.learningGoals?.items[0] ? await api.workspace!({ type: 'memory.learning.goals.rounds', companionId: 'deepseek-sister', id: goals.learningGoals.items[0].id, cursor: 0, limit: 10 }) : undefined,
        memory: await api.request({ type: 'memory.status', companionId: 'deepseek-sister' }) };
    })), contentType: 'application/json' });
    throw error;
  } finally { await application?.close().catch(() => undefined); await provider.close(); cleanup(root); }
});

// This fixture replaces only the external provider. Every application call below
// uses the actual preload, Main IPC, storage UtilityProcess and SQLite database.
const preparedResidents = new WeakMap<Page, Set<string>>();
async function ensureAwakeRoutine(page: Page, companionId: string, conversationId: string) {
  const prepared = preparedResidents.get(page) ?? new Set<string>(); preparedResidents.set(page, prepared);
  if (prepared.has(companionId)) return;
  // Opening a conversation no longer activates a dormant resident's world.
  // These fixtures explicitly need a live actor for their chat/work scenarios.
  await request(page, { type: 'companion.set-active', id: companionId, active: true });
  let world = (await request(page, { type: 'world.snapshot' })).world!;
  if (world.settings.mode !== 'realtime') world = (await request(page, { type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime' } })).world!;
  const routine = (await request(page, { type: 'routine.get', companionId, conversationId })).routine!;
  const clock = (offset: number) => String((Math.floor(world.clock.hour) + offset + 24) % 24).padStart(2, '0') + ':00';
  if (routine.runtime.plannedPhase !== 'awake' || routine.config.meals.length || routine.config.habits.length) {
    await request(page, { type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision,
      patch: { timeZone: world.settings.timeZone, wakeAt: clock(-8), sleepAt: clock(8), meals: [], habits: [] } });
  }
  // These are chat/stream/queue fixtures, not sleep-interruption tests. Prepare
  // the real resident at its own desk via actual pathfinding, without advancing
  // time artificially or bypassing the subsequent seating/work-ready gate.
  world = (await request(page, { type: 'world.snapshot' })).world!;
  const home = world.scenes.find(scene => scene.ownerId === companionId)!, computer = home.objects.find(object => object.kind === 'computer')!;
  const atComputer = () => request(page, { type: 'world.snapshot' }).then(response => {
    const resident = response.world!.actors.find(actor => actor.companionId === companionId)!;
    return resident.sceneId === home.id && Math.hypot(resident.position.x - computer.anchor.x, resident.position.y - computer.anchor.y) < .01 && !resident.route.length;
  });
  if (!await atComputer()) await request(page, { type: 'world.tool', companionId, conversationId, arguments: { action: 'move', destinationId: computer.id } });
  await expect.poll(atComputer, { timeout: 30_000, intervals: [250] }).toBe(true);
  expect((await request(page, { type: 'routine.get', companionId, conversationId })).routine!.runtime.canRespond).toBe(true);
  prepared.add(companionId);
}
async function prepareReplyAuthors(page: Page, authors: string[]) {
  for (const companionId of authors) {
    const conversation = (await request(page, { type: 'conversation.open', companionId })).conversation!;
    await ensureAwakeRoutine(page, companionId, conversation.id);
  }
}

async function providerFixture(hold?: { roleId: string; userText: string }): Promise<ProviderFixture> {
  const requests: ProviderRequest[] = [];
  const memoryRequests: ProviderFixture['memoryRequests'] = [];
  const socialReviews: ProviderFixture['socialReviews'] = [];
  const streamStarts: ProviderFixture['streamStarts'] = [], streamReleases = new Map<string, () => void>();
  const streamTimers = new Set<ReturnType<typeof setTimeout>>();
  let released = false;
  const server: Server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      try {
        const payload = JSON.parse(body) as { model: string; stream?: boolean; messages: Array<{ role: string; content: string; tool_call_id?: string }> };
        const userContext = payload.messages.filter(message => message.role === 'user').at(-1)?.content;
        if (!userContext) throw new Error('Missing actual companion context.');
        const systemContext = payload.messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
        if (systemContext.includes('用户明确设置的持续学习目标')) {
          // This fixture replaces only chat inference. Files, source receipts,
          // policy checks, native embedding, VCP and the rendered round are real.
          const stage = /阶段=(\w+)/u.exec(systemContext)?.[1];
          const data = JSON.parse(userContext).data;
          const quote = '普通读者最多同时借三本书，每本借期十四天。';
          const citation = [{ sourceId: data.reads?.[0]?.id, quote }];
          const output = stage === 'plan' ? { focus: '借阅规则与预约限制', questions: ['借阅数量与期限是什么？'], searchQueries: [] }
            : stage === 'learn' ? { summary: '从实际教材整理借阅规则，尚未声称掌握其他制度。', claims: [{ text: quote, evidence: citation }] }
              : stage === 'questions' ? { questions: ['普通读者最多借几本书，借期多久？'] }
                : stage === 'answer' ? { answers: [String(data.recalled).includes('十四天') ? '最多同时借三本书，每本借期十四天。' : '不知道'] }
                  : stage === 'assess' ? { evaluations: [{ evaluation: 'supported', rationale: '实际回答与本轮材料中的数量和期限一致。', evidence: citation }], gaps: ['预约限制尚需进一步形成记忆。'], nextPlan: ['下轮阅读续借与预约的实际材料。'] }
                    : { action: 'new', content: quote, reason: '新的有出处主题。' };
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(output) } }] })); return;
        }
        if (/个人记忆时间线|月度时间线摘要器/.test(systemContext)) {
          // Only the global chat provider is replaced. The original VCP timeline
          // still builds its files and vectors through the real native runtime.
          memoryRequests.push({ purpose: 'vcp_timeline', companionId: '', sourceIds: [] });
          const date = userContext.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? '';
          const content = userContext.includes('用户喜欢看海') ? `${date} 用户喜欢看海。` : '没有新的共同经历。';
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
          return;
        }
        // Original AIMemo sends its complete plain-text prompt in one user
        // message. The host gateway adds its constraint system message; this is
        // neither the JSON journal extractor nor the ordinary chat contract.
        if (userContext.includes('VCP记忆处理单元') && userContext.includes('[完整知识库]')) {
          const knowledge = /\*\*\[完整知识库\]\*\*:[\s\S]*?```\s*([\s\S]*?)```/u.exec(userContext)?.[1] ?? '';
          const dialogue = /\*\*\[当前对话上下文\]\*\*:[\s\S]*?```\s*([\s\S]*?)```/u.exec(userContext)?.[1] ?? '';
          const query = /(?:^|\n)User:\s*([\s\S]*)$/u.exec(dialogue)?.[1] ?? '';
          const relevant = /喜欢|看海|休闲/u.test(query) && knowledge.includes('用户喜欢看海');
          memoryRequests.push({ purpose: 'vcp_aimemo', companionId: '', sourceIds: [] });
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '这是我获取的所有相关知识/记忆[[' + (relevant ? '用户喜欢看海。' : '未找到相关记忆') + ']]' } }] }));
          return;
        }
        const context = JSON.parse(userContext) as {
          purpose?: string; companion?: { id: string }; currentMessage?: { content: string }; source?: { content: string };
          proposedText?: string; facts?: unknown[]; nativeActions?: unknown[];
          runtimeState?: { revision: number }; memoryRecall?: { context?: { text: string; revision: string; profileKey: string } };
          conversation: { replyingAs: string }; messages: Array<{ id?: string; authorId?: string; speaker?: string; content: string }>; memories: unknown[];
        };
        let text: string, stateCall: Record<string, unknown> | undefined;
        // This deterministic provider verifies phase wiring only. Actual
        // unsupported social claims have separate negative and real-model gates.
        if (context.purpose === 'companion_social_progress_review') {
          socialReviews.push({ proposedText: context.proposedText ?? '', facts: context.facts ?? [], nativeActions: context.nativeActions ?? [] });
          text = JSON.stringify({ supported: true, correction: '' });
        } else if (context.purpose === 'world_decision') text = JSON.stringify({ action: null, reason: '没有需要打扰的世界事件。', appraisals: [] });
        else if (context.purpose === 'world_social') text = JSON.stringify({ text: null, reason: '本例不继续伙伴话题。' });
        else if (context.purpose === 'world_message_authorization') text = JSON.stringify({ allowed: false, confidence: .99, evidence: [], reason: '本例无转发委托。' });
        else if (context.purpose === 'world_attention') text = JSON.stringify({ urgency: 'ordinary', confidence: .95, evidence: [context.source?.content ?? ''], reason: '用户没有请求打断当前作息。' });
        else if (context.purpose === 'vcp_sleep_reflection') text = JSON.stringify({ notes: [], dream: null });
        else if (context.purpose === 'vcp_experience_journal') {
          memoryRequests.push({ purpose: context.purpose, companionId: context.companion?.id ?? '', sourceIds: context.messages.map(message => message.id).filter((id): id is string => !!id) });
          const appreciation = context.messages.find(message => message.authorId === 'user' && message.id && message.content === '谢谢你一直陪我，我相信你，也会支持你。');
          text = JSON.stringify({ notes: context.messages.filter(message => message.authorId === 'user' && message.id && message.content.includes('喜欢看海')).map(message => ({
            content: '用户喜欢看海。', diaryName: '生活日记', tags: ['用户', '看海'],
            sourceMessageIds: [message.id], evidence: [{ sourceMessageId: message.id, quote: message.content }],
          })), ...(appreciation ? { stateProposal: { reason: '用户表达了陪伴的感谢与信任。', sourceMessageIds: [appreciation.id], evidence: [{ sourceMessageId: appreciation.id, quote: appreciation.content }], appraisals: [{ type: 'support', target: 'user', intensity: .7, confidence: .95 }] } } : {}) });
        } else {
          const latestUser = context.messages.filter(message => message.speaker === 'user').at(-1)?.content ?? '';
          const recalledSeaside = context.memoryRecall?.context?.text.includes('用户喜欢看海') ?? false;
          const reply = latestUser === '格式验收' ? richReply : latestUser.includes('喜欢看海') ? '好呀，我记住你喜欢看海了。周末可以留些时间慢慢逛。'
            : latestUser.includes('喜欢什么') && recalledSeaside ? '记得，你喜欢看海。'
            : `我收到了「${latestUser}」，我们接着聊。`;
          requests.push({ path: request.url ?? '', headers: request.headers, model: payload.model,
            companionId: context.conversation.replyingAs, latestUser, memories: context.memories, reply, stateRevision: context.runtimeState?.revision, processedMemory: context.memoryRecall?.context,
            toolResults: payload.messages.filter(message => message.role === 'tool').map(message => message.content) });
          if (latestUser.startsWith('流式验收：') && payload.stream && request.url?.endsWith('/chat/completions')) {
            const step = payload.messages.some(message => message.role === 'tool' && message.tool_call_id === 'fixture_stream_inspect') ? 1 : 0;
            const first = step ? '状态已经核对，' : latestUser === '流式验收：工具后接着说' ? '我先说第一句，' : latestUser === '流式验收：取消' ? '这一段取消前已经出现。' : latestUser === '流式验收：重启恢复' ? '重启前已经出现的正文。' : '这是第一段真实增量，';
            const second = step ? '我接着说完。' : latestUser === '流式验收：工具后接着说' ? '再核对当前状态。' : latestUser === '流式验收：取消' ? '取消后不能继续出现。' : latestUser === '流式验收：重启恢复' ? '现在继续完整回答。' : '这是稍后返回的第二段。';
            const key = latestUser + '/' + step;
            response.setHeader('Content-Type', 'text/event-stream'); response.setHeader('Cache-Control', 'no-cache'); response.flushHeaders();
            const chunk = (delta: Record<string, unknown>, finish: string | null = null) => { if (!response.destroyed && !response.writableEnded) response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n'); };
            const finish = () => { const timer = setTimeout(() => {
              streamTimers.delete(timer); if (response.destroyed || response.writableEnded) return;
              chunk({ content: second });
              const tools = !step && latestUser === '流式验收：工具后接着说';
              if (tools) chunk({ tool_calls: [{ index: 0, id: 'fixture_stream_inspect', type: 'function', function: { name: 'world', arguments: '{"action":"state","parameters":{"action":"inspect"}}' } }] });
              chunk({}, tools ? 'tool_calls' : 'stop'); response.end('data: [DONE]\n\n');
            }, 200); streamTimers.add(timer); };
            streamReleases.set(key, finish);
            const timer = setTimeout(() => { streamTimers.delete(timer); chunk({ role: 'assistant', content: first }); streamStarts.push({ userText: latestUser, step, first, second }); }, 100);
            streamTimers.add(timer);
            response.on('close', () => { if (streamReleases.get(key) === finish) streamReleases.delete(key); clearTimeout(timer); streamTimers.delete(timer); });
            return;
          }
          if (!released && hold?.roleId === context.conversation.replyingAs && hold.userText === latestUser) return;
          const appreciation = latestUser === '谢谢你一直陪我，我相信你，也会支持你。' ? [...context.messages].reverse().find(message => message.speaker === 'user' && message.content === latestUser) : undefined;
          if (appreciation?.id && context.runtimeState && !payload.messages.some(message => message.role === 'tool' && message.tool_call_id === 'fixture_state')) stateCall = {
            id: 'fixture_state', type: 'function', function: { name: 'world', arguments: JSON.stringify({ action: 'state', parameters: { action: 'update', expectedRevision: context.runtimeState.revision, proposal: {
              expression: 'gentle', reason: '用户表达了陪伴的感谢与信任。', sourceMessageIds: [appreciation.id], evidence: [{ sourceMessageId: appreciation.id, quote: appreciation.content }],
              appraisals: [{ type: 'support', target: 'user', intensity: .7, confidence: .95 }],
            } } }) },
          };
          text = JSON.stringify({ text: reply, memories: [], topic: '一起看海' });
        }
        response.setHeader('Content-Type', 'application/json');
        if (request.url?.endsWith('/chat/completions')) {
          response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: stateCall ? '' : text, ...(stateCall ? { tool_calls: [stateCall] } : {}) }, finish_reason: stateCall ? 'tool_calls' : 'stop' }] }));
        } else if (request.url?.endsWith('/messages')) {
          response.end(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }));
        } else {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: 'Unsupported fixture endpoint' }));
        }
      } catch {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: 'Invalid companion fixture request' }));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Provider fixture has no local port.');
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests, memoryRequests, socialReviews, streamStarts, releaseStream: (text, step = 0) => { const key = text + '/' + step, finish = streamReleases.get(key); streamReleases.delete(key); finish?.(); }, release: () => { released = true; },
    close: () => new Promise<void>((resolve, reject) => { for (const timer of streamTimers) clearTimeout(timer); streamTimers.clear(); server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}

async function launch(profilePath: string, openDefaultChats = true): Promise<{ application: ElectronApplication; page: Page }> {
  const application = await electron.launch({ ...resolveElectronLaunchOptions(),
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profilePath, WORLDLINEBOX_E2E_CREATE_PARENT_PATH: path.dirname(profilePath) }) });
  await preparePackagedCompanionLaunch(application, profilePath);
  const page = await application.firstWindow();
  const nativeWindow = await application.browserWindow(page);
  await nativeWindow.evaluate(win => { win.unmaximize(); win.setSize(1440, 900); win.setFocusable(false); win.setOpacity(0); win.webContents.setBackgroundThrottling(false); win.hide(); });
  await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
  // Windows does not reliably composite fully hidden windows for screenshot /
  // actionability checks. A transparent, non-focusable surface stays invisible
  // to the user while exercising the real compositor.
  await nativeWindow.evaluate(win => win.showInactive());
  if (!existsSync(path.join(profilePath, 'companion-library.json'))) {
    const prepared = await page.evaluate(async () => {
      const bridge = (window as unknown as { worldlinebox: { library: WorldlineBoxLibraryApi; companions: WorldlineBoxCompanionsApi } }).worldlinebox;
      const created = await bridge.library.create({ displayName: '伙伴资产库' });
      if (!created.ok) throw new Error('Could not create the real companion asset library.');
      return bridge.companions.workspace!({ type: 'select', libraryId: created.value.libraryId });
    });
    expect(prepared.ok, prepared.error).toBe(true);
    expect(prepared.selected!.dataRoot).not.toContain(path.join(profilePath, 'companions'));
  }
  if (openDefaultChats) await prepareReplyAuthors(page, ['deepseek-sister', 'deepseek-flash']);
  return { application, page };
}

function companionDataRoot(profile: string): string {
  const locator = path.join(profile, 'companion-library.json');
  if (!existsSync(locator)) return path.join(profile, 'companions'); // Explicit pre-upgrade fixtures are migrated on selection.
  const selection = JSON.parse(readFileSync(locator, 'utf8')) as { libraryPath: string };
  return path.join(selection.libraryPath, '.worldlinebox', 'companions');
}

async function request(page: Page, input: CompanionsRequest) {
  const response = await page.evaluate(value => (window as unknown as CompanionBridgeWindow).worldlinebox.companions.request(value), input);
  expect(response.ok, response.error).toBe(true);
  return response;
}

async function setGlobal(page: Page, input: Parameters<WorldlineBoxLlmApi['setConfig']>[0]) {
  const result = await page.evaluate(value => (window as unknown as CompanionBridgeWindow).worldlinebox.llm.setConfig(value), input);
  expect(result.ok).toBe(true);
}

async function messages(page: Page, conversationId: string): Promise<CompanionMessage[]> {
  return (await request(page, { type: 'messages', conversationId, limit: 100 })).messages ?? [];
}

async function waitForReplies(page: Page, conversationId: string, authorIds: string[], afterSequence: number) {
  await expect.poll(async () => {
    const [response, state] = await Promise.all([
      request(page, { type: 'messages', conversationId, limit: 100 }), request(page, { type: 'state' }),
    ]);
    const replies = response.messages?.filter(message => message.sequence > afterSequence && message.kind === 'text' && message.status === 'sent'
      && !message.isReplyDraft && !message.replyDraft) ?? [];
    return authorIds.every(id => replies.some(message => message.authorId === id))
      && !state.state?.activities.some(activity => activity.conversationId === conversationId);
  }, { timeout: 20_000 }).toBe(true);
}

async function sendUi(page: Page, conversationId: string, content: string, authors: string[]) {
  await prepareReplyAuthors(page, authors);
  await page.locator(`[data-companion-conversation="${conversationId}"]`).click();
  await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toBeVisible();
  const previousSequence = (await messages(page, conversationId)).at(-1)?.sequence ?? 0;
  await page.getByRole('textbox', { name: '输入消息', exact: true }).fill(content);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await waitForReplies(page, conversationId, authors, previousSequence);
}

async function sendBridge(page: Page, conversationId: string, content: string, authors: string[]) {
  await prepareReplyAuthors(page, authors);
  if (conversationId.startsWith('private-')) await request(page, { type: 'conversation.open', companionId: conversationId.slice(8) });
  const result = await request(page, { type: 'message.send', conversationId, content, clientId: randomUUID() });
  if (!result.message) throw new Error('Actual message send did not return a persisted message.');
  await waitForReplies(page, conversationId, authors, result.message.sequence);
  return result.message;
}

async function decodeLocalImage(page: Page, id: string) {
  const decoded = await page.evaluate(async attachmentId => {
    const image = new Image();
    image.src = `worldlinebox-companion://attachment/${attachmentId}`;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight, url: image.src };
  }, id);
  expect(decoded.width).toBeGreaterThan(0);
  expect(decoded.height).toBeGreaterThan(0);
  expect(decoded.url).toBe(`worldlinebox-companion://attachment/${id}`);
}

async function theme(page: Page, mode: '亮色' | '暗色') {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '通用设置', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: '外观', exact: true }).click();
  await dialog.getByRole('radio', { name: 'WorldlineBox', exact: true }).click();
  await dialog.getByRole('radio', { name: mode, exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

function cleanup(root: string) {
  const absolute = path.resolve(root);
  if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('worldlinebox-companions-e2e-')) {
    throw new Error('Refusing cleanup outside this temporary companion profile.');
  }
  removeCompanionTestDirectory(absolute);
}

test.describe.configure({ timeout: 120_000 });

test('real companion UI supports persistent contacts, private chats and multi-role group chat', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-ui-'));
  const profile = path.join(root, 'profile');
  const provider = await providerFixture();
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(profile);
    application = launched.application;
    let page = launched.page;
    expect(await page.locator('[data-application-module]').evaluateAll(elements => elements.map(element => element.getAttribute('data-application-module')))).toEqual(['dsh', 'companions', 'assets']);
    await setGlobal(page, { apiFormat: 'openai_chat', baseUrl: `${provider.baseUrl}/global/v1`, model: 'fixture-global', apiKey: 'fixture-global-ui-key' });
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('[data-companions]')).toBeVisible();
    await expect(page.getByRole('heading', { name: '消息', exact: true })).toBeVisible();
    await expect(page.locator('[data-companion-conversation]')).toHaveCount(2);
    const state = (await request(page, { type: 'state' })).state!;
    expect(state.configured).toBe(true);
    expect(state.companions.every(companion => !companion.llm && companion.model === '')).toBe(true);
    expect(await application.evaluate(({ app }) => app.getAppMetrics().some(metric => metric.type === 'Utility'
      && (metric.name === 'WorldlineBox Companion Storage' || metric.serviceName === 'WorldlineBox Companion Storage')))).toBe(true);

    const sisterChat = 'private-deepseek-sister';
    await sendUi(page, sisterChat, '我喜欢看海，周末想慢慢逛。', ['deepseek-sister']);
    await expect(page.locator('[data-companion-messages]').getByText('好呀，我记住你喜欢看海了。周末可以留些时间慢慢逛。', { exact: true })).toBeVisible();
    const preferenceSource = (await messages(page, sisterChat)).find(message => message.authorId === 'user' && message.content === '我喜欢看海，周末想慢慢逛。')!;
    // Journal capture and native VCP indexing are durable background work.
    // Wait for the real acknowledgement, using the bundled local embedding model.
    await expect.poll(async () => (await request(page, { type: 'memory.list', companionId: 'deepseek-sister' })).memories?.filter(note => note.status === 'indexed').length, { timeout: 90_000 }).toBe(1);
    await expect.poll(async () => (await request(page, { type: 'memory.status', companionId: 'deepseek-sister' })).memoryStatus?.pending, { timeout: 35_000 }).toBe(0);
    const learned = (await request(page, { type: 'memory.list', companionId: 'deepseek-sister' })).memories!;
    expect(learned).toHaveLength(1);
    expect(learned[0]).toMatchObject({ content: '用户喜欢看海。', origin: 'user', captureMethod: 'automatic', sourceMessageId: preferenceSource.id });
    expect((await request(page, { type: 'memory.list', companionId: 'deepseek-flash' })).memories).toEqual([]);

    // Built-ins retain their stable identity and cannot be removed. A reset is
    // a separate explicit flow, while the catalogue still opens existing roles.
    const flashBefore = (await messages(page, 'private-deepseek-flash')).map(message => message.id);
    await page.getByRole('button', { name: '联系人', exact: true }).click();
    await page.locator('[data-companion-contact="deepseek-flash"]').click();
    await expect(page.getByRole('button', { name: '移除联系人', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '重置伙伴', exact: true })).toBeVisible();
    const cannotRemove = await page.evaluate(() => (window as unknown as CompanionBridgeWindow).worldlinebox.companions.request({ type: 'companion.delete', id: 'deepseek-flash' }));
    expect(cannotRemove.ok).toBe(false);
    expect((await messages(page, 'private-deepseek-flash')).map(message => message.id)).toEqual(flashBefore);
    const add = page.getByRole('dialog', { name: '添加联系人', exact: true });

    await page.getByRole('button', { name: '添加联系人', exact: true }).click();
    await add.getByRole('tab', { name: '自定义角色', exact: true }).click();
    await add.getByLabel('名字', { exact: true }).fill('海盐');
    await add.getByLabel('个性签名', { exact: true }).fill('一起把生活中的小事记下来');
    await add.getByLabel('人设', { exact: true }).fill('你是海盐，一位喜欢海边散步的伙伴。说话简短自然，尊重用户，记得共同经历。');
    const selectedImagePath = path.resolve('assets', 'companions', 'deepseek.jpg');
    expect(existsSync(selectedImagePath)).toBe(true);
    // Only the native file chooser is replaced. This temporary app still copies
    // the real image, registers it in SQLite and serves it through its protocol.
    await application.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
    }, selectedImagePath);
    await add.getByRole('button', { name: '选择本地头像', exact: true }).click();
    await page.getByRole('dialog', { name: '调整头像', exact: true }).getByRole('button', { name: '使用此头像', exact: true }).click(); await expect(page.getByRole('dialog', { name: '调整头像', exact: true })).toHaveCount(0);
    await expect(add.locator('.companions-avatar-editor .has-local-image')).toHaveCount(1);
    await expect(add.getByRole('combobox', { name: '伙伴 LLM 服务' })).toHaveValue('global');
    await add.getByRole('button', { name: '添加伙伴', exact: true }).click();
    await expect(add).toHaveCount(0);
    const afterCreate = (await request(page, { type: 'state' })).state!;
    const custom = afterCreate.companions.find(companion => companion.name === '海盐')!;
    expect(custom.builtin).toBe(false);
    expect(custom.llm).toBeUndefined();
    expect(custom.avatarAttachmentId).toBeTruthy();
    const avatarId = custom.avatarAttachmentId!;
    await decodeLocalImage(page, avatarId);
    const savedAvatar = readFileSync(path.join(companionDataRoot(profile), 'attachments', `${avatarId}.png`));
    expect(await sharp(savedAvatar).metadata()).toMatchObject({ format: 'png', width: 512, height: 512 });
    const oriented = await sharp(selectedImagePath).autoOrient().png().toBuffer({ resolveWithObject: true });
    const side = Math.min(oriented.info.width, oriented.info.height);
    const expectedAvatar = await sharp(oriented.data).extract({ left: Math.round((oriented.info.width - side) / 2), top: Math.round((oriented.info.height - side) / 2), width: side, height: side }).resize(512, 512).ensureAlpha().raw().toBuffer();
    expect((await sharp(savedAvatar).ensureAlpha().raw().toBuffer()).equals(expectedAvatar)).toBe(true);
    await page.locator(`[data-companion-contact="${custom.id}"]`).click();
    await expect(page.locator('.companions-contact-profile .has-local-image')).toHaveCount(1);
    await page.getByRole('button', { name: '发消息', exact: true }).click();
    const customChat = `private-${custom.id}`;
    await sendUi(page, customChat, '海盐，今天认识你很开心。', [custom.id]);
    await page.getByRole('button', { name: '发送文件或图片', exact: true }).click();
    await expect(page.locator('.companions-draft-attachments')).toContainText('deepseek.jpg');
    await sendUi(page, customChat, '这张图片也发给你。', [custom.id]);
    const attachmentMessage = (await messages(page, customChat)).find(message => message.content === '这张图片也发给你。')!;
    expect(attachmentMessage.attachments).toHaveLength(1);
    const attachment = attachmentMessage.attachments[0]!;
    expect(attachment).toMatchObject({ name: 'deepseek.jpg', mime: 'image/jpeg', size: readFileSync(selectedImagePath).length,
      url: `worldlinebox-companion://attachment/${attachment.id}`, path: selectedImagePath });
    await expect(page.locator('.companions-attachment img')).toHaveAttribute('src', attachment.url!);
    await expect(page.locator('.companions-attachment img')).toBeVisible();
    await decodeLocalImage(page, attachment.id);
    const customHistory = await messages(page, customChat);

    await page.getByRole('button', { name: '创建群聊', exact: true }).click();
    const groupDialog = page.getByRole('dialog', { name: '创建群聊', exact: true });
    await groupDialog.getByLabel('群聊名称', { exact: true }).fill('蓝色海边');
    await expect(groupDialog.locator('.companions-member-picker input:checked')).toHaveCount(0);
    for (const name of ['大肥鱼', '小肥鱼', custom.name]) await groupDialog.getByLabel(name, { exact: true }).check();
    await expect(groupDialog.locator('.companions-member-picker input:checked')).toHaveCount(3);
    await groupDialog.getByRole('button', { name: '创建群聊', exact: true }).click();
    await expect(groupDialog).toHaveCount(0);
    const group = (await request(page, { type: 'state' })).state!.conversations.find(conversation => conversation.title === '蓝色海边')!;
    expect(group.memberIds).toEqual(expect.arrayContaining(['deepseek-sister', 'deepseek-flash', custom.id]));
    await sendUi(page, group.id, '大家好，我们周末一起聊聊海边的故事吧。', group.memberIds);
    const groupHistory = await messages(page, group.id);
    expect(groupHistory.filter(message => message.authorId !== 'user').map(message => message.authorId)).toEqual(group.memberIds);
    expect(provider.requests.filter(item => item.latestUser === '大家好，我们周末一起聊聊海边的故事吧。').every(item => item.memories.length === 0)).toBe(true);
    await expect(page.locator('.companions-chat-header h2')).toContainText('蓝色海边');
    await expect(page.locator('[data-companion-messages] .companions-message')).toHaveCount(4);

    const artifacts = path.resolve('.tools', 'test-output', 'companions');
    mkdirSync(artifacts, { recursive: true });
    await theme(page, '亮色');
    await expect(page.locator('[data-application-module="companions"]')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('textbox', { name: '输入消息', exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, 'verified-messages-light.png') });
    await theme(page, '暗色');
    await expect(page.locator('.companions-chat-header h2')).toContainText('蓝色海边');
    await page.screenshot({ path: path.join(artifacts, 'verified-messages-dark.png') });
    await theme(page, '亮色');
    await page.getByRole('button', { name: '联系人', exact: true }).click();
    await page.locator('[data-companion-contact="deepseek-sister"]').click();
    await expect(page.getByRole('heading', { name: '联系人', exact: true })).toBeVisible();
    await expect(page.locator('.companions-contact-profile h2')).toHaveText('大肥鱼');
    await expect(page.locator('[data-companion-contact]')).toHaveCount(16);
    await page.screenshot({ path: path.join(artifacts, 'verified-contacts-light.png') });

    const requestCount = provider.requests.length;
    const sisterHistory = await messages(page, sisterChat);
    await application.close(); application = undefined;
    const databaseBytes = readFileSync(path.join(companionDataRoot(profile), 'messages.sqlite'));
    expect(databaseBytes.subarray(0, 16).toString()).toBe('SQLite format 3\u0000');
    expect(databaseBytes.includes(Buffer.from(avatarId))).toBe(true);
    expect(databaseBytes.includes(Buffer.from(attachment.id))).toBe(true);
    const restarted = await launch(profile);
    application = restarted.application; page = restarted.page;
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('[data-companions]')).toBeVisible();
    const persisted = (await request(page, { type: 'state' })).state!;
    expect(persisted.companions.map(companion => companion.id)).toEqual(afterCreate.companions.map(companion => companion.id));
    expect(persisted.companions.find(companion => companion.id === custom.id)?.avatarAttachmentId).toBe(avatarId);
    expect(persisted.conversations.find(conversation => conversation.id === group.id)?.memberIds).toEqual(group.memberIds);
    expect(await messages(page, sisterChat)).toEqual(sisterHistory);
    expect(await messages(page, group.id)).toEqual(groupHistory);
    expect(await messages(page, customChat)).toEqual(customHistory);
    await decodeLocalImage(page, avatarId);
    await decodeLocalImage(page, attachment.id);
    await page.locator(`[data-companion-conversation="${customChat}"]`).click();
    await expect(page.locator('.companions-attachment img')).toHaveAttribute('src', attachment.url!);
    expect((await request(page, { type: 'memory.list', companionId: 'deepseek-sister' })).memories).toEqual(learned);
    // An observation interval verifies launch does not replay inference or sends.
    await page.waitForTimeout(750);
    expect(provider.requests).toHaveLength(requestCount);
  } finally {
    if (application) await application.close();
    await provider.close();
    cleanup(root);
  }
});

test('global routing updates immediately while an independent encrypted role connection stays unchanged', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-companions-e2e-routing-'));
  const profile = path.join(root, 'profile');
  const provider = await providerFixture();
  const globalOne = 'fixture-global-one-secret';
  const globalTwo = 'fixture-global-two-secret';
  const roleKey = 'fixture-independent-role-secret';
  let application: ElectronApplication | undefined;
  try {
    const launched = await launch(profile);
    application = launched.application;
    const page = launched.page;
    await setGlobal(page, { apiFormat: 'openai_chat', baseUrl: `${provider.baseUrl}/global-a/v1`, model: 'global-one', apiKey: globalOne });
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('[data-companion-conversation]')).toHaveCount(2);
    await sendBridge(page, 'private-deepseek-sister', '第一组全局连接', ['deepseek-sister']);
    expect(provider.requests.at(-1)).toMatchObject({ path: '/global-a/v1/chat/completions', model: 'global-one', companionId: 'deepseek-sister' });
    expect(provider.requests.at(-1)?.headers.authorization).toBe(`Bearer ${globalOne}`);

    await page.getByRole('button', { name: '联系人', exact: true }).click();
    await page.getByRole('button', { name: '添加联系人', exact: true }).click();
    const add = page.getByRole('dialog', { name: '添加联系人', exact: true });
    await add.getByRole('tab', { name: '自定义角色', exact: true }).click();
    await add.getByLabel('名字', { exact: true }).fill('巡游者');
    await add.getByLabel('人设', { exact: true }).fill('你是巡游者，喜欢慢慢观察世界。自然聊天，尊重用户。');
    await add.getByRole('combobox', { name: '伙伴 LLM 服务' }).selectOption('independent');
    await add.getByRole('combobox', { name: '连接方式', exact: true }).selectOption('anthropic');
    await add.getByRole('textbox', { name: 'API URL', exact: true }).fill(`${provider.baseUrl}/independent/v1`);
    await add.getByLabel('API Key', { exact: true }).fill(roleKey);
    await add.getByRole('textbox', { name: '模型', exact: true }).fill('private-anthropic-model');
    await add.getByRole('button', { name: '添加伙伴', exact: true }).click();
    await expect(add).toHaveCount(0);
    const role = (await request(page, { type: 'state' })).state!.companions.find(companion => companion.name === '巡游者')!;
    expect(role.llm).toEqual({ apiFormat: 'anthropic', baseUrl: `${provider.baseUrl}/independent/v1`, model: 'private-anthropic-model', hasKey: true });
    const privateConversation = (await request(page, { type: 'conversation.open', companionId: role.id })).conversation!;
    await sendBridge(page, privateConversation.id, '独立连接第一条', [role.id]);
    expect(provider.requests.at(-1)).toMatchObject({ path: '/independent/v1/messages', model: 'private-anthropic-model', companionId: role.id });
    expect(provider.requests.at(-1)?.headers['x-api-key']).toBe(roleKey);
    expect(provider.requests.at(-1)?.headers.authorization).toBeUndefined();

    await setGlobal(page, { apiFormat: 'anthropic', baseUrl: `${provider.baseUrl}/global-b/v1`, model: 'global-two', apiKey: globalTwo });
    await sendBridge(page, 'private-deepseek-sister', '全局连接已更新', ['deepseek-sister']);
    expect(provider.requests.at(-1)).toMatchObject({ path: '/global-b/v1/messages', model: 'global-two', companionId: 'deepseek-sister' });
    expect(provider.requests.at(-1)?.headers['x-api-key']).toBe(globalTwo);
    await sendBridge(page, privateConversation.id, '独立连接保持原样', [role.id]);
    expect(provider.requests.at(-1)).toMatchObject({ path: '/independent/v1/messages', model: 'private-anthropic-model', companionId: role.id });
    expect(provider.requests.at(-1)?.headers['x-api-key']).toBe(roleKey);

    const publicState = await request(page, { type: 'state' });
    const history = await messages(page, privateConversation.id);
    const globalConfig = await page.evaluate(() => (window as unknown as CompanionBridgeWindow).worldlinebox.llm.getConfig());
    for (const key of [globalOne, globalTwo, roleKey]) {
      expect(JSON.stringify({ publicState, history, globalConfig })).not.toContain(key);
      const ciphertext = readFileSync(path.join(companionDataRoot(profile), 'llm-keys.enc.json'), 'utf8');
      expect(ciphertext).not.toContain(key);
    }
    const encrypted = JSON.parse(readFileSync(path.join(companionDataRoot(profile), 'llm-keys.enc.json'), 'utf8')) as Record<string, string>;
    expect(Object.keys(encrypted)).toEqual([role.id]);
    expect(Buffer.from(encrypted[role.id]!, 'base64').equals(Buffer.from(roleKey))).toBe(false);
    expect(await application.evaluate(({ safeStorage }, encoded) => safeStorage.decryptString(Buffer.from(encoded, 'base64')), encrypted[role.id]!)).toBe(roleKey);

    // The edit UI exposes the configured route but never fills the saved key.
    await page.locator(`[data-companion-contact="${role.id}"]`).click();
    await page.getByRole('button', { name: '编辑资料', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑伙伴资料', exact: true });
    await expect(edit.getByLabel('API Key', { exact: true })).toHaveValue('');
    await edit.getByRole('button', { name: '取消', exact: true }).click();
    await application.close(); application = undefined;
    const files = ['companions/messages.sqlite', 'companions/messages.sqlite-wal', 'companions/llm-keys.enc.json', 'ai-config.json', 'ai-key.enc'];
    for (const relative of files) {
      const filename = path.join(profile, relative);
      if (!existsSync(filename)) continue;
      const bytes = readFileSync(filename);
      for (const key of [globalOne, globalTwo, roleKey]) expect(bytes.includes(Buffer.from(key))).toBe(false);
    }
  } finally {
    if (application) await application.close();
    await provider.close();
    cleanup(root);
  }
});

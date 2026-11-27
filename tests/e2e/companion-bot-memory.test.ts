import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import type { BotRequest, WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { BotMemoryCatalog, BotMemoryFullNote, BotMemoryRecallReport } from '../../src/shared/companion-bot-memory';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
import { LOCAL_TEXT_EMBEDDING_MODEL_ID } from '../../src/shared/embedding/global-profile';
import { electronLaunchEnv, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';
import { enableCallVisualFixture } from './fixtures/call-visual-binding';

async function request(page: Page, input: BotRequest) {
  return page.evaluate(input => (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request(input), input);
}
async function memory<T>(page: Page, input: BotRequest): Promise<T> {
  const result = await request(page, input);
  expect(result.ok, `${input.type}: ${result.error ?? 'missing successful receipt'}`).toBe(true);
  return result.memory as T;
}

async function memoryEvidenceDirectory() {
  const suffix = process.env.WORLDLINEBOX_E2E_MEMORY_EVIDENCE_SUFFIX;
  if (suffix && !/^[a-zA-Z0-9_-]+$/u.test(suffix)) throw Error('Invalid memory evidence suffix');
  const directory = path.resolve('artifacts/superagent-bot-development/ui', ...(suffix ? [`memory-${suffix}`] : []));
  await mkdir(directory, { recursive: true });
  return directory;
}

test('opens the companion workspace with an exclusively locked legacy index and retires it on the next launch', async () => {
  test.skip(process.platform !== 'win32', 'Uses a Windows exclusive file handle.');
  test.setTimeout(90_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-vcp-locked-upgrade-'));
  const companionRoot = path.join(profile, 'companion-bot-v2'), legacy = path.join(companionRoot, 'memory');
  const caches = ['capture-plans', 'capture-results'].map(name => path.join(companionRoot, 'memory-encoder', name));
  for (const directory of [legacy, ...caches]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'old.sqlite'), 'legacy fixture');
  }
  const lockedFile = path.join(legacy, 'old.sqlite');
  const lock = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $file=[IO.File]::Open($env:WLB_TEST_LOCKED_INDEX,'Open','ReadWrite','None'); try { [Console]::WriteLine('locked'); [Console]::Out.Flush(); $null=[Console]::ReadLine() } finally { $file.Dispose() }"],
  { env: { ...process.env, WLB_TEST_LOCKED_INDEX: lockedFile }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(lock, 'close');
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  const open = async () => {
    application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({
      WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN',
    }) });
    const page = await application.firstWindow();
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
    const state = await request(page, { type: 'state' });
    expect(state.ok).toBe(true);
  };
  try {
    const ready = await Promise.race([once(lock.stdout, 'data'), closed.then(() => { throw Error('Legacy file handle closed before acquisition'); })]);
    expect(String(ready[0]).trim()).toBe('locked');
    await open();
    await expect.poll(() => caches.some(directory => existsSync(directory))).toBe(false);
    expect(existsSync(lockedFile)).toBe(true);
    const retirementReceipt = path.join(companionRoot, '.vcp-v5-legacy-memory-retired');
    expect(existsSync(retirementReceipt)).toBe(false);
    await application!.close(); application = undefined;
    lock.stdin.end('\n'); await closed;
    await open();
    await expect.poll(() => existsSync(legacy)).toBe(false);
    await expect.poll(() => existsSync(retirementReceipt)).toBe(true);
    await application!.close(); application = undefined;
    // Simulate an installation that already retired its index, before work
    // caches had their own retirement receipt. Only this isolated fixture is edited.
    const workReceipt = path.join(companionRoot, '.vcp-v5-legacy-work-retired');
    await rm(workReceipt, { force: true });
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    const oldWork: string[] = [];
    for (const [segments, eventId] of [
      [['memory-encoder', '.worldlinebox-brain'], 'capture-v3-memory-fixture'],
      [['memory-maintenance', digest('audience'), 'maintenance-' + digest('job'), '.worldlinebox-brain'], 'memory-maintenance-fixture'],
      [['memory-review', digest('review'), '.worldlinebox-brain'], 'memory-review-fixture'],
    ] as const) {
      const directory = path.toNamespacedPath(path.join(companionRoot, ...segments));
      const filename = path.join(directory, digest(eventId) + '.json');
      await mkdir(directory, { recursive: true }); await writeFile(filename, JSON.stringify({ eventId }));
      oldWork.push(filename);
    }
    const unrelated = path.join(companionRoot, 'memory-review', 'my-notes.txt');
    await writeFile(unrelated, '其他文件');
    const currentWork = path.join(companionRoot, 'vcp-maintenance-v2', 'plans', 'fixture');
    await mkdir(currentWork, { recursive: true });
    await writeFile(path.join(currentWork, 'draft.txt'), '当前记忆维护的任务上下文');
    await open();
    await expect.poll(() => existsSync(workReceipt)).toBe(true);
    expect(oldWork.filter(name => existsSync(name))).toEqual([]);
    expect(await readFile(unrelated, 'utf8')).toBe('其他文件');
    expect(await readFile(path.join(currentWork, 'draft.txt'), 'utf8')).toBe('当前记忆维护的任务上下文');
  } finally {
    if (lock.exitCode === null) lock.kill();
    await closed.catch(() => undefined);
    if (application) await application.close();
    await removeCompanionTestDirectory(profile);
  }
});

test('reopens a legacy transcript on a fresh native lane only where the retired memory body was sent', async () => {
  test.setTimeout(90_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-vcp-transcript-upgrade-'));
  const file = path.join(profile, 'companion-bot-v2', 'bot.sqlite');
  const launch = () => electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN',
  }) });
  let app: Awaited<ReturnType<typeof launch>> | undefined, db: DatabaseSync | undefined;
  try {
    app = await launch();
    const firstPage = await app.firstWindow();
    await firstPage.waitForFunction(() => Reflect.has(window, 'worldlinebox'));
    const state = await request(firstPage, { type: 'state' });
    const room = state.snapshot!.conversations.find(item => item.kind === 'direct' && item.memberIds.includes(DEFAULT_BOT_COMPANION_ID))!;
    await app.close(); app = undefined;
    db = new DatabaseSync(file);
    const owner = DEFAULT_BOT_COMPANION_ID, at = new Date().toISOString();
    const persisted = db.prepare('SELECT scope_id,domain_id,revision FROM bot_conversations WHERE id=?').get(room.id)!;
    const revision = Number(persisted.revision), scopeId = String(persisted.scope_id), domainId = String(persisted.domain_id);
    db.prepare('INSERT OR IGNORE INTO bot_lanes(id,conversation_id,companion_id,acl_revision) VALUES(?,?,?,?)').run('fixture-inbox', room.id, owner, revision);
    const inboxLane = String(db.prepare('SELECT id FROM bot_lanes WHERE conversation_id=? AND companion_id=?').get(room.id, owner)!.id);
    for (const name of ['submitted', 'ordinary', 'unsent']) {
      const event = 'old-event-' + name, topic = 'old-topic-' + name, message = 'old-message-' + name, lane = 'old-native-' + name;
      const human = '人类原文 ' + name;
      db.prepare('INSERT INTO bot_native_topics(id,conversation_id,acl_revision,title,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(topic, room.id, revision, name, at, at);
      db.prepare('INSERT INTO bot_topic_bindings(topic_id,conversation_id,companion_id,native_lane_id,lane_epoch) VALUES(?,?,?,?,?)').run(topic, room.id, owner, lane, 1);
      db.prepare(`INSERT INTO bot_messages(id,event_id,conversation_id,sender_id,sender_name,sender_type,content,status,kind,correlation_id,created_at)
        VALUES(?,?,?,'user','用户','user',?,'done','message',?,?)`).run(message, event, room.id, human, event, at);
      db.prepare(`INSERT INTO bot_inbox(id,lane_id,conversation_id,companion_id,source,source_instance_id,source_message_id,sender_id,sender_type,sender_name,
        scope_id,domain_id,acl_revision,kind,content,payload_json,correlation_id,source_record_id,reply_message_id,status,occurred_at,received_at,dsh_event_id)
        VALUES(?,?,?,?,'user','local',?,'user','user','用户',?,?,?,'message',?,'{}',?,?,?,?,?,?,?)`)
        .run(event, inboxLane, room.id, owner, message, scopeId, domainId, revision, human, event, message,
          'old-reply-' + name, name === 'unsent' ? 'failed' : 'done', at, at, name === 'unsent' ? null : event);
      db.prepare('INSERT INTO bot_topic_events VALUES(?,?,?)').run(event, room.id, topic);
      const saved = { message: { content: human }, ...(name === 'ordinary' ? {} : { memoryEvidence:
        JSON.stringify({ kind: 'passive-memory-evidence', items: [{ text: '只存在于旧日记的内容', origin: 'vcp-rag-result' }] }) }) };
      const meta = db.prepare('INSERT INTO bot_metadata VALUES(?,?)');
      meta.run('native-input:' + event, JSON.stringify({ system: '旧伙伴设定', prompt: JSON.stringify(saved) }));
      if (name === 'unsent') meta.run('native-dispatch:' + event, 'unsent');
    }
    db.prepare('DELETE FROM bot_metadata WHERE key=?').run('vcp-v5-retired-evidence-removed');
    db.exec('PRAGMA user_version=22'); db.close(); db = undefined;
    app = await launch();
    const reopened = await app.firstWindow();
    await reopened.waitForFunction(() => Reflect.has(window, 'worldlinebox'));
    expect((await request(reopened, { type: 'state' })).ok).toBe(true);
    db = new DatabaseSync(file, { readOnly: true });
    expect(db.prepare('SELECT 1 FROM bot_metadata WHERE key=?').get('vcp-v5-retired-evidence-removed')).toBeTruthy();
    const binding = db.prepare('SELECT native_lane_id FROM bot_topic_bindings WHERE topic_id=?');
    expect(binding.get('old-topic-submitted')!.native_lane_id).toMatch(/^topic-vcp5-/u);
    for (const name of ['ordinary', 'unsent']) expect(binding.get('old-topic-' + name)!.native_lane_id).toBe('old-native-' + name);
    expect(db.prepare('SELECT native_lane_id FROM bot_retired_memory_events WHERE event_id=?').get('old-event-submitted')!.native_lane_id).toBe('old-native-submitted');
    expect(db.prepare('SELECT content FROM bot_messages WHERE id=?').get('old-message-submitted')!.content).toBe('人类原文 submitted');
    for (const name of ['submitted', 'ordinary', 'unsent']) {
      const saved = db.prepare('SELECT value FROM bot_metadata WHERE key=?').get('native-input:old-event-' + name)!;
      const native = JSON.parse(String(saved.value));
      expect(native.system).toBe('旧伙伴设定');
      expect(JSON.parse(native.prompt)).toEqual({ message: { content: '人类原文 ' + name } });
    }
  } finally { db?.close(); if (app) await app.close(); removeCompanionTestDirectory(profile); }
});

test('cold-starts idle diary organization while the companion workspace remains closed', async () => {
  test.setTimeout(300_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-vcp-idle-reopen-'));
  // Keep a daytime window on CI while using the unmodified real clock and
  // normal companion quiet period. Etc/GMT signs express hours west of UTC.
  const west = ((new Date().getUTCHours() - 12 + 36) % 24) - 12;
  const tz = west ? 'Etc/GMT' + (west > 0 ? '+' : '') + west : 'UTC';
  const launch = () => electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN', TZ: tz,
  }) });
  let application: Awaited<ReturnType<typeof launch>> | undefined, database: DatabaseSync | undefined;
  try {
    application = await launch();
    const page = await application.firstWindow();
    await page.waitForFunction(() => Reflect.has(window, 'worldlinebox'));
    const initial = await request(page, { type: 'state' });
    const room = initial.snapshot!.conversations.find(item => item.kind === 'direct' && item.memberIds.includes(DEFAULT_BOT_COMPANION_ID))!;
    const scope = { conversationId: room.id, companionId: DEFAULT_BOT_COMPANION_ID };
    await memory(page, { type: 'memory.maintenance.settings.update', ...scope, settings: { enabled: false } });
    await memory(page, { type: 'memory.remember', ...scope, requestId: 'idle-reopen-note', content: '隔离测试日记：周日去南门取书。', tags: ['阅读', '约定'] });
    await expect.poll(async () => (await memory<BotMemoryCatalog>(page, { type: 'memory.catalog', ...scope })).items[0]?.indexState,
      { timeout: 45000 }).toBe('indexed');
    expect((await request(page, { type: 'chat.activity', conversationId: room.id })).ok).toBe(true);
    await memory(page, { type: 'memory.maintenance.settings.update', ...scope, settings: { enabled: true } });
    await application.close(); application = undefined;
    // A previously sent chat message is the input to the normal DeepMemo projection.
    // Seed the host publication journal while the fixture app is closed. The worker
    // must build its own searchable history when the UI subsequently asks for it.
    const keyword = 'WLBDEEPHISTORY', original = 'WLBDEEPHISTORY 蓝色雨伞放在南门的取书柜。';
    const messageId = 'fixture-sent-history-message', created = Date.now();
    database = new DatabaseSync(path.join(profile, 'companion-bot-v2', 'bot.sqlite'));
    database.prepare(`INSERT INTO bot_messages(id,event_id,conversation_id,sender_id,sender_name,sender_type,content,status,kind,correlation_id,created_at)
      VALUES(?,?,?,'user','用户','user',?,'sent','message',?,?)`).run(messageId, messageId, room.id, original, messageId, new Date(created).toISOString());
    database.prepare('INSERT INTO bot_history_projection(message_id,conversation_id,timestamp) VALUES(?,?,?)').run(messageId, room.id, created);
    database.close(); database = undefined;
    database = new DatabaseSync(path.join(profile, 'companion-bot-v2', 'bot.sqlite'), { readOnly: true });
    const stored = database.prepare(`SELECT id,trigger_kind,kind,phase,status FROM bot_maintenance_jobs
      WHERE automatic=1 AND json_extract(scope_json,'$.companionId')=? ORDER BY sequence DESC LIMIT 1`);
    expect(stored.get(scope.companionId)).toBeUndefined();
    // Observe only the persisted journal after relaunch. No companion IPC,
    // navigation, model settings or user input can trigger the startup probe.
    application = await launch();
    const reopened = await application.firstWindow();
    await reopened.waitForFunction(() => Reflect.has(window, 'worldlinebox'));
    await expect(reopened.locator('.bot-workspace')).toHaveCount(0);
    await expect.poll(() => stored.get(scope.companionId), { timeout: 160_000, intervals: [1000] }).toMatchObject({
      trigger_kind: 'idle', kind: 'dream', phase: 'waiting_executor', status: 'queued',
    });
    await expect(reopened.locator('.bot-workspace')).toHaveCount(0);
    const idleJobId = String(stored.get(scope.companionId)!.id);
    await reopened.locator('[data-application-module="companions"]').click();
    await reopened.getByRole('button', { name: '稍后设置', exact: true }).click();
    await reopened.getByRole('button', { name: '记忆', exact: true }).click();
    const dialog = reopened.getByRole('dialog', { name: '记忆工作台', exact: true });
    await expect(dialog.locator('.bot-memory-row-open').first()).toContainText('周日去南门取书', { timeout: 45_000 });
    await dialog.getByRole('button', { name: '召回试查', exact: true }).click();
    await dialog.getByRole('button', { name: '原话关键词', exact: true }).click();
    await dialog.getByRole('textbox', { name: '想回想什么？', exact: true }).fill(keyword);
    await dialog.getByRole('button', { name: '开始试查', exact: true }).click();
    const output = dialog.locator('.bot-memory-recall-output');
    await expect(output.getByRole('heading', { name: '原话来源 · VCPChat DeepMemo' })).toBeVisible({ timeout: 45_000 });
    await expect(output.locator('article pre')).toContainText(original);
    await expect(output.getByText('这次没有返回匹配记录', { exact: true })).toHaveCount(0);
    await expect(output.locator('.bot-memory-rank, .bot-memory-result-heading h3 span')).toHaveCount(0);
    const record = (await memory<{ reports: BotMemoryRecallReport[] }>(reopened, { type: 'memory.recall.records', ...scope })).reports[0]!;
    expect(record).toMatchObject({ mode: 'history', query: keyword, presentation: 'formatted' });
    expect(record.evidence).toContain(original);
    expect(record.stages.some(item => item.name.includes('DeepMemo'))).toBe(true);
    const evidenceDirectory = await memoryEvidenceDirectory();
    await reopened.screenshot({ path: path.join(evidenceDirectory, 'deepmemo-original.png') });
    await dialog.getByRole('textbox', { name: '想回想什么？', exact: true }).fill('WLBABSENTNOHISTORY');
    await dialog.getByRole('button', { name: '开始试查', exact: true }).click();
    await expect(output.getByText('这次没有返回匹配记录', { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(output.getByRole('heading', { name: '原话来源 · VCPChat DeepMemo' })).toHaveCount(0);
    const miss = (await memory<{ reports: BotMemoryRecallReport[] }>(reopened, { type: 'memory.recall.records', ...scope })).reports[0]!;
    expect(miss).toMatchObject({ mode: 'history', query: 'WLBABSENTNOHISTORY', presentation: 'empty' });
    await dialog.getByRole('button', { name: '整理与梦境', exact: true }).click();
    const idle = dialog.locator(`[data-maintenance-job="${idleJobId}"]`);
    await expect(idle.locator('strong')).toHaveText('闲时梦境');
    await idle.click();
    const heading = dialog.locator('.bot-maintenance-detail-heading h3');
    await expect(heading).toContainText('闲时梦境');
    const displayedJobs: Array<{ mode: string; title: string }> = [];
    for (const [mode, name] of [['scan', '只读健康检查'], ['track', '事件追踪'], ['deepclean', '深度清理']] as const) {
      await dialog.getByRole('combobox', { name: '日记维护模式', exact: true }).selectOption(mode);
      await dialog.getByRole('button', { name: '开始' + name, exact: true }).click();
      if (mode === 'deepclean') await dialog.getByRole('button', { name: '确认深度清理', exact: true }).click();
      const title = name + ' · 第1批';
      await expect(heading).toContainText(title);
      await expect(dialog.locator('.bot-maintenance-job').getByText(title, { exact: true })).toHaveCount(1);
      displayedJobs.push({ mode, title });
    }
    await reopened.screenshot({ path: path.join(evidenceDirectory, 'maintenance-job-list.png') });
    const proof = path.join(evidenceDirectory, 'deepmemo-and-maintenance-jobs.json');
    await writeFile(proof, JSON.stringify({ keyword, original, report: record, miss, idleJobId, idleTitle: '闲时梦境', displayedJobs }, null, 2) + '\n');
    await test.info().attach('deepmemo-and-maintenance-jobs.json', { contentType: 'application/json', path: proof });
  } finally {
    database?.close();
    if (application) await application.close();
    removeCompanionTestDirectory(profile);
  }
});

test('maximized companion workspace keeps one chat summary after using the desktop pet and memory', async () => {
  const testInfo = test.info();
  test.skip(process.platform !== 'win32', 'Requires the Windows caption buttons.');
  test.setTimeout(90_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-companion-maximize-'));
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN',
  }, { gpu: 'hardware' }) });
  try {
    const page = await application.firstWindow();
    const native = await application.browserWindow(page);
    await native.evaluate(window => {
      window.unmaximize();
      window.setContentSize(1200, 760);
    });
    await page.locator('[data-application-module="companions"]').click();
    const header = page.locator('.bot-chat-header h2');
    await expect(header).toHaveText('大肥鱼');
    await enableCallVisualFixture(application, page);
    const memoryButton = page.getByRole('button', { name: '记忆', exact: true });
    await expect(memoryButton).toBeVisible();
    const search = page.locator('.bot-contact-search input');
    await search.fill('大肥鱼');
    await page.getByRole('button', { name: '最大化', exact: true }).click();
    const restore = page.getByRole('button', { name: '向下还原', exact: true });
    await expect(restore).toBeVisible();
    const summaries = page.locator('.bot-workspace > .bot-chat-context');
    await expect(summaries).toHaveCount(1);

    const call = page.getByRole('dialog', { name: '与大肥鱼会面', exact: true });
    const openPet = async () => {
      await page.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
      await call.getByRole('button', { name: '接通', exact: true }).click();
      const opened = application.waitForEvent('window');
      await call.getByRole('button', { name: '切换为桌宠', exact: true }).click();
      const pet = await opened;
      const floating = pet.getByRole('dialog', { name: '与大肥鱼会面', exact: true });
      await floating.getByRole('button', { name: '展开会面输入', exact: true }).click();
      await floating.getByRole('button', { name: '更多会面功能', exact: true }).click();
      return { pet, floating };
    };
    const { pet, floating } = await openPet();
    const closed = pet.waitForEvent('close');
    await floating.getByRole('button', { name: '返回会面场景', exact: true }).click().catch(error => { if (!pet.isClosed()) throw error; });
    await closed;
    await call.getByRole('button', { name: '结束并关闭会面', exact: true }).click();
    await expect(call).toHaveCount(0);
    await expect(summaries).toHaveCount(1);

    const second = await openPet();
    const hungUp = second.pet.waitForEvent('close');
    await second.floating.getByRole('button', { name: '挂断', exact: true }).click().catch(error => { if (!second.pet.isClosed()) throw error; });
    await hungUp;
    await expect(call).toHaveCount(0);
    await expect(summaries).toHaveCount(1);
    await expect(restore).toBeVisible();
    await expect(search).toHaveValue('大肥鱼');
    await page.screenshot({ path: testInfo.outputPath('companions-after-desktop-pet.png') });

    const third = await openPet();
    await memoryButton.click();
    const dialog = page.getByRole('dialog', { name: '记忆工作台', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '新日记', exact: true }).click();
    const diary = dialog.getByRole('textbox', { name: '日记正文' });
    await diary.fill('桌宠返回时保留这篇日记草稿');
    const nativePet = await application.browserWindow(third.pet);
    const nativeClosed = third.pet.waitForEvent('close');
    await nativePet.evaluate(window => { window.close(); });
    await nativeClosed;
    await expect(call).toBeVisible();
    await expect(dialog).toBeHidden();
    await call.getByRole('button', { name: '结束并关闭会面', exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(diary).toHaveValue('桌宠返回时保留这篇日记草稿');
    await expect(summaries).toHaveCount(1);
    await restore.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '关闭记忆工作台', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(summaries).toHaveCount(1);
    await expect(search).toHaveValue('大肥鱼');
  } finally {
    await application.close();
    removeCompanionTestDirectory(profile);
  }
});

// eslint-disable-next-line no-empty-pattern -- Electron supplies its own real window.
test('memory workspace manages real local VCP notes and inspects original recall without a chat model', async ({}, testInfo) => {
  test.setTimeout(180000);
  testInfo.annotations.push({ type: 'local-memory', description: 'Human-authored test facts through real Main IPC and bundled 768-dimensional embedding; no chat/DSH request or recall stub.' });
  const prefix = 'wlb-bot-memory-app-', profile = await mkdtemp(path.join(tmpdir(), prefix));
  const resolved = path.resolve(profile);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith(prefix)) throw Error('Unexpected owned memory test profile');
  const evidence = await memoryEvidenceDirectory();
  const application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_PERF_OFFSCREEN: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: resolved, WORLDLINEBOX_E2E_LOCALE: 'zh-CN',
  }) });
  let failurePage: Page | undefined;
  try {
    const page = await application.firstWindow();
    failurePage = page;
    const identity = await application.evaluate(({ app, BrowserWindow }, expected) => {
      const path = process.getBuiltinModule('node:path');
      if (path.resolve(app.getPath('userData')) !== expected) throw Error('Memory test must never use the real user profile');
      // A hidden normal native window can stop producing animation frames after
      // long IPC work, stranding Playwright's ordinary stability check. Use the
      // same real offscreen surface as the task/peer UI tests, without forcing
      // clicks or bypassing the renderer's actionability checks.
      const frames = { paints: 0 }; Reflect.set(globalThis, '__memoryUiFrames', frames);
      const isolate = (window: Electron.BrowserWindow) => {
        window.on('show', () => window.hide());
        window.webContents.setBackgroundThrottling(false);
        window.webContents.on('paint', () => { frames.paints++; });
        window.webContents.on('did-finish-load', () => { window.webContents.setBackgroundThrottling(false); window.hide(); });
        window.setMinimumSize(0, 0); window.setSize(1440, 960);
        window.hide();
      };
      for (const window of BrowserWindow.getAllWindows()) isolate(window);
      app.on('browser-window-created', (_event, window) => isolate(window));
      return { pid: process.pid, packaged: app.isPackaged, appPath: app.getAppPath(), profile: app.getPath('userData'), offscreen: BrowserWindow.getAllWindows()[0]!.webContents.isOffscreen() };
    }, resolved);
    expect(identity.offscreen).toBe(true);
    if (process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE) { expect(identity.packaged).toBe(true); expect(identity.appPath).toMatch(/app\.asar$/u); }
    const waitForPaint = async () => {
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const previous = await application.evaluate(({ BrowserWindow }) => {
        const previous = (Reflect.get(globalThis, '__memoryUiFrames') as { paints: number }).paints;
        BrowserWindow.getAllWindows()[0]!.webContents.invalidate(); return previous;
      });
      await expect.poll(() => application.evaluate(() => (Reflect.get(globalThis, '__memoryUiFrames') as { paints: number }).paints)).toBeGreaterThan(previous);
    };
    // Select appearance without navigating away during the initial bootstrap.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const initial = await request(page, { type: 'state' });
    expect(initial.ok).toBe(true); expect(initial.snapshot?.runtime.ready).toBe(false);
    expect(initial.snapshot?.tasks).toEqual([]);
    const conversation = initial.snapshot!.conversations.find(item => item.kind === 'direct' && item.memberIds.includes(DEFAULT_BOT_COMPANION_ID))!;
    expect(conversation).toBeTruthy();
    const scope = { conversationId: conversation.id, companionId: DEFAULT_BOT_COMPANION_ID };
    const longText = '本地测试：雨天的看展安排\n这是一组隔离测试事实，不是用户真实生活记录。周六预报下雨，所以把湖边散步改成市美术馆看展，下午两点在南门见。\n\n' +
      '路线已经讨论：乘地铁二号线，从广场东侧走到南门。看完展之后，可以在附近喝茶；午饭先各自安排，不把一下午排得太满。\n\n' +
      '尚未完成的事项是预约门票。只记录已经确认的安排，不把待办写成完成。若展馆临时闭馆，需要重新讨论目的地。\n\n' +
      '原来的湖边散步只是被雨天方案替代，等天气合适可以再去。测试中特别保留这段变化经过，全文读取应当能看到最后这句话：全文结尾校验雨伞。';
    const shortText = '本地测试：傍晚的饮品偏好\n隔离测试事实：傍晚以后喝无咖啡因的麦茶，白天喝咖啡的安排没有改变。';
    await memory(page, { type: 'memory.remember', ...scope, content: longText });
    await memory(page, { type: 'memory.remember', ...scope, content: shortText });
    await expect.poll(async () => {
      const catalog = await memory<BotMemoryCatalog>(page, { type: 'memory.catalog', ...scope, limit: 24 });
      return catalog.items.map(item => item.indexState);
    }, { timeout: 45000, message: 'Wait for both durable diary writes to receive their native index receipts' }).toEqual(['indexed', 'indexed']);
    const catalog = await memory<BotMemoryCatalog>(page, { type: 'memory.catalog', ...scope, limit: 24 });
    expect(catalog.total).toBe(2); expect(catalog.items.every(item => item.indexState === 'indexed')).toBe(true);
    const long = catalog.items.find(item => item.content?.startsWith('本地测试：雨天'))!, short = catalog.items.find(item => item.id !== long.id)!;
    expect(long.checksum).toMatch(/^[a-f0-9]{32}$/);
    // Two records are enough to prove real server cursors without seeding an entire UI page.
    const first = await memory<BotMemoryCatalog>(page, { type: 'memory.catalog', ...scope, limit: 1 });
    expect(first.items).toHaveLength(1); expect(first.nextCursor).toBeTruthy();
    const next = await memory<BotMemoryCatalog>(page, { type: 'memory.catalog', ...scope, limit: 1, cursor: first.nextCursor });
    expect(next.items).toHaveLength(1); expect(next.items[0]!.id).not.toBe(first.items[0]!.id); expect(next.nextCursor).toBeUndefined();
    const note = await memory<BotMemoryFullNote>(page, { type: 'memory.note', ...scope, id: long.id });
    expect(note.content).toBe(longText); expect(note.content.length).toBeGreaterThan(long.content!.length);
    const memoryRoot = path.join(resolved, 'companion-bot-v2', 'vcp-memory-v5');
    const homes = (await readdir(memoryRoot, { withFileTypes: true })).filter(item => item.isDirectory() && /^[a-f0-9]{64}$/.test(item.name));
    expect(homes).toHaveLength(1);
    const config = JSON.parse(await readFile(path.join(memoryRoot, homes[0]!.name, 'config.json'), 'utf8'));
    expect(config).toMatchObject({ VECTORDB_DIMENSION: 768, WhitelistEmbeddingModel: LOCAL_TEXT_EMBEDDING_MODEL_ID, LOCAL_EMBEDDING_ENABLED: false });
    expect(config).not.toHaveProperty('EMBEDDING_API_KEY');
    const open = async () => {
      await page.getByRole('button', { name: '稍后设置', exact: true }).click();
      await page.getByRole('button', { name: '记忆', exact: true }).click();
      await expect(page.getByRole('dialog', { name: '记忆工作台', exact: true })).toBeVisible();
    };
    const row = (id: string) => page.locator(`[data-memory-note="${id}"]`);
    await open(); await row(long.id).locator('.bot-memory-row-open').click();
    const dialog = page.getByRole('dialog', { name: '记忆工作台', exact: true });
    await expect(dialog.locator('.bot-memory-fulltext')).toContainText('全文结尾校验雨伞');
    await expect.poll(() => dialog.locator('.bot-memory-identity img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await page.evaluate(() => document.fonts.ready);
    const panel = await dialog.boundingBox(); expect(panel!.width).toBeGreaterThanOrEqual(1000); expect(panel!.height).toBeGreaterThanOrEqual(700);
    await expect.poll(() => page.locator('html').getAttribute('data-ui-effects')).toMatch(/^(full|reduced)$/);
    const uiEffects = await page.locator('html').getAttribute('data-ui-effects');
    const surface = await page.locator('.bot-memory-backdrop').evaluate(element => ({ background: getComputedStyle(element).backgroundColor,
      blur: getComputedStyle(element).backdropFilter, underlayBlur: getComputedStyle(document.querySelector('.bot-main')!).filter }));
    expect(surface.background).toBe('rgba(20, 23, 40, 0.12)');
    if (uiEffects === 'reduced') { expect(surface.blur).toBe('none'); expect(surface.underlayBlur).toBe('none'); }
    else expect([surface.blur, surface.underlayBlur].some(value => value.includes('blur('))).toBe(true);
    const captureImage = async (name: string) => {
      await waitForPaint(); const image = testInfo.outputPath(name);
      const png = await application.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.webContents.setBackgroundThrottling(false); window.hide();
        return (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64');
      });
      await writeFile(image, Buffer.from(png, 'base64')); await copyFile(image, path.join(evidence, name));
      await testInfo.attach(name, { path: image, contentType: 'image/png' });
    };
    const capture = (theme: 'light' | 'dark') => captureImage(`memory-workspace-app-${theme}.png`);
    await capture('light');
    await row(short.id).locator('.bot-memory-row-open').click(); await expect(dialog.locator('.bot-memory-fulltext')).toContainText('麦茶');
    expect(await dialog.boundingBox()).toEqual(panel);
    await dialog.getByRole('button', { name: '召回试查', exact: true }).click(); expect(await dialog.boundingBox()).toEqual(panel);
    await dialog.getByRole('button', { name: '整理与梦境', exact: true }).click();
    const modes = dialog.getByRole('combobox', { name: '日记维护模式', exact: true });
    await expect(modes.locator('option')).toHaveText(['只读健康检查', '日常整理', '事件追踪', '深度清理']);
    await modes.selectOption('deepclean');
    const brief = dialog.locator('details.bot-maintenance-brief');
    await brief.locator('summary').click();
    await brief.getByLabel('项目或关注点', { exact: true }).fill('看展');
    await brief.getByLabel('起始日期', { exact: true }).fill('2026-10-01');
    await brief.getByLabel('结束日期', { exact: true }).fill('2026-11-27');
    await dialog.getByRole('button', { name: '开始深度清理', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '确认深度清理', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '确认深度清理', exact: true })).toHaveCount(0);
    const schedule = dialog.locator('details.bot-maintenance-settings');
    await schedule.locator('summary').click();
    const automatic = schedule.getByRole('checkbox', { name: '启用自动记忆整理', exact: true });
    await expect(automatic).toBeChecked();
    await expect(schedule).toContainText('重新打开后，伙伴会在空闲时接续');
    await expect(schedule).toContainText('由你逐项批准');
    await automatic.click(); await expect(automatic).not.toBeChecked();
    await expect.poll(async () => (await memory<{ enabled: boolean }>(page, { type: 'memory.maintenance.settings.get', ...scope })).enabled).toBe(false);
    await automatic.click(); await expect(automatic).toBeChecked();
    await expect.poll(async () => (await memory<{ enabled: boolean }>(page, { type: 'memory.maintenance.settings.get', ...scope })).enabled).toBe(true);
    await dialog.getByRole('button', { name: '日记', exact: true }).click();
    await dialog.getByRole('button', { name: '关闭记忆工作台', exact: true }).click();
    await page.evaluate(() => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme: 'dark' })));
    await page.reload(); await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await open(); await row(long.id).locator('.bot-memory-row-open').click(); await expect(dialog.locator('.bot-memory-fulltext')).toContainText('全文结尾校验雨伞');
    await page.evaluate(() => document.fonts.ready); await capture('dark');
    await dialog.getByRole('button', { name: '编辑日记', exact: true }).click();
    const edited = longText.replace('下午两点', '下午三点');
    await dialog.getByRole('textbox', { name: '日记正文', exact: true }).fill(edited);
    await dialog.getByRole('textbox', { name: '标签，用逗号分隔', exact: true }).fill('本地测试,雨天安排');
    await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('索引已确认', { timeout: 45000 });
    const updated = await memory<BotMemoryFullNote>(page, { type: 'memory.note', ...scope, id: long.id });
    expect(updated.content).toBe(edited); expect(updated.checksum).not.toBe(long.checksum);
    const stale = await memory<{ state: string }>(page, { type: 'memory.update', ...scope, id: long.id, expectedChecksum: long.checksum, content: '这段过期修改不能覆盖已保存内容。' });
    expect(stale.state).toBe('conflict');
    expect((await memory<BotMemoryFullNote>(page, { type: 'memory.note', ...scope, id: long.id })).content).toBe(edited);
    await row(long.id).locator('input[type="checkbox"]').check(); await row(short.id).locator('input[type="checkbox"]').check();
    await dialog.getByRole('button', { name: '整理选中日记', exact: true }).click();
    const mergedText = '本地测试整理：雨天看展与麦茶\n隔离测试事实：周六下雨，原来的湖边散步改为市美术馆看展，下午三点南门见。预约门票仍未完成。傍晚以后喝麦茶，白天咖啡的习惯保持不变。';
    await dialog.getByRole('textbox', { name: '日记正文', exact: true }).fill(mergedText);
    await dialog.getByRole('textbox', { name: '标签，用逗号分隔', exact: true }).fill('本地测试');
    await dialog.getByRole('button', { name: '保存并归档原记录', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('原记录已归档', { timeout: 45000 });
    const organized = await memory<BotMemoryCatalog>(page, { type: 'memory.catalog', ...scope });
    expect(organized.items.filter(item => item.indexState === 'archived')).toHaveLength(2);
    const merged = organized.items.find(item => ![long.id, short.id].includes(item.id))!; expect(merged.indexState).toBe('indexed');
    await row(long.id).locator('.bot-memory-row-open').click(); await expect(dialog.locator('.bot-memory-note-meta')).toContainText('已归档');
    await expect(dialog.getByRole('button', { name: '编辑日记', exact: true })).toBeDisabled();
    await expect(row(long.id).locator('input[type="checkbox"]')).toBeDisabled();
    await expect(dialog.locator('.bot-memory-fulltext')).toContainText('全文结尾校验雨伞');
    const beforeRecall = await memory<{ historyMessages: number }>(page, { type: 'memory.inspect', ...scope });
    const reports: BotMemoryRecallReport[] = [];
    await dialog.getByRole('button', { name: '召回试查', exact: true }).click();
    const reference = dialog.locator('.bot-memory-reference-import');
    await reference.locator('summary').click();
    const fileName = '馆内指南.md', content = '南门服务台负责登记参观预约。';
    await reference.getByLabel('参考文档').setInputFiles({ name: fileName, mimeType: 'text/markdown', buffer: Buffer.from(content) });
    await reference.getByRole('button', { name: '导入', exact: true }).click();
    await expect(reference.getByRole('status')).toContainText(fileName + ' 已保存');
    expect(await readFile(path.join(memoryRoot, homes[0]!.name, 'knowledge', 'Companion', fileName), 'utf8')).toBe(content);
    await reference.locator('summary').click();
    for (const mode of ['passive', 'semantic'] as const) {
      await dialog.getByRole('button', { name: mode === 'passive' ? '被动召回' : '语义查找', exact: true }).click();
      await dialog.getByRole('textbox', { name: '想回想什么？', exact: true }).fill('这次本地测试周六下雨，最后约在哪里看展，几点见面？');
      await dialog.getByRole('button', { name: '开始试查', exact: true }).click();
      await expect(dialog.locator('.bot-memory-hit').first()).toBeVisible({ timeout: 45000 });
      const records = await memory<{ reports: BotMemoryRecallReport[] }>(page, { type: 'memory.recall.records', ...scope, limit: 5 });
      const report = records.reports[0]!; reports.push(report);
      expect(report.mode).toBe(mode); expect(report.hits.some(hit => hit.text.includes('市美术馆'))).toBe(true);
      expect(report.stages.some(stage => stage.name !== 'host.context.prepare')).toBe(true); expect(report.totalMs).toBeGreaterThan(0);
      expect(await dialog.locator('.bot-memory-hit p').allTextContents()).toEqual(report.hits.map(hit => hit.text));
      expect(await dialog.locator('.bot-memory-rank').allTextContents()).toEqual(report.hits.map(hit => String(hit.rank)));
      await expect(dialog.locator('.bot-memory-diagnostics')).not.toHaveAttribute('open');
      await dialog.locator('.bot-memory-diagnostics>summary').click();
      await expect(dialog.locator('.bot-memory-stage')).toHaveCount(report.stages.length);
      expect(await dialog.locator('.bot-memory-stage-name').allTextContents()).not.toEqual(report.stages.map(stage => stage.name));
      expect(await dialog.locator('.bot-memory-stage-status').allTextContents()).not.toContain('completed');
      const original = await dialog.locator('.bot-memory-stage-raw>pre').textContent();
      expect(JSON.parse(original!)).toEqual(report.stages);
      await expect(dialog.locator('.bot-memory-diagnostics')).toContainText('不能相加为总耗时');
    }
    // Actual stage names and measurements, rendered by the production renderer.
    // Resizing only this verified test window exercises all layout breakpoints.
    const recallLayout: unknown[] = [];
    const originalBounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
    for (const width of [1440, 900, 620]) {
      await application.evaluate(({ BrowserWindow }, width) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        window.setMinimumSize(560, 560); window.setSize(width, 900); window.hide();
      }, width);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width); await waitForPaint();
      await dialog.locator('.bot-memory-diagnostics>summary').scrollIntoViewIfNeeded();
      const geometry = await dialog.locator('.bot-memory-stages').evaluate(element => {
        const stages = element.getBoundingClientRect(), rows = [...element.children].map(item => {
          const bounds = item.getBoundingClientRect();
          return { width: bounds.width, outside: bounds.left < stages.left - 1 || bounds.right > stages.right + 1,
            overflow: item.scrollWidth > item.clientWidth + 1 };
        });
        return { viewport: innerWidth, columns: getComputedStyle(element).gridTemplateColumns.split(' ').length,
          width: stages.width, rows, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      expect(geometry.columns).toBe(geometry.viewport > 1000 ? 3 : geometry.viewport > 620 ? 2 : 1);
      expect(geometry.rows.every(row => !row.outside && !row.overflow)).toBe(true);
      expect(geometry.horizontalOverflow).toBe(false);
      recallLayout.push(geometry);
      await captureImage(`memory-recall-stages-${width}-dark.png`);
    }
    await application.evaluate(({ BrowserWindow }, bounds) => { const window = BrowserWindow.getAllWindows()[0]!; window.setBounds(bounds); window.hide(); }, originalBounds);
    await dialog.getByRole('button', { name: '最近5次试查', exact: true }).click();
    await expect(dialog.locator('.bot-memory-recall-records>div>button')).toHaveCount(2);
    const afterRecall = await memory<{ historyMessages: number }>(page, { type: 'memory.inspect', ...scope });
    expect(afterRecall.historyMessages).toBe(beforeRecall.historyMessages);
    const after = await request(page, { type: 'state', conversationId: scope.conversationId });
    expect(after.snapshot?.messages).toHaveLength(0); expect(after.snapshot?.tasks).toEqual([]); expect(after.snapshot?.runtime.activeLanes).toBe(0);
    await dialog.getByRole('button', { name: '日记', exact: true }).click(); await row(merged.id).locator('.bot-memory-row-open').click();
    await dialog.locator('summary[aria-label="更多操作"]').click(); await dialog.getByRole('menuitem', { name: '忘记这条记忆', exact: true }).click();
    await dialog.getByRole('button', { name: '确认忘记', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('这条记忆已撤回', { timeout: 45000 });
    expect((await memory<BotMemoryCatalog>(page, { type: 'memory.catalog', ...scope })).items.some(item => item.id === merged.id)).toBe(false);
    expect((await memory<{ reports: BotMemoryRecallReport[] }>(page, { type: 'memory.recall.records', ...scope })).reports).toEqual([]);
    const nativeVisible = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible()));
    expect(nativeVisible).toBe(false);
    await writeFile(path.join(evidence, 'memory-workspace-app-evidence.json'), JSON.stringify({
      identity,
      route: 'actual Electron Main IPC / bundled VCP / local EmbeddingGemma 768', authoredTestFacts: true, configuredChatModel: false,
      testRendering: { hardwareGpuRequested: process.env.WORLDLINEBOX_E2E_ENABLE_HARDWARE_GPU === '1', claim: 'Functional coverage only; production GPU performance is not measured' },
      pagination: { first: first.items[0]!.id, next: next.items[0]!.id }, panel, surface, uiEffects, nativeVisible, dimension: config.VECTORDB_DIMENSION,
      recall: reports.map(report => ({ requestId: report.requestId, mode: report.mode, totalMs: report.totalMs, stages: report.stages, hits: report.hits })), recallLayout,
      historyMessagesBefore: beforeRecall.historyMessages, historyMessagesAfter: afterRecall.historyMessages,
      staleChecksumRejected: true, archivedOriginals: 2, mergedMemoryWithdrawn: true,
    }, null, 2) + '\n');
  } catch (error) {
    const diagnostic: Record<string, unknown> = { error: error instanceof Error ? error.message : String(error), profile: resolved };
    const within = async <T>(work: Promise<T>): Promise<T | { timedOut: true }> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([work, new Promise<{ timedOut: true }>(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), 4000); })]); }
      finally { if (timer) clearTimeout(timer); }
    };
    diagnostic.native = await within(application.evaluate(({ app, BrowserWindow }) => ({ pid: process.pid, profile: app.getPath('userData'),
      frames: Reflect.get(globalThis, '__memoryUiFrames'), windows: BrowserWindow.getAllWindows().map(window => ({ visible: window.isVisible(), offscreen: window.webContents.isOffscreen(), bounds: window.getBounds(), loading: window.webContents.isLoading() })) }))).catch(value => ({ error: String(value) }));
    if (failurePage) diagnostic.renderer = await within(failurePage.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('button[aria-label="记忆"]'), bounds = button?.getBoundingClientRect(), style = button ? getComputedStyle(button) : undefined;
      return { visibilityState: document.visibilityState, readyState: document.readyState, viewport: { width: innerWidth, height: innerHeight },
        button: button && bounds && style ? { bounds: bounds.toJSON(), clientRects: [...button.getClientRects()].map(rect => rect.toJSON()), disabled: button.disabled,
          display: style.display, visibility: style.visibility, opacity: style.opacity, pointerEvents: style.pointerEvents,
          pointStack: document.elementsFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2).slice(0, 6).map(element => ({ tag: element.tagName, className: element.className, text: element.textContent?.slice(0, 120) })) } : null };
    })).catch(value => ({ error: String(value) }));
    const screenshot = await within(application.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]; return window ? (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64') : undefined;
    })).catch(() => undefined);
    if (typeof screenshot === 'string') { const file = testInfo.outputPath('memory-failure.png'); await writeFile(file, Buffer.from(screenshot, 'base64')); await testInfo.attach('memory-failure', { path: file, contentType: 'image/png' }); }
    await writeFile(testInfo.outputPath('memory-failure-diagnostic.json'), JSON.stringify(diagnostic, null, 2));
    throw error;
  } finally {
    await application.close();
    // The only recursively removed path is this test's validated mkdtemp child.
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionMessage, CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import type { WorldlineBoxDshLauncherApi } from '../../src/shared/dsh-launcher';
import type { CompanionFileInput, CompanionToolImageReference } from '../../src/shared/companion-file-tool';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; llm: WorldlineBoxLlmApi; dshLauncher: WorldlineBoxDshLauncherApi } };
const companionId = 'deepseek-sister', conversationId = 'private-deepseek-sister';
const marker = '世界线只读文件验收：蓝色的纸船。';
const finalText = '读取完成：文本写着“蓝色的纸船”。图片像素已实际传入；文本快照、图片和已有音频都附在这条回复。音频仅发送，没有声称听过。';
async function request(page: Page, value: CompanionsRequest) {
  const response = await page.evaluate(input => (window as unknown as Bridge).worldlinebox.companions.request(input), value);
  expect(response.ok, response.error).toBe(true); return response;
}
async function launch(profile: string) {
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(),
    env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }, { gpu: 'software' }) });
  const page = await application.firstWindow(), native = await application.browserWindow(page);
  await native.evaluate(window => { window.unmaximize(); window.setSize(1440, 1050); window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.hide(); });
  await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page'); return { application, page };
}
async function openChat(page: Page) {
  await page.locator('[data-application-module="companions"]').click(); await page.getByRole('button', { name: '联系人', exact: true }).click();
  await page.locator(`[data-companion-contact="${companionId}"]`).click(); await page.getByRole('button', { name: '发消息', exact: true }).click();
}
async function awake(page: Page) {
  const world = (await request(page, { type: 'world.snapshot' })).world!;
  await request(page, { type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime' } });
  const routine = (await request(page, { type: 'routine.get', companionId, conversationId })).routine!, hour = Math.floor(world.clock.hour);
  const clock = (delta: number) => String((hour + delta + 24) % 24).padStart(2, '0') + ':00';
  await request(page, { type: 'routine.configure', companionId, conversationId, expectedRevision: routine.revision,
    patch: { timeZone: world.settings.timeZone, wakeAt: clock(-8), sleepAt: clock(8), meals: [], habits: [] } });
}
function wave() {
  const samples = 16000, data = Buffer.alloc(44 + samples * 2); data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let sample = 0; sample < samples; sample++) data.writeInt16LE(Math.round(Math.sin(sample / 16000 * Math.PI * 880) * 2500), 44 + sample * 2);
  return data;
}
function cleanup(root: string) {
  const target = path.resolve(root);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('worldlinebox-file-vision-e2e-')) throw new Error('Unexpected file vision cleanup path.');
  rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
}

// Only the native chooser and remote model are fixtures. Main executes the
// registered tools, SQLite commits their references, and Chromium decodes media.
// eslint-disable-next-line no-empty-pattern
test('reads actual text and image pixels with native tools, sends an existing file and preserves the one reply with managed attachments across restart', async ({}, testInfo) => {
  test.setTimeout(150000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-file-vision-e2e-')), profile = path.join(root, 'profile'), uploads = path.join(root, 'uploads'); mkdirSync(uploads);
  const imageFile = path.join(uploads, '纸船.png'), textFile = path.join(uploads, '验收记录.txt'), audioFile = path.join(uploads, '现有轻音.wav');
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#5b8fa8"/><path d="M35 88H205L165 132H75Z" fill="#e9d7a5"/><path d="M120 25L170 88H120Z" fill="#c85c45"/></svg>')).png().toFile(imageFile);
  writeFileSync(textFile, marker + '\n第二行保留原始来源。\n', 'utf8'); const originalAudio = wave(); writeFileSync(audioFile, originalAudio);
  const providerErrors: string[] = [], primary: Array<{ files: CompanionFileInput[]; toolIds: string[] }> = [];
  let application: ElectronApplication | undefined, proof: { image: CompanionToolImageReference; bytes: number; sha256: string } | undefined;
  const server = createServer((incoming, outgoing) => {
    let raw = ''; incoming.setEncoding('utf8'); incoming.on('data', chunk => { raw += chunk; }); incoming.on('end', () => { void (async () => {
      try {
        const body = JSON.parse(raw), context = JSON.parse(body.messages[1].content); let output: unknown, toolCalls: unknown;
        if (context.purpose === 'world_attention') output = { urgency: 'ordinary', confidence: .99, evidence: [context.source.content], reason: '普通只读查看请求，正常等待。' };
        else if (context.purpose === 'world_decision') output = { action: null, reason: '遵守当前生活安排。', appraisals: [] };
        else if (context.purpose === 'world_social') output = { text: null, reason: '自然结束。' };
        else if (context.purpose === 'memory_query') output = {};
        else if (context.purpose === 'memory_dream') output = { candidates: [], dream: null };
        else if (context.purpose?.startsWith('memory_')) output = { candidates: [] };
        else {
          const files = context.files as CompanionFileInput[], tools = body.messages.filter((message: { role: string }) => message.role === 'tool');
          primary.push({ files, toolIds: tools.map((tool: { tool_call_id: string }) => tool.tool_call_id) });
          if (!tools.length) {
            expect(files.map(file => file.name).sort()).toEqual(['现有轻音.wav', '纸船.png', '验收记录.txt'].sort());
            for (const file of files) { expect(file.available).toBe(true); expect(path.isAbsolute(file.path!)).toBe(true); expect(existsSync(file.path!)).toBe(true); }
            const find = (name: string) => files.find(file => file.name === name)!.path!;
            toolCalls = [['read_text', 'read_file', find('验收记录.txt')], ['read_pixels', 'read_image', find('纸船.png')], ['send_audio', 'send_file', find('现有轻音.wav')]]
              .map(([id, name, filename]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify({ path: filename }) } }));
            output = '我先实际查看这份文字和图片，再把已有文件附给你。';
          } else {
            expect(tools.map((tool: { tool_call_id: string }) => tool.tool_call_id).sort()).toEqual(['read_text', 'read_pixels', 'send_audio'].sort());
            expect(tools.find((tool: { tool_call_id: string }) => tool.tool_call_id === 'read_text').content).toContain(marker);
            const image = context.toolVisionManifest.find((item: { callId: string }) => item.callId === 'read_pixels') as CompanionToolImageReference & { delivery: string };
            expect(image.delivery).toBe('image_provided'); expect(image.mime).toBe('image/jpeg');
            let found = false;
            for (const message of body.messages.filter((message: { role: string; content: unknown }) => message.role === 'user' && Array.isArray(message.content))) {
              let label: { callId: string; attachmentId: string; sha256: string } | undefined;
              for (const part of message.content) {
                if (part.type === 'text') label = JSON.parse(part.text).hostToolImage;
                if (part.type === 'image_url' && label?.callId === 'read_pixels') {
                  const match = String(part.image_url.url).match(/^data:image\/jpeg;base64,(.+)$/u); expect(match).toBeTruthy(); const bytes = Buffer.from(match![1]!, 'base64'), metadata = await sharp(bytes).metadata();
                  const hash = createHash('sha256').update(bytes).digest('hex'); expect(hash).toBe(image.sha256); expect(label.attachmentId).toBe(image.attachmentId); expect(label.sha256).toBe(hash);
                  expect(metadata).toMatchObject({ format: 'jpeg', width: 240, height: 160 }); expect(bytes.length).toBeLessThanOrEqual(1024 * 1024); expect(readFileSync(image.path)).toEqual(bytes);
                  proof = { image, bytes: bytes.length, sha256: hash }; found = true;
                }
              }
            }
            expect(found).toBe(true); output = finalText;
          }
        }
        outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ choices: [{ message: { content: typeof output === 'string' ? output : JSON.stringify(output), ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }] }));
      } catch (cause) { providerErrors.push(cause instanceof Error ? cause.message : 'Local provider fixture failed.'); outgoing.writeHead(400); outgoing.end(); }
    })(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    let opened = await launch(profile); application = opened.application; let page = opened.page;
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Local fixture address missing.');
    await page.evaluate(baseUrl => (window as unknown as Bridge).worldlinebox.llm.setConfig({ apiFormat: 'openai_chat', model: 'gpt-4o', apiKey: 'fixture-file-vision-key', baseUrl }), 'http://127.0.0.1:' + address.port);
    await openChat(page); await awake(page);
    await application.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }); }, [imageFile, textFile, audioFile]);
    await page.getByRole('button', { name: '发送文件或图片', exact: true }).click(); await expect(page.locator('.companions-draft-attachments > span')).toHaveCount(3);
    await page.getByRole('textbox', { name: '输入消息', exact: true }).fill('请直接查看上传的文字和图片，把它们的快照和已有音频附给我；不要修改、运行或创建外部任务。'); await page.getByRole('button', { name: '发送', exact: true }).click();
    let reply: CompanionMessage | undefined;
    await expect.poll(async () => { const messages = (await request(page, { type: 'messages', conversationId, limit: 30 })).messages!; reply = messages.find(message => message.authorId === companionId && !message.isReplyDraft && message.content.includes(finalText)); return reply?.attachments.length ?? 0; }, { timeout: 45000 }).toBe(3);
    expect(providerErrors).toEqual([]); expect(primary).toHaveLength(2); expect(proof).toBeTruthy();
    const source = (await request(page, { type: 'messages', conversationId, limit: 30 })).messages!.find(message => message.authorId === 'user' && message.content.includes('直接查看上传'))!;
    expect(reply!.replyToId).toBe(source.id); expect(reply!.attachments.map(attachment => attachment.mime).sort()).toEqual(['audio/wav', 'image/jpeg', 'text/plain'].sort());
    const bubble = page.locator(`[data-companion-message="${reply!.id}"]`); await expect(bubble).toContainText('蓝色的纸船'); await expect(bubble.locator('.companions-attachment-images img')).toHaveCount(1); await expect(bubble.locator('.is-text')).toHaveCount(1); await expect(bubble.locator('audio')).toHaveCount(1);
    await expect.poll(() => bubble.locator('img').last().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(240);
    await expect.poll(() => bubble.locator('audio').evaluate((audio: HTMLAudioElement) => audio.readyState), { timeout: 15000 }).toBeGreaterThanOrEqual(1);
    const actions = (await request(page, { type: 'actions', conversationId })).actions ?? []; expect(actions).toEqual([]);
    const runtime = await page.evaluate(() => (window as unknown as Bridge).worldlinebox.dshLauncher.request({ type: 'state' })); if (!runtime.ok) throw new Error(runtime.error); expect(runtime.state?.tasks ?? []).toEqual([]);
    const screenshot = testInfo.outputPath('file-vision-final.png'); await bubble.screenshot({ path: screenshot }); await testInfo.attach('real-tool-attachments', { path: screenshot, contentType: 'image/png' });
    const replyId = reply!.id, attachmentIds = reply!.attachments.map(attachment => attachment.id);
    await application.close(); application = undefined;
    const database = new DatabaseSync(path.join(profile, 'companions', 'messages.sqlite'), { readOnly: true });
    try {
      const stored = database.prepare('SELECT value FROM metadata WHERE key=?').get(`loop/${source.id}/${companionId}`)!;
      const checkpoint = JSON.parse(String(stored.value)) as CompanionLoopCheckpoint; expect(checkpoint.status).toBe('done'); expect(checkpoint.messageId).toBe(replyId); expect(checkpoint.turns).toHaveLength(2);
      expect(checkpoint.turns[0]!.results!.flatMap(result => result.attachmentIds ?? []).sort()).toEqual([...attachmentIds].sort()); expect(checkpoint.turns[0]!.results!.flatMap(result => result.images ?? [])).toHaveLength(1);
      const allCheckpoints = database.prepare("SELECT value FROM metadata WHERE key LIKE 'loop/%' OR key LIKE 'message-loop/%'").all().map(row => String(row.value)).join('\n');
      expect(allCheckpoints).not.toMatch(/"base64"\s*:/u); expect(allCheckpoints).not.toContain('data:image/');
      const files = attachmentIds.map(id => database.prepare('SELECT relative_path,data FROM attachments WHERE id=?').get(id)!);
      for (const file of files) { const filename = path.resolve(profile, 'companions', String(file.relative_path)); expect(filename.startsWith(path.join(profile, 'companions', 'attachments') + path.sep)).toBe(true); expect(existsSync(filename)).toBe(true); const item = JSON.parse(String(file.data)); if (item.mime === 'audio/wav') expect(readFileSync(filename)).toEqual(originalAudio); }
    } finally { database.close(); }
    for (const filename of [imageFile, textFile, audioFile]) rmSync(filename); expect(existsSync(imageFile)).toBe(false);
    opened = await launch(profile); application = opened.application; page = opened.page; await openChat(page);
    const restored = (await request(page, { type: 'messages', conversationId, limit: 30 })).messages!.find(message => message.id === replyId)!; expect(restored.attachments.map(attachment => attachment.id)).toEqual(attachmentIds);
    const restoredBubble = page.locator(`[data-companion-message="${replyId}"]`); await expect(restoredBubble).toContainText(finalText); await expect.poll(() => restoredBubble.locator('.companions-attachment-images img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(240);
    await expect.poll(() => restoredBubble.locator('audio').evaluate((audio: HTMLAudioElement) => audio.readyState), { timeout: 15000 }).toBeGreaterThanOrEqual(1); expect(primary).toHaveLength(2);
    const report = { fixture: 'scripted_local_model_real_main_tools', toolCallIds: ['read_text', 'read_pixels', 'send_audio'], modelRequests: primary.length, actualJpeg: { width: 240, height: 160, bytes: proof!.bytes, sha256: proof!.sha256 }, managedAttachments: attachmentIds.length, originalFilesDeleted: true, restartPreservedAttachmentIds: true, dshTasks: 0, checkpointHasNoPixels: true, providerErrors };
    const artifacts = path.resolve('.tools/test-output/companions'); mkdirSync(artifacts, { recursive: true }); writeFileSync(path.join(artifacts, 'verified-companion-file-vision.json'), JSON.stringify(report, null, 2)); await restoredBubble.screenshot({ path: path.join(artifacts, 'verified-companion-file-vision.png') }); await testInfo.attach('file-vision-proof', { body: JSON.stringify(report), contentType: 'application/json' });
  } finally { await application?.close().catch(() => undefined); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); cleanup(root); }
});

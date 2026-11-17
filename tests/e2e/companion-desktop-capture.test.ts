import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { WorldlineBoxBotMediaApi } from '../../src/shared/companion-bot-media';
import type { DshRuntime } from '../../src/shared/dsh-launcher';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';
import { enableCallVisualFixture } from './fixtures/call-visual-binding';
import { seedNativeRuntime } from './fixtures/dsh-native-runtime';

type Api = { companionBot: WorldlineBoxBotApi; companionBotMedia: WorldlineBoxBotMediaApi };

async function playLoopbackFixture(app: Awaited<ReturnType<typeof electron.launch>>, input: string) {
  const source = await readFile(input);
  await app.evaluate(async ({ BrowserWindow }, base64) => {
    const sound = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    await sound.loadURL('about:blank');
    await sound.webContents.executeJavaScript(`(async()=>{const context=new AudioContext();const player=context.createBufferSource();
      player.buffer=await context.decodeAudioData(Uint8Array.from(atob(${JSON.stringify(base64)}),x=>x.charCodeAt(0)).buffer);
      player.loop=true;player.connect(context.destination);await context.resume();player.start();})()`, true);
  }, source.toString('base64'));
}

test('transcribes a two-hour movie from the attachment button without sending it', async () => {
  const ffmpeg = path.resolve('resources/ffmpeg/win32-x64/ffmpeg.exe');
  const input = path.resolve('tests/fixtures/media/sensevoice-zh.wav');
  test.skip(process.platform !== 'win32' || !existsSync(ffmpeg) || !existsSync(input) || !existsSync('resources/speech-models/model.int8.onnx'));
  test.setTimeout(420_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-desktop-companion-capture-'));
  if (path.dirname(profile) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('wlb-desktop-companion-capture-')) throw Error('Unexpected test profile');
  const movie = path.join(profile, 'long-movie.mkv');
  const prepared = spawnSync(ffmpeg, ['-nostdin', '-loglevel', 'error', '-i', input, '-f', 'lavfi', '-i', 'color=s=16x16:r=1/120',
    '-filter_complex', '[0:a]asplit[a][b];[a]apad=whole_dur=7205[a1];[a1][b]concat=n=2:v=0:a=1[audio]',
    '-map', '1:v:0', '-map', '[audio]', '-c:v', 'ffv1', '-c:a', 'flac', '-t', '7211', movie],
  { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  expect(prepared.status, prepared.stderr).toBe(0);
  const launch = resolveElectronLaunchOptions();
  const app = await electron.launch({ ...launch, env: electronLaunchEnv({
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN',
  }) });
  try {
    const page = await app.firstWindow();
    await page.locator('[data-application-module="companions"]').click();
    const call = page.getByRole('button', { name: '拨打伙伴电话', exact: true });
    await expect(async () => {
      await enableCallVisualFixture(app, page);
      await expect(call).toBeEnabled({ timeout: 1_200 });
    }).toPass({ timeout: 20_000 });
    const room = await page.evaluate(async () => (await (Reflect.get(window, 'worldlinebox') as Api).companionBot.request({ type: 'state' })).snapshot!.conversations[0]!.id);
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, movie);
    await page.getByRole('button', { name: '添加文件', exact: true }).click({ button: 'right' });
    await expect(page.locator('.bot-capture-status-row .bot-desktop-capture-status')).toHaveText('正在分段转写音轨');
    await expect(page.getByRole('button', { name: '预览 音频转写.txt' })).toBeVisible({ timeout: 240_000 });
    const result = await page.evaluate(async conversationId => {
      const api = Reflect.get(window, 'worldlinebox') as Api;
      const files = await api.companionBotMedia.request({ type: 'media.list', conversationId });
      const id = files.media!.find(item => item.name === '音频转写.txt')!.id;
      const transcript = await api.companionBotMedia.request({ type: 'media.text.read', conversationId, id });
      const state = await api.companionBot.request({ type: 'state', conversationId });
      return { text: transcript.textPage?.content, sentCount: state.snapshot!.messages.length };
    }, room);
    expect(result.text).toMatch(/音轨总时长 02:00:1[01]/u);
    expect(result.text?.match(/[九9]点/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(result.sentCount).toBe(0);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('routes a real DSH watch tool call with default access and returns aligned evidence', async () => {
  const manager = path.join(process.env.APPDATA ?? '.', 'WorldlineBox', 'dsh');
  const runtimes = JSON.parse(await readFile(path.join(manager, 'runtimes.json'), 'utf8').catch(() => '[]')) as DshRuntime[];
  const runtime = runtimes.find(item => item.version === '0.2.2-rc.3') ?? runtimes.find(item => item.version === '0.2.2-rc.2');
  test.skip(!runtime || process.platform !== 'win32' || !existsSync('resources/speech-models/model.int8.onnx'));
  test.setTimeout(240_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-desktop-companion-capture-'));
  if (path.dirname(profile) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('wlb-desktop-companion-capture-')) throw Error('Unexpected test profile');
  const prompt = '陪我看看屏幕上刚播了什么，也听一下声音。';
  let evidence: { durationSeconds?: number; imagePath?: string; transcript?: string } | undefined;
  let observedImage = false;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.end('{"object":"list","data":[{"id":"desktop-watch-fixture","object":"model"}]}'); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> };
    const source = data.messages.findLastIndex(message => {
      const content = JSON.stringify(message.content ?? '');
      return content.includes(prompt) && content.includes('identity');
    });
    const results = source < 0 ? [] : data.messages.slice(source + 1).filter(message => message.role === 'tool');
    let tool: { name: string; arguments: string } | undefined;
    let content = '{"notes":[]}';
    if (source >= 0 && data.tools?.some(entry => entry.function.name === 'companion_desktop_capture')) {
      if (results.length === 0) tool = { name: 'companion_desktop_capture', arguments: '{"operation":"watch","seconds":5}' };
      else if (results.length === 1) {
        const payload = results[0]!.content;
        const serialized = typeof payload === 'string' ? payload : typeof (payload as Array<{ text?: string }>)[0]?.text === 'string' ? (payload as Array<{ text: string }>)[0]!.text : '';
        try { evidence = JSON.parse(serialized) as typeof evidence; } catch { content = serialized.slice(0, 600); }
        if (evidence?.imagePath) tool = { name: 'read_image', arguments: JSON.stringify({ file_path: evidence.imagePath }) };
        else content = '未获采集授权。';
      } else {
        observedImage = JSON.stringify(data.messages.slice(source + 1)).includes('image_url');
        content = '已观看并收到画面与声音。';
      }
    }
    const delta = tool ? { tool_calls: [{ index: 0, id: 'watch-' + crypto.randomUUID(), type: 'function', function: tool }] } : { content };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 2000, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  const launch = resolveElectronLaunchOptions();
  try {
    await seedNativeRuntime(manager, runtime!, profile);
    app = await electron.launch({ ...launch, env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1',
      WORLDLINEBOX_E2E_USER_DATA_PATH: profile, WORLDLINEBOX_E2E_LOCALE: 'zh-CN' }) });
    const page = await app.firstWindow();
    expect((await page.evaluate(baseUrl => (Reflect.get(window, 'worldlinebox') as { llm: WorldlineBoxLlmApi }).llm.setConfig({
      apiFormat: 'openai_chat', model: 'desktop-watch-fixture', baseUrl, apiKey: 'localhost-only-fixture',
    }), 'http://127.0.0.1:' + (server.address() as { port: number }).port)).ok).toBe(true);
    await page.locator('[data-application-module="companions"]').click();
    const setup = page.locator('[data-shared-dsh-setup]');
    await setup.getByRole('combobox', { name: '选择 DSH 版本' }).selectOption(runtime!.id);
    await setup.getByRole('button', { name: '创建并共享', exact: true }).click();
    await expect(page.getByRole('button', { name: '拨打伙伴电话', exact: true })).toBeEnabled({ timeout: 90_000 });
    await playLoopbackFixture(app, 'tests/fixtures/media/sensevoice-zh.wav');
    const box = page.getByRole('textbox', { name: '发送消息…', exact: true });
    await box.fill(prompt);
    await box.press('Enter');
    await expect(page.locator('.bot-desktop-capture-status').getByRole('status')).toHaveText('伙伴正在观看屏幕', { timeout: 60_000 });
    await expect(page.getByText('已观看并收到画面与声音。', { exact: true })).toBeVisible({ timeout: 90_000 });
    expect(evidence?.durationSeconds).toBeGreaterThan(4);
    expect(evidence?.transcript).toMatch(/\[00:\d\d\.\d{3} – 00:\d\d\.\d{3}\] \S/u);
    expect(observedImage).toBe(true);
  } finally {
    await app?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('uses native DSH for companion recordings and ordinary audio attachments', async () => {
  const manager = path.join(process.env.APPDATA ?? '.', 'WorldlineBox', 'dsh');
  const runtimes = JSON.parse(await readFile(path.join(manager, 'runtimes.json'), 'utf8').catch(() => '[]')) as DshRuntime[];
  const runtime = runtimes.find(item => item.version === '0.2.2-rc.3') ?? runtimes.find(item => item.version === '0.2.2-rc.2');
  test.skip(!runtime || process.platform !== 'win32' || !existsSync('resources/speech-models/model.int8.onnx'));
  test.setTimeout(345_000);
  const profile = await mkdtemp(path.join(tmpdir(), 'wlb-desktop-companion-capture-'));
  if (path.dirname(profile) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('wlb-desktop-companion-capture-')) throw Error('Unexpected test profile');
  const prompt = '请转写这条音频。我们接着看。';
  const fixture = path.resolve('tests/fixtures/media/sensevoice-zh.wav');
  type Observation = { name: string; kind: 'screen' | 'video'; surface: 'call' | 'pet'; audio?: { subtitles?: string[] }; frameSheets?: string[][];
    durationSeconds: number; sources: { kind: 'video' | 'screen'; from: number; to: number; originalPath: string }[] };
  const requested = new Map<string, { image: boolean; evidence: Observation; prior: boolean; presentation?: string }>();
  let ordinaryTranscript = '', ordinaryFile: Record<string, unknown> | undefined, rawAudioInRequest = false;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.end('{"object":"list","data":[{"id":"presence-fixture","object":"model"}]}'); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    rawAudioInRequest ||= /data:audio\/|input_audio/u.test(body);
    const data = JSON.parse(body) as { messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }> };
    const source = data.messages.findLastIndex(message => message.role === 'user' && JSON.stringify(message.content).includes('identity'));
    const user = data.messages[source]?.content;
    let envelope: { observation?: Observation; stage?: unknown; message?: { content: string }; files?: Array<{ id: string }> } | undefined;
    try { envelope = JSON.parse(typeof user === 'string' ? user : user?.find(part => part.type === 'text')?.text ?? ''); } catch { /* auxiliary turns */ }
    const results = data.messages.slice(source + 1).filter(message => message.role === 'tool');
    let tool: { name: string; arguments: string } | undefined;
    let content = '{"notes":[]}';
    if (envelope?.observation) {
      const { name } = envelope.observation;
      if (!requested.has(name)) requested.set(name, { image: JSON.stringify(user).includes('image_url'), evidence: envelope.observation,
        prior: JSON.stringify(data.messages.slice(0, source)).includes(prompt) });
      if (envelope.stage) {
        const text = envelope.observation.surface === 'pet' ? '桌宠也在看这段录像。' : '视频会面已经接收到字幕。';
        if (!results.length) tool = { name: 'call_stage', arguments: '{}' };
        else if (results.length === 1) tool = { name: 'call_present', arguments: JSON.stringify({ segments: [{ text, gesture: 'nod' }] }) };
        else { requested.get(name)!.presentation = JSON.stringify(results.at(-1)!.content); content = ''; }
      } else content = '这一幕很有意思。';
    } else if (envelope?.message?.content.startsWith(prompt) && envelope.files?.length) {
      ordinaryFile = envelope.files[0];
      if (!results.length) tool = { name: 'companion_recognize_audio', arguments: JSON.stringify({ attachmentId: envelope.files[0]!.id }) };
      else { ordinaryTranscript = JSON.stringify(results.at(-1)!.content); content = '已转写音频。'; }
    }
    const delta = tool ? { tool_calls: [{ index: 0, id: 'listen-' + crypto.randomUUID(), type: 'function', function: tool }] } : { content };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 2000, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await seedNativeRuntime(manager, runtime!, profile);
    app = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_DSH_SILENT: '1', WORLDLINEBOX_E2E_LOCALE: 'zh-CN', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }) });
    const page = await app.firstWindow();
    expect((await page.evaluate(baseUrl => (Reflect.get(window, 'worldlinebox') as { llm: WorldlineBoxLlmApi }).llm.setConfig({
      apiFormat: 'openai_chat', model: 'presence-fixture', baseUrl, apiKey: 'localhost-only-fixture',
    }), `http://127.0.0.1:${(server.address() as { port: number }).port}`)).ok).toBe(true);
    await page.locator('[data-application-module="companions"]').click();
    const setup = page.locator('[data-shared-dsh-setup]');
    await setup.getByRole('combobox', { name: '选择 DSH 版本' }).selectOption(runtime!.id);
    await setup.getByRole('button', { name: '创建并共享', exact: true }).click();
    await expect(page.getByRole('button', { name: '拨打伙伴电话', exact: true })).toBeEnabled({ timeout: 90_000 });
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, fixture);
    await page.getByRole('button', { name: '添加文件', exact: true }).click();
    await expect(page.getByRole('button', { name: '预览 sensevoice-zh.wav' })).toBeVisible();
    const box = page.getByRole('textbox', { name: '发送消息…', exact: true });
    await box.fill(prompt);
    await page.getByRole('button', { name: '发送 ↑', exact: true }).click();
    await expect(page.getByText('已转写音频。', { exact: true })).toBeVisible({ timeout: 75_000 });
    expect(ordinaryFile).toMatchObject({ audioRecognition: true });
    expect(ordinaryFile).not.toHaveProperty('path');
    expect(ordinaryTranscript).toContain('startSeconds');
    expect(ordinaryTranscript).toMatch(/[九9]点/u);
    const audioCard = page.locator('.bot-attachment').filter({ has: page.getByRole('button', { name: '打开预览 sensevoice-zh.wav', exact: true }) });
    await expect(audioCard.locator('.bot-voice-actions')).toContainText('大窗查看');
    await audioCard.getByRole('button', { name: '转文字', exact: true }).click();
    await expect(audioCard.getByRole('region', { name: '语音转写' })).toContainText(/[九9]点/u, { timeout: 30_000 });
    await audioCard.getByRole('button', { name: '收起文字' }).click();
    await expect(audioCard.getByRole('region', { name: '语音转写' })).toBeHidden();
    await expect(page.getByRole('button', { name: '陪伴设置', exact: true })).toHaveCount(0);
    await playLoopbackFixture(app, fixture);
    await page.getByRole('button', { name: '拨打伙伴电话', exact: true }).click();
    const meeting = page.getByRole('dialog', { name: '与大肥鱼会面', exact: true });
    await meeting.getByRole('button', { name: '接通', exact: true }).click();
    await meeting.getByRole('button', { name: '展开会面输入', exact: true }).click();
    await meeting.getByRole('button', { name: '陪伴设置', exact: true }).click();
    const settings = meeting.getByRole('region', { name: '陪伴设置', exact: true });
    await expect(settings.getByRole('button', { name: '看屏幕', exact: true })).toHaveCount(0);
    await expect(settings.getByRole('checkbox')).toHaveCount(0);
    expect((await settings.boundingBox())!.width).toBeLessThan(245);
    await meeting.getByRole('combobox', { name: '精力值', exact: true }).selectOption('active');
    await meeting.getByRole('button', { name: '开始陪伴', exact: true }).click();
    const status = meeting.locator('.bot-presence-status');
    await expect(status.getByRole('status')).toHaveText('陪伴中');
    const countdown = status.getByLabel('下次心跳');
    await expect(countdown).toHaveText(/00:[23][0-9]/u);
    const initial = await countdown.textContent();
    await expect(countdown).not.toHaveText(initial!);
    await expect(status.getByRole('button', { name: '聊聊此刻' })).toHaveCount(0);
    expect(requested.size).toBe(0);
    await expect(meeting.locator('.bot-call-bubble-text')).toHaveText('视频会面已经接收到字幕。', { timeout: 75_000 });
    const firstSegmentId = await meeting.getByRole('region', { name: '伙伴当前回应' }).getAttribute('data-call-segment');
    await expect.poll(() => [...requested.values()].filter(item => item.presentation).length, { timeout: 85_000 }).toBe(2);
    await expect(countdown).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.bot-transcript').getByText('视频会面已经接收到字幕。', { exact: true })).toHaveCount(1);
    for (const [name, request] of requested) {
      expect(name).toMatch(/\.\d{3}Z_.*\.webm$/u);
      expect(request).toMatchObject({ prior: true, image: true });
      expect(request.presentation).toContain('accepted');
      expect(request.evidence.audio?.subtitles?.join('\n')).toMatch(/\[00:00:\d\d\.\d{3} – 00:00:\d\d\.\d{3}\] \S/u);
      expect(request.evidence.frameSheets?.flat().length).toBeGreaterThanOrEqual(3);
      expect(request.evidence.frameSheets?.every(sheet => sheet.length <= 6)).toBe(true);
      expect(request.evidence.durationSeconds).toBeGreaterThan(20);
      expect(request.evidence.sources.length).toBeGreaterThanOrEqual(2);
      for (const [index, source] of request.evidence.sources.entries()) {
        expect(source.kind).toBe('video');
        expect(path.isAbsolute(source.originalPath)).toBe(true);
        expect((await readFile(source.originalPath)).subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
        if (index) expect(source.from - request.evidence.sources[index - 1]!.to).toBeLessThan(.8);
      }
    }
    expect(rawAudioInRequest).toBe(false);
    await status.getByRole('button', { name: '暂停陪伴' }).click();
    await expect(status.getByRole('status')).toHaveText('陪伴已暂停');
    await expect(countdown).toHaveCount(0);
    await status.getByRole('button', { name: '结束陪伴' }).click();
    await expect(status).toHaveCount(0);
    await meeting.getByRole('button', { name: '陪伴设置', exact: true }).click();
    await settings.getByRole('button', { name: '查看观察缓存' }).click();
    const archive = page.getByRole('dialog', { name: '观察缓存', exact: true });
    await expect(archive.getByText('已归档', { exact: false }).first()).toBeVisible();
    await expect(archive.locator('video')).toBeVisible();
    await expect.poll(() => archive.locator('video').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThan(0);
    await archive.getByRole('button', { name: '清空归档' }).click();
    await expect(archive.getByText('已归档', { exact: false })).toHaveCount(0);
    await expect.poll(() => [...requested.values()].every(item => item.evidence.sources.every(source => !existsSync(source.originalPath)))).toBe(true);
    await archive.getByRole('button', { name: '关闭', exact: true }).click();
    const openPet = app.waitForEvent('window');
    await meeting.getByRole('button', { name: '切换为桌宠', exact: true }).click();
    const pet = await openPet;
    await pet.getByRole('button', { name: '陪伴设置', exact: true }).click();
    await pet.getByRole('combobox', { name: '精力值', exact: true }).selectOption('active');
    await pet.getByRole('button', { name: '开始陪伴', exact: true }).click();
    const petStatus = pet.locator('.bot-call-status-row .bot-presence-status');
    await expect(petStatus.getByLabel('下次心跳')).toBeVisible();
    await expect(pet.locator('.bot-call-bubble-text')).toHaveText('桌宠也在看这段录像。', { timeout: 65_000 });
    expect(await pet.getByRole('region', { name: '伙伴当前回应' }).getAttribute('data-call-segment')).not.toBe(firstSegmentId);
    const petRecording = [...requested.values()].filter(item => item.presentation).at(-1);
    expect(petRecording).toMatchObject({ prior: true, image: true, evidence: { kind: 'video' } });
    expect(petRecording?.evidence.audio?.subtitles?.length).toBeGreaterThan(0);
    await petStatus.getByRole('button', { name: '结束陪伴' }).click();
  } finally {
    await app?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

import { _electron as electron, expect, test, type ElectronApplication, type Locator } from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_MUSIC_PREFERENCES } from '../../src/shared/music';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';
import { MUSIC_CONTROL_CHANNEL, MUSIC_CONTROL_RESULT_CHANNEL, type MusicCommand, type MusicReply, type MusicShare } from '../../src/shared/music';
import { BOT_EVENT_CHANNEL, type WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import { enableCallVisualFixture } from './fixtures/call-visual-binding';

function companionCommand(application: ElectronApplication, input: Omit<MusicCommand, 'id'>): Promise<MusicReply> {
  return application.evaluate(({ BrowserWindow, ipcMain }, { input, channel, result }) => new Promise<MusicReply>((resolve, reject) => {
    const id = process.getBuiltinModule('node:crypto').randomUUID();
    const onReply = (_event: Electron.IpcMainEvent, reply: MusicReply) => {
      if (reply.id === id) { clearTimeout(timer); ipcMain.off(result, onReply); resolve(reply); }
    };
    const timer = setTimeout(() => { ipcMain.off(result, onReply); reject(Error('No music command response')); }, 15_000);
    ipcMain.on(result, onReply);
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('index.html'))!.webContents.send(channel, { id, ...input });
  }), { input, channel: MUSIC_CONTROL_CHANNEL, result: MUSIC_CONTROL_RESULT_CHANNEL });
}

async function publishMusicFixture(application: ElectronApplication, room: string, sender: { id: string; name: string }, card: MusicShare) {
  await application.evaluate(({ app, BrowserWindow }, { room, sender, card, channel }) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const path = process.getBuiltinModule('node:path');
    const db = new DatabaseSync(path.join(app.getPath('userData'), 'companion-bot-v2', 'bot.sqlite'));
    const id = 'reply-' + card.id;
    const body = '一起听这份作品。';
    try {
      db.exec('PRAGMA busy_timeout = 1000; BEGIN IMMEDIATE');
      db.prepare(`INSERT INTO bot_messages(id,event_id,conversation_id,sender_id,sender_name,sender_type,content,status,kind,correlation_id,created_at)
        VALUES(?,?,?,?,?,'companion',?,'sent','message',?,'2026-01-01T00:00:00.000Z')`).run(id,id,room,sender.id,sender.name,body,id);
      const insert = db.prepare('INSERT INTO bot_reply_parts(message_id,event_id,conversation_id,id,sequence,payload_json) VALUES(?,?,?,?,?,?)');
      insert.run(id,id,room,'text',0,JSON.stringify({ id:'text', kind:'text', sequence:0, text:body }));
      insert.run(id,id,room,card.id,1,JSON.stringify({ id:card.id, kind:'music', sequence:1, music:card }));
      db.exec('COMMIT');
    } finally { db.close(); }
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('index.html'))!.webContents.send(channel, { type:'changed', conversationId:room });
  }, { room, sender, card, channel: BOT_EVENT_CHANNEL });
}

// Synthetic PCM audio proves continuity without requesting/recording any copyrighted music.
function silenceWav(seconds = 180) {
  const length=8000*seconds*2;const bytes=Buffer.alloc(44+length);
  bytes.write('RIFF');bytes.writeUInt32LE(length+36,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);
  bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(8000,24);bytes.writeUInt32LE(16000,28);
  bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(length,40);return bytes;
}
const multilingualLyrics = [
  { timeMs: 53000, text:'メロディーが夜の街に響く。ゆっくり歩きながら、遠い灯りを見上げる。',
    translatedText:'旋律在夜晚的街道回响。', direction:'ltr' },
  { timeMs: 54000, text:'밤하늘 아래 우리 함께 천천히 걸어가요.',
    translatedText:'我们一起在夜空下慢慢走。', direction:'ltr' },
  { timeMs: 54500, text:'月色 Moonlight / 夜の空 / 밤하늘',
    translatedText:'同一片夜空。', direction:'ltr', sidewaysRuns:['夜の空', '밤하늘'] },
  { timeMs: 56000, text:'Вечер стих, и далёкие огни снова зажглись.',
    translatedText:'夜色渐静，远处的灯又亮了。', direction:'ltr' },
  { timeMs: 57000, text:'ในค่ำคืนที่เงียบสงบ แสงไฟไกล ๆ ค่อย ๆ สว่างขึ้น',
    translatedText:'静夜里，远处的灯渐渐亮了。', direction:'ltr' },
  { timeMs: 58000, text:'هدأ المساء وأضاءت الأضواء البعيدة من جديد — Pop',
    translatedText:'夜色渐静，远处的灯又亮了。', direction:'rtl' },
  { timeMs: 59000, text:'रात ढली और दूर की रोशनी फिर जल उठी।',
    translatedText:'夜深了，远处的灯再次亮起。', direction:'ltr' },
];

async function installPublicMusicFixture(application: ElectronApplication, defaults: typeof DEFAULT_MUSIC_PREFERENCES) {
  await application.evaluate(({ipcMain,app},{defaults: value, samples})=>{
    // Network projections are a deterministic fixture. Preference saves still use the
    // production MUSIC_SAVE handler and its actual atomic userData file.
    const fs=process.getBuiltinModule('fs');const path=process.getBuiltinModule('path');
    ipcMain.removeHandler('worldlinebox:music');
    ipcMain.handle('worldlinebox:music',async (_event,input:{type:string;playlistId:string;trackId:string})=>{
      if(input.type==='preferences') {
        const file=path.join(app.getPath('userData'),'music-player.json');
        return {ok:true,value:fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):value};
      }
      if(input.type==='catalog') return {ok:true,value:{id:input.playlistId,name:'静谧时光 · 播放验收',coverUrl:'',trackCount:3,tracks:['101','102','103'].map((id,index)=>({id,name:['薄雾与晨光','远处的山','雨后的窗'][index],artists:['Worldline 测试音频'],album:'本地静音 PCM',coverUrl:'',durationMs:180000}))}};
      if(input.type==='stream')return {ok:true,value:{trackId:input.trackId,url:`https://test.music.126.net/${input.trackId}.wav`}};
      if(input.type==='lyrics')return {ok:true,value:{trackId:input.trackId,lines:[
        {timeMs:0,text:'测试歌词 · 开始'},
        {timeMs:10000,text:'测试歌词 · 十秒',translatedText:'A quiet moment'},
        {timeMs:40000,text:'测试歌词 · 四十秒'},
        {timeMs:50000,text:'换行测试 · ' + '晚风吹过，灯光随着旋律亮起来。'.repeat(4),
          translatedText:'Pop Pop, the evening lights begin to glow with the rhythm. '.repeat(3).trim()},
        {timeMs:52000,text:'When it felt like too much and we started to fight',
          translatedText:'当压力袭来，我们开始争吵'},
        {timeMs:55000,text:'竖排测试 · ' + '晚风吹过，灯光随着旋律亮起来。'.repeat(4),
          translatedText:'黄昏落下，街灯依次亮起。'},
        ...samples,
        {timeMs:60000,text:'溢出测试 · ' + '晚风经过窗边'.repeat(300) + ' · 结束'},
      ].sort((a, b) => a.timeMs - b.timeMs)}};
      return {ok:false,error:'Unexpected music fixture operation'};
    });
  },{defaults,samples:multilingualLyrics.map(({timeMs,text,translatedText})=>({timeMs,text,translatedText}))});
}

function captionGeometry(viewport: Locator) {
  return viewport.evaluate(node => {
    const bounds = node.getBoundingClientRect();
    const vertical = getComputedStyle(node).writingMode === 'vertical-rl';
    const boxes = [...node.querySelectorAll('b,small')].map(child => {
      const range = document.createRange();
      range.selectNodeContents(child);
      return [...range.getClientRects()];
    });
    return {
      inside: boxes.flat().every(rect => rect.left >= bounds.left + 4 && rect.right <= bounds.right - 4
        && rect.top >= bounds.top + 4 && rect.bottom <= bounds.bottom - 4),
      wraps: new Set(boxes[0]!.map(rect => vertical ? rect.left : rect.top)).size > 2,
    };
  });
}
// eslint-disable-next-line no-empty-pattern -- Playwright requires this signature even without browser fixtures.
test('music keeps real audio across tabs, renders desktop lyrics, and manages named playlists',async ({})=>{
  test.setTimeout(150000);
  const parent=await realpath(tmpdir());const root=await mkdtemp(path.join(parent,'worldlinebox-music-e2e-'));
  const userData=path.join(root,'user-data');await mkdir(userData);
  let application:ElectronApplication|undefined;
  const launch=async(restoreOnColdStart = false)=>{
    const app=await electron.launch({executablePath:resolveElectronExecutablePath(),args:[resolveElectronAppPath()],env:electronLaunchEnv({WORLDLINEBOX_E2E:'1',WORLDLINEBOX_E2E_DSH_SILENT:'1',WORLDLINEBOX_E2E_USER_DATA_PATH:userData})});
    application=app;
    const page=await app.firstWindow();
    await installPublicMusicFixture(app,DEFAULT_MUSIC_PREFERENCES);
    await app.context().route('https://test.music.126.net/**',route=>{
      const bytes=silenceWav();const range=/bytes=(\d+)-(\d*)/.exec(route.request().headers()['range']??'');
      const start=range?Number(range[1]):0;const end=range&&range[2]?Math.min(Number(range[2]),bytes.length-1):bytes.length-1;
      return route.fulfill({status:range?206:200,contentType:'audio/wav',body:bytes.subarray(start,end+1),headers:{'accept-ranges':'bytes','content-length':String(end-start+1),...(range?{'content-range':`bytes ${start}-${end}/${bytes.length}`}:{})}});
    });
    if (!restoreOnColdStart) {
      await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
      await page.reload();
    }
    const native=await app.browserWindow(page);await native.evaluate(win=>{win.webContents.setBackgroundThrottling(false);win.unmaximize();win.setSize(1440,960);win.hide();});
    await expect.poll(() => native.evaluate(win => win.webContents.executeJavaScript('!!document.querySelector("[data-dsh-launcher]")', false)), { timeout:15_000 }).toBe(true);
    return {app,page};
  };
  try {
    let run=await launch();application=run.app;let page=run.page;
    const native = await application.browserWindow(page);
    expect(await native.evaluate(win => win.webContents.executeJavaScript(`
      [...document.querySelectorAll('button')].find(button => button.textContent.trim() === '伙伴').click();
      navigator.userActivation.hasBeenActive;
    `, false))).toBe(false);
    await expect.poll(() => native.evaluate(win => win.webContents.executeJavaScript(
      '!!document.querySelector(\'button[aria-label="拨打伙伴电话"]\')', false))).toBe(true);
    const initialChat = await native.evaluate(win => win.webContents.executeJavaScript(`
      (async () => {
        const api = window.worldlinebox.companionBot;
        const { snapshot } = await api.request({ type: 'state' });
        const room = snapshot.conversations.find(item => item.kind === 'direct');
        const { id, name } = snapshot.companions.find(item => room.memberIds.includes(item.id));
        const connected = await api.request({ type: 'app.connect', conversationId: room.id, appId: 'music' });
        if (!connected.ok) throw Error(connected.error);
        return { room: room.id, sender: { id, name } };
      })();
    `, false)) as { room: string; sender: { id: string; name: string } };
    const autoCard: MusicShare = { id: 'fresh-auto-card', title: '初次播放', preview: ['雨后的窗'], trackCount: 1, mode: 'once',
      queue: { kind: 'tracks', tracks: [{ playlistId: '18322613388', trackId: '103' }] } };
    const coldStatus = await companionCommand(application, { conversationId: initialChat.room, surface: 'chat',
      control: { action: 'status', target: 'global' } });
    expect(coldStatus).toMatchObject({ ok: true, value: { playlistName: '幻酱的作品集', playing: false } });
    await publishMusicFixture(application, initialChat.room, initialChat.sender, autoCard);
    await expect.poll(() => native.evaluate(win => win.webContents.executeJavaScript(
      '!!document.querySelector(\'button[aria-label="播放 初次播放"]\')', false))).toBe(true);
    const autoPlayback = await companionCommand(application, { conversationId: initialChat.room, surface: 'chat',
      control: { action: 'present', target: 'inline', card: autoCard } });
    expect(autoPlayback, autoPlayback.error).toMatchObject({ ok: true, value: { trackId: '103' } });
    const freshAudio = page.locator('[data-inline-music-audio]');
    await expect.poll(() => native.evaluate(win => win.webContents.executeJavaScript(
      'document.querySelector("[data-inline-music-audio]")?.currentTime ?? 0', false))).toBeGreaterThan(0);
    expect(await native.evaluate(win => win.webContents.executeJavaScript(`({
      global: !!document.querySelector('[data-global-music-audio]'),
      activated: navigator.userActivation.hasBeenActive,
    })`, false))).toEqual({ global: false, activated: false });
    await page.getByRole('button', { name: '启动器', exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    await expect(freshAudio).toHaveCount(0);

    await page.getByRole('button',{name:'设置',exact:true}).click();
    const settings = page.getByRole('dialog', { name: '通用设置' });
    await expect(settings.getByRole('tab', { name: '常规' })).toHaveAttribute('aria-selected', 'true');
    await expect(settings.getByRole('radiogroup', { name: '语言' })).toBeVisible();
    await expect(page.locator('[data-application-view="assets"] .app-shell')).toHaveCount(0);
    await page.getByRole('tab',{name:'音乐',exact:true}).click();
    const panel=page.getByRole('region',{name:'网易云音乐歌单播放器'});
    await expect(panel).toBeVisible();await expect(panel.getByText('薄雾与晨光',{exact:true}).first()).toBeVisible();
    await expect(page.locator('[data-application-view="assets"] .app-shell')).toHaveCount(0);
    await expect.poll(()=>page.locator('[data-global-music-audio]').evaluate((node:HTMLAudioElement)=>node.readyState)).toBeGreaterThanOrEqual(1);
    expect(await page.locator('[data-global-music-audio]').evaluate((node:HTMLAudioElement)=>node.paused)).toBe(true);
    await panel.getByRole('slider',{name:'播放进度'}).press('Home');
    await panel.getByRole('slider',{name:'播放进度'}).press('ArrowRight');
    for(let index=0;index<4;index++)await panel.getByRole('button',{name:'快进 10 秒'}).click();
    await expect.poll(()=>page.locator('[data-global-music-audio]').evaluate((node:HTMLAudioElement)=>node.currentTime)).toBeGreaterThan(37);
    await panel.getByRole('slider',{name:'音量'}).press('Home');
    for(let index=0;index<7;index++)await panel.getByRole('slider',{name:'音量'}).press('ArrowRight');
    await panel.getByRole('button',{name:'播放',exact:true}).click();
    await expect.poll(()=>page.locator('[data-global-music-audio]').evaluate((node:HTMLAudioElement)=>node.paused)).toBe(false);
    const audio=await page.locator('[data-global-music-audio]').elementHandle();
    await page.getByRole('tab',{name:'常规',exact:true}).click();
    await page.getByRole('dialog',{name:'通用设置'}).getByRole('button',{name:'关闭',exact:true}).click();
    await page.getByRole('button',{name:'资产管理',exact:true}).click();
    await page.getByRole('button',{name:'启动器',exact:true}).click();
    const continuity=await audio!.evaluate((node:HTMLAudioElement)=>({connected:node.isConnected,paused:node.paused,time:node.currentTime,src:node.src}));
    expect(continuity).toMatchObject({connected:true,paused:false,time:expect.any(Number)});
    expect(continuity.time,JSON.stringify(continuity)).toBeGreaterThan(37);
    await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'音乐',exact:true}).click();
    await panel.getByRole('button',{name:'暂停',exact:true}).click();
    const openedLyrics = application.waitForEvent('window');
    await panel.getByRole('button',{name:'打开桌面歌词'}).click();
    const lyricPage = await openedLyrics;
    const lyricWindow = await application.browserWindow(lyricPage);
    await expect.poll(() => application!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some(window => window.isAlwaysOnTop() && window.getTitle().includes('桌面歌词')))).toBe(true);
    const overlayControls = lyricPage.getByRole('group', { name:'桌面歌词播放控制' });
    const globalTrack = () => page.locator('[data-global-music-audio]').evaluate((node: HTMLAudioElement) =>
      ({ file:node.src.split('/').at(-1), paused:node.paused }));
    await overlayControls.getByRole('button', { name:'播放', exact:true }).click();
    await expect.poll(globalTrack).toEqual({ file:'101.wav', paused:false });
    await overlayControls.getByRole('button', { name:'暂停', exact:true }).click();
    await expect.poll(globalTrack).toEqual({ file:'101.wav', paused:true });
    await overlayControls.getByRole('button', { name:'下一首' }).click();
    await expect.poll(globalTrack).toEqual({ file:'102.wav', paused:false });
    await overlayControls.getByRole('button', { name:'上一首' }).click();
    await expect.poll(globalTrack).toEqual({ file:'101.wav', paused:false });
    await overlayControls.getByRole('button', { name:'暂停', exact:true }).click();
    await expect.poll(globalTrack).toEqual({ file:'101.wav', paused:true });
    await panel.getByRole('button',{name:'打开滚动歌词'}).click();
    await panel.getByRole('button',{name:'测试歌词 · 四十秒'}).click();
    await expect.poll(() => application!.evaluate(({ BrowserWindow }) => {
      const child = BrowserWindow.getAllWindows().find(window => window.getTitle().includes('桌面歌词'));
      return child?.webContents.executeJavaScript('document.querySelector("b")?.textContent');
    })).toBe('测试歌词 · 四十秒');
    await expect(lyricPage.locator('.card')).toHaveCSS('background-color', 'rgba(225, 231, 241, 0.28)');
    await expect(lyricPage.locator('.card')).toHaveCSS('box-shadow', /inset/);
    const viewport = lyricPage.locator('.caption-viewport');
    await expect.poll(() => captionGeometry(viewport)).toMatchObject({ inside:true });
    const wide = await lyricWindow.evaluate(window => window.getBounds());
    await panel.getByRole('button', { name:/^换行测试/ }).click();
    await expect(viewport.locator('small')).toHaveCSS('writing-mode', 'horizontal-tb');
    await expect.poll(() => captionGeometry(viewport)).toEqual({ inside:true, wraps:true });
    await expect.poll(() => lyricWindow.evaluate(window => window.getBounds().height)).toBeGreaterThan(wide.height);
    await lyricPage.getByLabel('歌词描边颜色').fill('#0088cc');
    await lyricPage.getByLabel('歌词填充颜色').fill('#ffdf91');
    for (const tag of ['b', 'small']) {
      await expect(viewport.locator(tag)).toHaveCSS('color', 'rgb(255, 223, 145)');
      await expect(viewport.locator(tag)).toHaveCSS('-webkit-text-stroke-color', 'rgb(0, 136, 204)');
    }
    await panel.getByRole('button', { name:/^溢出测试/ }).click();
    await expect(viewport).toHaveAttribute('data-scrollable', '');
    expect(await viewport.evaluate(node => {
      node.scrollTop = node.scrollHeight;
      const tail = document.createRange();
      const text = node.querySelector('b')!.firstChild!;
      tail.setStart(text, text.textContent!.length - 2);
      tail.setEndAfter(text);
      return tail.getBoundingClientRect().bottom < node.getBoundingClientRect().bottom;
    })).toBe(true);
    await panel.getByRole('button', { name:/^换行测试/ }).click();
    await lyricPage.getByRole('button', { name:'切换竖排' }).click();
    await expect(lyricPage.locator('.card')).toHaveAttribute('data-orientation', 'vertical');
    await expect(viewport.locator('small')).toHaveCSS('writing-mode', 'vertical-rl');
    await expect(viewport.locator('small')).toHaveCSS('text-orientation', 'sideways');
    await panel.getByRole('button', { name:/^When it felt/ }).click();
    await expect(viewport.locator('b')).toHaveText(/^When it felt/);
    await expect(viewport.locator('b')).toHaveCSS('writing-mode', 'vertical-rl');
    await expect(viewport.locator('b')).toHaveCSS('text-orientation', 'sideways');
    await expect(viewport.locator('small')).toHaveCSS('text-orientation', 'mixed');
    await expect.poll(() => lyricWindow.evaluate(window => {
      const { width, height } = window.getBounds();
      return height > width;
    })).toBe(true);
    await expect.poll(() => captionGeometry(viewport)).toMatchObject({ inside:true });
    for (const sample of multilingualLyrics) {
      await panel.getByRole('button', { name: sample.text }).click();
      await expect(viewport.locator('b')).toHaveText(sample.text);
      await expect(viewport.locator('b')).toHaveCSS('writing-mode', 'vertical-rl');
      await expect(viewport.locator('b')).toHaveCSS('text-orientation', sample.sidewaysRuns ? 'mixed' : 'sideways');
      await expect(viewport.locator('b')).toHaveCSS('direction', sample.direction);
      await expect(viewport.locator('small')).toHaveCSS('text-orientation', 'mixed');
      await expect(viewport.locator('small')).toHaveCSS('direction', 'ltr');
      for (const text of sample.sidewaysRuns ?? []) {
        const run = viewport.locator('b span').filter({ hasText:text });
        await expect(run).toHaveCSS('text-orientation', 'sideways');
      }
      await expect.poll(() => captionGeometry(viewport)).toMatchObject({ inside:true });
    }
    await panel.getByRole('button', { name:/^竖排测试/ }).click();
    await expect(viewport.locator('b')).toHaveCSS('writing-mode', 'vertical-rl');
    await expect(viewport.locator('small')).toHaveCSS('writing-mode', 'vertical-rl');
    await expect.poll(() => lyricWindow.evaluate(window => window.getBounds().height)).toBeGreaterThan(wide.height);
    const size = await lyricPage.locator('b').evaluate(node => parseFloat(getComputedStyle(node).fontSize));
    await lyricPage.getByRole('button', { name:'放大歌词' }).click();
    await expect.poll(() => lyricPage.locator('b').evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBe(size + 2);
    const increaseFont = lyricPage.getByRole('button', { name:'放大歌词' });
    for (let fontSize = size + 2; fontSize < 40; fontSize += 2) await increaseFont.click();
    await expect(increaseFont).toBeDisabled();
    await expect.poll(() => captionGeometry(viewport)).toEqual({ inside:true, wraps:true });
    await panel.getByRole('button', { name:/^溢出测试/ }).click();
    await expect(viewport).toHaveAttribute('data-scrollable', '');
    await viewport.hover();
    await lyricPage.mouse.wheel(0, 144);
    await expect.poll(() => viewport.evaluate(node => node.scrollLeft)).toBeLessThan(0);
    await panel.getByRole('button', { name:'测试歌词 · 四十秒' }).click();
    await expect.poll(() => captionGeometry(viewport)).toMatchObject({ inside:true });
    await lyricWindow.evaluate(window => {
      const setIgnore = window.setIgnoreMouseEvents.bind(window);
      Reflect.set(window, 'testClickThrough', false);
      window.setIgnoreMouseEvents = (ignore: boolean, options?: Electron.IgnoreMouseEventsOptions) => { Reflect.set(window, 'testClickThrough', ignore); setIgnore(ignore, options); };
    });
    await lyricPage.getByRole('button', { name:'锁定桌面歌词' }).click();
    await expect(lyricPage.getByRole('group', { name:'桌面歌词布局' })).toHaveCount(0);
    await expect(overlayControls).toHaveCount(0);
    await expect(lyricPage.locator('.card')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(lyricPage.locator('.card')).toHaveCSS('box-shadow', 'none');
    await expect.poll(() => lyricWindow.evaluate(window => Reflect.get(window, 'testClickThrough'))).toBe(true);
    await lyricPage.getByRole('button', { name:'解锁桌面歌词' }).click();
    await expect.poll(() => lyricWindow.evaluate(window => Reflect.get(window, 'testClickThrough'))).toBe(false);
    const savedBounds = process.platform === 'win32' ? await application.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows().find(child => child.getTitle().includes('桌面歌词'))!;
      const bounds = window.getBounds();
      const { workArea } = screen.getDisplayMatching(bounds);
      window.setPosition(workArea.x + Math.round((workArea.width - bounds.width) / 5),
        workArea.y + Math.round((workArea.height - bounds.height) / 3));
      return window.getBounds();
    }) : undefined;
    if (savedBounds) {
      await expect.poll(async () => {
        const stored = await readFile(path.join(userData, 'desktop-lyrics-bounds.json'), 'utf8').catch(() => undefined);
        return stored && JSON.parse(stored);
      }).toEqual(savedBounds);
    }
    await lyricPage.getByRole('button', { name:'锁定桌面歌词' }).click();
    await expect(lyricPage.locator('.card')).toHaveAttribute('data-locked', 'true');
    await panel.getByRole('button',{name:'返回歌单'}).click();
    const savedPlayer = async () => JSON.parse(await readFile(path.join(userData, 'music-player.json'), 'utf8'));
    await expect.poll(savedPlayer).toMatchObject({ positionSeconds:40, desktopLyricsVisible:true, autoPlay:false });
    await application.close();application=undefined;
    run=await launch(true);application=run.app;page=run.page;
    const restoredLyrics = () => application!.windows().find(candidate => candidate.url() === 'about:blank');
    await expect.poll(async () => restoredLyrics()?.locator('b').textContent({ timeout:500 }).catch(() => null), { timeout:15_000 })
      .toBe('测试歌词 · 四十秒');
    const restoredOverlay = restoredLyrics()!;
    await expect(restoredOverlay.locator('.card')).toHaveAttribute('data-orientation', 'vertical');
    await expect(restoredOverlay.locator('b')).toHaveCSS('font-size', '40px');
    if (savedBounds) {
      const restoredWindow = await application.browserWindow(restoredOverlay);
      await expect.poll(async () => {
        const bounds = await restoredWindow.evaluate(window => window.getBounds());
        const centerOffset = bounds.x + bounds.width / 2 - (savedBounds.x + savedBounds.width / 2);
        const bottomOffset = bounds.y + bounds.height - (savedBounds.y + savedBounds.height);
        return Math.max(Math.abs(centerOffset), Math.abs(bottomOffset));
      }).toBeLessThanOrEqual(2);
    }
    await restoredOverlay.getByRole('button', { name:'解锁桌面歌词' }).click();
    await expect(restoredOverlay.getByLabel('歌词描边颜色')).toHaveValue('#0088cc');
    await expect(restoredOverlay.getByLabel('歌词填充颜色')).toHaveValue('#ffdf91');
    await expect.poll(()=>page.locator('[data-global-music-audio]').evaluate((node:HTMLAudioElement)=>node.currentTime)).toBe(40);
    expect(await page.locator('[data-global-music-audio]').evaluate((node:HTMLAudioElement)=>node.paused)).toBe(true);
    await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'音乐',exact:true}).click();
    await page.getByRole('button', { name:'关闭桌面歌词' }).click();
    await expect.poll(savedPlayer).toMatchObject({ desktopLyricsVisible:false });
    await expect(page.getByRole('slider',{name:'音量'})).toHaveValue('0.35');
    await page.getByRole('button',{name:'播放模式：列表循环'}).click();
    await expect(page.getByRole('button',{name:'播放模式：单曲循环'})).toBeVisible();
    await page.getByText('网易云音乐歌单',{exact:true}).click();
    await page.getByRole('textbox',{name:'歌单名称',exact:true}).fill('工作歌单');await page.getByRole('textbox',{name:'网易云歌单 ID',exact:true}).fill('987654321');
    await page.getByRole('textbox',{name:'歌单简介',exact:true}).fill('适合工作时听的歌');
    await page.getByRole('button',{name:'保存并切换'}).click();
    await expect(page.getByRole('combobox',{name:'切换网易云歌单'})).toHaveValue('987654321');
    await expect(page.getByText('适合工作时听的歌',{exact:true})).toBeVisible();
    await expect(page.getByText('幻酱的作品集',{exact:true}).filter({ visible:true })).toBeVisible();
    await page.getByRole('button',{name:'删除歌单 工作歌单'}).click();
    await expect(page.getByRole('combobox',{name:'切换网易云歌单'})).toHaveValue('18322613388');
    await page.getByRole('dialog',{name:'通用设置'}).getByRole('button',{name:'关闭',exact:true}).click();
    await page.getByRole('button',{name:'伙伴',exact:true}).click();
    await expect(page.getByRole('button', { name:'拨打伙伴电话', exact:true })).toBeDisabled();
    await expect(page.getByRole('button', { name:'播放 初次播放' })).toBeVisible();
    await expect(page.locator('[data-inline-music-audio]')).toHaveCount(0);
    await enableCallVisualFixture(application, page);
    const { room, sender } = await page.evaluate(async () => {
      const result = await (Reflect.get(window, 'worldlinebox') as { companionBot: WorldlineBoxBotApi }).companionBot.request({ type: 'state' });
      const conversation = result.snapshot!.conversations.find(item => item.kind === 'direct')!;
      const companion = result.snapshot!.companions.find(item => conversation.memberIds.includes(item.id))!;
      return { room:conversation.id, sender:{ id:companion.id, name:companion.name } };
    });
    const control = (control: MusicCommand['control']) => companionCommand(application!, { conversationId: room, surface: 'chat', control });
    await page.getByRole('button', { name: '应用', exact: true }).click();
    const apps = page.getByRole('dialog', { name: '连接应用' });
    const appChoices = apps.getByRole('button');
    await expect(appChoices).toHaveCount(5);
    const rows = await appChoices.evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().top));
    expect(new Set(rows).size).toBe(5);
    expect((await apps.boundingBox())!.width).toBeLessThan(180);
    await apps.screenshot({ path: test.info().outputPath('apps-menu.png') });
    await expect(apps.getByRole('button', { name: '音乐', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await apps.press('Escape');
    await expect(page.getByRole('button', { name: '打开对话播放器' })).toHaveCount(0);
    expect(await control({ action:'play', target:'global', trackId:'102' })).toMatchObject({ ok:true, value:{ trackId:'102' } });
    await expect.poll(() => page.locator('[data-global-music-audio]').evaluate((node:HTMLAudioElement) => ({ file:node.src.split('/').at(-1), paused:node.paused }))).toEqual({ file:'102.wav', paused:false });
    const single: MusicShare = { id:'single-work', title:'雨后的窗', mode:'once', trackCount:1, preview:['雨后的窗'],
      queue:{ kind:'tracks', tracks:[{ playlistId:'18322613388', trackId:'103' }] } };
    await publishMusicFixture(application, room, sender, single);
    await expect(page.locator('.bot-message-bubble').filter({ hasText:'一起听这份作品。' }).getByRole('button', { name:'播放 雨后的窗' })).toBeVisible();
    await expect(page.locator('[data-inline-music-audio]')).toHaveCount(0);
    expect(await control({ action:'present', target:'inline', card:single })).toMatchObject({ ok:true, value:{ trackId:'103' } });
    const inline = page.locator('.bot-message-bubble [data-music-card]').getByRole('region', { name:'对话音乐播放器' });
    await expect(inline).toContainText('雨后的窗');
    await expect.poll(() => page.locator('[data-inline-music-audio]').evaluate((node:HTMLAudioElement) => node.paused)).toBe(false);
    expect(await control({ action:'pause', target:'inline' })).toMatchObject({ ok:true });
    await expect.poll(() => page.locator('[data-inline-music-audio]').evaluate((node:HTMLAudioElement) => node.paused)).toBe(true);
    expect(await control({ action:'resume', target:'inline' })).toMatchObject({ ok:true });
    await expect.poll(() => page.locator('[data-inline-music-audio]').evaluate((node:HTMLAudioElement) => node.paused)).toBe(false);
    expect(await control({ action:'lyrics', target:'inline', visible:true })).toMatchObject({ ok:true });
    await expect(inline.getByRole('button', { name:'测试歌词 · 开始' })).toBeVisible();
    expect(await control({ action:'status', target:'global' })).toMatchObject({ ok:true, value:{
      trackId:'102', trackName:'远处的山', playing:true, playlistName:'幻酱的作品集', trackCount:3,
    } });
    expect(await control({ action:'pause', target:'global' })).toMatchObject({ ok:true });
    await expect.poll(() => page.locator('[data-inline-music-audio]').evaluate((node:HTMLAudioElement) => node.paused)).toBe(false);
    await inline.getByRole('button', { name:'关闭对话音乐播放器' }).click();
    const card = { id: 'ordered-works', title: '今晚的作品选集', trackCount: 2, preview: ['雨后的窗', '薄雾与晨光'],
      mode: 'once' as const, queue: { kind: 'tracks' as const, tracks: [{ playlistId: '18322613388', trackId: '103' }, { playlistId: '987654321', trackId: '101' }] } };
    await publishMusicFixture(application, room, sender, card);
    expect(await control({ action:'present', target:'inline', card })).toMatchObject({ ok:true, value:{ trackId:'103', trackCount:2 } });
    await expect(inline).toContainText(card.title);
    const audioInline = page.locator('[data-inline-music-audio]');
    const readTrack = () => audioInline.evaluate((node: HTMLAudioElement) => ({ file:node.src.split('/').at(-1), paused:node.paused }));
    const endTrack = () => audioInline.evaluate((node: HTMLAudioElement) => { node.currentTime = node.duration - 0.1; });
    await expect.poll(readTrack).toEqual({ file: '103.wav', paused: false });
    await page.locator('.bot-message-bubble:has([data-music-card="ordered-works"])')
      .screenshot({ path: test.info().outputPath('inline-player.png'), timeout: 5000 });
    await endTrack();
    await expect.poll(readTrack).toEqual({ file: '101.wav', paused: false });
    await endTrack();
    await expect.poll(readTrack).toEqual({ file: '101.wav', paused: true });
    await page.getByRole('button', { name:'启动器', exact:true }).click();
    await page.getByRole('button', { name:'伙伴', exact:true }).click();
    await expect(audioInline).toHaveCount(0);
    await expect(page.getByRole('button', { name:'拨打伙伴电话', exact:true })).toBeDisabled();
    await enableCallVisualFixture(application, page);
    await page.getByRole('button', { name:'播放 今晚的作品选集' }).click({ timeout: 5000 });
    await expect.poll(readTrack).toEqual({ file: '103.wav', paused: false });
    await page.getByRole('button', { name:'拨打伙伴电话', exact:true }).click();
    const meeting = page.locator('.bot-call-window');
    await meeting.getByRole('button', { name:'接通', exact:true }).click();
    await expect(meeting).toHaveClass(/is-connected/u);
    const callCard: MusicShare = { ...single, id:'meeting-work', title:'远处的山', preview:['远处的山'],
      queue:{ kind:'tracks', tracks:[{ playlistId:'18322613388', trackId:'102' }] } };
    await publishMusicFixture(application, room, sender, callCard);
    const callPlayback = await control({ action:'present', target:'inline', card:callCard });
    expect(callPlayback, callPlayback.error).toMatchObject({ ok:true, value:{ trackId:'102' } });
    const callPlayer = page.locator('.bot-main [data-music-card="meeting-work"]').getByRole('region', { name:'对话音乐播放器' });
    await expect(callPlayer).toContainText('远处的山');
    await expect(meeting.locator('[data-music-card]')).toHaveCount(0);
    const lyricsOpening = application.waitForEvent('window');
    expect(await control({ action:'lyrics', target:'global', visible:true })).toMatchObject({ ok:true });
    const commandOverlay = await lyricsOpening;
    if (process.platform === 'win32') {
      const petOpening = application.waitForEvent('window');
      await meeting.getByRole('button', { name:'切换为桌宠' }).click();
      const petPage = await petOpening;
      await expect(petPage.locator('[data-music-card]')).toHaveCount(0);
      await callPlayer.getByRole('button', { name:'暂停', exact:true }).click();
      await expect.poll(readTrack).toEqual({ file:'102.wav', paused:true });
    }
    await expect.poll(() => application!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some(window => window.isAlwaysOnTop() && window.getTitle().includes('桌面歌词')))).toBe(true);
    await commandOverlay.getByRole('button', { name:'关闭桌面歌词' }).click();
    await expect.poll(savedPlayer).toMatchObject({ desktopLyricsVisible:false });
    await application.close();application=undefined;
    run=await launch();application=run.app;page=run.page;
    await expect(page.locator('[data-global-music-audio]')).toHaveCount(0);
    expect(restoredLyrics()).toBeUndefined();
    await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'音乐',exact:true}).click();
    await expect(page.getByRole('button', { name:'打开桌面歌词' })).toBeVisible();
  } finally {
    await application?.close().catch(()=>undefined);
    await removeProfile(root,parent);
  }
});
async function removeProfile(root:string,parent:string) {
  const resolved=await realpath(root);if(path.dirname(resolved)!==parent||!path.basename(resolved).startsWith('worldlinebox-music-e2e-'))throw new Error('Unexpected music profile');
  await rm(resolved,{recursive:true,force:true,maxRetries:6,retryDelay:150});
}

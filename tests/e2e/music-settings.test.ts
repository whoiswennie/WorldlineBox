import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
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
async function installPublicMusicFixture(application: ElectronApplication, defaults: typeof DEFAULT_MUSIC_PREFERENCES) {
  await application.evaluate(({ipcMain,app},value)=>{
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
      if(input.type==='lyrics')return {ok:true,value:{trackId:input.trackId,lines:[{timeMs:0,text:'测试歌词 · 开始'},{timeMs:10000,text:'测试歌词 · 十秒',translatedText:'A quiet moment'},{timeMs:40000,text:'测试歌词 · 四十秒'}]}};
      return {ok:false,error:'Unexpected music fixture operation'};
    });
  },defaults);
}
// eslint-disable-next-line no-empty-pattern -- Playwright requires this signature even without browser fixtures.
test('music keeps real audio across tabs, renders desktop lyrics, and manages named playlists',async ({})=>{
  test.setTimeout(150000);
  const parent=await realpath(tmpdir());const root=await mkdtemp(path.join(parent,'worldlinebox-music-e2e-'));
  const userData=path.join(root,'user-data');await mkdir(userData);
  let application:ElectronApplication|undefined;
  const launch=async()=>{
    const app=await electron.launch({executablePath:resolveElectronExecutablePath(),args:[resolveElectronAppPath()],env:electronLaunchEnv({WORLDLINEBOX_E2E:'1',WORLDLINEBOX_E2E_DSH_SILENT:'1',WORLDLINEBOX_E2E_USER_DATA_PATH:userData})});
    application=app;
    const page=await app.firstWindow();
    await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    await installPublicMusicFixture(app,DEFAULT_MUSIC_PREFERENCES);
    await app.context().route('https://test.music.126.net/**',route=>{
      const bytes=silenceWav();const range=/bytes=(\d+)-(\d*)/.exec(route.request().headers()['range']??'');
      const start=range?Number(range[1]):0;const end=range&&range[2]?Math.min(Number(range[2]),bytes.length-1):bytes.length-1;
      return route.fulfill({status:range?206:200,contentType:'audio/wav',body:bytes.subarray(start,end+1),headers:{'accept-ranges':'bytes','content-length':String(end-start+1),...(range?{'content-range':`bytes ${start}-${end}/${bytes.length}`}:{})}});
    });
    await page.reload(); const native=await app.browserWindow(page);await native.evaluate(win=>{win.webContents.setBackgroundThrottling(false);win.unmaximize();win.setSize(1440,960);win.hide();});
    await expect.poll(() => native.evaluate(win => win.webContents.executeJavaScript('!!document.querySelector("[data-dsh-launcher]")', false))).toBe(true);
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
        const { snapshot } = await window.worldlinebox.companionBot.request({ type: 'state' });
        const room = snapshot.conversations.find(item => item.kind === 'direct');
        const { id, name } = snapshot.companions.find(item => room.memberIds.includes(item.id));
        return { room: room.id, sender: { id, name } };
      })();
    `, false)) as { room: string; sender: { id: string; name: string } };
    const autoCard: MusicShare = { id: 'fresh-auto-card', title: '初次播放', preview: ['雨后的窗'], trackCount: 1, mode: 'once',
      queue: { kind: 'tracks', tracks: [{ playlistId: '18322613388', trackId: '103' }] } };
    const coldStatus = await companionCommand(application, { conversationId: initialChat.room, surface: 'chat',
      control: { action: 'status', target: 'global' } });
    expect(coldStatus).toMatchObject({ ok: true, value: { playlistName: '幻酱的作品集', playing: false } });
    await publishMusicFixture(application, initialChat.room, initialChat.sender, autoCard);
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
    await panel.getByRole('button',{name:'打开滚动歌词'}).click();
    await panel.getByRole('button',{name:'测试歌词 · 四十秒'}).click();
    await expect.poll(() => application!.evaluate(({ BrowserWindow }) => {
      const child = BrowserWindow.getAllWindows().find(window => window.getTitle().includes('桌面歌词'));
      return child?.webContents.executeJavaScript('document.querySelector("b")?.textContent');
    })).toBe('测试歌词 · 四十秒');
    expect(await lyricPage.locator('.card').evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    const wide = await lyricWindow.evaluate(window => window.getBounds());
    await lyricPage.getByRole('button', { name:'切换竖排' }).click();
    await expect(lyricPage.locator('.card')).toHaveAttribute('data-orientation', 'vertical');
    await expect.poll(() => lyricWindow.evaluate(window => window.getBounds().height)).toBeGreaterThan(wide.height);
    const size = await lyricPage.locator('b').evaluate(node => parseFloat(getComputedStyle(node).fontSize));
    await lyricPage.getByRole('button', { name:'放大歌词' }).click();
    await expect.poll(() => lyricPage.locator('b').evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBe(size + 2);
    await lyricWindow.evaluate(window => {
      const setIgnore = window.setIgnoreMouseEvents.bind(window);
      Reflect.set(window, 'testClickThrough', false);
      window.setIgnoreMouseEvents = (ignore: boolean, options?: Electron.IgnoreMouseEventsOptions) => { Reflect.set(window, 'testClickThrough', ignore); setIgnore(ignore, options); };
    });
    await lyricPage.getByRole('button', { name:'锁定桌面歌词' }).click();
    await expect(lyricPage.getByRole('group', { name:'桌面歌词布局' })).toHaveCount(0);
    await expect.poll(() => lyricWindow.evaluate(window => Reflect.get(window, 'testClickThrough'))).toBe(true);
    await lyricPage.getByRole('button', { name:'解锁桌面歌词' }).click();
    await expect.poll(() => lyricWindow.evaluate(window => Reflect.get(window, 'testClickThrough'))).toBe(false);
    await panel.getByRole('button',{name:'关闭桌面歌词'}).click();
    await panel.getByRole('button',{name:'返回歌单'}).click();
    await expect.poll(async ()=>JSON.parse(await readFile(path.join(userData,'music-player.json'),'utf8')).positionSeconds).toBe(40);
    await application.close();application=undefined;
    run=await launch();application=run.app;page=run.page;
    await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'音乐',exact:true}).click();
    await expect.poll(()=>page.locator('[data-global-music-audio]').evaluate((node:HTMLAudioElement)=>node.currentTime)).toBe(40);
    expect(await page.locator('[data-global-music-audio]').evaluate((node:HTMLAudioElement)=>node.paused)).toBe(true);
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
    await expect(appChoices).toHaveCount(4);
    const rows = await appChoices.evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().top));
    expect(new Set(rows).size).toBe(4);
    expect((await apps.boundingBox())!.width).toBeLessThan(180);
    await apps.screenshot({ path: test.info().outputPath('apps-menu.png') });
    await apps.getByRole('button', { name: '音乐', exact: true }).click();
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
    const controlCall = (control: MusicCommand['control']) => companionCommand(application!, { conversationId: room, surface: 'call', control });
    const callCard: MusicShare = { ...single, id:'meeting-work', title:'远处的山', preview:['远处的山'],
      queue:{ kind:'tracks', tracks:[{ playlistId:'18322613388', trackId:'102' }] } };
    await publishMusicFixture(application, room, sender, callCard);
    const callPlayback = await controlCall({ action:'present', target:'inline', card:callCard });
    expect(callPlayback, callPlayback.error).toMatchObject({ ok:true, value:{ trackId:'102' } });
    await expect(meeting.locator('.bot-message-bubble [data-music-card="meeting-work"]').getByRole('region', { name:'对话音乐播放器' })).toContainText('远处的山');
    const lyricsOpening = application.waitForEvent('window');
    expect(await control({ action:'lyrics', target:'global', visible:true })).toMatchObject({ ok:true });
    await lyricsOpening;
    if (process.platform === 'win32') {
      const petOpening = application.waitForEvent('window');
      await meeting.getByRole('button', { name:'切换为桌宠' }).click();
      const petPage = await petOpening;
      const petPlayer = petPage.locator('.bot-message-bubble [data-music-card="meeting-work"]').getByRole('region', { name:'对话音乐播放器' });
      await expect(petPlayer).toContainText('远处的山');
      await petPlayer.getByRole('button', { name:'暂停', exact:true }).click();
      await expect.poll(readTrack).toEqual({ file:'102.wav', paused:true });
    }
    await expect.poll(() => application!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some(window => window.isAlwaysOnTop() && window.getTitle().includes('桌面歌词')))).toBe(true);
  } finally {
    await application?.close().catch(()=>undefined);
    await removeProfile(root,parent);
  }
});
async function removeProfile(root:string,parent:string) {
  const resolved=await realpath(root);if(path.dirname(resolved)!==parent||!path.basename(resolved).startsWith('worldlinebox-music-e2e-'))throw new Error('Unexpected music profile');
  await rm(resolved,{recursive:true,force:true,maxRetries:6,retryDelay:150});
}

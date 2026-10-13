import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_MUSIC_PREFERENCES } from '../../src/shared/music';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

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
test('music lives only in Settings, keeps real audio across tabs, and restores persisted progress paused after restart',async ({})=>{
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
    await page.route('https://test.music.126.net/**',route=>{
      const bytes=silenceWav();const range=/bytes=(\d+)-(\d*)/.exec(route.request().headers()['range']??'');
      const start=range?Number(range[1]):0;const end=range&&range[2]?Math.min(Number(range[2]),bytes.length-1):bytes.length-1;
      return route.fulfill({status:range?206:200,contentType:'audio/wav',body:bytes.subarray(start,end+1),headers:{'accept-ranges':'bytes','content-length':String(end-start+1),...(range?{'content-range':`bytes ${start}-${end}/${bytes.length}`}:{})}});
    });
    await page.reload(); const native=await app.browserWindow(page);await native.evaluate(win=>{win.webContents.setBackgroundThrottling(false);win.unmaximize();win.setSize(1440,960);win.hide();});
    await expect(page.locator('[data-dsh-launcher]')).toBeVisible();return {app,page};
  };
  try {
    let run=await launch();application=run.app;let page=run.page;
    expect(await page.locator('[data-global-music-audio]').count()).toBe(1);
    await page.getByRole('button',{name:'设置',exact:true}).click();
    await page.getByRole('tab',{name:'音乐',exact:true}).click();
    const panel=page.getByRole('region',{name:'网易云音乐歌单播放器'});
    await expect(panel).toBeVisible();await expect(panel.getByText('薄雾与晨光',{exact:true}).first()).toBeVisible();
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
    await panel.getByRole('button',{name:'打开滚动歌词'}).click();
    await panel.getByRole('button',{name:'测试歌词 · 四十秒'}).click();
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
    await page.getByRole('button',{name:'保存并切换'}).click();
    await expect(page.getByRole('combobox',{name:'切换网易云歌单'})).toHaveValue('987654321');
    await page.getByRole('button',{name:'删除歌单 工作歌单'}).click();
    await expect(page.getByRole('combobox',{name:'切换网易云歌单'})).toHaveValue('18322613388');
  } finally {
    await application?.close().catch(()=>undefined);
    await removeProfile(root,parent);
  }
});
async function removeProfile(root:string,parent:string) {
  const resolved=await realpath(root);if(path.dirname(resolved)!==parent||!path.basename(resolved).startsWith('worldlinebox-music-e2e-'))throw new Error('Unexpected music profile');
  await rm(resolved,{recursive:true,force:true,maxRetries:6,retryDelay:150});
}

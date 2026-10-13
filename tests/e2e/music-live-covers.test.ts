import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { WorldlineBoxMusicApi } from '../../src/shared/music';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';

test('official default playlist returns and renders real playlist and album covers without fixture metadata', async () => {
  test.setTimeout(130000);
  const parent=await realpath(tmpdir());const root=await mkdtemp(path.join(parent,'worldlinebox-music-live-'));const userData=path.join(root,'user-data');await mkdir(userData);
  const application=await electron.launch({executablePath:resolveElectronExecutablePath(),args:[resolveElectronAppPath()],env:electronLaunchEnv({WORLDLINEBOX_E2E:'1',WORLDLINEBOX_E2E_DSH_SILENT:'1',WORLDLINEBOX_E2E_USER_DATA_PATH:userData})});
  try {
    const page=await application.firstWindow();await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    const native=await application.browserWindow(page);await native.evaluate(win=>{win.webContents.setBackgroundThrottling(false);win.unmaximize();win.setSize(1440,1080);win.hide();});
    await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'音乐',exact:true}).click();
    const catalog=await page.evaluate(()=> (window as Window&{worldlinebox?:{music:WorldlineBoxMusicApi}}).worldlinebox!.music.catalog('18322613388'));
    expect(catalog.tracks.length).toBeGreaterThan(10);expect(catalog.coverUrl).toMatch(/^https:\/\/p\d+\.music\.126\.net\//);
    const playlist=page.locator('[data-music-cover="playlist"] img');const album=page.locator('[data-music-cover="current-track"] img');
    await expect(playlist).toHaveAttribute('src',catalog.coverUrl);
    await expect.poll(()=>playlist.evaluate((node:HTMLImageElement)=>node.complete&&node.naturalWidth>0),{timeout:30000}).toBe(true);
    await expect.poll(()=>album.evaluate((node:HTMLImageElement)=>node.complete&&node.naturalWidth>0),{timeout:30000}).toBe(true);
    const albumSource=await album.getAttribute('src');expect(catalog.tracks.some(track=>track.coverUrl===albumSource)).toBe(true);
    let publicStream: string | undefined;
    for (const track of catalog.tracks.slice(0,10)) {
      try { const stream=await page.evaluate(({playlistId,trackId}) => (window as Window&{worldlinebox?:{music:WorldlineBoxMusicApi}}).worldlinebox!.music.stream(playlistId,trackId),{playlistId:catalog.id,trackId:track.id}); publicStream=stream.url;break; }
      catch { /* Some songs are restricted; try the next public item. */ }
    }
    expect(publicStream).toMatch(/^https:\/\/[^/]+\.music\.126\.net\//);
    await expect(page.getByRole('button',{name:'播放',exact:true})).toBeEnabled({timeout:30000});
    expect(await page.locator('[data-global-music-audio]').evaluate((node:HTMLAudioElement)=>node.paused)).toBe(true);
    await page.locator('[data-global-music-audio]').evaluate((node:HTMLAudioElement)=>{node.muted=true;});
    await page.getByRole('button',{name:'播放',exact:true}).click();
    await expect.poll(()=>page.locator('[data-global-music-audio]').evaluate((node:HTMLAudioElement)=>!node.paused&&node.currentTime>0.25),{timeout:30000}).toBe(true);
    await page.getByRole('button',{name:'暂停',exact:true}).click();
    await page.locator('[data-global-music-audio]').evaluate((node:HTMLAudioElement)=>{node.muted=false;});
    const screenshot=path.resolve('artifacts/dsh-launcher/music-settings-live-covers.png');await mkdir(path.dirname(screenshot),{recursive:true});
    await writeFile(path.resolve('.tools/dsh-research/music-live-receipt.json'),JSON.stringify({fixture:false,playlistId:catalog.id,name:catalog.name,trackCount:catalog.tracks.length,playlistCover:catalog.coverUrl,albumCover:albumSource,publicStream,realPublicPlayback:true,playlistNaturalWidth:await playlist.evaluate((node:HTMLImageElement)=>node.naturalWidth),albumNaturalWidth:await album.evaluate((node:HTMLImageElement)=>node.naturalWidth),paused:true,screenshot},null,2));
    await native.evaluate(win=>win.showInactive());
    try { await page.screenshot({path:screenshot}); } finally { await native.evaluate(win=>win.hide()); }
  } finally { await application.close();await cleanup(root,parent); }
});
async function cleanup(root:string,parent:string) {
  const resolved=await realpath(root);if(path.dirname(resolved)!==parent||!path.basename(resolved).startsWith('worldlinebox-music-live-'))throw new Error('Unexpected live music profile');
  await rm(resolved,{recursive:true,force:true,maxRetries:6,retryDelay:150});
}

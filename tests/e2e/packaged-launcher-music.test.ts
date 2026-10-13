import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { WorldlineBoxMusicApi } from '../../src/shared/music';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { electronLaunchEnv } from './electron-test-helpers';

test('packaged EXE starts with the global model and persistent music settings', async () => {
  test.setTimeout(90000);
  const parent=await realpath(tmpdir());const root=await mkdtemp(path.join(parent,'worldlinebox-packaged-music-'));
  const application=await electron.launch({executablePath:path.resolve('out/WorldlineBox-win32-x64/WorldlineBox.exe'),args:[],env:electronLaunchEnv({WORLDLINEBOX_E2E:'1',WORLDLINEBOX_E2E_DSH_SILENT:'1',WORLDLINEBOX_E2E_USER_DATA_PATH:path.join(root,'user-data')})});
  try {
    const page=await application.firstWindow();await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    const native=await application.browserWindow(page);await native.evaluate(win=>{win.webContents.setBackgroundThrottling(false);win.hide();});
    const state=await page.evaluate(async()=>{
      const api=(window as Window&{worldlinebox?:{music:WorldlineBoxMusicApi;llm:WorldlineBoxLlmApi}}).worldlinebox!;
      return {music:await api.music.preferences(),llm:await api.llm.getConfig()};
    });
    expect(state.music).toMatchObject({playlistId:'18322613388',autoPlay:false});
    expect(state.llm.ok).toBe(true);
    if(state.llm.ok)expect(state.llm.value).toMatchObject({apiFormat:'openai_chat',model:'deepseek-flash',baseUrl:'https://api.deepseek.com'});
    await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'音乐',exact:true}).click();
    await expect(page.locator('[data-music-settings-slot]')).toBeVisible();
    await expect(page.locator('[data-global-music-audio]')).toHaveCount(1);
    expect(await page.locator('[data-global-music-audio]').evaluate((node:HTMLAudioElement)=>node.paused)).toBe(true);
  } finally {await application.close();await cleanup(root,parent);}
});
async function cleanup(root:string,parent:string) {
  const resolved=await realpath(root);if(path.dirname(resolved)!==parent||!path.basename(resolved).startsWith('worldlinebox-packaged-music-'))throw new Error('Unexpected packaged music profile');
  await rm(resolved,{recursive:true,force:true,maxRetries:6,retryDelay:150});
}

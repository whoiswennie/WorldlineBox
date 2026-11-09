import {mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {_electron as electron,expect,test} from '@playwright/test';
import type {WorldlineBoxBotApi} from '../../src/shared/companion-bot';
import {electronLaunchEnv,resolveElectronLaunchOptions} from './electron-test-helpers';
// eslint-disable-next-line no-empty-pattern -- Reads the actual persisted real-model acceptance through production UI and IPC.
test('renders compact progress and reconnectable topic links from the actual collaborative project',async({},testInfo)=>{
  test.skip(process.env.WORLDLINEBOX_BOT_TOPICS_UI_VERIFY!=='1','Requires the passed real-topic acceptance profile. Does not submit new user tasks.');test.setTimeout(120000);
  const evidence=path.resolve('artifacts/companion-topic-real'),report=JSON.parse(await readFile(path.join(evidence,'result.json'),'utf8'));
  if(!report.passed||path.dirname(path.resolve(report.profile))!==path.resolve(tmpdir())||!path.basename(report.profile).startsWith('wlb-project-real-'))throw Error('Requires the passed, owned real-test profile.');
  const app=await electron.launch({...resolveElectronLaunchOptions(),env:electronLaunchEnv({WORLDLINEBOX_E2E:'1',WORLDLINEBOX_E2E_USER_DATA_PATH:report.profile,WORLDLINEBOX_E2E_LOCALE:'zh-CN',WORLDLINEBOX_E2E_PERF_OFFSCREEN:'1'})});
  try{
    const page=await app.firstWindow();await expect(page.locator('[data-application-module="companions"]')).toBeVisible();
    await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0]!;win.setMinimumSize(0,0);win.setSize(1680,1040);win.webContents.setBackgroundThrottling(false);});
    await page.locator('[data-application-module="companions"]').click();
    const state=await page.evaluate(()=>(Reflect.get(window,'worldlinebox') as {companionBot:WorldlineBoxBotApi}).companionBot.request({type:'state'}));
    const room=state.snapshot!.conversations.find(room=>room.id===report.groupId)!;await page.locator('.bot-sidebar .bot-conversation').filter({hasText:room.title}).first().click();
    await expect(page.locator('.bot-message-topic').first()).toBeVisible();
    await page.locator('.bot-message-topic').filter({hasText:report.originalTopic.title}).first().click();await expect(page.locator('.bot-topic-current')).toContainText(report.originalTopic.title);
    const bubbles=page.locator('.bot-execution-toggle');expect(await bubbles.count()).toBeGreaterThan(5);
    for(const bubble of await bubbles.all())await expect(bubble).toHaveAttribute('aria-expanded','false');
    const capture=async(name:string)=>{await mkdir(evidence,{recursive:true});const file=path.join(evidence,name+'.png');await page.screenshot({path:file,fullPage:true});await testInfo.attach(name,{path:file,contentType:'image/png'});};
    await page.locator('[data-bot-message]').last().scrollIntoViewIfNeeded();await capture('topic-links-latest-ui');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.setSize(1200,850));
    expect(await page.locator('.bot-main').evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);await capture('topic-links-narrow-ui');
    await page.locator('.bot-topic-current').click();await page.getByLabel('搜索话题',{exact:true}).fill('SIDE_');await expect(page.locator('.bot-topic-list')).toContainText('SIDE_');await capture('topic-picker-narrow-ui');
  }finally{await app.close();}
});

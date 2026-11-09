import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import { electronLaunchEnv, resolveElectronLaunchOptions } from './electron-test-helpers';

// eslint-disable-next-line no-empty-pattern -- Electron owns the tested window.
test('profile clears only WorldlineBox companion history and VCP memory through the native background cleanup',async({},testInfo)=>{
  test.setTimeout(90000);
  const profile=await mkdtemp(path.join(tmpdir(),'wlb-clear-ui-'));
  if(path.dirname(profile)!==tmpdir()||!path.basename(profile).startsWith('wlb-clear-ui-'))throw Error('Unexpected cleanup fixture root');
  const app=await electron.launch({...resolveElectronLaunchOptions(),env:electronLaunchEnv({...process.env,WORLDLINEBOX_E2E:'1',WORLDLINEBOX_E2E_USER_DATA_PATH:profile,WORLDLINEBOX_E2E_LOCALE:'zh-CN'})});
  try{
    const page=await app.firstWindow();await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
    await page.getByRole('button',{name:'稍后设置',exact:true}).click();
    const fixture=await page.evaluate(async()=>{
      const api=(Reflect.get(window,'worldlinebox') as {companionBot:WorldlineBoxBotApi}).companionBot;
      const response=await api.request({type:'state'}),room=response.snapshot!.conversations[0]!;
      return {roomId:room.id,companionId:room.memberIds.find(id=>id!=='user')!};
    });
    const memoryHome=await app.evaluate(async({app},input)=>{
      const path=process.getBuiltinModule('node:path'),fs=process.getBuiltinModule('node:fs/promises'),{createHash}=process.getBuiltinModule('node:crypto');
      if(path.resolve(app.getPath('userData'))!==path.resolve(input.profile))throw Error('Must use the isolated fixture profile');
      const require=process.getBuiltinModule('node:module').createRequire(path.join(app.getAppPath(),'package.json'));
      const Database=require('better-sqlite3') as {new(file:string):{prepare(sql:string):{run(...values:unknown[]):void;get(...values:unknown[]):unknown};close():void}};
      const root=path.join(input.profile,'companion-bot-v2'),db=new Database(path.join(root,'bot.sqlite'));
      let domain:string;
      try{
        domain=(db.prepare('SELECT domain_id FROM bot_conversations WHERE id=?').get(input.roomId) as {domain_id:string}).domain_id;
        db.prepare("INSERT INTO bot_messages(id,event_id,conversation_id,sender_id,sender_name,sender_type,content,status,kind,correlation_id,created_at) VALUES('clear-ui','clear-event',?,'user','User','user','应被清空的旧聊天','sent','message','cleanup-ui',?)").run(input.roomId,new Date().toISOString());
      }finally{db.close();}
      const scope={companionId:input.companionId,conversationId:input.roomId,securityDomainId:domain};
      const memoryHome=path.join(root,'memory',createHash('sha256').update(JSON.stringify([scope.companionId,scope.securityDomainId])).digest('hex'));
      await fs.mkdir(memoryHome,{recursive:true});await fs.writeFile(path.join(memoryHome,'worldlinebox-scope.json'),JSON.stringify(scope));await fs.writeFile(path.join(memoryHome,'old-diary.txt'),'应被清空的日记');
      await fs.mkdir(path.join(root,'workspaces','keep-dsh'),{recursive:true});await fs.writeFile(path.join(root,'workspaces','keep-dsh','KEEP.txt'),'DSH_WORKSPACE');
      return memoryHome;
    },{...fixture,profile});
    await page.reload();await page.locator('[data-application-module="companions"]').click();
    await page.getByRole('button',{name:'稍后设置',exact:true}).click();
    await expect(page.locator('.bot-transcript')).toContainText('应被清空的旧聊天');
    await page.getByRole('button',{name:'角色卡',exact:true}).click();
    const card=page.getByRole('dialog',{name:'角色卡'});await card.getByRole('button',{name:'基本资料',exact:true}).click();
    await card.getByRole('button',{name:'清空聊天与记忆',exact:true}).click();
    await expect(card.locator('.bot-data-clear-confirm')).toContainText('此操作无法撤销');
    const evidence=path.resolve('artifacts/companion-cleanup/ui');await mkdir(evidence,{recursive:true});
    await page.screenshot({path:path.join(evidence,'profile-clear-confirm.png')});
    await card.getByRole('button',{name:'取消',exact:true}).click();
    await expect(page.locator('.bot-transcript')).toContainText('应被清空的旧聊天');
    await card.getByRole('button',{name:'清空聊天与记忆',exact:true}).click();
    await card.getByRole('button',{name:'确认清空聊天与记忆',exact:true}).click();
    await expect(card.locator('.bot-data-clear-complete')).toHaveText('聊天、日记与记忆已清空',{timeout:30000});
    await expect(page.locator('.bot-transcript .bot-message')).toHaveCount(0);
    await expect(card.getByLabel('名字',{exact:true})).toHaveValue('大肥鱼');
    await expect(readFile(path.join(memoryHome,'old-diary.txt'))).rejects.toMatchObject({code:'ENOENT'});
    expect(await readFile(path.join(profile,'companion-bot-v2','workspaces','keep-dsh','KEEP.txt'),'utf8')).toBe('DSH_WORKSPACE');
    await page.screenshot({path:path.join(evidence,'profile-clear-complete.png')});
    await testInfo.attach('clear-complete',{path:path.join(evidence,'profile-clear-complete.png'),contentType:'image/png'});
    await card.getByRole('button',{name:'关闭',exact:true}).first().click();
    await expect(page.locator('.bot-error[role=alert]')).toHaveCount(0);
    await page.reload();await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('.bot-transcript .bot-message')).toHaveCount(0);
  }finally{await app.close();await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
});

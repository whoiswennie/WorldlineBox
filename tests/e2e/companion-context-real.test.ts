import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {_electron as electron,expect,test,type Page} from '@playwright/test';
import type {BotRequest,WorldlineBoxBotApi} from '../../src/shared/companion-bot';
import type {BotNativeTopic} from '../../src/shared/companion-bot-topics';
import type {BotNativeContext} from '../../src/shared/companion-native-context';
import {botContextOccupancy} from '../../src/shared/companion-native-context';
import type {WorldlineBoxDshLauncherApi} from '../../src/shared/dsh-launcher';
import {electronLaunchEnv,resolveElectronLaunchOptions} from './electron-test-helpers';

// eslint-disable-next-line no-empty-pattern -- Actual configured model and production IPC, never fabricated context readings.
test('independent native topic meters survive rapid switching, follow-ups and native compaction',async({},testInfo)=>{
  test.skip(process.env.WORLDLINEBOX_BOT_CONTEXT_REAL!=='1','Requires the owned real-model profile and the organizer acceptance fixture.');test.setTimeout(900000);
  const prior=JSON.parse(await readFile(path.resolve('artifacts/companion-topic-organizer-real/result.json'),'utf8')) as {passed:boolean;profile:string;topicId:string;roomId:string;mainSession:string;coldRename:{title:string}};
  const profile=path.resolve(process.env.WORLDLINEBOX_BOT_PROJECT_PROFILE??prior.profile);
  if(!prior.passed||profile!==path.resolve(prior.profile)||path.dirname(profile)!==path.resolve(tmpdir())||!path.basename(profile).startsWith('wlb-project-real-'))throw Error('Requires the owned isolated real-test profile.');
  const evidence=path.resolve('artifacts/companion-context-real');await mkdir(evidence,{recursive:true});
  const report:Record<string,unknown>={profile,realModel:true,nativeDsh:true,productionIpc:true,stages:[]};
  const app=await electron.launch({...resolveElectronLaunchOptions(),env:electronLaunchEnv({WORLDLINEBOX_E2E:'1',WORLDLINEBOX_E2E_USER_DATA_PATH:profile,WORLDLINEBOX_E2E_LOCALE:'zh-CN',WORLDLINEBOX_E2E_PERF_OFFSCREEN:'1',WORLDLINEBOX_E2E_DSH_SILENT:'1'})});
  const page=await app.firstWindow(),roomId=prior.roomId,companionId='builtin-dafeiyu';
  const request=(input:BotRequest)=>page.evaluate(input=>(Reflect.get(window,'worldlinebox') as {companionBot:WorldlineBoxBotApi}).companionBot.request(input),input);
  const state=()=>request({type:'state',conversationId:roomId});
  const stage=async(name:string)=>{(report.stages as object[]).push({name,at:new Date().toISOString()});console.log('[real context] '+name);await writeFile(path.join(evidence,'progress.json'),JSON.stringify(report,null,2));};
  const capture=async(name:string,target:Page=page)=>{const filename=path.join(evidence,name+'.png');await target.screenshot({path:filename,fullPage:true});await testInfo.attach(name,{path:filename,contentType:'image/png'});};
  const context=async(topicId:string)=>{
    let sample:BotNativeContext|undefined;
    await expect.poll(async()=>{const result=await request({type:'topic.context',conversationId:roomId,topicId,companionId});if(!result.ok)throw Error(result.error);sample=result.topicContext?.sample;return !!botContextOccupancy(sample);},{timeout:60000,intervals:[1000]}).toBe(true);
    return sample!;
  };
  const selectUi=async(topic:BotNativeTopic)=>{
    await page.locator('.bot-topic-current').click();await expect(page.getByRole('dialog',{name:'接入之前的话题',exact:true})).toBeVisible();
    await page.getByLabel('搜索话题',{exact:true}).fill(topic.title);
    const row=page.locator(`[data-topic-id="${topic.id}"]`);await expect(row).toBeVisible();await row.locator('.bot-topic-open').click();
    await expect(page.locator('.bot-topic-current')).toContainText(topic.title);
  };
  const assertMeter=async(sample:BotNativeContext)=>{
    const occupancy=botContextOccupancy(sample)!;
    await expect(page.locator('.bot-context-meter')).toHaveAttribute('data-native-context-session',sample.sessionId);
    await expect(page.locator('.bot-context-trigger')).toContainText(`${occupancy.percent}%`);
    await expect(page.locator('.bot-context-trigger')).toHaveAttribute('title',`~${occupancy.tokens.toLocaleString('zh-CN')} / ${occupancy.capacity.toLocaleString('zh-CN')} tokens`);
  };
  const send=async(content:string)=>{
    const before=Math.max(0,...(await state()).snapshot!.messages.map(message=>message.sequence));
    await page.locator('.bot-composer textarea').fill(content);await page.locator('.bot-composer .bot-send').click();
    await expect(page.locator('.bot-composer textarea')).toHaveValue('');
    let sessionId='';await expect.poll(async()=>{const snapshot=(await state()).snapshot!,message=snapshot.messages.find(message=>message.sequence>before&&message.senderId===companionId&&message.execution);if(message?.status==='failed')throw Error(message.error??'Native inference failed');if(message?.status==='sent'){sessionId=message.execution!.sessionId!;return true;}return false;},{timeout:240000,intervals:[1000]}).toBe(true);
    return sessionId;
  };
  try{
    await expect(page.locator('[data-application-module="companions"]')).toBeVisible();await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0]!;win.setMinimumSize(0,0);win.setSize(1680,1040);win.webContents.setBackgroundThrottling(false);});
    report.packaged=await app.evaluate(({app})=>app.isPackaged);
    await page.locator('[data-application-module="companions"]').click();await request({type:'conversation.open',companionId});
    await page.locator('.bot-sidebar .bot-conversation').filter({has:page.locator('.bot-conversation-title strong',{hasText:/^大肥鱼$/})}).click();
    await stage('cold-read-original-topic-without-a-model-turn');
    const topicA=(await request({type:'topic.list',conversationId:roomId,mode:'all',query:prior.coldRename.title})).topics!.find(topic=>topic.id===prior.topicId)!;
    expect(topicA).toBeTruthy();await selectUi(topicA);const original=await context(topicA.id);expect(original.sessionId).toBe(prior.mainSession);await assertMeter(original);
    await stage('new-independent-topic-has-no-borrowed-reading');
    await page.getByRole('button',{name:'新话题',exact:true}).click();const created=(await state()).snapshot!.chatRuntime!.topic!;
    const topicB=(await request({type:'topic.rename',conversationId:roomId,topicId:created.id,title:'独立上下文验收 '+Date.now().toString(36),requestId:randomUUID()})).topic!;
    await expect(page.locator('.bot-context-trigger')).toContainText('待统计');await expect(page.locator('.bot-context-meter')).not.toHaveAttribute('data-native-context-session',original.sessionId);
    const sessionB=await send('这是独立话题的真实验收。请只回答“独立话题已接入”，不要调用工具。');expect(sessionB).not.toBe(original.sessionId);
    const sampleB=await context(topicB.id);expect(sampleB.sessionId).toBe(sessionB);expect(sampleB.pressure?.projectedTokens).not.toBe(original.pressure?.projectedTokens);await assertMeter(sampleB);
    await page.locator('.bot-context-trigger').click();await capture('topic-b-independent');await page.keyboard.press('Escape');
    await stage('rapid-switching-keeps-each-session-reading');
    for(let index=0;index<4;index++){await selectUi(topicA);await assertMeter(original);await selectUi(topicB);await assertMeter(sampleB);}
    report.independence={topicA:topicA.id,sessionA:original.sessionId,topicB:topicB.id,sessionB,sampleA:original,sampleB,rapidSwitches:8};
    await stage('follow-up-and-live-native-pressure');await selectUi(topicA);
    const material=Array.from({length:100},(_,index)=>`验收资料段落 ${index+1}：这份虚构项目资料只用于测试上下文压缩，包含需求分析、文件交付、伙伴协作、界面设计和验收流程。每个阶段都需要核对输入资料、明确工作职责、保留可追溯的结果以及检查最终文件。`).join('\n');
    expect(await send('继续当前验收话题。下面是临时测试资料，只用于本次任务，不代表用户事实。读完只回复“资料收到”，不要工具，不要复述。\n'+material)).toBe(original.sessionId);
    expect(await send('关于刚才临时资料的追问：其中是否包含文件交付和伙伴协作？只回答一句，不使用工具。')).toBe(original.sessionId);
    const beforeCompact=await context(topicA.id);expect(beforeCompact.asOfSeq).toBeGreaterThan(original.asOfSeq!);await assertMeter(beforeCompact);
    await page.locator('.bot-context-trigger').click();await capture('topic-a-before-compaction');await page.keyboard.press('Escape');
    await stage('native-compaction-while-viewing-another-topic');
    await page.getByRole('button',{name:'压缩',exact:true}).click();
    await selectUi(topicB);await assertMeter(sampleB);
    await expect(page.locator('.bot-topic-notice')).toContainText('已完成原生上下文压缩',{timeout:240000});
    await expect(page.locator('.bot-topic-notice')).toContainText(topicA.title);await assertMeter(sampleB);
    const afterCompact=await context(topicA.id),unchangedB=await context(topicB.id);
    expect(afterCompact.sessionId).toBe(original.sessionId);expect(afterCompact.asOfSeq).toBeGreaterThan(beforeCompact.asOfSeq!);
    expect(botContextOccupancy(afterCompact)!.tokens).toBeLessThan(botContextOccupancy(beforeCompact)!.tokens);
    expect(unchangedB.pressure).toEqual(sampleB.pressure);expect(unchangedB.usage).toEqual(sampleB.usage);
    await selectUi(topicA);await assertMeter(afterCompact);await page.locator('.bot-context-trigger').click();await capture('topic-a-after-compaction');await page.keyboard.press('Escape');
    report.compaction={before:beforeCompact,after:afterCompact,otherSessionUnchanged:true};
    await stage('compare-the-same-session-in-native-dsh-ui');
    const launcher=await page.evaluate(()=>(Reflect.get(window,'worldlinebox') as {dshLauncher:WorldlineBoxDshLauncherApi}).dshLauncher.request({type:'state'}));
    if(!launcher.ok)throw Error(launcher.error);const instance=launcher.state!.instances.find(instance=>instance.isDefault)!;
    const workbenchPromise=app.waitForEvent('window');
    const opened=await page.evaluate(instanceId=>(Reflect.get(window,'worldlinebox') as {dshLauncher:WorldlineBoxDshLauncherApi}).dshLauncher.request({type:'instance.open',instanceId}),instance.id);expect(opened.ok).toBe(true);
    const native=await workbenchPromise,nativeWindow=await app.browserWindow(native);
    await nativeWindow.evaluate(win=>{win.setOpacity(0);win.setFocusable(false);win.webContents.setBackgroundThrottling(false);win.showInactive();});
    await expect(native.getByText(topicA.title,{exact:true}).first()).toBeVisible({timeout:60000});
    // A fresh native browser partition can have DSH's own welcome/settings modal.
    // Dismiss it through its public controls before selecting the real Session.
    await capture('native-initial',native);await writeFile(path.join(evidence,'native-initial-ui.txt'),await native.locator('body').innerText());
    await native.keyboard.press('Escape');
    if(await native.getByText('预览版说明',{exact:true}).isVisible())await native.getByRole('button',{name:'继续',exact:true}).click();
    const skip=native.getByRole('button',{name:/^(跳过|Skip)$/});
    if(await skip.first().isVisible()){await skip.first().click();const confirmation=native.getByRole('dialog').getByRole('button',{name:/^(跳过|Skip)$/});if(await confirmation.isVisible())await confirmation.click();}
    await native.getByText(topicA.title,{exact:true}).first().click();
    const nativeMeter=native.getByRole('button',{name:/上下文已用\s*\d+%|\d+% of context used/});await expect(nativeMeter).toBeVisible({timeout:60000});
    const expected=botContextOccupancy(afterCompact)!.percent;await expect(nativeMeter).toHaveAccessibleName(new RegExp(`(?:上下文已用\\s*${expected}%|${expected}% of context used)`));
    await nativeMeter.click();
    const nativePanel=native.getByRole('dialog',{name:'上下文已用',exact:true}),nativeShort=(value:number)=>{const scaled=value>=1000000?value/1000000:value>=1000?value/1000:value;return String(scaled>=100?Math.round(scaled):Math.round(scaled*10)/10)+(value>=1000000?'M':value>=1000?'K':'');};
    await expect(nativePanel).toContainText(`~${nativeShort(botContextOccupancy(afterCompact)!.tokens)} / ${nativeShort(botContextOccupancy(afterCompact)!.capacity)}`);
    for(const value of Object.values(afterCompact.breakdown!))await expect(nativePanel).toContainText(`~${nativeShort(value)}`);
    report.nativeUiComparison={sameSession:afterCompact.sessionId,percent:expected,nativeAccessibleLabel:await nativeMeter.getAttribute('aria-label'),nativePanel:await nativePanel.innerText()};await capture('native-dsh-same-session',native);await native.close();
    await stage('compact-layout');await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().startsWith('file:'))!.setSize(1200,850));
    await page.locator('.bot-context-trigger').click();const bounds=await page.locator('.bot-context-panel').boundingBox(),viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.y).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(viewport.width);await capture('narrow-context-layout');
    report.passed=true;await stage('passed');
  }catch(error){report.passed=false;report.error=error instanceof Error?error.stack:String(error);throw error;}
  finally{await writeFile(path.join(evidence,'result.json'),JSON.stringify(report,null,2));await app.close();}
});

// eslint-disable-next-line no-empty-pattern -- Reads the persisted real three-companion project; no model or projection mocks.
test('a real collaborative group shows each companion native session independently',async({},testInfo)=>{
  test.skip(process.env.WORLDLINEBOX_BOT_CONTEXT_REAL!=='1','Requires the owned real-model project fixture.');test.setTimeout(180000);
  const fixture=JSON.parse(await readFile(path.resolve('artifacts/companion-topic-real/result.json'),'utf8')) as {passed:boolean;profile:string;groupId:string;originalTopic:{id:string};collaboration:{workerSessions:string[]};mainSession:string};
  const profile=path.resolve(process.env.WORLDLINEBOX_BOT_PROJECT_PROFILE??fixture.profile);
  if(!fixture.passed||profile!==path.resolve(fixture.profile)||path.dirname(profile)!==path.resolve(tmpdir())||!path.basename(profile).startsWith('wlb-project-real-'))throw Error('Requires the owned real-test project profile.');
  const evidence=path.resolve('artifacts/companion-context-real'),report:Record<string,unknown>={profile,groupId:fixture.groupId,topicId:fixture.originalTopic.id,readOnly:true};await mkdir(evidence,{recursive:true});
  const app=await electron.launch({...resolveElectronLaunchOptions(),env:electronLaunchEnv({WORLDLINEBOX_E2E:'1',WORLDLINEBOX_E2E_USER_DATA_PATH:profile,WORLDLINEBOX_E2E_LOCALE:'zh-CN',WORLDLINEBOX_E2E_PERF_OFFSCREEN:'1'})});
  try{
    const page=await app.firstWindow(),request=(input:BotRequest)=>page.evaluate(input=>(Reflect.get(window,'worldlinebox') as {companionBot:WorldlineBoxBotApi}).companionBot.request(input),input);
    await expect(page.locator('[data-application-module="companions"]')).toBeVisible();await page.locator('[data-application-module="companions"]').click();
    const room=(await request({type:'state'})).snapshot!.conversations.find(room=>room.id===fixture.groupId)!;expect(room).toBeTruthy();
    await page.locator('.bot-sidebar .bot-conversation').filter({has:page.locator('.bot-conversation-title strong',{hasText:room.title})}).click();
    expect((await request({type:'topic.select',conversationId:room.id,topicId:fixture.originalTopic.id})).ok).toBe(true);
    const select=page.locator('.bot-topic-controls select');await expect(select).toBeVisible();const readings:BotNativeContext[]=[];
    for(const companionId of room.memberIds.filter(id=>id!=='user')){
      const result=await request({type:'topic.context',conversationId:room.id,topicId:fixture.originalTopic.id,companionId});expect(result.ok).toBe(true);
      const sample=result.topicContext?.sample,reading=botContextOccupancy(sample);expect(reading,companionId+' has its own native reading').toBeTruthy();
      await select.selectOption(companionId);await expect(page.locator('.bot-context-meter')).toHaveAttribute('data-native-context-session',sample!.sessionId);
      await expect(page.locator('.bot-context-trigger')).toHaveAttribute('title',`~${reading!.tokens.toLocaleString('zh-CN')} / ${reading!.capacity.toLocaleString('zh-CN')} tokens`);
      readings.push(sample!);
    }
    expect(readings).toHaveLength(3);expect(new Set(readings.map(sample=>sample.sessionId)).size).toBe(3);
    expect(readings.map(sample=>sample.sessionId).sort()).toEqual([fixture.mainSession,...fixture.collaboration.workerSessions].sort());
    await page.locator('.bot-context-trigger').click();const file=path.join(evidence,'group-independent-context.png');await page.screenshot({path:file,fullPage:true});await testInfo.attach('group-independent-context',{path:file,contentType:'image/png'});
    report.readings=readings;report.packaged=await app.evaluate(({app})=>app.isPackaged);report.passed=true;
  }catch(error){report.passed=false;report.error=error instanceof Error?error.stack:String(error);throw error;}
  finally{await writeFile(path.join(evidence,'group-result.json'),JSON.stringify(report,null,2));await app.close();}
});

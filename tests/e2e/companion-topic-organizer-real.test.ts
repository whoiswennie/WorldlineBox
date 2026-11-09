import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {decodeDshZstdFrames} from '../helpers/dsh-native-journal';
import {_electron as electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import type {BotMessage,BotRequest,WorldlineBoxBotApi} from '../../src/shared/companion-bot';
import {electronLaunchEnv,resolveElectronLaunchOptions} from './electron-test-helpers';

// eslint-disable-next-line no-empty-pattern -- Real configured model, native DSH and production Electron IPC.
test('real ordered replies, standalone stickers and scalable topic management survive a cold native rename',async({},testInfo)=>{
  test.skip(process.env.WORLDLINEBOX_BOT_ORGANIZER_REAL!=='1','Opt in with the owned real-test profile and actual configured model.');test.setTimeout(900000);
  const profile=path.resolve(process.env.WORLDLINEBOX_BOT_PROJECT_PROFILE??'');
  if(path.dirname(profile)!==path.resolve(tmpdir())||!path.basename(profile).startsWith('wlb-project-real-'))throw Error('Requires the owned isolated real-test profile.');
  const evidence=path.resolve('artifacts/companion-topic-organizer-real');await mkdir(evidence,{recursive:true});
  const suffix=Date.now().toString(36),marker='ORDER_'+suffix,file=path.join(profile,'有序交付-'+suffix+'.txt'),topicLabel='顺序与话题验收 '+suffix;
  const report:Record<string,unknown>={profile,marker,realModel:true,nativeDsh:true,productionIpc:true,stages:[]};
  let app:ElectronApplication|undefined,page!:Page,roomId!:string,topicId:string,mainSession:string;
  const request=(input:BotRequest)=>page.evaluate(input=>(Reflect.get(window,'worldlinebox') as {companionBot:WorldlineBoxBotApi}).companionBot.request(input),input);
  const state=()=>request({type:'state',conversationId:roomId});
  const stage=async(name:string)=>{(report.stages as object[]).push({name,at:new Date().toISOString()});console.log('[real organizer] '+name);await writeFile(path.join(evidence,'progress.json'),JSON.stringify(report,null,2));};
  const capture=async(name:string)=>{const filename=path.join(evidence,name+'.png');await page.screenshot({path:filename,fullPage:true});await testInfo.attach(name,{path:filename,contentType:'image/png'});};
  const launch=async()=>{
    app=await electron.launch({...resolveElectronLaunchOptions(),env:electronLaunchEnv({WORLDLINEBOX_E2E:'1',WORLDLINEBOX_E2E_USER_DATA_PATH:profile,WORLDLINEBOX_E2E_LOCALE:'zh-CN',WORLDLINEBOX_E2E_PERF_OFFSCREEN:'1'})});
    page=await app.firstWindow();await expect(page.locator('[data-application-module="companions"]')).toBeVisible();
    await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0]!;win.setMinimumSize(0,0);win.setSize(1680,1040);win.webContents.setBackgroundThrottling(false);});
    await page.locator('[data-application-module="companions"]').click();
    const result=await request({type:'conversation.open',companionId:'builtin-dafeiyu'});expect(result.ok).toBe(true);roomId=result.conversationId!;
    await page.locator('.bot-sidebar .bot-conversation').filter({has:page.locator('.bot-conversation-title strong',{hasText:/^大肥鱼$/})}).click();await expect(page.locator('.bot-chat-header h2')).toHaveText('大肥鱼');
  };
  const send=async(content:string)=>{const before=Math.max(0,...(await state()).snapshot!.messages.map(message=>message.sequence));await page.locator('.bot-composer textarea').fill(content);await page.locator('.bot-composer .bot-send').click();await expect(page.locator('.bot-composer textarea')).toHaveValue('');return before;};
  const reply=async(before:number)=>{let message:BotMessage|undefined;await expect.poll(async()=>{const result=await state();const replies=result.snapshot!.messages.filter(message=>message.sequence>before&&message.senderId==='builtin-dafeiyu'&&message.execution);const failure=replies.find(message=>message.status==='failed');if(failure)throw Error(failure.error??'Native model task failed');message=replies.find(message=>message.status==='sent');return !!message;},{timeout:240000,intervals:[1000]}).toBe(true);return message!;};
  const openPicker=async()=>{await page.locator('.bot-topic-current').click();await expect(page.getByRole('dialog',{name:'接入之前的话题',exact:true})).toBeVisible();};
  const search=async(query:string)=>{await page.getByLabel('搜索话题',{exact:true}).fill(query);await expect.poll(async()=>{const items=await request({type:'topic.list',conversationId:roomId,query,mode:'all'});return items.topics?.length??0;}).toBeGreaterThan(0);};
  const renameUi=async(title:string)=>{await page.getByRole('button',{name:/^管理话题 /}).first().click();await page.getByRole('menuitem',{name:'重命名',exact:true}).click();await page.getByLabel('话题名称',{exact:true}).fill(title);await page.getByRole('button',{name:'保存名称',exact:true}).click();await expect(page.getByRole('dialog',{name:'重命名话题',exact:true})).toHaveCount(0);};
  try{
    await launch();await stage('real-native-ordered-answer-sticker-and-file');
    await page.getByRole('button',{name:'新话题',exact:true}).click();topicId=(await state()).snapshot!.chatRuntime!.topic!.id;report.topicId=topicId;report.roomId=roomId;
    expect((await request({type:'topic.rename',conversationId:roomId,topicId,title:topicLabel,requestId:randomUUID()})).ok).toBe(true);
    const before=await send(`这是一次正式功能验收，只操作我给出的文件。请严格依次：1. 先用普通助手正文告诉我“关键结论：${marker}，资料已经核对”，这段必须出现在任何工具调用之前。2. 调用chat_list_stickers选择一张真实表情，再用chat_send_sticker发送它，caption为“给你一个表情”。3. 用原生文件工具写入绝对路径 ${file.replaceAll('\\','/')}，内容为${marker}，然后用原生present交付此文件。4. 最后普通正文只说“交付完毕”。不要重复表情台词或最初的关键结论。`);
    const answer=await reply(before);mainSession=answer.execution!.sessionId!;report.mainSession=mainSession;
    const parts=answer.parts??[];expect(parts.some(part=>part.text?.includes(marker))).toBe(true);expect(parts.some(part=>part.attachments?.some(media=>media.kind==='sticker'))).toBe(true);expect(parts.some(part=>part.attachments?.some(media=>media.name===path.basename(file)))).toBe(true);
    const order=parts.map(part=>part.sequence);expect(order).toEqual([...order].sort((a,b)=>a-b));expect((await readFile(file,'utf8')).trim()).toBe(marker);
    const bubble=page.locator(`[data-bot-message="${answer.id}"]`);await bubble.scrollIntoViewIfNeeded();await expect(bubble.locator('.bot-execution,.bot-message-progress')).toHaveCount(0);
    await expect(bubble.locator('.bot-message-text')).toHaveCount(1);await expect(bubble.locator('.bot-message-text')).toHaveText('交付完毕');
    await expect(bubble).not.toContainText('给你一个表情');await expect(bubble).not.toContainText('关键结论');await expect(bubble.locator('.bot-message-inline-stickers')).toHaveCount(1);await expect(bubble.locator('.bot-attachment-card')).toHaveCount(1);
    const current=(await state()).snapshot!.messages.filter(message=>message.eventId===answer.eventId&&message.senderId!=='user');expect(current).toHaveLength(1);
    report.orderedReply={singleBubble:true,finalBodyOnly:true,mediaCaptionsHidden:true,completedExecutionChromeHidden:true,parts:parts.map(part=>({kind:part.kind,sequence:part.sequence,text:part.text,files:part.attachments?.map(media=>media.name)})),sha256:createHash('sha256').update(await readFile(file)).digest('hex')};await capture('final-answer-sticker-delivery');
    await stage('standalone-user-sticker-and-two-native-duel-replies');
    const sticker=parts.flatMap(part=>part.attachments??[]).find(media=>media.kind==='sticker')!;
    for(let round=0;round<2;round++){
      const start=Math.max(...(await state()).snapshot!.messages.map(message=>message.sequence));
      const sent=await request({type:'message.send',conversationId:roomId,content:round===0?'': '继续斗图，只发一张无台词的真实表情，不要普通正文。',attachmentIds:[sticker.id],requestId:randomUUID()});expect(sent.ok).toBe(true);
      const response=await reply(start);expect(response.execution?.sessionId).toBe(mainSession);
      // An unsolicited sticker may receive text; the explicit duel must send
      // media. Both are a single native reply, without placeholder duplication.
      if(round===1)expect(response.parts?.some(part=>part.attachments?.some(media=>media.kind==='sticker'))).toBe(true);
      else expect(!!response.content||!!response.attachments?.length).toBe(true);
      expect((await state()).snapshot!.messages.filter(message=>message.eventId===response.eventId&&message.senderId!=='user')).toHaveLength(1);
      await page.locator(`[data-bot-message="${response.id}"]`).scrollIntoViewIfNeeded();
    }
    await capture('standalone-sticker-duel');
    await stage('many-topics-recent-pagination-fuzzy-favorites-and-pin');
    const seeded:Array<{id:string;title:string}>=[];
    for(let index=0;index<27;index++){
      const created=await request({type:'topic.new',conversationId:roomId,requestId:randomUUID()});expect(created.ok).toBe(true);
      const title=`验收${suffix} 资料整理 ${String(index).padStart(2,'0')} ${index===3?'长远旅行规划':'项目讨论'}`;
      expect((await request({type:'topic.rename',conversationId:roomId,topicId:created.topic!.id,title,requestId:randomUUID()})).ok).toBe(true);seeded.push({id:created.topic!.id,title});
    }
    await openPicker();await expect(page.locator('.bot-topic-row')).toHaveCount(6);await page.getByRole('tab',{name:'全部',exact:true}).click();await expect(page.locator('.bot-topic-row')).toHaveCount(12);
    const pageOne=await page.locator('.bot-topic-row').evaluateAll(elements=>elements.map(element=>element.getAttribute('data-topic-id')));await page.getByRole('button',{name:'下一页',exact:true}).click();await expect(page.locator('.bot-topic-row')).toHaveCount(12);
    await expect.poll(async()=>JSON.stringify(await page.locator('.bot-topic-row').evaluateAll(elements=>elements.map(element=>element.getAttribute('data-topic-id'))))).not.toBe(JSON.stringify(pageOne));
    await search(suffix+' 长旅规');await expect(page.locator('.bot-topic-row')).toHaveCount(1);await expect(page.locator('.bot-topic-open')).toContainText('长远旅行规划');
    await page.getByRole('button',{name:/^管理话题 /}).click();await page.getByRole('menuitem',{name:'收藏话题',exact:true}).click();await page.getByRole('tab',{name:'收藏夹',exact:true}).click();await expect(page.locator('.bot-topic-row')).toHaveCount(1);await capture('favorite-fuzzy-search');
    await page.getByRole('button',{name:/^管理话题 /}).click();await page.getByRole('menuitem',{name:'置顶话题',exact:true}).click();await page.getByRole('tab',{name:'最近',exact:true}).click();await page.getByLabel('搜索话题',{exact:true}).fill('');await expect(page.locator('.bot-topic-row')).toHaveCount(6);await expect(page.locator('.bot-topic-open').first()).toContainText('长远旅行规划');await capture('recent-six-pinned-first');
    report.topicList={seeded:seeded.length,recentLimit:6,pageLimit:12,fuzzySearch:true,favoriteSearch:true,pinnedFirst:true};
    await page.getByRole('button',{name:'关闭话题列表'}).click();expect((await request({type:'topic.select',conversationId:roomId,topicId})).ok).toBe(true);
    await stage('restart-before-rename-to-test-cold-native-session');await app!.close();app=undefined;await launch();await openPicker();await search(topicLabel);await expect(page.locator('.bot-topic-row')).toHaveCount(1);
    const renamed=`原生同步验收 ${suffix}`;await renameUi(renamed);
    // Renamed rows no longer match the old query; search the new title.
    await page.getByLabel('搜索话题',{exact:true}).fill(renamed);
    await expect.poll(async()=>{const found=await request({type:'topic.list',conversationId:roomId,query:renamed,mode:'all'});return found.topics?.find(topic=>topic.id===topicId)?.renamePending;},{timeout:120000,intervals:[1000]}).toBe(false);
    await expect(page.locator('.bot-topic-sync')).toHaveCount(0);await capture('cold-native-title-synchronized');await page.locator('.bot-topic-open').first().click();
    const followup=await reply(await send('继续当前话题，不调用工具、不重写文件。刚才交付文件里那个ORDER_开头的验收标记是什么？只回答标记。'));
    expect(followup.execution?.sessionId).toBe(mainSession);expect(followup.content).toContain(marker);report.coldRename={title:renamed,sameSession:true,followupContext:true};
    // Read only owned DSH persistence, independently of the launcher's title mirror.
    const instances=JSON.parse(await readFile(path.join(profile,'dsh','native-instances.json'),'utf8')) as Array<{homePath:string}>;
    const titles:Array<{file:string;event:unknown}>=[];
    const walk=async(directory:string)=>{for(const entry of await readdir(directory,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const filename=path.join(directory,entry.name);if(entry.isDirectory())await walk(filename);else if(/\.jsonl(?:\.zstd)?$/u.test(entry.name)&&filename.split(path.sep).includes(mainSession)){let bytes=await readFile(filename);if(entry.name.endsWith('.zstd'))bytes=decodeDshZstdFrames(bytes);for(const line of bytes.toString('utf8').split(/\r?\n/u).filter(Boolean)){const event=JSON.parse(line);if(event.type==='session/title'&&event.data?.title===renamed)titles.push({file:filename,event});}}}};
    for(const instance of instances)await walk(path.join(instance.homePath,'sessions'));expect(titles.length).toBeGreaterThan(0);report.nativeTitleEvents=titles;await capture('same-session-follow-up-after-cold-rename');report.passed=true;await stage('passed');
  }catch(error){report.passed=false;report.error=error instanceof Error?error.stack:String(error);throw error;}
  finally{await writeFile(path.join(evidence,'result.json'),JSON.stringify(report,null,2));await app?.close();}
});

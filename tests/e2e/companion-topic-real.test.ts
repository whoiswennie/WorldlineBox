import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import { _electron as electron,expect,test,type ElectronApplication } from '@playwright/test';
import type {BotRequest,BotResponse,WorldlineBoxBotApi} from '../../src/shared/companion-bot';
import {electronLaunchEnv,resolveElectronLaunchOptions} from './electron-test-helpers';

const enabled=process.env.WORLDLINEBOX_BOT_TOPICS_REAL==='1',hash=(text:string|Uint8Array)=>createHash('sha256').update(text).digest('hex');
// eslint-disable-next-line no-empty-pattern -- Tests the actual Electron window and configured model.
test('real topic follow-ups, queued input, steering, collaboration and native compaction',async({},testInfo)=>{
  test.skip(!enabled||process.env.WORLDLINEBOX_BOT_TOPICS_RESUME==='1','Opt in with WORLDLINEBOX_BOT_TOPICS_REAL=1 and an owned isolated WORLDLINEBOX_BOT_PROJECT_PROFILE. Uses the real configured model.');
  test.setTimeout(1_500_000);
  const profile=path.resolve(process.env.WORLDLINEBOX_BOT_PROJECT_PROFILE??'');
  if(path.dirname(profile)!==path.resolve(tmpdir())||!path.basename(profile).startsWith('wlb-project-real-'))throw Error('Use an owned isolated real-test profile.');
  const evidence=path.resolve('artifacts/companion-topic-real');await mkdir(evidence,{recursive:true});
  const suffix=Date.now().toString(36),project=path.join(profile,'话题协作-'+suffix),inputs=path.join(profile,'话题输入-'+suffix),marker='STEER_'+suffix,sideToken='SIDE_'+suffix;
  await mkdir(project,{recursive:true});await mkdir(inputs,{recursive:true});
  const brief=path.join(inputs,'开发需求.md'),csv=path.join(inputs,'账单.csv'),amendment=path.join(inputs,'补充资料.md');
  await writeFile(csv,'name,category,amount\n地铁,交通,12.5\n午餐,餐饮,30\n退款,交通,-4\n晚餐,餐饮,20\n');
  await writeFile(brief,`实现无第三方依赖的 Node ES modules 账单分析项目，目录 ${project.replaceAll('\\','/')}。ledger.mjs导出parseCsv(text)和summarize(rows)，summary为{count,total}。支持BOM、空行、带引号字段、负金额。cli.mjs通过--input和--output读CSV写JSON，输出count和total。附件四行统计count=4,total=58.5。至少6项node:test真实测试，README中文运行说明。Claude实现，通知GPT独立验证并写qa.json（checkedBy="gpt",passed=true,列出真实验证命令），GPT再通知大肥鱼；大肥鱼独立运行验证后原生present交付topic-project.zip、README.md、qa.json。用户明确授权本目录内文件创建修改。`);
  await writeFile(amendment,`这是执行期间用户补充的正式需求。最终cli输出JSON和qa.json都必须包含guideMarker="${marker}"，请主脑将本文件实际转交开发者和测试者。不要只在聊天中复述。`);
  const report:Record<string,unknown>={profile,project,marker,sideToken,realModel:true,realNativeDsh:true,realElectronIpc:true,stages:[]};
  const stage=async(name:string)=>{(report.stages as object[]).push({name,at:new Date().toISOString()});console.log('[real topics] '+name);await writeFile(path.join(evidence,'progress.json'),JSON.stringify(report,null,2));};
  let app:ElectronApplication|undefined;
  try{
    await stage('launch');app=await electron.launch({...resolveElectronLaunchOptions(),env:electronLaunchEnv({WORLDLINEBOX_E2E:'1',WORLDLINEBOX_E2E_USER_DATA_PATH:profile,WORLDLINEBOX_E2E_LOCALE:'zh-CN',WORLDLINEBOX_E2E_PERF_OFFSCREEN:'1'})});
    const page=await app.firstWindow();await expect(page.locator('[data-application-module="companions"]')).toBeVisible();
    await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0]!;win.setMinimumSize(0,0);win.setSize(1680,1040);win.webContents.setBackgroundThrottling(false);});
    const request=(input:BotRequest)=>page.evaluate(input=>(Reflect.get(window,'worldlinebox') as {companionBot:WorldlineBoxBotApi}).companionBot.request(input),input);
    const state=(conversationId:string)=>request({type:'state',conversationId});
    const capture=async(name:string)=>{const file=path.join(evidence,name+'.png');await page.screenshot({path:file,fullPage:true});await testInfo.attach(name,{path:file,contentType:'image/png'});};
    const send=async(content:string)=>{await page.locator('.bot-composer textarea').fill(content);await page.locator('.bot-composer .bot-send').click();await expect(page.locator('.bot-composer textarea')).toHaveValue('');};
    const attach=async(files:string[])=>{await app!.evaluate(({dialog},files)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:files});},files);await page.getByRole('button',{name:'添加文件',exact:true}).click();for(const file of files)await expect(page.locator('.bot-draft-attachments')).toContainText(path.basename(file));};
    const awaitIdle=async(room:string)=>{let result:BotResponse={ok:false};await expect.poll(async()=>{result=await state(room);const failed=result.snapshot?.messages.find(message=>message.status==='failed'&&!message.execution?.continuation);if(failed)throw Error(failed.error??'Native task failed');return !!result.snapshot&&!result.snapshot.messages.some(message=>['running','queued'].includes(message.status))&&!result.snapshot.chatRuntime?.queued.length;},{timeout:600000,intervals:[1000]}).toBe(true);return result;};
    await page.locator('[data-application-module="companions"]').click();
    await expect(page.locator('.bot-sidebar')).toBeVisible();
    await stage('create-three-companion-group');
    await page.getByRole('button',{name:'新群聊',exact:true}).click();const dialog=page.getByRole('dialog',{name:'新群聊',exact:true}),title='话题协作验收 '+suffix;
    await dialog.getByLabel('聊天名称').fill(title);for(const name of ['大肥鱼','Claude','GPT'])await dialog.getByLabel(name,{exact:true}).check();await dialog.getByRole('button',{name:'创建',exact:true}).click();
    await expect(page.locator('.bot-chat-header h2')).toHaveText(title);
    const group=(await request({type:'state'})).snapshot!.conversations.find(room=>room.title===title)!;report.groupId=group.id;
    expect((await request({type:'conversation.policy',conversationId:group.id,participationMode:'mentions'})).ok).toBe(true);
    await page.getByRole('button',{name:'新话题',exact:true}).click();await attach([brief,csv]);
    await send(`@大肥鱼 你作为此项目主脑，组织Claude开发、GPT独立验收。先阅读这两份真实附件，然后必须用chat_ask_user向我确认“是否开始账单项目？”，收到我的回答再继续分工。项目目录 ${project.replaceAll('\\','/')}，附件里有职责、API与交付要求。接下来我可能补充附件需求，必须一并交接。禁止代替其他伙伴编造结果。`);
    let initial:BotResponse={ok:false};await expect.poll(async()=>{initial=await state(group.id);const failed=initial.snapshot?.messages.find(message=>message.status==='failed');if(failed)throw Error(failed.error??'Native kickoff failed');return initial.snapshot?.messages.some(message=>!!message.execution?.question);},{timeout:240000,intervals:[1000]}).toBe(true);
    const first=initial.snapshot!.messages.find(message=>message.execution?.question)!,originalTopic=initial.snapshot!.chatRuntime!.topic!;report.originalTopic=originalTopic;report.mainSession=first.execution!.sessionId;
    const firstBubble=page.locator(`[data-bot-message="${first.id}"]`);await expect(firstBubble.locator('.bot-execution-toggle')).toHaveAttribute('aria-expanded','false');
    await stage('steer-with-real-attachment');await attach([amendment]);await send('@大肥鱼 补充需求在刚发送的“补充资料.md”中，请将这份附件纳入正在执行的账单项目，并转交Claude和GPT。');
    await expect(page.locator('.bot-input-queue')).toContainText('补充资料.md');await capture('queued-steering-attachment');
    await page.locator('.bot-input-queue').getByRole('button',{name:'引导',exact:true}).click();await expect(page.locator('.bot-input-queue')).toHaveCount(0,{timeout:30000});
    await stage('queue-independent-topic');await send(`@大肥鱼 这是排队的独立新话题。只在此话题记住口令 ${sideToken}，并用一句话介绍口令用途，不联系其他伙伴、不修改账单项目。`);
    await expect(page.locator('.bot-input-queue')).toContainText(sideToken);await capture('queue-above-composer');
    await firstBubble.locator('.bot-execution-question textarea').fill('开始，请按补充资料要求完成，并实际验证后交付。');await firstBubble.getByRole('button',{name:'回复并继续',exact:true}).click();
    await stage('real-collaboration-running');
    let final:BotResponse={ok:false};await expect.poll(async()=>{
      final=await state(group.id);const failed=final.snapshot?.messages.find(message=>message.status==='failed'&&!message.execution?.continuation);if(failed)throw Error(failed.error??'Native task failed');
      return final.snapshot?.messages.some(message=>message.senderId==='builtin-dafeiyu'&&message.status==='sent'&&message.attachments?.some(file=>file.name==='topic-project.zip'));
    },{timeout:720000,intervals:[1000]}).toBe(true);final=await awaitIdle(group.id);
    const messages=final.snapshot!.messages,mainRuns=messages.filter(message=>message.senderId==='builtin-dafeiyu'&&message.execution?.sessionId===first.execution!.sessionId),claude=messages.filter(message=>message.senderId==='claude'&&message.execution),gpt=messages.filter(message=>message.senderId==='gpt'&&message.execution);
    expect(mainRuns.length).toBeGreaterThanOrEqual(2);expect(claude.length).toBeGreaterThan(0);expect(gpt.length).toBeGreaterThan(0);
    const independent=messages.find(message=>message.senderId==='builtin-dafeiyu'&&message.content.includes(sideToken)&&message.execution?.sessionId!==first.execution!.sessionId)!;expect(independent).toBeTruthy();
    const qa=JSON.parse(await readFile(path.join(project,'qa.json'),'utf8'));expect(qa).toMatchObject({checkedBy:'gpt',passed:true,guideMarker:marker});
    const tests=await promisify(execFile)(process.execPath,['--test'],{cwd:project,timeout:60000});await writeFile(path.join(evidence,'project-tests.txt'),tests.stdout+tests.stderr);
    const delivered=messages.find(message=>message.attachments?.some(file=>file.name==='topic-project.zip'))!;expect(delivered.attachments?.some(file=>file.name==='qa.json')).toBe(true);await page.locator(`[data-bot-message="${delivered.id}"]`).scrollIntoViewIfNeeded();await capture('collaboration-native-delivery');
    report.collaboration={main:'builtin-dafeiyu',workers:['claude','gpt'],routerAgents:0,mainRuns:mainRuns.map(message=>({id:message.id,session:message.execution?.sessionId})),workerSessions:[...new Set([...claude,...gpt].map(message=>message.execution?.sessionId))],independentSession:independent.execution?.sessionId,guideMarkerVerified:true,qa,tests:tests.stdout};
    await stage('select-original-topic-and-follow-up');
    await page.locator('.bot-topic-current').click();await page.getByLabel('搜索话题',{exact:true}).fill(originalTopic.title.slice(0,18));await page.locator('.bot-topic-list>button').filter({hasText:originalTopic.title}).first().click();
    expect((await state(group.id)).snapshot?.chatRuntime?.topic?.id).toBe(originalTopic.id);
    const before=Math.max(...messages.map(message=>message.sequence));await send(`@大肥鱼 继续刚才账单项目，仍由你协调Claude实现、GPT独立核验：给ledger.mjs新增totalsByCategory(rows)，返回按类别汇总金额的对象；样例交通=8.5、餐饮=50。增加至少2项测试，更新qa.json和README，重新打包原生交付topic-project.zip。保留补充资料的guideMarker。不要重建项目目录。`);
    await expect.poll(async()=>{final=await state(group.id);return final.snapshot?.messages.some(message=>message.sequence>before&&message.senderId==='builtin-dafeiyu'&&message.status==='sent'&&message.attachments?.some(file=>file.name==='topic-project.zip'));},{timeout:600000,intervals:[1000]}).toBe(true);final=await awaitIdle(group.id);
    const followups=final.snapshot!.messages.filter(message=>message.sequence>before&&message.senderId==='builtin-dafeiyu'&&message.execution);expect(followups.every(message=>message.execution?.sessionId===first.execution!.sessionId)).toBe(true);
    const check=path.join(project,'independent-check.mjs');await writeFile(check,`import assert from 'node:assert/strict';import {summarize,totalsByCategory} from './ledger.mjs';const rows=[{name:'a',category:'甲',amount:2},{name:'b',category:'乙',amount:4},{name:'c',category:'甲',amount:-1}];assert.deepEqual(summarize(rows),{count:3,total:5});assert.deepEqual(totalsByCategory(rows),{'甲':1,'乙':4});console.log('independent follow-up verification passed');`);
    const independentCheck=await promisify(execFile)(process.execPath,[check],{cwd:project,timeout:60000});report.followup={sameMainSession:true,independentCheck:independentCheck.stdout};await capture('follow-up-same-topic');
    await stage('native-manual-compaction');await page.getByRole('button',{name:'压缩',exact:true}).click();await expect(page.locator('.bot-topic-notice')).toContainText('已完成原生上下文压缩',{timeout:180000});await capture('native-context-compacted');report.nativeCompacted=true;
    await stage('resume-after-compaction');const beforeCompact=Math.max(...final.snapshot!.messages.map(message=>message.sequence));await send(`@大肥鱼 继续当前话题：不要调用其他伙伴或修改文件。请根据当前会话已完成的真实结果，说出项目目录、主脑与两位协作者，以及补充资料里的guideMarker，并确认新增的按类别统计函数名。`);final=await awaitIdle(group.id);
    const compactReply=final.snapshot!.messages.find(message=>message.sequence>beforeCompact&&message.senderId==='builtin-dafeiyu'&&message.execution)!;expect(compactReply.execution?.sessionId).toBe(first.execution!.sessionId);expect(compactReply.content).toContain(marker);expect(compactReply.content).toContain('totalsByCategory');report.afterCompaction={sameSession:true,contextPreserved:true};
    await stage('manual-new-topic');await page.getByRole('button',{name:'新话题',exact:true}).click();const newTopic=(await state(group.id)).snapshot!.chatRuntime!.topic!;expect(newTopic.id).not.toBe(originalTopic.id);await send('@大肥鱼 这是手动开启的新话题，只回复“新话题已开启”，不要回顾账单项目，也不要联系其他伙伴。');final=await awaitIdle(group.id);const newReply=final.snapshot!.messages.filter(message=>message.senderId==='builtin-dafeiyu'&&message.execution).at(-1)!;expect(newReply.execution?.sessionId).not.toBe(first.execution!.sessionId);
    await stage('reconnect-queued-earlier-topic');await page.locator('.bot-topic-current').click();await page.getByLabel('搜索话题',{exact:true}).fill(sideToken);await page.locator('.bot-topic-list>button').filter({hasText:sideToken}).first().click();const sideBefore=Math.max(...final.snapshot!.messages.map(message=>message.sequence));await send('@大肥鱼 这个话题刚才约定的口令是什么？只回答口令，不调用工具、不联系其他伙伴。');final=await awaitIdle(group.id);const sideReply=final.snapshot!.messages.find(message=>message.sequence>sideBefore&&message.senderId==='builtin-dafeiyu'&&message.execution)!;expect(sideReply.execution?.sessionId).toBe(independent.execution?.sessionId);expect(sideReply.content).toContain(sideToken);await capture('reconnected-earlier-topic');
    report.topicManagement={manualNewSession:true,queuedTopicReconnected:true};
    report.inputs=await Promise.all([brief,csv,amendment].map(async file=>({path:file,sha256:hash(await readFile(file))})));
    report.passed=true;await stage('passed');
  }catch(error){report.passed=false;report.error=error instanceof Error?error.stack:String(error);throw error;}
  finally{await writeFile(path.join(evidence,'result.json'),JSON.stringify(report,null,2));await app?.close();}
});

// eslint-disable-next-line no-empty-pattern -- Continues the exact persisted real-model project after restart.
test('reconnects the real completed project and verifies compaction, follow-ups and topic switching after restart',async({},testInfo)=>{
  test.skip(!enabled||process.env.WORLDLINEBOX_BOT_TOPICS_RESUME!=='1','Resume the persisted real-model topic acceptance with WORLDLINEBOX_BOT_TOPICS_RESUME=1.');test.setTimeout(600000);
  const evidence=path.resolve('artifacts/companion-topic-real'),report=JSON.parse(await readFile(path.join(evidence,'result.json'),'utf8'));
  const profile=path.resolve(process.env.WORLDLINEBOX_BOT_PROJECT_PROFILE??'');if(profile!==path.resolve(report.profile)||path.dirname(profile)!==path.resolve(tmpdir())||!path.basename(profile).startsWith('wlb-project-real-'))throw Error('Resume must use the exact owned real-test profile.');
  const app=await electron.launch({...resolveElectronLaunchOptions(),env:electronLaunchEnv({WORLDLINEBOX_E2E:'1',WORLDLINEBOX_E2E_USER_DATA_PATH:profile,WORLDLINEBOX_E2E_LOCALE:'zh-CN',WORLDLINEBOX_E2E_PERF_OFFSCREEN:'1'})});
  try{
    const page=await app.firstWindow();await expect(page.locator('[data-application-module="companions"]')).toBeVisible();
    await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0]!;win.setMinimumSize(0,0);win.setSize(1680,1040);win.webContents.setBackgroundThrottling(false);});
    const request=(input:BotRequest)=>page.evaluate(input=>(Reflect.get(window,'worldlinebox') as {companionBot:WorldlineBoxBotApi}).companionBot.request(input),input);
    const state=()=>request({type:'state',conversationId:report.groupId});
    const capture=async(name:string)=>{const file=path.join(evidence,name+'.png');await page.screenshot({path:file,fullPage:true});await testInfo.attach(name,{path:file,contentType:'image/png'});};
    const stage=async(name:string)=>{report.stages.push({name,at:new Date().toISOString()});console.log('[real topics resume] '+name);await writeFile(path.join(evidence,'progress.json'),JSON.stringify(report,null,2));};
    const waitReply=async(before:number)=>{let reply;await expect.poll(async()=>{const result=await state();const failed=result.snapshot?.messages.find(message=>message.sequence>before&&message.status==='failed');if(failed)throw Error(failed.error??'Real continuation failed');reply=result.snapshot?.messages.find(message=>message.sequence>before&&message.senderId==='builtin-dafeiyu'&&message.status==='sent'&&message.execution);return !!reply;},{timeout:180000,intervals:[1000]}).toBe(true);return reply!;};
    const send=async(content:string)=>{await page.locator('.bot-composer textarea').fill(content);await page.locator('.bot-composer .bot-send').click();await expect(page.locator('.bot-composer textarea')).toHaveValue('');};
    await page.locator('[data-application-module="companions"]').click();const room=(await request({type:'state'})).snapshot!.conversations.find(room=>room.id===report.groupId)!;
    await page.locator('.bot-sidebar .bot-conversation').filter({hasText:room.title}).first().click();await expect(page.locator('.bot-chat-header h2')).toHaveText(room.title);
    const select=async(id:string,query:string)=>{await page.locator('.bot-topic-current').click();await page.getByLabel('搜索话题',{exact:true}).fill(query);await page.locator('.bot-topic-list>button').filter({hasText:query}).first().click();expect((await state()).snapshot!.chatRuntime!.topic!.id).toBe(id);};
    await select(report.originalTopic.id,report.originalTopic.title);
    await stage('native-manual-compaction-after-restart');await page.getByRole('button',{name:'压缩',exact:true}).click();await expect(page.locator('.bot-topic-notice')).toContainText('已完成原生上下文压缩',{timeout:180000});report.nativeCompacted=true;await capture('native-context-compacted');
    await stage('same-session-follow-up-after-compaction');let before=Math.max(...(await state()).snapshot!.messages.map(message=>message.sequence));
    await send('@大肥鱼 继续当前话题，不调用其他伙伴、不修改文件：请根据此会话已完成的真实结果，说出项目目录、主脑与两位协作者、补充资料里的guideMarker，以及新增的按类别统计函数名。');
    const compactReply=await waitReply(before);expect(compactReply.execution?.sessionId).toBe(report.mainSession);expect(compactReply.content).toContain(report.marker);expect(compactReply.content).toContain('totalsByCategory');report.afterCompaction={sameSession:true,contextPreserved:true};await capture('follow-up-after-compaction');
    await stage('manual-new-topic-after-restart');await page.getByRole('button',{name:'新话题',exact:true}).click();expect((await state()).snapshot!.chatRuntime!.topic!.id).not.toBe(report.originalTopic.id);before=Math.max(...(await state()).snapshot!.messages.map(message=>message.sequence));
    await send('@大肥鱼 这是手动开启的新话题，只回复“新话题已开启”，不要回顾账单项目，也不要联系其他伙伴。');const newReply=await waitReply(before);expect(newReply.execution?.sessionId).not.toBe(report.mainSession);
    await stage('reconnect-earlier-queued-topic-after-restart');const sideToken=String(report.sideToken??String(report.marker).replace('STEER_','SIDE_'));
    await page.locator('.bot-topic-current').click();await page.getByLabel('搜索话题',{exact:true}).fill(sideToken);await page.locator('.bot-topic-list>button').filter({hasText:sideToken}).first().click();before=Math.max(...(await state()).snapshot!.messages.map(message=>message.sequence));
    await send('@大肥鱼 这个话题刚才约定的口令是什么？只回答口令，不调用工具、不联系其他伙伴。');const reply=await waitReply(before);expect(reply.execution?.sessionId).toBe(report.collaboration.independentSession);expect(reply.content).toContain(sideToken);await capture('reconnected-earlier-topic');
    report.topicManagement={manualNewSession:true,queuedTopicReconnected:true};report.verifiedAfterRestart=true;report.passed=true;delete report.error;await stage('passed-after-restart');
  }catch(error){report.passed=false;report.error=error instanceof Error?error.stack:String(error);throw error;}
  finally{await writeFile(path.join(evidence,'result.json'),JSON.stringify(report,null,2));await app.close();}
});

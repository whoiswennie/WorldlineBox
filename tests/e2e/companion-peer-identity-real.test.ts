import { copyFile, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { _electron as electron, expect, test } from '@playwright/test';
import type { BotRequest, WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type { DshRuntime } from '../../src/shared/dsh-launcher';
import { seedNativeRuntime } from './fixtures/dsh-native-runtime';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronLaunchOptions } from './electron-test-helpers';

// eslint-disable-next-line no-empty-pattern -- Opt-in real configured inference and production Electron/DSH, no model responses stubbed.
test('real companions keep speaker identity and deliver direct and four-companion group results back to GPT', async ({},testInfo)=>{
  test.skip(process.env.WORLDLINEBOX_PEER_IDENTITY_REAL!=='1','Requires explicitly enabled real-model acceptance.');test.setTimeout(720000);
  const source=path.join(process.env.APPDATA!,'WorldlineBox'),resume=process.env.WORLDLINEBOX_PEER_IDENTITY_PROFILE,profile=resume?path.resolve(resume):await mkdtemp(path.join(tmpdir(),'wlb-peer-identity-real-'));
  if(path.dirname(profile)!==path.resolve(tmpdir())||!path.basename(profile).startsWith('wlb-peer-identity-real-'))throw Error('Requires the owned isolated identity profile');
  const evidence=path.resolve('artifacts/companion-peer-identity');await mkdir(evidence,{recursive:true});
  const report:Record<string,unknown>={passed:false,realModel:true,actualDsh:true,productionIpc:true,profile,stages:[]};
  const stage=async(name:string)=>{(report.stages as object[]).push({name,at:new Date().toISOString()});console.log('[peer identity] '+name);await writeFile(path.join(evidence,'progress.json'),JSON.stringify(report,null,2));};
  const catalog=JSON.parse(await readFile(path.join(source,'dsh/runtimes.json'),'utf8')) as DshRuntime[],runtime=catalog.find(item=>item.version==='0.2.2-rc.1')!;
  if(!runtime)throw Error('Installed sealed native runtime required');if(!resume){await seedNativeRuntime(path.join(source,'dsh'),runtime,profile);
  const profiles=JSON.parse(await readFile(path.join(source,'ai-profiles.json'),'utf8')) as {activeProfileId:string};
  if(!/^ai_[a-f0-9]{24}$/.test(profiles.activeProfileId))throw Error('Configured model required');
  await mkdir(path.join(profile,'ai-profile-keys'));await copyFile(path.join(source,'ai-profiles.json'),path.join(profile,'ai-profiles.json'));
  await copyFile(path.join(source,'ai-profile-keys',profiles.activeProfileId+'.bin'),path.join(profile,'ai-profile-keys',profiles.activeProfileId+'.bin'));
  const local=JSON.parse(await readFile(path.join(source,'Local State'),'utf8'));if(local.os_crypt)await writeFile(path.join(profile,'Local State'),JSON.stringify({os_crypt:local.os_crypt}));
  }
  if(path.resolve(resolveElectronAppPath())!==process.cwd()){
    const tooling=path.join(resolveElectronAppPath(),'.tools');await mkdir(tooling,{recursive:true});
    await symlink(path.resolve('.tools/bot-memory-release'),path.join(tooling,'bot-memory-release'),'junction').catch((error:NodeJS.ErrnoException)=>{if(error.code!=='EEXIST')throw error;});
  }
  await stage('launch-isolated-real-application');
  const app=await electron.launch({...resolveElectronLaunchOptions(),env:electronLaunchEnv({WORLDLINEBOX_E2E:'1',WORLDLINEBOX_E2E_USER_DATA_PATH:profile,WORLDLINEBOX_E2E_LOCALE:'zh-CN',WORLDLINEBOX_E2E_PERF_OFFSCREEN:'1',WORLDLINEBOX_E2E_DSH_SILENT:'1'})});
  try{
    const page=await app.firstWindow(),request=(input:BotRequest)=>page.evaluate(input=>(Reflect.get(window,'worldlinebox') as {companionBot:WorldlineBoxBotApi}).companionBot.request(input),input);
    await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0]!;win.setMinimumSize(0,0);win.setSize(1440,1000);win.webContents.setBackgroundThrottling(false);});
    await page.locator('[data-application-module="companions"]').click();const setup=page.locator('[data-shared-dsh-setup]');
    if(!resume){await setup.getByRole('combobox',{name:'选择 DSH 版本'}).selectOption(runtime.id);await setup.getByRole('button',{name:'创建并共享',exact:true}).click();}
    await request({type:'conversation.open',companionId:'gpt'});await page.locator('.bot-sidebar .bot-conversation').filter({has:page.locator('.bot-conversation-title strong',{hasText:/^GPT$/})}).first().click();await expect(page.locator('.bot-composer textarea')).toBeVisible({timeout:120000});
    const actors=[{id:'builtin-dafeiyu',name:'大肥鱼',fact:'正在整理蓝色资料夹，完成了五分之三'},{id:'claude',name:'Claude',fact:'正在画素描画，刚完成一张'},{id:'gemini',name:'Gemini',fact:'正在做钢琴练习，练到第三段'}];
    for(const actor of actors){const snapshot=(await request({type:'state'})).snapshot!;if(!snapshot.companions.some(person=>person.id===actor.id))throw Error('Missing real built-in '+actor.id);
      await request({type:'companion.update',companionId:actor.id,name:actor.name,persona:`你是虚拟伙伴${actor.name}，以自己身份自然与伙伴、用户交谈。今天真实测试设定的近况是：${actor.fact}。不要编造其他近况，不要替其他成员发言。`});}
    const gptRoom=(await request({type:'conversation.open',companionId:'gpt'})).conversationId!;
    const snapshot=(room:string)=>request({type:'state',conversationId:room});
    const waitDelivery=async(room:string,after:number,names:string[])=>{let answer='';await expect.poll(async()=>{const data=(await snapshot(room)).snapshot!,messages=data.messages.filter(m=>m.sequence>after&&m.senderId==='gpt'&&m.id.startsWith('reply-'));const failed=messages.find(m=>m.status==='failed');if(failed)throw Error(failed.error??'GPT failed');const found=messages.find(m=>m.status==='sent'&&names.every(name=>m.content.includes(name)));answer=found?.content??'';return !!found;},{timeout:240000,intervals:[1000]}).toBe(true);return answer;};
    const capture=async(room:string,name:string)=>{await request({type:'state',conversationId:room});const state=(await snapshot(room)).snapshot!;const title=state.conversations.find(item=>item.id===room)!.title;await page.locator('.bot-sidebar .bot-conversation').filter({has:page.locator('.bot-conversation-title strong',{hasText:title})}).first().click();const file=path.join(evidence,name+'.png');await page.screenshot({path:file});await testInfo.attach(name,{path:file,contentType:'image/png'});};
    await stage('user-asks-gpt-to-check-fish');
    if(!resume){const directRequest=await request({type:'message.send',conversationId:gptRoom,requestId:randomUUID(),content:'你问问大肥鱼她最近在忙什么，收到她的实际回答后告诉我。'});expect(directRequest.ok,directRequest.error).toBe(true);}
    const directAnswer=await waitDelivery(gptRoom,0,['蓝色']);expect(directAnswer).not.toMatch(/本人让我|替本人问|回复本人|本人请你/);await capture(gptRoom,'gpt-direct-final');
    const directState=(await snapshot(gptRoom)).snapshot!,peer=directState.conversations.find(room=>room.kind==='peer'&&room.memberIds.includes('gpt')&&room.memberIds.includes('builtin-dafeiyu'));expect(peer).toBeTruthy();
    const peerState=(await snapshot(peer!.id)).snapshot!;expect(peerState.messages.filter(m=>m.senderId==='builtin-dafeiyu'&&m.status==='sent'&&m.id.startsWith('reply-'))).toHaveLength(1);expect(peerState.messages.map(m=>m.content).join('\n')).not.toContain('回复本人');await capture(peer!.id,'peer-natural-dialogue');
    report.direct={answer:directAnswer,messages:directState.messages,peerMessages:peerState.messages};await stage('four-companion-group-fan-out');
    const priorGroup=resume?(await request({type:'state'})).snapshot!.conversations.find(room=>room.kind==='group'&&room.title==='四伙伴身份与协同验收'):undefined;
    const group=priorGroup?.id??(await request({type:'conversation.create',title:'四伙伴身份与协同验收',kind:'group',memberIds:['gpt',...actors.map(actor=>actor.id)],participationMode:'mentions'})).conversationId!;
    if(!priorGroup){const groupRequest=await request({type:'message.send',conversationId:group,requestId:randomUUID(),content:'@GPT 请你在这个群里分别问大肥鱼、Claude、Gemini，她们今天各自在忙什么。不要替她们猜，等三位都实际回答后，由你汇总交给我。'});expect(groupRequest.ok,groupRequest.error).toBe(true);}
    const groupAnswer=await waitDelivery(group,0,['蓝色','素描','钢琴']);expect(groupAnswer).not.toMatch(/本人让我|替本人问|回复本人|本人请你/);await capture(group,'four-companion-group-final');
    const groupState=(await snapshot(group)).snapshot!;for(const actor of actors)expect(groupState.messages.some(m=>m.senderId===actor.id&&m.id.startsWith('reply-')&&m.status==='sent')).toBe(true);report.group={answer:groupAnswer,messages:groupState.messages};
    const baseline=Math.max(...groupState.messages.map(m=>m.sequence));await stage('follow-up-addressed-to-claude');
    await request({type:'message.send',conversationId:group,requestId:randomUUID(),content:'@Claude 刚才由谁负责向我汇总大家的近况？你自己是哪位，你今天在做什么？请用你自己的身份回答我。'});
    await expect.poll(async()=>{const data=(await snapshot(group)).snapshot!,reply=data.messages.find(m=>m.sequence>baseline&&m.senderId==='claude'&&m.id.startsWith('reply-')&&m.status==='sent');if(reply){report.followUp=reply.content;return reply.content.includes('GPT')&&reply.content.includes('Claude')&&reply.content.includes('素描');}return false;},{timeout:180000,intervals:[1000]}).toBe(true);
    await capture(group,'group-follow-up-identity');
    const injections=await app.evaluate(({app})=>{
      const path=process.getBuiltinModule('node:path'),require=process.getBuiltinModule('node:module').createRequire(path.join(app.getAppPath(),'package.json'));
      const Database=require('better-sqlite3') as {new(file:string,options:object):{prepare(sql:string):{all():Array<{companion_id:string;sender_id:string;conversation_id:string;kind:string;value:string}>};close():void}};
      const db=new Database(path.join(app.getPath('userData'),'companion-bot-v2/bot.sqlite'),{readonly:true});
      try{return db.prepare(`SELECT i.companion_id,i.sender_id,i.conversation_id,c.kind,m.value FROM bot_inbox i
        JOIN bot_metadata m ON m.key='native-input:'||i.id JOIN bot_conversations c ON c.id=i.conversation_id ORDER BY i.sequence`).all();}finally{db.close();}
    });
    report.identityContracts=injections.map(row=>{const envelope=JSON.parse(JSON.parse(row.value).prompt);expect(envelope.identity.id).toBe(row.companion_id);expect(envelope.message.senderId).toBe(row.sender_id);expect(envelope.delivery.self.id).toBe(row.companion_id);expect(envelope.delivery.replyAs.id).toBe(row.companion_id);expect(envelope.delivery.speaker.id).toBe(row.sender_id);expect(envelope.room.id).toBe(row.conversation_id);if(row.kind==='peer')expect(envelope.delivery.audience).toMatchObject({userParticipates:false,userRole:'observer'});return{self:envelope.delivery.self,speaker:envelope.delivery.speaker,audience:envelope.delivery.audience,kind:envelope.delivery.kind};});
    const finalDirect=(await snapshot(gptRoom)).snapshot!;expect(finalDirect.messages.filter(m=>m.senderId==='gpt'&&m.status==='sent'&&m.content.includes('蓝色'))).toHaveLength(1);
    report.direct={answer:directAnswer,messages:finalDirect.messages,peerMessages:peerState.messages};report.passed=true;await writeFile(path.join(evidence,'real-result.json'),JSON.stringify(report,null,2));
  }finally{await writeFile(path.join(evidence,'progress.json'),JSON.stringify(report,null,2));await app.close();}
});

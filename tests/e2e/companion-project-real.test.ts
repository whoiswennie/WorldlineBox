import { constants } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import type { BotResponse, WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import type {WorldlineBoxDshLauncherApi} from '../../src/shared/dsh-launcher';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronLaunchOptions } from './electron-test-helpers';

const enabled=process.env.WORLDLINEBOX_BOT_PROJECT_REAL==='1';
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
// eslint-disable-next-line no-empty-pattern -- The actual Electron app owns the UI.
test('real companions receive absolute file paths, collaborate on a project and deliver verified native artifacts through chat',async({},testInfo)=>{
  test.skip(!enabled,'Opt in with WORLDLINEBOX_BOT_PROJECT_REAL=1; uses the configured real model and an isolated copy of its runtime.');
  test.setTimeout(1_500_000);
  const root=process.env.WORLDLINEBOX_BOT_PROJECT_PROFILE??await mkdtemp(path.join(tmpdir(),'wlb-project-real-'));
  if(path.dirname(path.resolve(root))!==path.resolve(tmpdir())||!path.basename(root).startsWith('wlb-project-real-'))throw Error('Unexpected real acceptance profile');
  const evidence=path.resolve('artifacts/companion-project-real');await mkdir(evidence,{recursive:true});
  const previous=process.env.WORLDLINEBOX_BOT_PROJECT_RESUME_VERIFICATION==='1'?JSON.parse(await readFile(path.join(evidence,'result.json'),'utf8')):undefined;
  if(previous&&path.resolve(previous.profile)!==path.resolve(root))throw Error('Verification must use the exact original acceptance profile');
  const source=path.join(process.env.APPDATA!,'WorldlineBox'),profile=root,project=previous?.projectPath??path.join(root,'共同开发项目-'+Date.now().toString(36)),inputs=path.join(root,'项目输入 资料');
  if(!path.resolve(project).startsWith(path.resolve(root)+path.sep))throw Error('Acceptance project must stay inside its owned profile');
  await mkdir(project,{recursive:true});await mkdir(inputs,{recursive:true});
  const report:Record<string,unknown>={...(previous??{}),realModel:true,realNativeDsh:true,realElectronIpc:true,profile,projectPath:project,stages:previous?.stages??[],...(previous?{verificationResumed:true}:{})};
  const stages=report.stages as Array<{name:string;at:string}>;
  const stage=async(name:string)=>{stages.push({name,at:new Date().toISOString()});console.log('[real companion project] '+name);await writeFile(path.join(evidence,'progress.json'),JSON.stringify(report,null,2));};
  let app:ElectronApplication|undefined,passed=false;
  try{
    if(!process.env.WORLDLINEBOX_BOT_PROJECT_PROFILE){
      await stage('copy-isolated-runtime');
      const catalog=JSON.parse(await readFile(path.join(source,'dsh','runtimes.json'),'utf8')) as Array<{id:string;version:string;adapter:string}>;
      const runtime=catalog.filter(row=>row.adapter==='node-cli-web-v1').sort((a,b)=>b.version.localeCompare(a.version,undefined,{numeric:true}))[0]!;
      if(!runtime||!/^runtime-[a-f0-9]+$/.test(runtime.id))throw Error('Installed native DSH runtime required');
      await mkdir(path.join(profile,'dsh','runtimes'),{recursive:true});
      await cp(path.join(source,'dsh','runtimes',runtime.id),path.join(profile,'dsh','runtimes',runtime.id),{recursive:true,mode:constants.COPYFILE_FICLONE});
      await writeFile(path.join(profile,'dsh','runtimes.json'),JSON.stringify([runtime]));
      const profiles=JSON.parse(await readFile(path.join(source,'ai-profiles.json'),'utf8')) as {activeProfileId:string};
      if(!/^ai_[a-f0-9]{24}$/.test(profiles.activeProfileId))throw Error('Configured real model required');
      await mkdir(path.join(profile,'ai-profile-keys'),{recursive:true});
      await copyFile(path.join(source,'ai-profiles.json'),path.join(profile,'ai-profiles.json'));
      await copyFile(path.join(source,'ai-profile-keys',profiles.activeProfileId+'.bin'),path.join(profile,'ai-profile-keys',profiles.activeProfileId+'.bin'));
      const local=JSON.parse(await readFile(path.join(source,'Local State'),'utf8'));
      if(local.os_crypt)await writeFile(path.join(profile,'Local State'),JSON.stringify({os_crypt:local.os_crypt}));
      report.runtime={id:runtime.id,version:runtime.version};
    }
    const selectedRuntime=JSON.parse(await readFile(path.join(profile,'dsh','runtimes.json'),'utf8'))[0] as {id:string;version:string};
    report.runtime=selectedRuntime;
    // Dev VCP is a read-only module dependency; its writable homes remain in
    // this test profile. Keep the isolated application build independent of dev.
    if(path.resolve(resolveElectronAppPath())!==process.cwd()){
      const tooling=path.join(resolveElectronAppPath(),'.tools');await mkdir(tooling,{recursive:true});
      try{await symlink(path.resolve('.tools/bot-memory-release'),path.join(tooling,'bot-memory-release'),'junction');}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    }
    const csv='name,category,stock,reorder,price\n乌龙茶,饮品,4,5,8\n苏打水,饮品,12,3,4\n饼干,零食,3,4,6\n巧克力,零食,9,2,10\n';
    const brief=`开发一个可运行的库存看板，原生 HTML/CSS/ES modules，无 npm 依赖。共同目录：${project.replaceAll('\\','/')}。
必须产出 index.html、styles.css、app.mjs、sample.csv、README.md、tests/inventory.test.mjs。
app.mjs 导出 parseCsv(text)、summarize(rows)、filterRows(rows,query,category)、sortRows(rows,key)。summarize 返回 {totalStock,totalValue,lowStockCount}。ES模块在Node中导入时不能访问document；浏览器中正常渲染。
看板提供中文商品表格、搜索、分类筛选、库存排序、低库存标记和统计。使用附件CSV作为真实数据，不能把测试结果硬编码到统计函数。三个统计元素id为 summary-stock、summary-value、summary-low；搜索输入id=search；分类select id=category；排序select id=sort且库存倒序选项value=stock-desc；商品tbody id=inventory-body。样例总库存28，总货值188，低库存商品2种。
使用清爽的蓝白色卡片布局，适配窄屏。tests/inventory.test.mjs 使用 node:test 与 assert，至少覆盖CSV解析、统计、中文搜索、分类筛选、库存排序五项，使用不同数据验证计算，不能只断言固定样例。
Claude负责实现；完成后用message_peer给GPT转交检查任务，attachmentIds必须包含本次收到的三份原始附件；GPT独立检查与运行测试，生成 qa-report.json，包含 checkedBy="gpt"、testsPassed=true 和实际检查项目；大肥鱼核验后将整个项目打成 inventory-project.zip，用DSH原生present交付ZIP、README.md、qa-report.json三个真实文件。不能用文字假称已交付。
所有伙伴在各自的原生DSH会话中工作。通过message_peer传递本次任务和附件，转交时务必携带共享目录、需求和下一位伙伴的职责。完成后不要重复互相问候或继续联系。
`;
    const files=[path.join(inputs,'开发需求.md'),path.join(inputs,'库存数据.csv'),path.join(inputs,'验收配置.json')];
    if(!previous){await writeFile(files[0]!,brief);await writeFile(files[1]!,csv);await writeFile(files[2]!,JSON.stringify({expected:{totalStock:28,totalValue:188,lowStockCount:2},projectPath:project},null,2));}
    await stage('launch-real-app');
    app=await electron.launch({...resolveElectronLaunchOptions(),env:electronLaunchEnv({WORLDLINEBOX_E2E:'1',WORLDLINEBOX_E2E_PERF_OFFSCREEN:'1',WORLDLINEBOX_E2E_USER_DATA_PATH:profile,WORLDLINEBOX_E2E_LOCALE:'zh-CN'})});
    const page=await app.firstWindow();await expect(page.locator('[data-application-module="companions"]')).toBeVisible();
    await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0]!;window.setMinimumSize(0,0);window.setSize(1680,1040);window.webContents.setBackgroundThrottling(false);});
    const capture=async(name:string)=>{const filename=path.join(evidence,name+'.png');await page.screenshot({path:filename,fullPage:true});await testInfo.attach(name,{path:filename,contentType:'image/png'});};
    const state=(conversationId?:string)=>page.evaluate(conversationId=>(Reflect.get(window,'worldlinebox') as {companionBot:WorldlineBoxBotApi}).companionBot.request({type:'state',...(conversationId?{conversationId}:{})}),conversationId);
    await page.locator('[data-application-module="companions"]').click();
    const setup=page.locator('[data-shared-dsh-setup]');
    const launcher=await page.evaluate(()=>(Reflect.get(window,'worldlinebox') as {dshLauncher:WorldlineBoxDshLauncherApi}).dshLauncher.request({type:'state'}));
    if(!launcher.ok||!launcher.state?.instances.some(instance=>instance.isDefault)){
      await expect(setup).toBeVisible();
      await stage('create-shared-native-dsh');
      const select=setup.getByRole('combobox',{name:'选择 DSH 版本'});
      const value=await select.locator('option').last().getAttribute('value');await select.selectOption(value!);
      await setup.getByRole('button',{name:'创建并共享',exact:true}).click();
      await expect(page.locator('.bot-composer')).toBeVisible({timeout:240000});
    }
    let groupId='',final:BotResponse|undefined;
    if(previous){
      await stage('resume-real-delivery-verification');
      groupId=await app.evaluate(({app},project)=>{
        const path=process.getBuiltinModule('node:path'),require=process.getBuiltinModule('node:module').createRequire(path.join(app.getAppPath(),'package.json'));
        const Database=require('better-sqlite3') as {new(file:string,options:object):{prepare(sql:string):{get(...args:unknown[]):{conversation_id:string}|undefined};close():void}};
        const db=new Database(path.join(app.getPath('userData'),'companion-bot-v2','bot.sqlite'),{readonly:true});
        try{return db.prepare("SELECT m.conversation_id FROM bot_messages m JOIN bot_conversations c ON c.id=m.conversation_id WHERE c.kind='group' AND m.sender_id='user' AND instr(replace(m.content,char(92),'/'),?)>0 ORDER BY m.sequence DESC LIMIT 1").get(project.replaceAll('\\','/'))?.conversation_id??'';}finally{db.close();}
      },project);
      expect(groupId,'Original real project conversation').toBeTruthy();
      const room=(await state()).snapshot!.conversations.find(room=>room.id===groupId)!;
      await page.locator('.bot-sidebar .bot-conversation').filter({hasText:room.title}).click();final=await state(groupId);
    }else{
    await stage('real-companion-private-chat');
    await page.locator('.bot-sidebar .bot-conversation').filter({has:page.locator('strong',{hasText:/^大肥鱼$/})}).first().click();
    const beforePeer=(await state()).snapshot?.conversations.find(room=>room.kind==='peer'&&room.memberIds.includes('claude')&&room.memberIds.includes('builtin-dafeiyu'));
    const peerBaseline=beforePeer?Math.max(0,...((await state(beforePeer.id)).snapshot?.messages??[]).map(message=>message.sequence)):0;
    await page.locator('.bot-composer textarea').fill('请用companion_contact联系Claude，destination=peer，消息只写“这是伙伴私聊连通验收，请只回答：伙伴私聊已连接。不要再联系其他伙伴。”只发一次，不替她回答。');
    await page.locator('.bot-composer .bot-send').click();
    let peerId='';
    await expect.poll(async()=>{const response=await state();peerId=response.snapshot?.conversations.find(room=>room.kind==='peer'&&room.memberIds.includes('claude')&&room.memberIds.includes('builtin-dafeiyu'))?.id??'';if(!peerId)return false;const peer=await state(peerId);return !!peer.snapshot?.messages.some(item=>item.senderId==='claude'&&item.sequence>peerBaseline&&item.status==='sent'&&item.content.includes('伙伴私聊已连接'));},{timeout:240000,intervals:[1000]}).toBe(true);
    await page.locator('.bot-sidebar .bot-conversation').filter({hasText:'大肥鱼 × Claude'}).first().click();
    await expect(page.locator('.bot-peer-observer-dock')).toBeVisible();await expect(page.locator('.bot-composer')).toHaveCount(0);
    await expect(page.locator('.bot-transcript')).toContainText('伙伴私聊已连接');await capture('real-peer-observer');report.peer={realReply:true,observerComposerHidden:true};
    await stage('create-project-group');
    await page.getByRole('button',{name:'新群聊',exact:true}).click();const dialog=page.getByRole('dialog',{name:'新群聊',exact:true});
    const title='库存项目协作 '+Date.now().toString(36);await dialog.getByLabel('聊天名称').fill(title);
    for(const name of ['大肥鱼','Claude','GPT'])await dialog.getByLabel(name,{exact:true}).check();
    await dialog.getByRole('button',{name:'创建',exact:true}).click();await expect(page.locator('.bot-chat-header h2')).toHaveText(title);
    groupId=(await state()).snapshot!.conversations.find(room=>room.title===title)!.id;report.groupId=groupId;
    await app.evaluate(({dialog},files)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:files});},files);
    await page.getByRole('button',{name:'添加文件',exact:true}).click();await expect(page.locator('.bot-draft-attachments')).toContainText('开发需求.md');
    await page.locator('.bot-composer textarea').fill(`@大肥鱼 请组织Claude和GPT协作完成附件中的库存看板项目。你负责协调和最终交付，先实际读取三份附件，再通过message_peer给Claude发送开发任务并附上这三份附件；Claude开发后再通过message_peer通知GPT独立测试；GPT测试后通过message_peer通知你核验和打包交付。共享项目目录是 ${project.replaceAll('\\','/')}，用户明确授权你们创建和修改这个目录。每次转交须带上必要需求、绝对目录和下一步职责。你不要代替Claude实现或代替GPT编造检查报告；最终使用原生present交付inventory-project.zip、README.md、qa-report.json。`);
    await capture('project-input-attachments');await page.locator('.bot-composer .bot-send').click();
    await stage('native-project-running');
    await expect(page.locator('.bot-execution[data-status="running"] .bot-execution-round-title').first()).toBeVisible({timeout:180000});await capture('project-native-progress');
    const continued=new Set<string>(),runningCaptures=new Set<string>();
    const projectDeadline=Date.now()+720000;let completed=false;
    while(Date.now()<projectDeadline){
      final=await state(groupId);
      for(const message of final.snapshot?.messages??[]){
        const continuation=message.execution?.continuation,key=message.id+':'+continuation?.checkpoint;
        if(continuation&&!continued.has(key)){
          if(continued.size>=3)throw Error('Repeated output budget stops');
          const bubble=page.locator(`[data-bot-message="${message.id}"]`);await bubble.scrollIntoViewIfNeeded();await capture('native-output-paused-'+continued.size);
          await bubble.getByRole('button',{name:'继续执行',exact:true}).click();continued.add(key);
        }
        if(message.status==='failed'&&!message.execution?.continuation)throw Error('Native project failed: '+message.error);
        if(message.status==='running'&&message.execution?.steps.some(step=>step.type==='tool_call')&&!runningCaptures.has(message.senderId)){
          runningCaptures.add(message.senderId);await page.locator(`[data-bot-message="${message.id}"]`).scrollIntoViewIfNeeded();await capture('real-progress-'+message.senderId);
        }
      }
      completed=final.snapshot?.messages.some(message=>message.senderId==='builtin-dafeiyu'&&message.status==='sent'&&message.attachments?.some(ref=>ref.name==='inventory-project.zip'))??false;
      if(completed)break;await new Promise(resolve=>setTimeout(resolve,1500));
    }
    expect(completed,'Project delivered before the bounded deadline').toBe(true);
    report.explicitContinuations=continued.size;
    }
    await expect.poll(async()=>{final=await state(groupId);return final.snapshot!.messages.every(message=>!['queued','running'].includes(message.status));},{timeout:90000,intervals:[1500]}).toBe(true);
    const messages=final!.snapshot!.messages,delivered=messages.find(message=>message.senderId==='builtin-dafeiyu'&&message.attachments?.some(ref=>ref.name==='inventory-project.zip'))!;
    for(const id of ['builtin-dafeiyu','claude','gpt'])expect(messages.some(message=>message.senderId===id&&message.status==='sent')).toBe(true);
    const toolsBy=(id:string)=>messages.filter(message=>message.senderId===id).flatMap(message=>message.execution?.steps.filter(step=>step.type==='tool_call')??[]);
    expect(toolsBy('builtin-dafeiyu').some(step=>step.toolName==='present'||step.toolName?.endsWith('present_files')),'Coordinator uses native file presentation').toBe(true);
    expect(toolsBy('claude').some(step=>step.text?.includes('app.mjs')&&['write','edit','pwsh'].includes(step.toolName??'')),'Claude actually authors the application').toBe(true);
    expect(toolsBy('gpt').some(step=>step.text?.includes('--test')&&step.text.includes('inventory.test.mjs')),'GPT independently invokes the tests').toBe(true);
    for(const name of ['inventory-project.zip','README.md','qa-report.json'])expect(delivered.attachments?.some(ref=>ref.name===name)).toBe(true);
    const receiptFile=path.join(profile,'companion-bot-v2','workspaces',createHash('sha256').update('builtin-dafeiyu').digest('hex'),'.worldlinebox-brain',createHash('sha256').update(delivered.eventId).digest('hex')+'.json');
    const receipt=JSON.parse(await readFile(receiptFile,'utf8')) as {result:{status:string;artifacts:Array<{path:string}>}};
    expect(receipt.result.status).toBe('succeeded');
    const nativeSources=new Map(receipt.result.artifacts.map(artifact=>[path.basename(artifact.path),artifact.path]));
    for(const ref of (delivered.attachments??[]).filter(ref=>['inventory-project.zip','README.md','qa-report.json'].includes(ref.name))){const source=nativeSources.get(ref.name);expect(source,'Native presentation source '+ref.name).toBeTruthy();expect(path.isAbsolute(source!)).toBe(true);expect(ref.sha256).toBe(hash(await readFile(source!)));}
    await stage('verify-absolute-native-inputs');
    const contexts=await app.evaluate(({app},room)=>{
      const path=process.getBuiltinModule('node:path'),require=process.getBuiltinModule('node:module').createRequire(path.join(app.getAppPath(),'package.json'));
      const Database=require('better-sqlite3') as {new(file:string,options:object):{prepare(sql:string):{all(...args:unknown[]):Array<{companion_id:string;value:string}>};close():void}};
      const db=new Database(path.join(app.getPath('userData'),'companion-bot-v2','bot.sqlite'),{readonly:true});
      try{return db.prepare("SELECT i.companion_id,m.value FROM bot_inbox i JOIN bot_metadata m ON m.key='native-input:'||i.id WHERE i.conversation_id=?").all(room).map(row=>({companionId:row.companion_id,prompt:JSON.parse(JSON.parse(row.value).prompt)}));}finally{db.close();}
    },groupId);
    const inputProof=[];
    for(const id of ['builtin-dafeiyu','claude','gpt']){
      const context=contexts.find(item=>item.companionId===id&&item.prompt.files?.length>=3);expect(context,`Attachments delivered to ${id}`).toBeTruthy();
      for(const file of context!.prompt.files){expect(path.isAbsolute(file.path)).toBe(true);const bytes=await readFile(file.path);expect(hash(bytes)).toBe(file.sha256);}
      inputProof.push({companionId:id,absolutePaths:true,sha256Verified:true,files:context!.prompt.files.map((file:{name:string})=>file.name)});
    }
    report.inputs=inputProof;
    await stage('verify-real-project-output');
    const node=path.join(profile,'dsh','runtimes',selectedRuntime.id,'program','bin','node.exe');
    const testResult=await promisify(execFile)(process.platform==='win32'?node:process.execPath,['--test','tests/inventory.test.mjs'],{cwd:project,windowsHide:true,timeout:60000});
    expect(testResult.stdout).toMatch(/pass [5-9]|pass [1-9]\d/);await writeFile(path.join(evidence,'project-tests.txt'),testResult.stdout);
    const externalCheck=path.join(evidence,'independent-project-check.mjs');
    await writeFile(externalCheck,`import assert from 'node:assert/strict';
const api=await import(${JSON.stringify(pathToFileURL(path.join(project,'app.mjs')).href)});
const rows=api.parseCsv('name,category,stock,reorder,price\\n甲,饮品,2,3,4\\n乙,零食,5,2,3\\n');
assert.deepEqual(api.summarize(rows),{totalStock:7,totalValue:23,lowStockCount:1});
assert.equal(api.filterRows(rows,'甲','').length,1);
assert.equal(api.filterRows(rows,'','零食').length,1);
assert.equal(api.sortRows(rows,'stock-desc')[0].name,'乙');
console.log('Independent business assertions passed');
`);
    const independent=await promisify(execFile)(node,[externalCheck],{windowsHide:true,timeout:30000});expect(independent.stdout).toContain('Independent business assertions passed');
    const qa=JSON.parse(await readFile(path.join(project,'qa-report.json'),'utf8'));expect(qa).toMatchObject({checkedBy:'gpt',testsPassed:true});
    const require=createRequire(path.resolve('package.json')),Zip=require('adm-zip'),zip=new Zip(nativeSources.get('inventory-project.zip')!);
    const entries=zip.getEntries().map((entry:{entryName:string})=>entry.entryName);for(const suffix of ['index.html','app.mjs','README.md','tests/inventory.test.mjs'])expect(entries.some((name:string)=>name.endsWith(suffix))).toBe(true);
    const bubble=page.locator(`[data-bot-message="${delivered.id}"]`);await bubble.scrollIntoViewIfNeeded();
    const fileToggle=bubble.locator('.bot-message-file-toggle');if(await fileToggle.count())await fileToggle.click();
    await expect(bubble.locator('.bot-attachment-bundle')).toContainText('inventory-project.zip');await capture('project-real-deliverables');
    await bubble.getByRole('button',{name:'全部文件',exact:true}).click();
    const explorer=page.getByRole('dialog',{name:'全部附件',exact:true});await expect(explorer).toBeVisible();
    const saved=path.join(evidence,'inventory-project.zip');await app.evaluate(({dialog},saved)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:saved});},saved);
    await explorer.getByRole('button',{name:'保存 inventory-project.zip',exact:true}).click();await expect.poll(async()=>{try{return hash(await readFile(saved));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 'pending';throw error;}},{timeout:10000}).toBe(hash(await readFile(nativeSources.get('inventory-project.zip')!)));
    await explorer.getByRole('button',{name:'打开预览 README.md',exact:true}).click();await expect(page.locator('.bot-attachment-viewer .bot-attachment-document')).toBeVisible();await capture('project-delivery-preview');
    report.delivery={nativePresent:true,threeRealFiles:true,savedZipMatches:true,independentTestsPassed:true,externalBusinessAssertions:true,qaAuthor:'gpt'};
    report.collaboration=messages.filter(message=>message.senderId!=='user').map(message=>({id:message.id,companionId:message.senderId,status:message.status,steps:message.execution?.steps.length??0,tools:message.execution?.steps.filter(step=>step.type==='tool_call').map(step=>step.toolName)}));
    const server=createServer(async(request,response)=>{try{const file=path.join(project,decodeURIComponent(new URL(request.url!,'http://localhost').pathname).replace(/^\//,'')||'index.html');if(path.relative(project,file).startsWith('..'))throw Error('Outside project');response.setHeader('content-type',file.endsWith('.mjs')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');response.end(await readFile(file));}catch{response.statusCode=404;response.end();}});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('Project server missing');
    try{
      await app.evaluate(async({BrowserWindow},url)=>{const preview=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await preview.loadURL(url);},`http://127.0.0.1:${address.port}/`);
      const preview=(await app.windows()).at(-1)!;await expect(preview.locator('#inventory-body tr')).toHaveCount(4);
      await expect(preview.locator('#summary-stock')).toContainText('28');await expect(preview.locator('#summary-value')).toContainText('188');await expect(preview.locator('#summary-low')).toContainText('2');
      await preview.locator('#search').fill('茶');await expect(preview.locator('#inventory-body tr')).toHaveCount(1);await preview.locator('#search').fill('');
      await preview.locator('#sort').selectOption('stock-desc');await expect(preview.locator('#inventory-body tr').first()).toContainText('苏打水');
      await preview.screenshot({path:path.join(evidence,'actual-developed-project.png')});await preview.close();report.projectUi={rendersFourItems:true,metricsCorrect:true,searchWorks:true,sortWorks:true};
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
    passed=true;report.passed=true;delete report.failure;await stage('passed');
  }catch(error){report.passed=false;report.failure=error instanceof Error?error.message:String(error);throw error;}
  finally{
    await writeFile(path.join(evidence,'result.json'),JSON.stringify(report,null,2));await app?.close();
    if(passed&&!process.env.WORLDLINEBOX_BOT_PROJECT_PROFILE)await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:200});
  }
});

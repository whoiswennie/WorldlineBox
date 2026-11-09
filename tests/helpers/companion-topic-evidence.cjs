/* global require, console */
/* eslint-disable @typescript-eslint/no-require-imports -- Runs under Electron's Node ABI against the isolated real-test database. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{createHash}=require('node:crypto');
const Database=require('better-sqlite3'),AdmZip=require('adm-zip');
const reportPath=path.resolve('artifacts/companion-topic-real/result.json'),report=JSON.parse(fs.readFileSync(reportPath,'utf8'));
if(!report.passed||path.dirname(path.resolve(report.profile))!==path.resolve(os.tmpdir())||!path.basename(report.profile).startsWith('wlb-project-real-'))throw Error('Requires the passed, owned real-model acceptance profile.');
const root=path.join(report.profile,'companion-bot-v2'),db=new Database(path.join(root,'bot.sqlite'),{readonly:true});
const digest=value=>createHash('sha256').update(value).digest('hex');
try{
  const events=db.prepare(`SELECT i.id,i.companion_id,m.value FROM bot_topic_events t JOIN bot_inbox i ON i.id=t.event_id
    JOIN bot_metadata m ON m.key='native-input:'||i.id WHERE t.topic_id=? ORDER BY i.sequence`).all(report.originalTopic.id);
  const proofs=[],sessions={},nativeReceipts=[];let lastDelivery;
  const verify=(files,owner,kind)=>{for(const file of files){if(!path.isAbsolute(file.path))throw Error('Input path is not absolute.');const sha256=digest(fs.readFileSync(file.path));if(sha256!==file.sha256)throw Error('Input hash changed.');proofs.push({owner,kind,name:file.name,path:file.path,sha256});}};
  for(const event of events){
    verify(JSON.parse(JSON.parse(event.value).prompt).files,event.companion_id,'native-input');
    const workspace=path.join(root,'workspaces',digest(event.companion_id)),receiptPath=path.join(workspace,'.worldlinebox-brain',digest(event.id)+'.json');
    const receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'));if(receipt.status!=='complete'||receipt.result?.status!=='succeeded')throw Error('Native task receipt is not complete.');
    (sessions[event.companion_id]??=new Set()).add(receipt.result.sessionId);nativeReceipts.push({eventId:event.id,companionId:event.companion_id,sessionId:receipt.result.sessionId,artifactCount:receipt.result.artifacts?.length??0});
    for(const file of receipt.result.artifacts??[])if(path.basename(file.path)==='topic-project.zip'){
      const entries=new AdmZip(file.path).getEntries().map(entry=>entry.entryName);if(!entries.some(name=>name.endsWith('ledger.mjs'))||!entries.some(name=>name.endsWith('qa.json')))throw Error('Native ZIP is missing project outputs.');
      fs.copyFileSync(file.path,path.resolve('artifacts/companion-topic-real/topic-project.zip'));report.deliveryProof={source:file.path,sha256:digest(fs.readFileSync(file.path)),entries};
      lastDelivery={eventId:event.id,sha256:report.deliveryProof.sha256};
    }
  }
  const guidance=db.prepare(`SELECT g.*,i.companion_id FROM bot_guidance g JOIN bot_inbox i ON i.id=g.event_id WHERE g.conversation_id=?`).all(report.groupId);
  for(const command of guidance){
    if(command.status!=='accepted')throw Error('Guidance not accepted.');verify(JSON.parse(command.text).files,command.companion_id,'native-steering');
    const receipt=JSON.parse(fs.readFileSync(path.join(root,'workspaces',digest(command.companion_id),'.worldlinebox-brain',digest(command.event_id+':guidance:'+command.message_id)+'.json'),'utf8'));
    if(receipt.status!=='accepted'||receipt.sessionId!==report.mainSession)throw Error('Guidance receipt belongs to another native Session.');
  }
  if(!proofs.some(file=>file.kind==='native-steering'&&file.name==='补充资料.md')||!proofs.some(file=>file.owner==='claude'&&file.name==='补充资料.md')||!proofs.some(file=>file.owner==='gpt'&&file.name==='补充资料.md'))throw Error('Supplemental attachment did not reach every actual collaborator.');
  const mainBrain=path.join(root,'workspaces',digest('builtin-dafeiyu'),'.worldlinebox-brain');
  const compactions=fs.readdirSync(mainBrain).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(fs.readFileSync(path.join(mainBrain,name),'utf8'))).filter(receipt=>receipt.eventId?.startsWith('manual-compact:')&&receipt.status==='complete'&&receipt.compacted===true);
  if(!compactions.length)throw Error('Missing successful native compaction receipt.');
  if(lastDelivery){const published=db.prepare('SELECT attachments_json FROM bot_messages WHERE event_id=? AND sender_id=?').get(lastDelivery.eventId,'builtin-dafeiyu');
    const zip=JSON.parse(published.attachments_json).find(file=>file.name==='topic-project.zip');if(zip?.sha256!==lastDelivery.sha256)throw Error('Final native ZIP and its chat attachment differ.');report.deliveryProof.chatAttachmentMatches=true;}
  const finalTests=path.resolve('artifacts/companion-topic-real/project-tests-final.txt');if(fs.existsSync(finalTests)){const log=fs.readFileSync(finalTests,'utf8'),passed=/^# pass (\d+)\r?$/m.exec(log);if(!passed||!/^# fail 0\r?$/m.test(log))throw Error('Final project tests did not pass.');report.finalProjectTests={passed:Number(passed[1]),log:'project-tests-final.txt'};}
  report.nativeInputProofs=proofs;report.nativeReceipts=nativeReceipts;report.roleProof={mainCompanion:'builtin-dafeiyu',mainSessionsForProject:[...sessions['builtin-dafeiyu']],workerSessions:Object.fromEntries(Object.entries(sessions).filter(([owner])=>owner!=='builtin-dafeiyu').map(([owner,ids])=>[owner,[...ids]])),routerModelSessions:0,scope:'original project topic; independent user topics excluded'};
  report.nativeCompactionReceipts=compactions.map(receipt=>({eventId:receipt.eventId,status:receipt.status,compacted:receipt.compacted}));
  fs.writeFileSync(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,verifiedInputs:proofs.length,nativeReceipts:nativeReceipts.length,roleProof:report.roleProof,compactions:compactions.length,zipSaved:!!report.deliveryProof}));
}finally{db.close();}

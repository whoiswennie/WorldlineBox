import {afterEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {watch} from 'node:fs';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink,readdir,open,truncate,rename} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {BotMediaService} from '../../src/main/companion-bot/media-service';
import {BOT_MEDIA_PREVIEW_LIMITS} from '../../src/shared/companion-bot-media';
import type * as NativeFs from 'node:fs';
import type * as NativeFsPromises from 'node:fs/promises';

const protectedReads=vi.hoisted(()=>new Set<string>());
vi.mock('node:fs',async importOriginal=>{
  const actual=await importOriginal<typeof NativeFs>();
  return{...actual,createReadStream:(...args:Parameters<typeof actual.createReadStream>)=>{if(protectedReads.has(String(args[0])))throw new Error('Unexpected automatic attachment read');return actual.createReadStream(...args);}};
});
vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof NativeFsPromises>();
  const guard=(file:unknown)=>{if(protectedReads.has(String(file)))throw new Error('Unexpected automatic attachment read');};
  return{...actual,readFile:(...args:Parameters<typeof actual.readFile>)=>{guard(args[0]);return actual.readFile(...args);},open:(...args:Parameters<typeof actual.open>)=>{guard(args[0]);return actual.open(...args);}};
});

const roots:string[]=[];
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
afterEach(async()=>{protectedReads.clear();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'wlb-media-transfer-'));roots.push(root);
  const options={root:path.join(root,'media'),builtinRoot:path.resolve('resources/bot-stickers')};
  const home=(conversation:string)=>path.join(options.root,'conversations',hash(conversation));
  return{root,options,home,media:new BotMediaService(options)};
}
function wave(){
  const bytes=Buffer.alloc(44+32000);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);
  bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(16000,24);bytes.writeUInt32LE(32000,28);
  bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(32000,40);return bytes;
}

it('transfers only explicit registered IDs with original names, MIME, bytes and a target-scoped stable reference',async()=>{
  const {root,media,home,options}=await fixture(),sources=['订单 原始.csv','同内容另名.csv','不应转交.txt'].map(name=>path.join(root,name));
  await writeFile(sources[0]!,'订单,金额\n甲,123\n');await writeFile(sources[1]!,await readFile(sources[0]!));await writeFile(sources[2]!,'unrelated private data');
  const [a,b,privateFile]=await media.importFiles({conversationId:'alice',paths:sources});
  // A broken unrelated object must not be traversed or read by this operation.
  await symlink(path.join(root,'absent'),path.join(home('alice'),'objects','unrelated-junction'),'junction');
  const transferred=await media.transferToConversation({sourceConversationId:'alice',targetConversationId:'bob',attachmentIds:[b!.id,a!.id,b!.id]});
  expect(transferred).toHaveLength(2);expect(transferred.map(item=>item.name)).toEqual([b!.name,a!.name]);expect(transferred[0]!.id).not.toBe(b!.id);
  for(const [index,ref] of transferred.entries()){
    const source=[b!,a!][index]!;expect(ref).toMatchObject({name:source.name,originalName:source.originalName,mimeType:source.mimeType,size:source.size,sha256:source.sha256,kind:'file',storage:'managed'});
    const target=await media.getForAgent('bob',ref.id);expect(await readFile(target.path)).toEqual(await readFile(sources[0]!));expect(target.path.startsWith(home('bob')+path.sep)).toBe(true);
    expect(JSON.stringify(ref)).not.toContain(root);expect(ref.url).not.toBe(source.url);
  }
  expect(transferred[0]!.id).not.toBe(transferred[1]!.id);
  expect((await media.listMedia('bob')).map(item=>item.id)).toEqual(transferred.map(item=>item.id));
  await expect(media.resolveForConversation('bob',[privateFile!.id])).rejects.toThrow('不属于当前会话');
  expect(await readdir(path.join(home('bob'),'objects'))).toEqual([a!.sha256]);
  const restarted=new BotMediaService(options);
  expect(await restarted.transferToConversation({sourceConversationId:'alice',targetConversationId:'bob',attachmentIds:[b!.id,a!.id]})).toEqual(transferred);
  expect(await restarted.listMedia('bob')).toEqual(transferred);
});

it('preserves microphone voice metadata and later source transcripts without changing deterministic target IDs',async()=>{
  const {media,options}=await fixture(),bytes=wave(),transcript={text:'请核对两份文件。',audioSeconds:1,engine:'sensevoice-int8-cpu' as const};
  const source=await media.importVoice('alice',bytes,transcript),[first]=await media.transferToConversation({sourceConversationId:'alice',targetConversationId:'bob',attachmentIds:[source.id]});
  expect(first).toMatchObject({name:'语音消息.wav',mimeType:'audio/wav',sha256:hash(bytes),voice:{durationSeconds:1},transcript});
  expect(await readFile((await media.getForAgent('bob',first!.id)).path)).toEqual(bytes);
  const revised={...transcript,text:'请核对三份文件。'};await media.setTranscript('alice',source.id,revised);
  const [retry]=await media.transferToConversation({sourceConversationId:'alice',targetConversationId:'bob',attachmentIds:[source.id]});expect(retry!.id).toBe(first!.id);expect(retry!.transcript).toEqual(revised);
  expect((await new BotMediaService(options).resolveForConversation('bob',[first!.id]))[0]!.transcript).toEqual(revised);
});

it('preserves a clipboard image and its bounded thumbnail without turning its name into an object hash',async()=>{
  const {media}=await fixture(),bytes=await sharp({create:{width:40,height:24,channels:4,background:'#eeaa88'}}).png().toBuffer(),source=await media.importClipboardImage('alice',bytes);
  const [target]=await media.transferToConversation({sourceConversationId:'alice',targetConversationId:'bob',attachmentIds:[source.id]});
  expect(target).toMatchObject({name:'剪贴板图片.png',mimeType:'image/png',sha256:hash(bytes),width:40,height:24});expect(target!.previewUrl).toBeTruthy();expect(target!.previewUrl).not.toBe(source.previewUrl);
  const sourcePreview=await(await media.response(new Request(source.previewUrl!))).arrayBuffer(),targetPreview=await(await media.response(new Request(target!.previewUrl!))).arrayBuffer();expect(targetPreview).toEqual(sourcePreview);
});

it('rejects unknown IDs, another conversation scope, builtins and traversal before publishing any target reference',async()=>{
  const {root,media}=await fixture(),source=path.join(root,'explicit.txt');await writeFile(source,'explicit');const [ref]=await media.importFiles({conversationId:'alice',paths:[source]});
  for(const ids of [[],['unknown'],[ref!.id,'unknown'],['../objects/secret'],Array(65).fill(ref!.id)])await expect(media.transferToConversation({sourceConversationId:'alice',targetConversationId:'bob',attachmentIds:ids})).rejects.toThrow();
  await expect(media.transferToConversation({sourceConversationId:'other',targetConversationId:'bob',attachmentIds:[ref!.id]})).rejects.toThrow('不属于源会话');
  const packs=await media.listPacks({conversationId:'alice'}),builtin=(await media.listStickers({conversationId:'alice',packId:packs[0]!.id}))[0]!;
  await expect(media.transferToConversation({sourceConversationId:'alice',targetConversationId:'bob',attachmentIds:[builtin.id]})).rejects.toThrow('不属于源会话');
  for(const conversation of ['../escape','bad\0id'])await expect(media.transferToConversation({sourceConversationId:'alice',targetConversationId:conversation,attachmentIds:[ref!.id]})).rejects.toThrow('会话无效');
  expect(await media.listMedia('bob')).toEqual([]);
});

it('rejects a tampered original and refuses to repair over a tampered target during an idempotent retry',async()=>{
  const {root,media}=await fixture(),source=path.join(root,'checked.txt');await writeFile(source,'original');const [ref]=await media.importFiles({conversationId:'alice',paths:[source]});
  const [target]=await media.transferToConversation({sourceConversationId:'alice',targetConversationId:'bob',attachmentIds:[ref!.id]});
  const targetPath=(await media.getForAgent('bob',target!.id)).path;await writeFile(targetPath,'tampered');
  await expect(media.transferToConversation({sourceConversationId:'alice',targetConversationId:'bob',attachmentIds:[ref!.id]})).rejects.toThrow('校验失败');expect(await readFile(targetPath,'utf8')).toBe('tampered');
  const original=(await media.getForAgent('alice',ref!.id)).path;await writeFile(original,'modified');
  await expect(media.transferToConversation({sourceConversationId:'alice',targetConversationId:'carol',attachmentIds:[ref!.id]})).rejects.toThrow('校验失败');expect(await media.listMedia('carol')).toEqual([]);
});

it('rolls back a selected batch after a later object fails without deleting pre-existing target objects',async()=>{
  const {root,media,home}=await fixture(),first=path.join(root,'one.txt'),second=path.join(root,'two.txt');await writeFile(first,'first file');await writeFile(second,'second file');
  const refs=await media.importFiles({conversationId:'alice',paths:[first,second]}),target=path.join(home('bob'),'objects');await mkdir(target,{recursive:true});
  const corrupt=path.join(target,refs[1]!.sha256!);await writeFile(corrupt,'wrong bytes');
  await expect(media.transferToConversation({sourceConversationId:'alice',targetConversationId:'bob',attachmentIds:refs.map(ref=>ref.id)})).rejects.toThrow('校验失败');
  expect(await media.listMedia('bob')).toEqual([]);expect(await readdir(target)).toEqual([refs[1]!.sha256]);expect(await readFile(corrupt,'utf8')).toBe('wrong bytes');
});

it('rejects source or target directory junctions instead of following a path outside the managed domain',async()=>{
  const {root,media,home}=await fixture(),source=path.join(root,'checked.txt');await writeFile(source,'original');const [ref]=await media.importFiles({conversationId:'alice',paths:[source]});
  const outside=path.join(root,'outside');await mkdir(outside);await mkdir(home('bob'),{recursive:true});await symlink(outside,path.join(home('bob'),'objects'),'junction');
  await expect(media.transferToConversation({sourceConversationId:'alice',targetConversationId:'bob',attachmentIds:[ref!.id]})).rejects.toThrow('链接');expect(await readdir(outside)).toEqual([]);
  await rename(path.join(home('alice'),'objects'),path.join(root,'moved-objects'));await symlink(path.join(root,'moved-objects'),path.join(home('alice'),'objects'),'junction');
  await expect(media.transferToConversation({sourceConversationId:'alice',targetConversationId:'carol',attachmentIds:[ref!.id]})).rejects.toThrow('链接');
});

it('rejects a persisted traversal object manifest and a mismatched deterministic target reference',async()=>{
  const {root,media,home,options}=await fixture(),source=path.join(root,'checked.txt');await writeFile(source,'original');const [ref]=await media.importFiles({conversationId:'alice',paths:[source]});
  await media.transferToConversation({sourceConversationId:'alice',targetConversationId:'bob',attachmentIds:[ref!.id]});
  const targetManifest=path.join(home('bob'),'manifest.json'),target=JSON.parse(await readFile(targetManifest,'utf8'));target.media[0].name='other.txt';await writeFile(targetManifest,JSON.stringify(target));
  await expect(new BotMediaService(options).transferToConversation({sourceConversationId:'alice',targetConversationId:'bob',attachmentIds:[ref!.id]})).rejects.toThrow('不一致');
  const sourceManifest=path.join(home('alice'),'manifest.json'),bad=JSON.parse(await readFile(sourceManifest,'utf8'));bad.media[0].object='../outside.txt';await writeFile(sourceManifest,JSON.stringify(bad));
  await expect(new BotMediaService(options).transferToConversation({sourceConversationId:'alice',targetConversationId:'carol',attachmentIds:[ref!.id]})).rejects.toThrow('清单无效');
});

it('does not read, hash or copy an external-only large attachment for an automatic delegation',async()=>{
  const {root,media,home}=await fixture(),source=path.join(root,'large-video.mp4'),handle=await open(source,'wx');await handle.close();
  if(process.platform==='win32')await promisify(execFile)('fsutil.exe',['sparse','setflag',source],{windowsHide:true});
  await truncate(source,BOT_MEDIA_PREVIEW_LIMITS.video+1);protectedReads.add(source);const [ref]=await media.importFiles({conversationId:'alice',paths:[source]});expect(ref).toMatchObject({storage:'external',analysisBlocked:true});
  await expect(media.transferToConversation({sourceConversationId:'alice',targetConversationId:'bob',attachmentIds:[ref!.id]})).rejects.toThrow('不可自动跨会话');
  expect(await media.listMedia('bob')).toEqual([]);expect(await readdir(path.join(home('bob'),'objects'))).toEqual([]);
});

it('honors pre-cancellation and cleans an actual interrupted copy before allowing a complete retry',async()=>{
  const {root,media,home}=await fixture(),source=path.join(root,'interrupt.bin');await writeFile(source,Buffer.alloc(8*1024*1024,87));
  const [ref]=await media.importFiles({conversationId:'alice',paths:[source]}),pre=new AbortController();pre.abort(new Error('Fixture already cancelled'));
  await expect(media.transferToConversation({sourceConversationId:'alice',targetConversationId:'bob',attachmentIds:[ref!.id],signal:pre.signal})).rejects.toThrow('already cancelled');
  const target=path.join(home('bob'),'objects');await mkdir(target,{recursive:true});const controller=new AbortController(),observer=watch(target,{persistent:false},()=>controller.abort(new Error('Fixture interrupted the copy')));
  try{await expect(media.transferToConversation({sourceConversationId:'alice',targetConversationId:'bob',attachmentIds:[ref!.id],signal:controller.signal})).rejects.toBeDefined();expect(controller.signal.aborted).toBe(true);}finally{observer.close();}
  expect(await media.listMedia('bob')).toEqual([]);expect(await readdir(target)).toEqual([]);
  const [retry]=await media.transferToConversation({sourceConversationId:'alice',targetConversationId:'bob',attachmentIds:[ref!.id]});expect(hash(await readFile((await media.getForAgent('bob',retry!.id)).path))).toBe(ref!.sha256);
});

it('serializes duplicate deliveries, permits concurrent opposite transfers and treats a same-scope transfer as a no-op',async()=>{
  const {root,media}=await fixture(),a=path.join(root,'a.txt'),b=path.join(root,'b.txt');await writeFile(a,'alice bytes');await writeFile(b,'bob bytes');
  const [alice]=await media.importFiles({conversationId:'alice',paths:[a]}),[bob]=await media.importFiles({conversationId:'bob',paths:[b]});
  expect(await media.transferToConversation({sourceConversationId:'alice',targetConversationId:'alice',attachmentIds:[alice!.id]})).toEqual([alice]);
  const [first,retry,opposite]=await Promise.all([
    media.transferToConversation({sourceConversationId:'alice',targetConversationId:'bob',attachmentIds:[alice!.id]}),
    media.transferToConversation({sourceConversationId:'alice',targetConversationId:'bob',attachmentIds:[alice!.id]}),
    media.transferToConversation({sourceConversationId:'bob',targetConversationId:'alice',attachmentIds:[bob!.id]}),
  ]);
  expect(retry).toEqual(first);expect(await media.listMedia('bob')).toHaveLength(2);expect(await media.listMedia('alice')).toHaveLength(2);
  expect(await readFile((await media.getForAgent('alice',opposite[0]!.id)).path,'utf8')).toBe('bob bytes');
});

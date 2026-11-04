import {afterEach,expect,it,vi} from 'vitest';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import type * as NativeFs from 'node:fs';
import type sharp from 'sharp';
import {BotMediaService,inspectBotSticker} from '../../src/main/companion-bot/media-service';
import {BOT_MEDIA_PREVIEW_LIMITS,botMediaPreviewPolicy} from '../../src/shared/companion-bot-media';
const trace=vi.hoisted(()=>({protected:new Set<string>(),attempts:[] as string[],copyAllowed:false,sharp:0}));
vi.mock('node:fs',async importOriginal=>{const actual=await importOriginal<typeof NativeFs>();return{...actual,createReadStream:(...args:Parameters<typeof actual.createReadStream>)=>{if(trace.protected.has(String(args[0]))){trace.attempts.push('stream:'+String(args[0]));throw new Error('LARGE_MEDIA_READ_FORBIDDEN');}return actual.createReadStream(...args);}};});
vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof fs>();
  const guard=(operation:string,file:unknown)=>{if(trace.protected.has(String(file))){trace.attempts.push(operation+':'+String(file));throw new Error('LARGE_MEDIA_READ_FORBIDDEN');}};
  return{...actual,readFile:(...args:Parameters<typeof actual.readFile>)=>{guard('readFile',args[0]);return actual.readFile(...args);},
    open:(...args:Parameters<typeof actual.open>)=>{guard('open',args[0]);return actual.open(...args);},
    copyFile:(...args:Parameters<typeof actual.copyFile>)=>{if(!trace.copyAllowed)guard('copyFile',args[0]);return actual.copyFile(...args);}};
});
vi.mock('sharp',async importOriginal=>{const actual=await importOriginal<{default:typeof sharp}>();return{...actual,default:(...args:Parameters<typeof sharp>)=>{trace.sharp++;return actual.default(...args);}};});
const roots:string[]=[];
afterEach(async()=>{trace.protected.clear();trace.attempts.length=0;trace.copyAllowed=false;trace.sharp=0;for(const root of roots.splice(0))await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'bot-media-large-'));roots.push(root);const media=new BotMediaService({root:path.join(root,'media'),builtinRoot:path.resolve('resources/bot-stickers')});return{root,media};}
async function sparse(file:string,size:number){
  const handle=await fs.open(file,'wx');await handle.close();
  if(process.platform==='win32')await promisify(execFile)('fsutil.exe',['sparse','setflag',file],{windowsHide:true});
  await fs.truncate(file,size);trace.protected.add(file);
}
it('uses inclusive image/video/audio limits and leaves unknown huge files external-only',()=>{
  for(const kind of ['image','video','audio'] as const){const limit=BOT_MEDIA_PREVIEW_LIMITS[kind];
    expect(botMediaPreviewPolicy({mimeType:kind+'/fixture',size:limit}).previewEligibility).toBe('inline');
    expect(botMediaPreviewPolicy({mimeType:kind+'/fixture',size:limit+1}).previewEligibility).toBe('external-only');
  }
  expect(botMediaPreviewPolicy({name:'资料.md',mimeType:'text/markdown',size:BOT_MEDIA_PREVIEW_LIMITS.text}).previewEligibility).toBe('text');
  expect(botMediaPreviewPolicy({name:'资料.txt',mimeType:'text/plain',size:BOT_MEDIA_PREVIEW_LIMITS.text+1}).previewEligibility).toBe('external-only');
  expect(botMediaPreviewPolicy({mimeType:'application/octet-stream',size:500*1024*1024+1}).previewEligibility).toBe('external-only');
  expect(botMediaPreviewPolicy({mimeType:'application/pdf',size:200}).previewEligibility).toBe('file-only');
});
it('registers sparse oversized image/video/audio by metadata without opening, hashing, copying or decoding bytes',async()=>{
  const {root,media}=await fixture();const cases=[['picture.png',BOT_MEDIA_PREVIEW_LIMITS.image+1],['movie.mp4',BOT_MEDIA_PREVIEW_LIMITS.video+1],['sound.mp3',BOT_MEDIA_PREVIEW_LIMITS.audio+1],['unknown.bin',BOT_MEDIA_PREVIEW_LIMITS.video+1]] as const;
  const sources:string[]=[];for(const [name,size] of cases){const value=path.join(root,name);await sparse(value,size);sources.push(value);}
  const refs=await media.importFiles({conversationId:'a',paths:sources});expect(refs).toHaveLength(4);
  for(const ref of refs){expect(ref).toMatchObject({storage:'external',analysisBlocked:true,previewEligibility:'external-only'});expect(ref.sha256).toBeUndefined();expect(ref.previewUrl).toBeUndefined();expect(JSON.stringify(ref)).not.toContain(root);
    expect((await media.response(new Request(ref.url))).status).toBe(403);expect((await media.response(new Request(ref.url+'/preview'))).status).toBe(403);
    await expect(media.getForAgent('a',ref.id)).rejects.toThrow('不可直接读取');}
  const task=path.join(root,'task');await fs.mkdir(task);await expect(media.stageForTask({conversationId:'a',attachmentIds:[refs[0]!.id],destination:task})).rejects.toThrow('不可直接读取');expect(await fs.readdir(task)).toEqual([]);
  const source=(await media.getForUserOpen('a',refs[0]!.id)).path;expect(source).toBe(sources[0]);expect(await fs.stat(source)).toMatchObject({size:cases[0][1]});
  const restarted=new BotMediaService({root:path.join(root,'media'),builtinRoot:path.resolve('resources/bot-stickers')});expect(await restarted.resolveForConversation('a',refs.map(ref=>ref.id))).toEqual(refs);
  await expect(restarted.resolveForConversation('b',[refs[0]!.id])).rejects.toThrow('不属于当前会话');
  const [scope]=await fs.readdir(path.join(root,'media/conversations'));expect(await fs.readdir(path.join(root,'media/conversations',scope!,'objects'))).toEqual([]);
  expect(trace.attempts).toEqual([]);expect(trace.sharp).toBe(0);
});
it('checks the unified 200MiB sticker limit before parsing or copying and refuses changed external references',async()=>{
  const {root,media}=await fixture(),directory=path.join(root,'huge-pack');await fs.mkdir(directory);const image=path.join(directory,'huge.webp');await sparse(image,BOT_MEDIA_PREVIEW_LIMITS.image+1);
  await expect(inspectBotSticker(image)).rejects.toThrow('200MB');await expect(media.importStickerPack({conversationId:'a',directory})).rejects.toThrow('200MB');
  const [ref]=await media.importFiles({conversationId:'a',paths:[image]});await fs.utimes(image,new Date(0),new Date(0));
  await expect(media.getForUserOpen('a',ref!.id)).rejects.toThrow('已更改');expect(trace.attempts).toEqual([]);expect(trace.sharp).toBe(0);expect((await fs.stat(image)).size).toBe(BOT_MEDIA_PREVIEW_LIMITS.image+1);
});
it('copies external originals only for an explicit save, and opens managed files through an editable named copy',async()=>{
  const {root,media}=await fixture(),source=path.join(root,'large.png');await sparse(source,BOT_MEDIA_PREVIEW_LIMITS.image+1);const [external]=await media.importFiles({conversationId:'a',paths:[source]});
  trace.copyAllowed=true;const saved=path.join(root,'saved.png');await media.saveAttachment({conversationId:'a',id:external!.id,destination:saved});expect((await fs.stat(saved)).size).toBe(external!.size);expect(trace.attempts).toEqual([]);trace.copyAllowed=false;
  const small=path.join(root,'document.txt');await fs.writeFile(small,'canonical bytes');const [ref]=await media.importFiles({conversationId:'a',paths:[small]});
  expect(ref!.sha256).toMatch(/^[a-f0-9]{64}$/);expect(ref!.storage).toBe('managed');
  const opened=await media.getForUserOpen('a',ref!.id);expect(path.basename(opened.path)).toBe('document.txt');expect(opened.path).toContain('open-cache');await fs.writeFile(opened.path,'external app edit');
  expect(await fs.readFile((await media.getForAgent('a',ref!.id)).path,'utf8')).toBe('canonical bytes');expect((await fs.stat(source)).size).toBe(external!.size);
});
it('lazily previews a legacy external image under the new limit without copying it or granting AI analysis access',async()=>{
  const {root,media}=await fixture(),source=path.join(root,'legacy-image.png');
  await fs.writeFile(source,Buffer.from('LEGACY_IMAGE_BYTES'));
  const info=await fs.stat(source),externalSource={path:source,size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs,ino:info.ino,dev:info.dev};
  const digest=(value:string)=>createHash('sha256').update(value).digest('hex'),id='e_'+digest(JSON.stringify(externalSource));
  const home=path.join(root,'media','conversations',digest('a'));await fs.mkdir(path.join(home,'objects'),{recursive:true});
  await fs.writeFile(path.join(home,'manifest.json'),JSON.stringify({schema:1,conversationId:'a',packs:[],media:[{id,name:'legacy-image.png',originalName:'legacy-image.png',mimeType:'image/png',size:info.size,url:'',kind:'file',storage:'external',externalSource,analysisBlocked:true,previewEligibility:'external-only',previewLimitReason:'图片超过 50MB。'}]}));
  const [ref]=await media.listMedia('a');expect(ref).toMatchObject({storage:'external',previewEligibility:'inline',analysisBlocked:true});expect(ref!.previewLimitReason).toBeUndefined();
  expect((await media.response(new Request(ref!.url,{headers:{range:'bytes=0-5'}}))).status).toBe(206);
  expect(await fs.readdir(path.join(home,'objects'))).toEqual([]);
  await expect(media.getForAgent('a',id)).rejects.toThrow('不可直接读取');
  await fs.utimes(source,new Date(0),new Date(0));expect((await media.response(new Request(ref!.url))).status).toBe(404);
});

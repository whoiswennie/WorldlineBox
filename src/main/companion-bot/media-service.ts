import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { open, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import mime from 'mime-types';
import {botMediaPreviewPolicy,botMediaTextFormat,BOT_MEDIA_PREVIEW_LIMITS,normalizeBotMediaMime,type BotMediaRef,type BotStickerPack,type BotMediaTextPage} from '../../shared/companion-bot-media';
import { readBotTextPage } from './media-text';
import { validateSpeechWave, SPEECH_MAX_TRANSCRIPT, type LocalSpeechTranscript } from '../../shared/local-speech';

type ExternalSource={path:string;size:number;mtimeMs:number;ctimeMs:number;ino:number;dev:number};
type StoredMedia = BotMediaRef & { object?: string; externalSource?:ExternalSource; previewObject?:string; previewSha256?:string; previewSize?:number };
type Pack = Omit<BotStickerPack,'count'|'cover'> & { ids:string[] };
interface Manifest { schema:1; conversationId?:string; media:StoredMedia[]; packs:Pack[] }
export interface BotMediaOptions { root:string; builtinRoot:string;canUserAccessConversation?(conversationId:string):boolean|Promise<boolean> }
const hash = (value:string) => createHash('sha256').update(value).digest('hex');
const safeId = (value:string) => typeof value==='string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const fileName = (value:string) => Array.from(path.basename(value),character=>character.charCodeAt(0)<32||character==='/'||character==='\\'?'_':character).join('').slice(0,240) || '附件';
const samePath = (a:string,b:string) => process.platform==='win32' ? a.toLowerCase()===b.toLowerCase() : a===b;
const AUTOMATIC_IMAGE_BYTES=8*1024*1024, AUTOMATIC_IMAGE_PIXELS=20_000_000;

/** Reject links in every existing component, including junctions above a file. */
export async function assertBotMediaPhysicalPath(value:string):Promise<void> {
  if (!path.isAbsolute(value) || value.includes('\0')) throw new Error('媒体路径必须是完整本地路径。');
  const absolute=path.resolve(value), base=path.parse(absolute).root;
  let current=base;
  for(const part of path.relative(base,absolute).split(path.sep).filter(Boolean)) {
    current=path.join(current,part);const info=await lstat(current);
    if(info.isSymbolicLink())throw new Error('媒体路径不能包含链接或目录联接。');
  }
  if(!samePath(path.resolve(await realpath(absolute)),absolute))throw new Error('媒体路径解析到其他位置。');
}
async function ensureDirectory(value:string,signal?:AbortSignal):Promise<void> {
  signal?.throwIfAborted();
  const absolute=path.resolve(value),base=path.parse(absolute).root;let current=base;
  for(const part of path.relative(base,absolute).split(path.sep).filter(Boolean)) {
    signal?.throwIfAborted();
    current=path.join(current,part);
    try{await mkdir(current);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    const info=await lstat(current);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('媒体目录不能包含链接。');
  }
  signal?.throwIfAborted();await assertBotMediaPhysicalPath(absolute);signal?.throwIfAborted();
}
async function digestFile(value:string,signal?:AbortSignal):Promise<{sha256:string;size:number}> {
  signal?.throwIfAborted();
  const digest=createHash('sha256');let size=0;
  for await(const bytes of createReadStream(value,{signal})){signal?.throwIfAborted();digest.update(bytes);size+=bytes.length;}
  return{sha256:digest.digest('hex'),size};
}
/** A cancelled preparation removes only its own incomplete exclusive copy. */
async function copyTaskInput(source:string,destination:string,signal?:AbortSignal):Promise<void>{
  signal?.throwIfAborted();const target=await open(destination,'wx',0o600);let identity:Awaited<ReturnType<typeof target.stat>>|undefined,complete=false,failed=false,failure:unknown;
  const fail=(error:unknown)=>{failure=failed?new AggregateError([failure,error],'任务附件准备清理失败。'):error;failed=true;};
  try{
    identity=await target.stat();
    for await(const bytes of createReadStream(source,{signal})){
      signal?.throwIfAborted();let offset=0;
      while(offset<bytes.length){signal?.throwIfAborted();const written=await target.write(bytes,offset,bytes.length-offset);if(!written.bytesWritten)throw new Error('任务附件写入未取得进展。');offset+=written.bytesWritten;}
    }
    signal?.throwIfAborted();await target.sync();signal?.throwIfAborted();complete=true;
  }catch(error){fail(error);}
  try{await target.close();}catch(error){fail(error);}
  if(!complete&&identity)try{const current=await lstat(destination);if(current.dev===identity.dev&&current.ino===identity.ino&&!current.isSymbolicLink())await rm(destination,{force:true});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')fail(error);}
  if(failed)throw failure;
}
async function atomicManifest(value:string,manifest:Manifest){
  const temporary=value+'.'+randomUUID()+'.tmp';
  try{await writeFile(temporary,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});await rename(temporary,value);}finally{await rm(temporary,{force:true});}
}
export async function inspectBotSticker(value:string):Promise<{mimeType:string;animated:boolean;width?:number;height?:number}> {
  if((await stat(value)).size>BOT_MEDIA_PREVIEW_LIMITS.image)throw new Error('表情图片不能超过 200MB，更大的文件请作为普通附件导入并使用系统软件打开。');
  // Buffer input avoids libvips retaining a Windows file descriptor in its
  // global operation cache after a pack import; original storage stays opaque.
  const bytes=await readFile(value),header=bytes.subarray(0,1024*1024),read=header.length;
  if(bytes.subarray(0,1024).toString('utf8').trimStart().startsWith('<')&&/<!DOCTYPE|<!ENTITY|\bhref\s*=|\burl\s*\(|@import/i.test(bytes.toString('utf8')))throw new Error('SVG 表情不能包含实体或外部引用，请转成普通图片，原文件仍可作为附件发送。');
  if(read>=26&&header.subarray(0,2).toString()==='BM')return{mimeType:'image/bmp',animated:false,width:Math.abs(header.readInt32LE(18)),height:Math.abs(header.readInt32LE(22))};
  if(read>=22&&header.readUInt32LE(0)===0x00010000&&header.readUInt16LE(4)>0)return{mimeType:'image/x-icon',animated:false,width:header[6]||256,height:header[7]||256};
  const info=await sharp(bytes,{animated:true,limitInputPixels:100_000_000}).metadata();
  const types:Record<string,string>={jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',avif:'image/avif',heif:'image/heif',tiff:'image/tiff',svg:'image/svg+xml'};
  let mimeType=info.format&&types[info.format];if(info.format==='heif'&&info.compression==='av1')mimeType='image/avif';if(!mimeType)throw new Error('该文件不是支持的静态图片或动图。');
  let animated=(info.pages||1)>1;
  if(info.format==='png')for(let offset=8;offset+12<=read;){const size=header.readUInt32BE(offset);if(size>read-offset-12)break;if(header.subarray(offset+4,offset+8).toString()==='acTL'){animated=header.readUInt32BE(offset+8)>1;break;}offset+=12+size;}
  return{mimeType,animated,width:info.width,height:info.pageHeight||info.height};
}

/** Independent immutable media store. No asset-library or VCP dependency. */
export class BotMediaService {
  private readonly root:string;
  private readonly builtinRoot:string;
  private readonly canUserAccessConversation?:BotMediaOptions['canUserAccessConversation'];
  private readonly queues=new Map<string,Promise<unknown>>();
  private readonly manifests=new Map<string,Manifest>();
  private builtin?:Promise<Manifest>;
  private readonly verified=new Map<string,string>();
  private readonly externalDigests=new Map<string,{signature:string;sha256:string}>();
  constructor(options:BotMediaOptions){this.root=path.resolve(options.root);this.builtinRoot=path.resolve(options.builtinRoot);this.canUserAccessConversation=options.canUserAccessConversation;}
  private scope(conversationId:string){if(!safeId(conversationId))throw new Error('媒体会话无效。');return hash(conversationId);}
  private async serial<T>(conversationId:string,run:(manifest:Manifest,home:string)=>Promise<T>,signal?:AbortSignal):Promise<T>{
    signal?.throwIfAborted();
    const key=this.scope(conversationId),previous=this.queues.get(key)||Promise.resolve();
    const pending=previous.catch(()=>undefined).then(async()=>{
      signal?.throwIfAborted();const home=path.join(this.root,'conversations',key);await ensureDirectory(path.join(home,'objects'),signal);
      let manifest=this.manifests.get(key);
      if(!manifest){try{await assertBotMediaPhysicalPath(path.join(home,'manifest.json'));manifest=this.validate(JSON.parse(await readFile(path.join(home,'manifest.json'),'utf8')),conversationId);}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;manifest={schema:1,conversationId,media:[],packs:[]};}
        this.manifests.set(key,manifest);while(this.manifests.size>32)this.manifests.delete(this.manifests.keys().next().value!);}
      signal?.throwIfAborted();const working=structuredClone(manifest),result=await run(working,home);signal?.throwIfAborted();this.manifests.set(key,working);return result;
    });
    this.queues.set(key,pending);try{return await pending;}finally{if(this.queues.get(key)===pending)this.queues.delete(key);}
  }
  private validate(raw:unknown,conversationId?:string):Manifest{
    const data=raw as Manifest;
    if(!data||data.schema!==1||data.conversationId!==conversationId||!Array.isArray(data.media)||!Array.isArray(data.packs))throw new Error('媒体目录清单无效。');
    const ids=new Set<string>();
    for(const item of data.media){
      if(!item||!safeId(item.id)||ids.has(item.id)||!Number.isSafeInteger(item.size)||item.size<0||
        !['file','sticker'].includes(item.kind)||typeof item.name!=='string'||item.name!==fileName(item.name)||typeof item.mimeType!=='string')throw new Error('媒体条目清单无效。');
      if(item.storage==='external'){
        const source=item.externalSource;
        if(!conversationId||item.kind!=='file'||item.object||item.sha256||item.previewObject||!source||!path.isAbsolute(source.path)||source.path.includes('\0')||source.size!==item.size||
          ![source.size,source.mtimeMs,source.ctimeMs,source.ino,source.dev].every(Number.isFinite))throw new Error('外部附件清单无效。');
        const signature={path:path.resolve(source.path),size:source.size,mtimeMs:source.mtimeMs,ctimeMs:source.ctimeMs,ino:source.ino,dev:source.dev};
        if(item.id!=='e_'+hash(JSON.stringify(signature)))throw new Error('外部附件 ID 与授权文件元数据不匹配。');
      }else if(!/^[a-f0-9]{64}$/.test(item.sha256||'')||!item.object||!/^objects\/[a-f0-9]{64}(?:\.[a-z0-9]{1,8})?$/.test(item.object)||item.object.split('/')[1]!.split('.')[0]!==item.sha256)throw new Error('媒体对象清单无效。');
      ids.add(item.id);
      if(item.voice&&(!Number.isFinite(item.voice.durationSeconds)||item.voice.durationSeconds<=0||item.voice.durationSeconds>60||item.mimeType!=='audio/wav'))throw Error('语音消息清单无效。');
      if(item.transcript&&(typeof item.transcript.text!=='string'||item.transcript.text.length>SPEECH_MAX_TRANSCRIPT||item.transcript.engine!=='sensevoice-int8-cpu'||!Number.isFinite(item.transcript.audioSeconds)||item.transcript.audioSeconds<0))throw Error('音频转写清单无效。');
      if(item.previewObject&&(!/^objects\/[a-f0-9]{64}\.webp$/.test(item.previewObject)||!/^[a-f0-9]{64}$/.test(item.previewSha256||'')||item.previewObject!==`objects/${item.previewSha256}.webp`||!Number.isSafeInteger(item.previewSize)||(item.previewSize??-1)<0))throw new Error('表情预览清单无效。');
    }
    for(const pack of data.packs)if(!pack||!safeId(pack.id)||typeof pack.name!=='string'||!Array.isArray(pack.ids)||pack.ids.some(id=>!ids.has(id)))throw new Error('表情包清单无效。');
    return data;
  }
  private async builtins(){
    this.builtin??=(async()=>{await assertBotMediaPhysicalPath(path.join(this.builtinRoot,'manifest.json'));
      return this.validate(JSON.parse(await readFile(path.join(this.builtinRoot,'manifest.json'),'utf8')));})();
    return this.builtin;
  }
  private reference(item:StoredMedia,conversationId?:string):BotMediaRef{
    const ref={...item};
    delete ref.object;delete ref.externalSource;delete ref.previewObject;delete ref.previewSha256;delete ref.previewSize;delete ref.previewUrl;delete ref.previewEligibility;delete ref.previewLimitReason;
    const url=conversationId?`worldlinebox://bot-media/conversation/${this.scope(conversationId)}/${item.id}`:`worldlinebox://bot-media/builtin/${item.id}`;
    const mimeType=normalizeBotMediaMime(item.originalName||item.name,item.mimeType),current={name:item.originalName||item.name,mimeType,size:item.size};
    const policy=botMediaPreviewPolicy(current);
    return{...ref,mimeType,url,storage:item.storage||'managed',...policy,...(policy.previewEligibility==='external-only'?{analysisBlocked:true}:{}),...(item.previewObject&&policy.previewEligibility==='inline'?{previewUrl:url+'/preview'}:{})};
  }
  private packReference(pack:Pack,manifest:Manifest,conversationId?:string):BotStickerPack{
    const cover=manifest.media.find(item=>item.id===pack.ids[0]);return{id:pack.id,name:pack.name,builtin:pack.builtin,count:pack.ids.length,...(cover?{cover:this.reference(cover,conversationId)}:{})};
  }
  async listPacks({conversationId}:{conversationId:string}):Promise<BotStickerPack[]>{
    const builtin=await this.builtins();return this.serial(conversationId,async manifest=>[
      ...builtin.packs.map(pack=>this.packReference(pack,builtin)),...manifest.packs.map(pack=>this.packReference(pack,manifest,conversationId)),
    ]);
  }
  async listStickers({conversationId,packId}:{conversationId:string;packId:string}):Promise<BotMediaRef[]>{
    if(!safeId(packId))throw new Error('表情包 ID 无效。');const builtin=await this.builtins();
    const pack=builtin.packs.find(pack=>pack.id===packId);if(pack)return pack.ids.map(id=>this.reference(builtin.media.find(item=>item.id===id)!));
    return this.serial(conversationId,async manifest=>{const pack=manifest.packs.find(pack=>pack.id===packId);if(!pack)throw new Error('当前会话没有此表情包。');return pack.ids.map(id=>this.reference(manifest.media.find(item=>item.id===id)!,conversationId));});
  }
  async listMedia(conversationId:string):Promise<BotMediaRef[]>{return this.serial(conversationId,async manifest=>manifest.media.map(item=>this.reference(item,conversationId)));}
  private async verifyObject(root:string,item:StoredMedia,readContent=true,signal?:AbortSignal):Promise<string>{
    signal?.throwIfAborted();
    if(!item.object||!item.sha256)throw new Error('此附件没有已管理的内容对象。');
    const value=path.join(root,item.object);await assertBotMediaPhysicalPath(value);const info=await stat(value);
    if(!info.isFile()||info.size!==item.size)throw new Error('附件文件与已登记大小不一致。');
    const signature=[info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs,item.sha256].join(':');
    signal?.throwIfAborted();if(readContent&&this.verified.get(value)!==signature){const actual=await digestFile(value,signal);if(actual.sha256!==item.sha256)throw new Error('附件内容校验失败。');this.verified.delete(value);this.verified.set(value,signature);while(this.verified.size>512)this.verified.delete(this.verified.keys().next().value!);}
    return value;
  }
  private async externalSource(source:string):Promise<ExternalSource>{
    await assertBotMediaPhysicalPath(source);const info=await stat(source);if(!info.isFile())throw new Error('只能登记真实文件。');
    if(!Number.isSafeInteger(info.size)||info.size<0)throw new Error('附件大小超出可登记范围。');
    return{path:path.resolve(source),size:info.size,mtimeMs:info.mtimeMs,ctimeMs:info.ctimeMs,ino:info.ino,dev:info.dev};
  }
  private async verifyExternal(item:StoredMedia):Promise<string>{
    const expected=item.externalSource;if(!expected)throw new Error('外部附件引用无效。');const actual=await this.externalSource(expected.path);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('原始外部附件已更改，请重新选择文件。');return actual.path;
  }
  private async importObject(source:string,home:string,maximumSize=BOT_MEDIA_PREVIEW_LIMITS.video):Promise<{object:string;sha256:string;size:number}>{
    await assertBotMediaPhysicalPath(source);const handle=await open(source,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    const temporary=path.join(home,'objects','incoming-'+randomUUID());
    try{
      const before=await handle.stat();if(!before.isFile())throw new Error('只能发送真实文件。');
      if(before.size>maximumSize)throw new Error('文件已超过内嵌处理上限，请重新选择以登记外部引用。');
      const digest=createHash('sha256');let size=0;
      const target=await open(temporary,'wx',0o600);
      try{if(before.size)for await(const bytes of handle.createReadStream({autoClose:false,start:0,end:before.size-1})){digest.update(bytes);size+=bytes.length;let offset=0;while(offset<bytes.length){const written=await target.write(bytes,offset,bytes.length-offset);if(!written.bytesWritten)throw new Error('附件写入未取得进展。');offset+=written.bytesWritten;}}await target.sync();}finally{await target.close();}
      const after=await handle.stat();if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ino!==after.ino||size!==before.size)throw new Error('复制期间文件发生变化，请重试。');
      const sha256=digest.digest('hex'),object='objects/'+sha256;const value=path.join(home,object);
      try{await lstat(value);await this.verifyObject(home,{object,sha256,size} as StoredMedia);}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await rename(temporary,value);}
      return{object,sha256,size};
    }finally{await handle.close();await rm(temporary,{force:true});}
  }
  private async preview(home:string,object:string,limitInputPixels=100_000_000):Promise<Pick<StoredMedia,'previewObject'|'previewSha256'|'previewSize'>>{
    const bytes=await sharp(await readFile(path.join(home,object)),{page:0,pages:1,limitInputPixels}).rotate().resize({width:160,height:160,fit:'inside',withoutEnlargement:true}).webp({quality:80}).toBuffer();
    const previewSha256=createHash('sha256').update(bytes).digest('hex'),previewObject=`objects/${previewSha256}.webp`,target=path.join(home,previewObject);
    try{await writeFile(target,bytes,{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await this.verifyObject(home,{object:previewObject,sha256:previewSha256,size:bytes.length} as StoredMedia);}
    return{previewObject,previewSha256,previewSize:bytes.length};
  }
  private async attachmentImagePreview(home:string,object:string,size:number):Promise<Partial<StoredMedia>>{
    // Chat thumbnails must not decode a large source or an entire animation.
    // Larger originals remain available through an explicit viewer click.
    if(size>AUTOMATIC_IMAGE_BYTES)return{};
    const info=await inspectBotSticker(path.join(home,object));
    const dimensions={mimeType:info.mimeType,width:info.width,height:info.height};
    if(!info.width||!info.height||info.width*info.height>AUTOMATIC_IMAGE_PIXELS)return dimensions;
    return{...dimensions,...await this.preview(home,object,AUTOMATIC_IMAGE_PIXELS)};
  }
  async importFiles({conversationId,paths}:{conversationId:string;paths:string[]}):Promise<BotMediaRef[]>{
    if(!paths.length||paths.length>64)throw new Error('一次请选择 1 至 64 个附件。');
    return this.serial(conversationId,async(manifest,home)=>{
      const result:StoredMedia[]=[];
      for(const source of [...new Set(paths)]){
        const metadata=await this.externalSource(source),declaredMime=normalizeBotMediaMime(fileName(source),mime.lookup(source)||'application/octet-stream'),policy=botMediaPreviewPolicy({name:fileName(source),mimeType:declaredMime,size:metadata.size});
        if(policy.previewEligibility==='external-only'){
          const id='e_'+hash(JSON.stringify(metadata));let item=manifest.media.find(item=>item.id===id);
          if(!item){item={id,name:fileName(source),originalName:fileName(source),mimeType:declaredMime,size:metadata.size,url:'',kind:'file',storage:'external',externalSource:metadata,analysisBlocked:true,...policy};manifest.media.push(item);}result.push(item);continue;
        }
        const maximumSize=declaredMime.startsWith('image/')?BOT_MEDIA_PREVIEW_LIMITS.image:declaredMime.startsWith('audio/')?BOT_MEDIA_PREVIEW_LIMITS.audio:BOT_MEDIA_PREVIEW_LIMITS.video;
        const object=await this.importObject(source,home,maximumSize),id='f_'+object.sha256+'_'+hash(fileName(source)).slice(0,8);
        let item=manifest.media.find(item=>item.id===id);if(!item){
          const preview=declaredMime.startsWith('image/')?await this.attachmentImagePreview(home,object.object,object.size).catch(()=>({})):{};
          item={...object,mimeType:declaredMime,...preview,id,name:fileName(source),originalName:fileName(source),url:'',kind:'file'};manifest.media.push(item);}result.push(item);}
      await atomicManifest(path.join(home,'manifest.json'),manifest);return result.map(item=>this.reference(item,conversationId));
    });
  }
  /** Bytes originate in Main's native clipboard, never a renderer path or URL. */
  async importClipboardImage(conversationId:string,bytes:Buffer):Promise<BotMediaRef>{
    if(!bytes.length||bytes.length>BOT_MEDIA_PREVIEW_LIMITS.image)throw Error('剪贴板图片过大。');
    await sharp(bytes,{limitInputPixels:100_000_000}).metadata();
    const sha256=createHash('sha256').update(bytes).digest('hex');
    return this.serial(conversationId,async(manifest,home)=>{
      const id='f_'+sha256+'_clipboard',object='objects/'+sha256;let item=manifest.media.find(item=>item.id===id);
      if(!item){
        try{await writeFile(path.join(home,object),bytes,{flag:'wx',mode:0o600});}
        catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await this.verifyObject(home,{object,sha256,size:bytes.length} as StoredMedia);}
        const preview=await this.attachmentImagePreview(home,object,bytes.length).catch(()=>({}));
        item={...preview,id,object,sha256,size:bytes.length,name:'剪贴板图片.png',mimeType:'image/png',kind:'file',url:''};manifest.media.push(item);
      }
      await atomicManifest(path.join(home,'manifest.json'),manifest);return this.reference(item,conversationId);
    });
  }
  /** Persist only canonical, bounded microphone recordings; no renderer-supplied paths or transcript. */
  async importVoice(conversationId:string,bytes:Buffer,transcript:LocalSpeechTranscript):Promise<BotMediaRef>{
    const durationSeconds=validateSpeechWave(bytes),sha256=createHash('sha256').update(bytes).digest('hex');
    return this.serial(conversationId,async(manifest,home)=>{
      const id='v_'+sha256,object='objects/'+sha256;let item=manifest.media.find(item=>item.id===id);
      if(!item){
        try{await writeFile(path.join(home,object),bytes,{flag:'wx',mode:0o600});}
        catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await this.verifyObject(home,{object,sha256,size:bytes.length} as StoredMedia);}
        item={id,object,sha256,size:bytes.length,name:'语音消息.wav',mimeType:'audio/wav',kind:'file',url:'',voice:{durationSeconds},transcript};manifest.media.push(item);
      }
      await atomicManifest(path.join(home,'manifest.json'),manifest);return this.reference(item,conversationId);
    });
  }
  async setTranscript(conversationId:string,id:string,transcript:LocalSpeechTranscript):Promise<BotMediaRef>{
    if(transcript.text.length>SPEECH_MAX_TRANSCRIPT||!Number.isFinite(transcript.audioSeconds)||transcript.audioSeconds<0)throw Error('转写结果无效。');
    return this.serial(conversationId,async(manifest,home)=>{
      const item=manifest.media.find(item=>item.id===id);if(!item||!item.mimeType.startsWith('audio/'))throw Error('音频不属于当前会话。');
      item.transcript=transcript;await atomicManifest(path.join(home,'manifest.json'),manifest);return this.reference(item,conversationId);
    });
  }
  async importStickerPack({conversationId,directory}:{conversationId:string;directory:string}):Promise<BotStickerPack>{
    await assertBotMediaPhysicalPath(directory);if(!(await stat(directory)).isDirectory())throw new Error('请选择表情包文件夹。');
    const {readdir}=await import('node:fs/promises');const sources:string[]=[];
    const scan=async(folder:string)=>{for(const entry of await readdir(folder,{withFileTypes:true})){if(entry.isSymbolicLink())throw new Error('表情包不能包含链接。');const value=path.join(folder,entry.name);if(entry.isDirectory())await scan(value);else if(entry.isFile()&&/\.(?:png|apng|jpe?g|gif|webp|avif|hei[cf]|tiff?|svg|bmp|ico)$/i.test(entry.name)){sources.push(value);if(sources.length>2000)throw new Error('每个表情包最多 2000 张图片。');}}};
    await scan(directory);sources.sort();if(!sources.length)throw new Error('文件夹内没有支持的图片或动图。');
    for(const source of sources)if((await this.externalSource(source)).size>BOT_MEDIA_PREVIEW_LIMITS.image)throw new Error('表情图片超过 200MB，请作为普通附件导入并使用系统软件打开。');
    return this.serial(conversationId,async(manifest,home)=>{
      const items:Array<StoredMedia>=[],logicalNames:string[]=[];for(const source of sources){const object=await this.importObject(source,home,BOT_MEDIA_PREVIEW_LIMITS.image),details=await inspectBotSticker(path.join(home,object.object));
        const preview=await this.preview(home,object.object).catch(error=>{if(['image/bmp','image/x-icon'].includes(details.mimeType))return{};throw error;});
        const originalName=fileName(source),name=originalName.slice(0,originalName.length-path.extname(originalName).length).replace(/[-_]/g,' ');
        items.push({...object,...details,...preview,id:'',name,originalName,tags:[fileName(directory),name],description:`用户导入的表情，源文件标注：${name}。`,url:'',kind:'sticker'});logicalNames.push(path.relative(directory,source).replaceAll('\\','/'));}
      const packId='pack_'+hash(JSON.stringify([fileName(directory),items.map((item,index)=>[logicalNames[index],item.sha256])])).slice(0,32);
      const pack:Pack={id:packId,name:fileName(directory),builtin:false,ids:[]};
      for(const [index,item] of items.entries()){item.id='s_'+item.sha256+'_'+hash(logicalNames[index]!).slice(0,8)+'_'+packId.slice(-8);item.packId=packId;pack.ids.push(item.id);if(!manifest.media.some(old=>old.id===item.id))manifest.media.push(item);}
      if(!manifest.packs.some(old=>old.id===packId))manifest.packs.push(pack);await atomicManifest(path.join(home,'manifest.json'),manifest);
      return this.packReference(pack,manifest,conversationId);
    });
  }
  async resolveForConversation(conversationId:string,ids:string[],signal?:AbortSignal):Promise<BotMediaRef[]>{
    signal?.throwIfAborted();if(ids.length>64||ids.some(id=>!safeId(id)))throw new Error('附件 ID 无效。');const builtin=await this.builtins();signal?.throwIfAborted();
    return this.serial(conversationId,async(manifest,home)=>{const result:BotMediaRef[]=[];for(const id of [...new Set(ids)]){
      const common=builtin.media.find(item=>item.id===id),item=common||manifest.media.find(item=>item.id===id);if(!item)throw new Error('附件不属于当前会话。');
      signal?.throwIfAborted();if(item.storage==='external')await this.verifyExternal(item);else await this.verifyObject(common?this.builtinRoot:home,item,botMediaPreviewPolicy(item).previewEligibility!=='external-only',signal);
      signal?.throwIfAborted();result.push(this.reference(item,common?undefined:conversationId));}return result;},signal);
  }
  async getForAgent(conversationId:string,id:string,signal?:AbortSignal):Promise<{ref:BotMediaRef;path:string}>{
    signal?.throwIfAborted();const [ref]=await this.resolveForConversation(conversationId,[id],signal);signal?.throwIfAborted();if(ref?.analysisBlocked||ref?.previewEligibility==='external-only')throw new Error('此大媒体仅支持用户通过系统软件打开，当前任务不可直接读取或分析。');
    return this.sourceForUser(conversationId,id,signal);
  }
  /** Host-only projection. Never persist physical paths in renderer media refs.
   * External-only entries remain blocked for analysis, but their real location
   * and a streaming digest are available for an honest attachment inventory. */
  async verifiedLocalFile(conversationId:string,id:string,signal?:AbortSignal):Promise<{ref:BotMediaRef;path:string}>{
    signal?.throwIfAborted();const source=await this.sourceForUser(conversationId,id,signal);signal?.throwIfAborted();
    if(source.ref.sha256)return source;
    const info=await stat(source.path);signal?.throwIfAborted();const signature=[info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs].join(':');
    const cached=this.externalDigests.get(source.path);
    if(cached?.signature===signature)return{path:source.path,ref:{...source.ref,sha256:cached.sha256}};
    const actual=await digestFile(source.path,signal);
    signal?.throwIfAborted();await this.sourceForUser(conversationId,id,signal);signal?.throwIfAborted();
    if(actual.size!==source.ref.size)throw new Error('附件核验期间大小改变。');
    this.externalDigests.set(source.path,{signature,sha256:actual.sha256});
    while(this.externalDigests.size>512)this.externalDigests.delete(this.externalDigests.keys().next().value!);
    return{path:source.path,ref:{...source.ref,sha256:actual.sha256}};
  }
  private async sourceForUser(conversationId:string,id:string,signal?:AbortSignal):Promise<{ref:BotMediaRef;path:string}>{
    signal?.throwIfAborted();const [ref]=await this.resolveForConversation(conversationId,[id],signal);signal?.throwIfAborted();const builtin=await this.builtins();signal?.throwIfAborted();const common=builtin.media.find(item=>item.id===id);
    if(common)return{ref:ref!,path:await this.verifyObject(this.builtinRoot,common,true,signal)};
    return this.serial(conversationId,async(manifest,home)=>{const item=manifest.media.find(item=>item.id===id)!;return{ref:ref!,path:item.storage==='external'?await this.verifyExternal(item):await this.verifyObject(home,item,ref?.previewEligibility!=='external-only',signal)};},signal);
  }
  async getForUserOpen(conversationId:string,id:string):Promise<{ref:BotMediaRef;path:string}>{
    const source=await this.sourceForUser(conversationId,id);if(source.ref.storage==='external')return source;
    const folder=path.join(this.root,'open-cache',this.scope(conversationId),id);await ensureDirectory(folder);const target=path.join(folder,fileName(source.ref.originalName||source.ref.name));
    // External applications may edit this working copy. Reopening must preserve
    // those edits; the immutable message attachment remains in objects/.
    try{await assertBotMediaPhysicalPath(target);if(!(await stat(target)).isFile())throw new Error('打开副本不是普通文件。');return{ref:source.ref,path:target};}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    await this.saveAttachment({conversationId,id,destination:target});return{ref:source.ref,path:target};
  }
  async readTextPage({conversationId,id,offset,limit}:{conversationId:string;id:string;offset?:number;limit?:number}):Promise<BotMediaTextPage>{
    if(!safeId(id))throw new Error('附件 ID 无效。');
    if(this.canUserAccessConversation&&!await this.canUserAccessConversation(conversationId))throw new Error('附件会话访问权限已撤销。');
    return this.serial(conversationId,async(manifest,home)=>{
      const item=manifest.media.find(item=>item.id===id);if(!item)throw new Error('附件不属于当前会话。');
      const name=item.originalName||item.name,format=botMediaTextFormat({name,mimeType:item.mimeType});
      if(!format||botMediaPreviewPolicy({name,mimeType:item.mimeType,size:item.size}).previewEligibility!=='text')throw new Error('此附件不是 200MB 以内的纯文本，请使用系统软件打开。');
      const file=item.storage==='external'?await this.verifyExternal(item):await this.verifyObject(home,item);
      const page=await readBotTextPage(file,{name,size:item.size,format,offset,limit});
      // Revalidate the source after a page read too; a swapped or edited
      // original cannot inherit a previous attachment's authorization.
      if(item.storage==='external')await this.verifyExternal(item);else await this.verifyObject(home,item);
      if(this.canUserAccessConversation&&!await this.canUserAccessConversation(conversationId))throw new Error('附件会话访问权限已撤销。');
      return page;
    });
  }
  async stageForTask({conversationId,attachmentIds,destination,signal}:{conversationId:string;attachmentIds:string[];destination:string;signal?:AbortSignal}):Promise<Array<{ref:BotMediaRef;path:string;relativePath:string}>>{
    signal?.throwIfAborted();await assertBotMediaPhysicalPath(destination);signal?.throwIfAborted();if(!(await stat(destination)).isDirectory())throw new Error('任务附件目标不是现有工作目录。');
    signal?.throwIfAborted();const refs=await this.resolveForConversation(conversationId,attachmentIds,signal);
    if(refs.some(ref=>ref.analysisBlocked||ref.previewEligibility==='external-only'))throw new Error('附件包含大媒体，仅支持用户系统打开，当前任务不可直接读取或复制分析。');
    signal?.throwIfAborted();const target=path.join(destination,'attachments');await ensureDirectory(target,signal);const result=[];
    for(const ref of refs){signal?.throwIfAborted();const source=await this.getForAgent(conversationId,ref.id,signal);signal?.throwIfAborted();const label=fileName(ref.name),extension=path.extname(label).slice(0,12),limit=Math.min(160,240-ref.id.length-1);
      const name=ref.id+'-'+path.basename(label,path.extname(label)).slice(0,Math.max(1,limit-extension.length))+extension,value=path.join(target,name);
      try{await lstat(value);signal?.throwIfAborted();await assertBotMediaPhysicalPath(value);const actual=await digestFile(value,signal);if(actual.sha256!==ref.sha256)throw new Error('任务目录中的同名附件内容不同。');}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;signal?.throwIfAborted();await copyTaskInput(source.path,value,signal);}
      signal?.throwIfAborted();const actual=await digestFile(value,signal);if(actual.sha256!==ref.sha256)throw new Error('任务附件复制校验失败。');result.push({ref,path:value,relativePath:'attachments/'+name});}
    return result;
  }
  async saveAttachment({conversationId,id,destination}:{conversationId:string;id:string;destination:string}):Promise<void>{
    const source=await this.sourceForUser(conversationId,id);if(!path.isAbsolute(destination)||destination.includes('\0'))throw new Error('附件保存位置无效。');
    if(samePath(path.resolve(destination),path.resolve(source.path)))return;
    await assertBotMediaPhysicalPath(path.dirname(destination));
    try{await assertBotMediaPhysicalPath(destination);if(!(await stat(destination)).isFile())throw new Error('附件保存位置不是普通文件。');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const temporary=path.join(path.dirname(destination),'.worldlinebox-attachment-'+randomUUID()+'.tmp');
    try{const {copyFile}=await import('node:fs/promises');await copyFile(source.path,temporary,constants.COPYFILE_EXCL);
      if(source.ref.sha256){if((await digestFile(temporary)).sha256!==source.ref.sha256)throw new Error('保存附件校验失败。');}
      else{await this.sourceForUser(conversationId,id);if((await stat(temporary)).size!==source.ref.size)throw new Error('外部附件保存大小不一致。');}
      await rename(temporary,destination);}
    finally{await rm(temporary,{force:true});}
  }
  /** A URL resolves only through its exact persisted scope index, never a path. */
  async response(request:Request):Promise<Response>{
    const url=new URL(request.url);if(url.hostname!=='bot-media'||!['GET','HEAD'].includes(request.method))return new Response('Not found',{status:404});
    const parts=url.pathname.split('/').filter(Boolean);const preview=parts.at(-1)==='preview';if(preview)parts.pop();let item:StoredMedia|undefined,home:string;
    if(parts.length===2&&parts[0]==='builtin'&&safeId(parts[1]!)){item=(await this.builtins()).media.find(item=>item.id===parts[1]);home=this.builtinRoot;}
    else if(parts.length===3&&parts[0]==='conversation'&&/^[a-f0-9]{64}$/.test(parts[1]!)&&safeId(parts[2]!)){
      home=path.join(this.root,'conversations',parts[1]!);const manifestPath=path.join(home,'manifest.json');
      try{let manifest=this.manifests.get(parts[1]!);if(!manifest){await assertBotMediaPhysicalPath(manifestPath);manifest=JSON.parse(await readFile(manifestPath,'utf8')) as Manifest;
          if(!manifest.conversationId||this.scope(manifest.conversationId)!==parts[1])throw new Error('Media scope mismatch');manifest=this.validate(manifest,manifest.conversationId);this.manifests.set(parts[1]!,manifest);while(this.manifests.size>32)this.manifests.delete(this.manifests.keys().next().value!);}
        if(this.canUserAccessConversation&&!await this.canUserAccessConversation(manifest.conversationId!))return new Response('Conversation access revoked',{status:403});
        item=manifest.media.find(item=>item.id===parts[2]);}
      catch{return new Response('Not found',{status:404});}
    }else return new Response('Not found',{status:404});
    if(!item)return new Response('Not found',{status:404});
    if(botMediaPreviewPolicy({name:item.originalName||item.name,mimeType:item.mimeType,size:item.size}).previewEligibility==='external-only')return new Response('External media requires an explicit system-open action',{status:403});
    if(preview){if(!item.previewObject||!item.previewSha256||item.previewSize===undefined)return new Response('Not found',{status:404});item={...item,object:item.previewObject,sha256:item.previewSha256,size:item.previewSize,mimeType:'image/webp'};}
    try{
      const file=item.storage==='external'?await this.verifyExternal(item):await this.verifyObject(home!,item);const headers=new Headers({'content-type':normalizeBotMediaMime(item.originalName||item.name,item.mimeType),'content-length':String(item.size),'accept-ranges':'bytes',
        'x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'cache-control':parts[0]==='builtin'?'private, max-age=31536000, immutable':'private, no-store',
        'content-disposition':`${item.kind==='sticker'?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(item.name)}`});
      let start=0,end=item.size-1,status=200;const range=request.headers.get('range');
      if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||(!match[1]&&!match[2]))return new Response(null,{status:416,headers:{'content-range':`bytes */${item.size}`}});
        if(!match[1])start=Math.max(0,item.size-Number(match[2]));else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=item.size)return new Response(null,{status:416,headers:{'content-range':`bytes */${item.size}`}});
        status=206;headers.set('content-range',`bytes ${start}-${end}/${item.size}`);headers.set('content-length',String(end-start+1));}
      if(request.method==='HEAD'||item.size===0)return new Response(null,{status,headers});
      const stream=createReadStream(file,{start,end});request.signal.addEventListener('abort',()=>stream.destroy(),{once:true});
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>,{status,headers});
    }catch{return new Response('Media unavailable',{status:404});}
  }
}

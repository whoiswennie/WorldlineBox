import {afterEach,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {deflateSync} from 'node:zlib';
import {BotMediaService} from '../../src/main/companion-bot/media-service';
import {botMediaRequestSchema} from '../../src/shared/companion-bot-media';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});});
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'bot-media-test-'));roots.push(root);return{root,media:new BotMediaService({root:path.join(root,'media'),builtinRoot:path.resolve('resources/bot-stickers')})};}
it('preserves all 91 builtin originals, real content types, frames and separate static previews',async()=>{
  const {media}=await fixture(),packs=await media.listPacks({conversationId:'a'});
  expect(packs.map(pack=>[pack.name,pack.count])).toEqual([['八千代',17],['彩叶',8],['辉夜',21],['通用',45]]);
  const all=(await Promise.all(packs.map(pack=>media.listStickers({conversationId:'a',packId:pack.id})))).flat();
  expect(all).toHaveLength(91);expect(all.filter(item=>item.mimeType==='image/webp'&&item.animated)).toHaveLength(88);expect(all.filter(item=>item.mimeType==='image/avif')).toHaveLength(3);
  for(const item of all){const response=await media.response(new Request(item.url));expect(response.status).toBe(200);const bytes=new Uint8Array(await response.arrayBuffer());expect(hash(bytes)).toBe(item.sha256);expect(bytes.byteLength).toBe(item.size);expect(item.originalName).toBeTruthy();expect(item.tags?.length).toBeGreaterThan(0);expect(item.description).toBeTruthy();}
  const animated=all.find(item=>item.animated)!,preview=await media.response(new Request(animated.previewUrl!));
  const detail=await sharp(Buffer.from(await preview.arrayBuffer())).metadata();expect(detail.format).toBe('webp');expect(detail.pages||1).toBe(1);expect(detail.width).toBeLessThanOrEqual(160);
  const unnamed=all.find(item=>item.originalName==='110.jpg')!;expect(unnamed.name).toBe('遇到困难请拨打');expect(unnamed.tags).toContain('求助');
});
it('copies arbitrary binary files, persists stable ids and confines access to their exact conversation',async()=>{
  const {root,media}=await fixture(),source=path.join(root,'arbitrary.payload'),bytes=Buffer.from(Array.from({length:131073},(_,i)=>i%251));await writeFile(source,bytes);
  const [[first],[retry]]=await Promise.all([media.importFiles({conversationId:'a',paths:[source]}),media.importFiles({conversationId:'a',paths:[source]})]);
  expect(retry).toEqual(first);expect(first).toMatchObject({kind:'file',name:'arbitrary.payload',size:bytes.length,sha256:hash(bytes),mimeType:'application/octet-stream'});
  expect(JSON.stringify(first)).not.toContain(root);expect(first!.url).toMatch(/^worldlinebox:\/\/bot-media\/conversation\/[a-f0-9]{64}\//);
  await writeFile(source,'changed original');const stored=await media.getForAgent('a',first!.id);expect(await readFile(stored.path)).toEqual(bytes);
  await expect(media.resolveForConversation('b',[first!.id])).rejects.toThrow('不属于当前会话');
  const restarted=new BotMediaService({root:path.join(root,'media'),builtinRoot:path.resolve('resources/bot-stickers')});expect(await restarted.resolveForConversation('a',[first!.id])).toEqual([first]);
  const tampered=new URL(first!.url);tampered.pathname=tampered.pathname.replace(/\/conversation\/[^/]+/,`/conversation/${hash(Buffer.from('b'))}`);
  expect((await media.response(new Request(tampered))).status).toBe(404);
  await writeFile(stored.path,Buffer.alloc(bytes.length,1));await expect(media.resolveForConversation('a',[first!.id])).rejects.toThrow('校验失败');
});
it('creates bounded image thumbnails and keeps large encodings or canvases opaque until explicit opening',async()=>{
  const {root,media}=await fixture(),small=path.join(root,'截图.png'),wide=path.join(root,'大画布.svg'),large=path.join(root,'大编码.png');
  const bytes=await sharp({create:{width:320,height:240,channels:4,background:'#4488ff'}}).png().toBuffer();await writeFile(small,bytes);
  await writeFile(wide,'<svg xmlns="http://www.w3.org/2000/svg" width="6000" height="5000"><rect width="6000" height="5000" fill="red"/></svg>');
  await writeFile(large,Buffer.alloc(8*1024*1024+1));
  const [picture,canvas,encoded]=await media.importFiles({conversationId:'a',paths:[small,wide,large]});
  expect(picture).toMatchObject({mimeType:'image/png',width:320,height:240});expect(picture!.previewUrl).toBeTruthy();
  const preview=await media.response(new Request(picture!.previewUrl!)),info=await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
  expect(info.width).toBeLessThanOrEqual(160);expect(info.height).toBeLessThanOrEqual(160);
  expect(canvas).toMatchObject({width:6000,height:5000});expect(canvas!.previewUrl).toBeUndefined();expect(encoded!.previewUrl).toBeUndefined();
  expect(new Uint8Array(await(await media.response(new Request(picture!.url))).arrayBuffer())).toEqual(new Uint8Array(bytes));
});
it('persists a native clipboard screenshot with an immutable original, bounded preview and exact conversation access',async()=>{
  const {root,media}=await fixture(),bytes=await sharp({create:{width:64,height:48,channels:4,background:'#ff8899'}}).png().toBuffer();
  const first=await media.importClipboardImage('a',bytes);expect(first).toMatchObject({name:'剪贴板图片.png',mimeType:'image/png',sha256:hash(bytes),width:64,height:48});expect(first.previewUrl).toBeTruthy();
  expect(await media.importClipboardImage('a',bytes)).toEqual(first);expect(await readFile((await media.getForAgent('a',first.id)).path)).toEqual(bytes);
  await expect(media.resolveForConversation('b',[first.id])).rejects.toThrow('不属于当前会话');
  const restarted=new BotMediaService({root:path.join(root,'media'),builtinRoot:path.resolve('resources/bot-stickers')});expect(await restarted.resolveForConversation('a',[first.id])).toEqual([first]);
  await expect(media.importClipboardImage('a',Buffer.from('not a PNG'))).rejects.toThrow();
});
it('serves verified range bytes/HEAD and rejects bad ranges, traversal and HTML execution',async()=>{
  const {root,media}=await fixture(),file=path.join(root,'notes.html');await writeFile(file,'<script>unsafe</script>');const [ref]=await media.importFiles({conversationId:'a',paths:[file]});
  const range=await media.response(new Request(ref!.url,{headers:{range:'bytes=1-6'}}));expect(range.status).toBe(206);expect(await range.text()).toBe('script');expect(range.headers.get('content-range')).toBe('bytes 1-6/23');
  expect(range.headers.get('content-security-policy')).toContain('sandbox');expect(range.headers.get('content-disposition')).toMatch(/^attachment/);expect(range.headers.get('x-content-type-options')).toBe('nosniff');
  const head=await media.response(new Request(ref!.url,{method:'HEAD'}));expect(head.headers.get('content-length')).toBe('23');expect(await head.text()).toBe('');
  expect((await media.response(new Request(ref!.url,{headers:{range:'bytes=900-1000'}}))).status).toBe(416);
  expect((await media.response(new Request('worldlinebox://bot-media/builtin/..%2fsecret'))).status).toBe(404);
  expect((await media.response(new Request(ref!.url,{method:'POST'}))).status).toBe(404);
});
it('imports static and animated user packs without transcoding their originals',async()=>{
  const {root,media}=await fixture(),directory=path.join(root,'自定义表情');await mkdir(directory);
  await sharp({create:{width:12,height:10,channels:4,background:'#1199ff'}}).png().toFile(path.join(directory,'开心.png'));
  const builtin=(await media.listPacks({conversationId:'a'}))[0]!,animation=(await media.listStickers({conversationId:'a',packId:builtin.id}))[0]!;
  await writeFile(path.join(directory,'原始动图.gif'),await readFile((await media.getForAgent('a',animation.id)).path));
  const pack=await media.importStickerPack({conversationId:'a',directory}),items=await media.listStickers({conversationId:'a',packId:pack.id});expect(pack).toMatchObject({builtin:false,name:'自定义表情',count:2});
  expect(items.find(item=>item.animated)?.mimeType).toBe('image/webp');expect(items.find(item=>item.animated)?.sha256).toBe(animation.sha256);expect(items.every(item=>item.previewUrl)).toBe(true);
  expect((await media.importStickerPack({conversationId:'a',directory})).id).toBe(pack.id);
  await expect(media.listStickers({conversationId:'b',packId:pack.id})).rejects.toThrow('没有此表情包');
});
it('stages verified originals only into the assigned task directory and saves exact bytes',async()=>{
  const {root,media}=await fixture(),source=path.join(root,'工作文档.any');await writeFile(source,'任务附件原字节');const [ref]=await media.importFiles({conversationId:'a',paths:[source]});
  const task=path.join(root,'task');await mkdir(task);const [staged]=await media.stageForTask({conversationId:'a',attachmentIds:[ref!.id],destination:task});
  expect(staged!.relativePath).toMatch(/^attachments\//);expect(await readFile(staged!.path,'utf8')).toBe('任务附件原字节');
  const saved=path.join(root,'saved.any');await media.saveAttachment({conversationId:'a',id:ref!.id,destination:saved});expect(await readFile(saved)).toEqual(await readFile(source));
  await writeFile(staged!.path,'other data');await expect(media.stageForTask({conversationId:'a',attachmentIds:[ref!.id],destination:task})).rejects.toThrow('内容不同');
  await expect(media.stageForTask({conversationId:'b',attachmentIds:[ref!.id],destination:task})).rejects.toThrow('不属于当前会话');
});
it('rejects junction sources, junction destinations and unsafe request ids',async()=>{
  const {root,media}=await fixture(),outside=path.join(root,'outside'),link=path.join(root,'junction');await mkdir(outside);await writeFile(path.join(outside,'secret.txt'),'outside');await symlink(outside,link,'junction');
  await expect(media.importFiles({conversationId:'a',paths:[path.join(link,'secret.txt')]})).rejects.toThrow('链接');
  await expect(media.importStickerPack({conversationId:'a',directory:link})).rejects.toThrow('链接');
  const [ref]=await media.importFiles({conversationId:'a',paths:[path.join(outside,'secret.txt')]});await expect(media.saveAttachment({conversationId:'a',id:ref!.id,destination:path.join(link,'saved.txt')})).rejects.toThrow('链接');
  expect(botMediaRequestSchema.safeParse({type:'attachment.save',conversationId:'a',id:'../escape'}).success).toBe(false);
  expect(botMediaRequestSchema.safeParse({type:'files.import',conversationId:'a',paths:['bad\0file']}).success).toBe(false);
});
it('keeps genuine GIF and APNG animation bytes and stages long named files within Windows filename limits',async()=>{
  const {root,media}=await fixture(),directory=path.join(root,'动画格式');await mkdir(directory);
  const pixels=Buffer.from([...Array(4).fill([255,0,0,255]).flat(),...Array(4).fill([0,0,255,255]).flat()]);
  const gif=await sharp(pixels,{raw:{width:2,height:4,channels:4,pageHeight:2}}).gif({delay:[80,120],loop:0}).toBuffer();await writeFile(path.join(directory,'真正GIF.gif'),gif);
  const chunk=(type:string,data:Buffer)=>{const label=Buffer.from(type),body=Buffer.concat([label,data]);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const size=Buffer.alloc(4),end=Buffer.alloc(4);size.writeUInt32BE(data.length);end.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([size,body,end]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;
  const control=Buffer.alloc(8);control.writeUInt32BE(2);const frame=(sequence:number)=>{const bytes=Buffer.alloc(26);bytes.writeUInt32BE(sequence);bytes.writeUInt32BE(1,4);bytes.writeUInt32BE(1,8);bytes.writeUInt16BE(1,20);bytes.writeUInt16BE(10,22);return bytes;};
  const sequence=Buffer.alloc(4);sequence.writeUInt32BE(2);
  const apng=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('acTL',control),chunk('fcTL',frame(0)),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0,255]))),chunk('fcTL',frame(1)),chunk('fdAT',Buffer.concat([sequence,deflateSync(Buffer.from([0,0,0,255,255]))])),chunk('IEND',Buffer.alloc(0))]);
  await writeFile(path.join(directory,'真正APNG.apng'),apng);
  const pack=await media.importStickerPack({conversationId:'a',directory}),items=await media.listStickers({conversationId:'a',packId:pack.id});expect(items).toHaveLength(2);expect(items.every(item=>item.animated)).toBe(true);
  expect(items.find(item=>item.mimeType==='image/gif')?.sha256).toBe(hash(gif));expect(items.find(item=>item.mimeType==='image/png')?.sha256).toBe(hash(apng));
  const name='超长附件名'.repeat(35)+'.bin',source=path.join(root,name);await writeFile(source,'same bytes');const twin=path.join(root,'同内容另名.bin');await writeFile(twin,'same bytes');
  const [a,b]=await media.importFiles({conversationId:'a',paths:[source,twin]});expect(a!.sha256).toBe(b!.sha256);expect(a!.id).not.toBe(b!.id);
  const task=path.join(root,'task');await mkdir(task);const [staged]=await media.stageForTask({conversationId:'a',attachmentIds:[a!.id],destination:task});expect(path.basename(staged!.path).length).toBeLessThanOrEqual(240);expect(staged!.path).toMatch(/\.bin$/);
});
it('preserves user edits when an attachment is opened again while keeping canonical bytes unchanged',async()=>{
  const {root,media}=await fixture(),source=path.join(root,'计划.txt');await writeFile(source,'原始附件');
  const [ref]=await media.importFiles({conversationId:'a',paths:[source]}),opened=await media.getForUserOpen('a',ref!.id);
  expect(path.basename(opened.path)).toBe('计划.txt');await writeFile(opened.path,'用户在系统编辑器里保存的改稿');
  expect((await media.getForUserOpen('a',ref!.id)).path).toBe(opened.path);
  expect(await readFile(opened.path,'utf8')).toBe('用户在系统编辑器里保存的改稿');
  expect(await readFile((await media.getForAgent('a',ref!.id)).path,'utf8')).toBe('原始附件');
});

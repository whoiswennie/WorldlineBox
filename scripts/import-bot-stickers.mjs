import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const source=path.resolve(process.argv.find(value=>value.startsWith('--source='))?.slice(9)||'C:/Users/hp/Desktop/project/超时空辉夜姬表情包');
const target=path.resolve('resources/bot-stickers');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const inventory=[];const manifest={schema:1,media:[],packs:[]};
const semanticTags=[[/哭|泪/,['伤心','难过','哭泣']],[/喜欢|爱心|爱你|比心|沦陷/,['喜欢','爱心','心动']],[/真棒|不错|肯定|看好/,['赞同','鼓励','赞美']],[/无语|嫌弃/,['无语','吐槽','嫌弃']],[/问号|什么|干嘛|我吗|叫我/,['疑惑','提问']],[/焦急|不好|完啦|如坠冰窟|流汗|惊吓/,['着急','害怕','尴尬']],[/吃|口水/,['美食','吃饭','馋']],[/喝/,['饮料','喝茶']],[/大咩哟|不要啊|不情愿/,['拒绝','不愿意']],[/困|睡/,['困了','睡觉']],[/委屈/,['委屈']],[/惊到了|发现了什么/,['惊讶','发现']],[/骄傲|墨镜/,['得意']],[/想要/,['想要','期待']],[/好耶|耶|激动|跳舞/,['开心','庆祝']],[/恶龙咆哮|鬼叫|大哭大闹|呐喊|好气/,['生气','愤怒','抓狂']],[/偷看|偷笑|看戏/,['围观','吃瓜']],[/对不起/,['道歉','抱歉']],[/给你一拳|恐吓/,['警告','打闹']],[/原神|音游/,['游戏','娱乐']]];
if((await lstat(source)).isSymbolicLink()||path.resolve(await realpath(source)).toLowerCase()!==source.toLowerCase())throw new Error('Builtin sticker source must be physical');
await mkdir(path.join(target,'objects'),{recursive:true});
for(const folder of (await readdir(source,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'))){
  if(folder.isSymbolicLink())throw new Error('Builtin packs must not contain links');if(!folder.isDirectory())throw new Error('Builtin source must contain named pack directories only');
  const packId='builtin_'+digest(folder.name).slice(0,32),pack={id:packId,name:folder.name,builtin:true,ids:[]};
  const scan=async(directory)=>{for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'))){
    if(entry.isSymbolicLink())throw new Error('Builtin packs must not contain links');const filename=path.join(directory,entry.name);
    if(entry.isDirectory()){await scan(filename);continue;}if(!entry.isFile())throw new Error('Builtin packs must contain regular image files');
    const bytes=await readFile(filename),sha256=digest(bytes),info=await sharp(bytes,{animated:true}).metadata();
    const mimeType=info.format==='heif'&&info.compression==='av1'?'image/avif':{jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',heif:'image/heif',avif:'image/avif'}[info.format];if(!mimeType)throw new Error('Unsupported builtin image: '+filename);
    const extension={jpeg:'jpg',png:'png',gif:'gif',webp:'webp',heif:'heif',avif:'avif'}[info.format],object='objects/'+sha256+'.'+extension;
    try{await copyFile(filename,path.join(target,object),constants.COPYFILE_EXCL);}catch(error){if(error.code!=='EEXIST')throw error;}
    if(digest(await readFile(path.join(target,object)))!==sha256)throw new Error('Copied sticker hash mismatch');
    const id='b_'+sha256+'_'+packId.slice(-8);if(pack.ids.includes(id))throw new Error('Duplicate bytes within one builtin pack require an explicit alias decision');pack.ids.push(id);
    const preview=await sharp(bytes,{page:0,pages:1}).resize({width:160,height:160,fit:'inside',withoutEnlargement:true}).webp({quality:80}).toBuffer();
    const previewSha256=digest(preview),previewObject='objects/'+previewSha256+'.webp';
    try{await writeFile(path.join(target,previewObject),preview,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
    if(digest(await readFile(path.join(target,previewObject)))!==previewSha256)throw new Error('Builtin preview hash mismatch');
    const unnamed=entry.name==='110.jpg',name=unnamed?'遇到困难请拨打':path.basename(entry.name,path.extname(entry.name)).replace(/[-_]/g,' ');
    const tags=[...new Set([folder.name,name,...semanticTags.filter(([pattern])=>pattern.test(name)).flatMap(([,tags])=>tags),...(unnamed?['求助','遇到困难','帮助']:[])])];
    const description=unnamed?'三位角色并排，图中文字“遇到困难请拨打：”；表达求助、遇到困难或需要帮助。':`源文件标注：${name}。`;
    manifest.media.push({id,name,originalName:entry.name,tags,description,mimeType,size:bytes.length,sha256,url:'',kind:'sticker',packId,animated:(info.pages||1)>1,width:info.width,height:info.pageHeight||info.height,object,previewObject,previewSha256,previewSize:preview.length});
    inventory.push({relativePath:path.relative(source,filename).replaceAll('\\','/'),sha256,size:bytes.length,format:info.format==='heif'&&info.compression==='av1'?'avif':info.format,frames:info.pages||1,animated:(info.pages||1)>1,width:info.width,height:info.pageHeight||info.height});
  }};
  await scan(path.join(source,folder.name));manifest.packs.push(pack);
}
await writeFile(path.join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
const receipt={source,target,packs:manifest.packs.map(pack=>({id:pack.id,name:pack.name,count:pack.ids.length})),files:inventory.length,bytes:inventory.reduce((sum,item)=>sum+item.size,0),animated:inventory.filter(item=>item.animated).length,items:inventory};
await mkdir('artifacts/bot-refactor-2026-11-02',{recursive:true});await writeFile('artifacts/bot-refactor-2026-11-02/builtin-sticker-inventory.json',JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({...receipt,items:undefined}));

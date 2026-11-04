import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';

export async function verifyBotStickers(input){
  const root=await realpath(input),manifest=JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8'));
  if(manifest.schema!==1||!Array.isArray(manifest.media)||!Array.isArray(manifest.packs))throw new Error('Invalid builtin sticker manifest');
  const listed=new Set(),ids=new Set();let originalBytes=0,previewBytes=0;
  async function verify(relative,sha256,size){
    if(!/^objects\/[a-f0-9]{64}(?:\.[a-z0-9]{1,8})?$/.test(relative)||relative.split('/')[1].split('.')[0]!==sha256)throw new Error('Invalid builtin sticker object path');
    const file=path.join(root,relative),info=await lstat(file);if(info.isSymbolicLink()||!info.isFile()||info.size!==size||!(await realpath(file)).startsWith(root+path.sep))throw new Error('Invalid builtin sticker object');
    if(createHash('sha256').update(await readFile(file)).digest('hex')!==sha256)throw new Error('Builtin sticker checksum mismatch: '+relative);listed.add(path.basename(relative));
  }
  for(const item of manifest.media){
    if(!/^[A-Za-z0-9_-]{1,160}$/.test(item.id)||ids.has(item.id)||!item.originalName||!item.name||!Array.isArray(item.tags)||!item.tags.length||!item.description)throw new Error('Builtin sticker lacks unique semantic metadata');ids.add(item.id);
    await verify(item.object,item.sha256,item.size);originalBytes+=item.size;
    if(!item.previewObject||!item.previewSha256||!item.previewSize)throw new Error('Builtin sticker static preview missing');await verify(item.previewObject,item.previewSha256,item.previewSize);previewBytes+=item.previewSize;
  }
  const inPacks=new Set();for(const pack of manifest.packs){if(!pack.builtin||!Array.isArray(pack.ids)||!pack.name||!pack.ids.length)throw new Error('Invalid builtin sticker pack');for(const id of pack.ids){if(!ids.has(id)||inPacks.has(id))throw new Error('Invalid builtin sticker membership');inPacks.add(id);}}
  if(inPacks.size!==ids.size)throw new Error('Builtin sticker is not assigned to a pack');
  for(const entry of await readdir(path.join(root,'objects'),{withFileTypes:true}))if(!entry.isFile()||entry.isSymbolicLink()||!listed.has(entry.name))throw new Error('Unlisted builtin sticker object: '+entry.name);
  return{ok:true,packs:manifest.packs.length,stickers:manifest.media.length,animated:manifest.media.filter(item=>item.animated).length,originalBytes,previewBytes,objects:listed.size};
}

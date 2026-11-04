import { constants, type Stats } from 'node:fs';
import { open } from 'node:fs/promises';
import { BOT_MEDIA_PREVIEW_MAX_BYTES, BOT_MEDIA_TEXT_PAGE_BYTES, BOT_MEDIA_TEXT_PAGE_MAX_BYTES, type BotMediaTextPage } from '../../shared/companion-bot-media';

const binary = () => new Error('附件不是可安全预览的纯文本，或文本编码不受支持，请使用系统软件打开。');
const signature = (bytes:Buffer) => bytes.subarray(0,2).toString()==='MZ'||bytes.subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46]))
  || bytes.subarray(0,2).toString()==='PK'||bytes.subarray(0,4).equals(Buffer.from([0xd0,0xcf,0x11,0xe0]))
  || /^(?:%PDF-|GIF8|RIFF|OggS|fLaC|ID3)/.test(bytes.subarray(0,12).toString('latin1'))
  || bytes.subarray(0,4).equals(Buffer.from([0x89,0x50,0x4e,0x47]))||bytes.subarray(0,2).equals(Buffer.from([0xff,0xd8]))
  || bytes.subarray(4,8).toString()==='ftyp';
const validate = (value:string) => { for(let index=0;index<value.length;index++){const code=value.charCodeAt(index);if(code<32&&code!==9&&code!==10&&code!==13||code===127)throw binary();}return value; };
const same = (a:Stats,b:Stats) =>
  a.size===b.size&&a.ino===b.ino&&a.dev===b.dev&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;

/** Decode one bounded window from an already-authorized immutable attachment.
 * No whole-file allocation, charset guessing or executable document parser. */
export async function readBotTextPage(file:string,input:{name:string;size:number;format:'text'|'markdown';offset?:number;limit?:number}):Promise<BotMediaTextPage>{
  const offset=input.offset??0,limit=input.limit??BOT_MEDIA_TEXT_PAGE_BYTES;
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<4||limit>BOT_MEDIA_TEXT_PAGE_MAX_BYTES)throw new Error('文本分页范围无效。');
  if(input.size>BOT_MEDIA_PREVIEW_MAX_BYTES)throw new Error('文本超过 200MB，仅支持系统软件打开。');
  const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  try{
    const before=await handle.stat();
    if(!before.isFile()||before.size!==input.size||offset>before.size)throw new Error('附件文件与已登记大小或分页位置不一致。');
    const header=Buffer.alloc(Math.min(before.size,BOT_MEDIA_TEXT_PAGE_BYTES+4));
    const headRead=await handle.read(header,0,header.length,0),head=header.subarray(0,headRead.bytesRead);
    if(signature(head))throw binary();
    const encoding:BotMediaTextPage['encoding']=head[0]===0xff&&head[1]===0xfe?'utf-16le':head[0]===0xfe&&head[1]===0xff?'utf-16be':'utf-8';
    const bom=encoding!=='utf-8'?2:head[0]===0xef&&head[1]===0xbb&&head[2]===0xbf?3:0;
    const start=offset===0?bom:offset;
    if(start<bom||encoding!=='utf-8'&&(start-bom)%2)throw new Error('文本分页位置不在字符边界。');
    const decode=(bytes:Buffer,final:boolean):{content:string;bytes:number}=>{
      if(encoding!=='utf-8'){
        if(final&&bytes.length%2)throw binary();
        let length=bytes.length-bytes.length%2;
        if(!final&&length>=2){const last=encoding==='utf-16le'?bytes.readUInt16LE(length-2):bytes.readUInt16BE(length-2);if(last>=0xd800&&last<=0xdbff)length-=2;}
        try{return{content:validate(new TextDecoder(encoding,{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,length))),bytes:length};}catch{throw binary();}
      }
      let length=bytes.length;
      if(!final&&length){let begin=length-1;while(begin>=0&&(bytes[begin]!&0xc0)===0x80)begin--;if(begin<0)throw binary();const lead=bytes[begin]!,expected=lead<0x80?1:lead>=0xc2&&lead<=0xdf?2:lead>=0xe0&&lead<=0xef?3:lead>=0xf0&&lead<=0xf4?4:0;if(!expected)throw binary();if(length-begin<expected)length=begin;}
      try{return{content:validate(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,length))),bytes:length};}catch{throw binary();}
    };
    decode(head.subarray(bom),head.length===before.size);
    const bytes=Buffer.alloc(Math.min(limit,before.size-start)),read=await handle.read(bytes,0,bytes.length,start);
    const page=decode(bytes.subarray(0,read.bytesRead),start+read.bytesRead===before.size),end=start+page.bytes;
    if(end<before.size&&!page.bytes)throw new Error('文本分页未取得进展，请增加单页大小。');
    if(!same(before,await handle.stat()))throw new Error('读取期间附件已更改，请重新打开。');
    return{content:page.content,offset,...(end<before.size?{nextOffset:end}:{}),totalBytes:before.size,name:input.name,format:input.format,encoding};
  }finally{await handle.close();}
}

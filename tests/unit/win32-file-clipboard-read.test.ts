import { beforeEach, expect, it, vi } from 'vitest';

const native=vi.hoisted(()=>({paths:[] as string[],available:true,opened:true,close:vi.fn(),query:vi.fn()}));
vi.mock('koffi',()=>({default:{load:()=>({func:(prototype:string)=>{
  if(prototype.includes('IsClipboardFormatAvailable'))return(format:number)=>format===15&&native.available;
  if(prototype.includes('OpenClipboard'))return()=>native.opened;
  if(prototype.includes('GetClipboardData'))return()=>({drop:true});
  if(prototype.includes('CloseClipboard'))return native.close;
  if(prototype.includes('DragQueryFileW'))return native.query;
  throw Error('unexpected native call '+prototype);
}})}}));
beforeEach(()=>{
  native.paths=['C:\\照片\\一.png','D:\\文档\\二.pdf'];native.available=true;native.opened=true;native.close.mockReset();
  native.query.mockReset().mockImplementation((_drop:unknown,index:number,buffer:Buffer|null)=>{
    if(index===0xffffffff)return native.paths.length;
    const value=native.paths[index]??'';if(buffer)Buffer.from(value,'utf16le').copy(buffer);return value.length;
  });
});
it.skipIf(process.platform!=='win32')('reads every Unicode path from real format 15 and always releases the clipboard',async()=>{
  const {readWin32FileClipboard}=await import('../../src/main/win32-file-clipboard');
  expect(readWin32FileClipboard()).toEqual(native.paths);expect(native.close).toHaveBeenCalledOnce();
  expect(native.query).toHaveBeenCalledTimes(5);
});
it.skipIf(process.platform!=='win32')('bounds metadata reads and safely handles unavailable, busy or malformed clipboards',async()=>{
  const {readWin32FileClipboard}=await import('../../src/main/win32-file-clipboard');
  native.available=false;expect(readWin32FileClipboard()).toBeNull();expect(native.close).not.toHaveBeenCalled();
  native.available=true;native.opened=false;expect(readWin32FileClipboard()).toEqual([]);expect(native.close).not.toHaveBeenCalled();
  native.opened=true;native.paths=Array.from({length:1001},()=> 'C:\\file');expect(readWin32FileClipboard()).toEqual([]);expect(native.close).toHaveBeenCalledOnce();
  native.paths=['C:\\file'];native.query.mockImplementation(()=>{throw Error('clipboard changed');});expect(readWin32FileClipboard()).toEqual([]);expect(native.close).toHaveBeenCalledTimes(2);
});
it.skipIf(process.platform!=='win32')('keeps more than 64 native paths so the attachment layer can reject the whole over-limit batch explicitly',async()=>{
  const {readWin32FileClipboard}=await import('../../src/main/win32-file-clipboard');
  native.paths=Array.from({length:65},(_,index)=>`C:\\文件${index}.txt`);
  expect(readWin32FileClipboard()).toEqual(native.paths);expect(native.close).toHaveBeenCalledOnce();
});

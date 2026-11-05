import { expect, it, vi } from 'vitest';
import { isBotFilePaste } from '../../src/renderer/companion-bot/clipboard-paste';

function data(values:Record<string,string|undefined>={},types=Object.keys(values),files:File[]=[]){
  return {files,items:[],types,getData:(type:string)=>values[type]??''};
}
it('keeps ordinary text, HTML and path-looking text in the native editable paste path',()=>{
  for(const values of [{'text/plain':'正常聊天文字'},{'text/plain':'C:\\Users\\me\\notes.txt'},{'text/html':'<b>文字</b>'},{'text/uri-list':'https://example.com'}])
    expect(isBotFilePaste(data(values))).toBe(false);
});
it('recognizes native Explorer file metadata even when Chromium only exposes text and no File items',()=>{
  const probe=vi.fn(()=>true);
  expect(isBotFilePaste(data({'text/plain':'C:\\照片.png'}),probe)).toBe(true);
  expect(probe).toHaveBeenCalledOnce();
  expect(isBotFilePaste(data({},['FileNameW']))).toBe(true);
  expect(isBotFilePaste(data({'text/uri-list':'# Finder\nfile:///Users/me/a.png'}))).toBe(true);
});
it('accepts screenshots, File objects and opaque native pastes without requiring a file path from the renderer',()=>{
  expect(isBotFilePaste(data({},['image/png']))).toBe(true);
  expect(isBotFilePaste(data({},['Files']))).toBe(true);
  expect(isBotFilePaste(data({},[],[{} as File]))).toBe(true);
  expect(isBotFilePaste(data())).toBe(true);
});

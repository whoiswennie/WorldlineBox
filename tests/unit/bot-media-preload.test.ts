import {beforeEach,expect,it,vi} from 'vitest';
const transport=vi.hoisted(()=>({invoke:vi.fn(),getPathForFile:vi.fn()}));
vi.mock('electron',()=>({ipcRenderer:{invoke:transport.invoke},webUtils:{getPathForFile:transport.getPathForFile}}));
beforeEach(()=>{vi.resetModules();transport.invoke.mockReset().mockResolvedValue({ok:true,media:[]});transport.getPathForFile.mockReset();});
it('requires real File path grants for raw imports and consumes them after success',async()=>{
  const {companionBotMedia:api}=await import('../../src/preload/bridge/companion-bot-media');
  const request={type:'files.import' as const,conversationId:'a',paths:['C:/picked.txt']};
  expect(await api.request(request)).toMatchObject({ok:false});expect(transport.invoke).not.toHaveBeenCalled();
  const file=new File(['picked'],'picked.txt');transport.getPathForFile.mockReturnValue('C:/picked.txt');expect(api.getDroppedFilePaths([file])).toEqual(['C:/picked.txt']);
  expect(await api.request(request)).toMatchObject({ok:true});expect(transport.getPathForFile).toHaveBeenCalledWith(file);expect(transport.invoke).toHaveBeenCalledTimes(1);
  expect(await api.request(request)).toMatchObject({ok:false});expect(transport.invoke).toHaveBeenCalledTimes(1);
});
it('keeps failed import grants retryable but denies synthetic File handles and malformed paths',async()=>{
  const {companionBotMedia:api}=await import('../../src/preload/bridge/companion-bot-media');
  transport.getPathForFile.mockReturnValue('');expect(()=>api.getDroppedFilePaths([new File(['fake'],'fake.txt')])).toThrow('INVALID_DROP_FILE_HANDLE');
  transport.getPathForFile.mockReturnValue('C:/selected.txt');api.getDroppedFilePaths([new File(['x'],'selected.txt')]);
  transport.invoke.mockResolvedValueOnce({ok:false,error:'disk busy'});
  const request={type:'files.import' as const,conversationId:'a',paths:['C:/selected.txt']};expect(await api.request(request)).toMatchObject({ok:false});expect(await api.request(request)).toMatchObject({ok:true});
  expect(await api.request({type:'files.import',conversationId:'a',paths:['bad\0path']})).toMatchObject({ok:false});expect(transport.invoke).toHaveBeenCalledTimes(2);
});
it('allows system pickers and requires a File-derived grant for a raw directory import',async()=>{
  const {companionBotMedia:api}=await import('../../src/preload/bridge/companion-bot-media');
  expect(await api.request({type:'files.pick',conversationId:'a'})).toMatchObject({ok:true});expect(await api.request({type:'pack.pick',conversationId:'a'})).toMatchObject({ok:true});
  expect(await api.request({type:'pack.import',conversationId:'a',directory:'C:/private'})).toMatchObject({ok:false});expect(transport.invoke).toHaveBeenCalledTimes(2);
});
it('allows bounded reads of a registered attachment id but never accepts arbitrary text paths or unbounded IPC pages',async()=>{
  const {companionBotMedia:api}=await import('../../src/preload/bridge/companion-bot-media');
  const request={type:'media.text.read' as const,conversationId:'a',id:'registered-text',offset:0,limit:65536};
  expect(await api.request(request)).toMatchObject({ok:true});expect(transport.invoke).toHaveBeenCalledTimes(1);
  expect(await api.request({...request,limit:256*1024+1})).toMatchObject({ok:false});
  expect(await api.request({...request,offset:-1})).toMatchObject({ok:false});
  expect(await api.request({...request,path:'C:/private.txt'} as unknown as typeof request)).toMatchObject({ok:false});
  expect(transport.invoke).toHaveBeenCalledTimes(1);
});

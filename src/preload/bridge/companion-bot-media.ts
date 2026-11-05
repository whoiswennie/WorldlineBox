import { ipcRenderer, webUtils } from 'electron';
import { BOT_MEDIA_CHANNEL,BOT_MEDIA_CLIPBOARD_CHANNEL,botMediaRequestSchema,type BotMediaRequest,type WorldlineBoxBotMediaApi } from '../../shared/companion-bot-media';
import { resolveDroppedFilePaths } from '../dropped-files';

const grantedDrops=new Set<string>();
export const companionBotMedia:WorldlineBoxBotMediaApi=Object.freeze({
  hasClipboardFiles(conversationId:string){
    const parsed=botMediaRequestSchema.safeParse({type:'files.paste',conversationId});
    return parsed.success&&ipcRenderer.sendSync(BOT_MEDIA_CLIPBOARD_CHANNEL,parsed.data.conversationId)===true;
  },
  async request(input:BotMediaRequest){
    const parsed=botMediaRequestSchema.safeParse(input);if(!parsed.success)return{ok:false,error:'附件请求格式不正确。'};
    const paths=parsed.data.type==='files.import'?parsed.data.paths:parsed.data.type==='pack.import'?[parsed.data.directory]:[];
    if(paths.some(value=>!grantedDrops.has(value)))return{ok:false,error:'请通过选择文件或实际拖入文件来授权附件。'};
    const result=await ipcRenderer.invoke(BOT_MEDIA_CHANNEL,parsed.data);if(result?.ok)for(const value of paths)grantedDrops.delete(value);return result;
  },
  getDroppedFilePaths(files:File[]){const paths=resolveDroppedFilePaths(files,file=>webUtils.getPathForFile(file));for(const value of paths)grantedDrops.add(value);while(grantedDrops.size>1000)grantedDrops.delete(grantedDrops.values().next().value!);return paths;},
});

import type {BotReplyPart} from './companion-bot';
import type {BotMediaRef} from './companion-bot-media';
const comparable=(text:string)=>text.normalize('NFKC').replace(/\s+/gu,' ').trim();
/** Keep native order and all committed user-facing text. Only exact repeated
 * text adjacent to a media caption is collapsed; different answers survive. */
export function botReplyDisplayParts(parts:readonly BotReplyPart[]):BotReplyPart[]{
  const sorted=[...parts].sort((a,b)=>a.sequence-b.sequence),result:BotReplyPart[]=[];
  for(const part of sorted){
    const prior=result.at(-1),text=part.text?.trim();
    if(part.kind==='text'&&!text)continue;
    if(text&&prior?.text&&part.kind!==prior.kind&&comparable(text)===comparable(prior.text)){
      if(part.kind==='text')continue;
      result.push({...part,text:undefined});continue;
    }
    result.push(part);
  }
  return result;
}

/** The chat shows only the last committed body and media, while the native
 * source parts remain intact for receipts, memory and recovery. Captions are
 * tool metadata rather than an additional assistant answer. */
export function botReplyPresentation(parts:readonly BotReplyPart[],fallback:readonly BotMediaRef[]=[]):{content:string;attachments:BotMediaRef[]}{
  const ordered=[...parts].sort((a,b)=>a.sequence-b.sequence);
  const content=ordered.findLast(part=>part.kind==='text'&&!!part.text?.trim())?.text??'';
  const attachments:BotMediaRef[]=[],seen=new Set<string>();
  for(const part of ordered)for(const media of part.attachments??[]){
    if(media.kind==='sticker'||!seen.has(media.id))attachments.push(media);
    seen.add(media.id);
  }
  for(const media of fallback)if(!seen.has(media.id)){attachments.push(media);seen.add(media.id);}
  return{content,attachments};
}

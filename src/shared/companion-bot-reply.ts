import type {BotReplyPart} from './companion-bot';
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

import {expect,it,afterEach} from 'vitest';
import {BotStore} from '../../src/main/companion-bot/store';
import {botReplyDisplayParts,botReplyPresentation} from '../../src/shared/companion-bot-reply';
import type {BotMediaRef} from '../../src/shared/companion-bot-media';
let store:BotStore;afterEach(()=>store?.close());
it('projects the final committed body and media without changing the stored source or exposing tool captions',()=>{
  const parts=[{id:'last',kind:'text' as const,sequence:30,text:'最终正文'},{id:'early',kind:'text' as const,sequence:10,text:'过程正文'},{id:'caption',kind:'media' as const,sequence:20,text:'表情台词'}];
  expect(botReplyPresentation(parts).content).toBe('最终正文');expect(parts[1]!.text).toBe('过程正文');expect(botReplyPresentation([parts[2]!]).content).toBe('');
});
it('keeps an early substantive answer, media and the last response in native order despite asynchronous arrival',()=>{
  const parts=botReplyDisplayParts([{id:'last',kind:'text',sequence:30,text:'处理结束'},{id:'answer',kind:'text',sequence:10,text:'关键结论已经在这里'},{id:'sticker',kind:'media',sequence:20,text:'给你一张表情'}]);
  expect(parts.map(part=>part.text)).toEqual(['关键结论已经在这里','给你一张表情','处理结束']);
});
it('collapses an exact caption echo while preserving a genuinely different answer and standalone repeated stickers',()=>{
  expect(botReplyDisplayParts([{id:'a',kind:'media',sequence:1,text:'收到'},{id:'b',kind:'text',sequence:2,text:'收到'},{id:'c',kind:'text',sequence:3,text:'补充结论'}]).map(part=>part.text)).toEqual(['收到','补充结论']);
  expect(botReplyDisplayParts([{id:'a',kind:'media',sequence:1},{id:'b',kind:'media',sequence:2}])).toHaveLength(2);
  expect(botReplyDisplayParts([{id:'a',kind:'text',sequence:1,text:'哈哈'},{id:'b',kind:'text',sequence:2,text:'哈哈'}])).toHaveLength(2);
});
it('groups a real publication with the original reply, retains file authorization, and deduplicates replayed effect identity',()=>{
  store=new BotStore(':memory:');const actor=store.createCompanion({id:'actor',name:'伙伴',persona:'伙伴'}),room=store.openDirect(actor.id);
  const sent=store.enqueue({conversationId:room.id,senderId:'user',content:'发表情',sourceMessageId:'one'}),claim=store.claim({workerId:'worker'})!,event=claim.event;
  const sticker={id:'s',name:'表情',kind:'sticker',mimeType:'image/png',size:1,url:'worldlinebox-bot-media://test/s'} as BotMediaRef;
  store.appendReplyPart(event.id,{id:'native-text-10',kind:'text',sequence:10,text:'先回答关键内容'});
  const publication=store.publishForEvent(event.id,'tool',{content:'单独台词',attachments:[sticker]});
  store.appendReplyPart(event.id,{id:'media-tool',kind:'media',sequence:20,text:publication.content,attachments:[sticker],publicationId:publication.id});
  store.appendReplyPart(event.id,{id:'media-tool',kind:'media',sequence:21,text:publication.content,attachments:[sticker],publicationId:publication.id});
  store.appendReplyPart(event.id,{id:'native-text-30',kind:'text',sequence:30,text:'已交付'});
  store.settle({eventId:event.id,leaseToken:claim.leaseToken,status:'done',content:'先回答关键内容\n\n单独台词\n\n已交付'});
  const page=store.messagesPage(room.id);expect(page.items.map(message=>message.id)).toEqual([sent.message.id,event.replyMessageId]);
  expect(page.items[1]!.parts?.map(part=>part.sequence)).toEqual([10,20,30]);expect(store.modelAttachments(event,{ids:[sticker.id]})).toHaveLength(1);
  expect(store.searchMessages(room.id,{query:'单独台词'}).items.map(message=>message.id)).toEqual([event.replyMessageId]);
});

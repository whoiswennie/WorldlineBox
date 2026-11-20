import { expect, it, vi } from 'vitest';
import { nativeCallback, nativeServiceFixture, waitNative } from '../fixtures/bot-native-service';
import type { BotEvent } from '../../src/shared/companion-bot';

it('checks the browser account on connect and persists a retried video with one live presentation', async () => {
  const onEvent=vi.fn<(event:BotEvent)=>void>();
  const login=vi.fn(async ():Promise<'guest'|'signed-in'> => 'guest');
  const fixture=await nativeServiceFixture(async run => {
    if (!run.workerTools?.some(tool => tool.name === 'bilibili_video')) return '未连接';
    for (const [callId,video,autoPlay] of [['first','BV1B7411m7LV',true],['duplicate','BV1B7411m7LV',true],['silent','ep100',false]] as const) {
      const reply=await nativeCallback(run,'bilibili_video',{action:'play',video,autoPlay},callId);
      expect(reply.ok).toBe(true);
    }
    return '';
  },{onEvent, videoLogin:login, videoTool:async input => input.action === 'play' ? {card:{title:input.video,videoId:input.video,page:1}} : {result:[]}});
  try {
    const {service}=fixture;
    const room=(await service.handle({type:'state'})).snapshot!.conversations.find(item=>item.kind==='direct')!.id;
    const topic=(await service.handle({type:'topic.new',conversationId:room,requestId:'video-topic'})).topic!;
    const connect=() => service.handle({type:'app.connect',appId:'video',conversationId:room,topicId:topic.id});
    expect((await connect()).app).toEqual({id:'video',login:'guest'});
    login.mockResolvedValue('signed-in');
    expect((await connect()).app).toEqual({id:'video',login:'signed-in'});
    const send=async (id:string) => {
      const reply=await service.handle({type:'message.send',conversationId:room,topicId:topic.id,requestId:id,content:'播放视频'});
      const messageId=reply.replyMessageIds![0]!;
      await waitNative(()=>service.store.getMessage(messageId)?.status==='sent');
      return messageId;
    };
    const id=await send('with-video');
    expect(service.store.replyParts(id).filter(part=>part.video)).toHaveLength(2);
    await service.handle({type:'state',conversationId:room});
    expect(onEvent.mock.calls.filter(([event])=>event.type==='video-present')).toHaveLength(1);
    expect(login).toHaveBeenCalledTimes(2);
    await service.handle({type:'app.detach',conversationId:room,topicId:topic.id,appId:'video'});
    await send('without-video');
    expect(fixture.calls.at(-1)?.workerTools?.some(tool=>tool.name==='bilibili_video')).toBe(false);
  } finally { await fixture.close(); }
});

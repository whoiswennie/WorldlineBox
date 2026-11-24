import { expect, it, vi } from 'vitest';
import { nativeCallback, nativeServiceFixture, waitNative } from '../fixtures/bot-native-service';
import type { BotEvent } from '../../src/shared/companion-bot';

it('checks the browser account and presents a retried call video once in the main chat', async () => {
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
      const reply=await service.handle({type:'message.send',conversationId:room,topicId:topic.id,requestId:id,content:'播放视频',surface:'call'});
      const messageId=reply.replyMessageIds![0]!;
      await waitNative(()=>service.store.getMessage(messageId)?.status==='sent');
      return messageId;
    };
    const id=await send('with-video');
    expect(service.store.replyParts(id).filter(part=>part.video)).toHaveLength(2);
    await service.handle({type:'state',conversationId:room});
    expect(onEvent.mock.calls.filter(([event])=>event.type==='video-present')).toEqual([
      [{type:'video-present',conversationId:room,surface:'chat',cardId:expect.any(String)}],
    ]);
    expect(login).toHaveBeenCalledTimes(2);
    await service.handle({type:'app.detach',conversationId:room,topicId:topic.id,appId:'video'});
    await send('without-video');
    expect(fixture.calls.at(-1)?.workerTools?.some(tool=>tool.name==='bilibili_video')).toBe(false);
  } finally { await fixture.close(); }
});

it('keeps a later disable effective while the earlier video login check is still pending', async () => {
  let finish!: (login: 'guest') => void;
  const login = vi.fn(() => new Promise<'guest'>(resolve => { finish = resolve; }));
  const fixture = await nativeServiceFixture(async () => '', { videoLogin: login, videoTool: async () => ({}) });
  try {
    const { service } = fixture;
    const room = (await service.handle({ type: 'state' })).snapshot!.conversations[0]!.id;
    const connecting = service.handle({ type: 'app.connect', conversationId: room, appId: 'video' });
    await waitNative(() => login.mock.calls.length === 1);
    await service.handle({ type: 'app.detach', conversationId: room, appId: 'video' });
    finish('guest');
    await expect(connecting).rejects.toThrow('已关闭');
    expect(service.chatAppEnabled(room, 'video')).toBe(false);
  } finally { await fixture.close(); }
});

it('rejects direct calls to each disconnected chat application and explains how to enable it', async () => {
  const tools = ['browser', 'asset_manager', 'cabin_world', 'music', 'music_global_player', 'bilibili_video'];
  const results: Array<{ok: boolean; error?: string}> = [];
  const fixture = await nativeServiceFixture(async run => {
    for (const name of tools) results.push(await nativeCallback(run, name, {}));
    return '回归检查';
  });
  try {
    const { service } = fixture;
    const room = (await service.handle({ type: 'state' })).snapshot!.conversations[0]!.id;
    const sent = await service.handle({ type: 'message.send', conversationId: room, requestId: 'disabled-apps', content: '检查应用' });
    await waitNative(() => service.store.getMessage(sent.replyMessageIds![0]!)?.status === 'sent');
    expect(results).toHaveLength(tools.length);
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.error).toContain('启用');
    }
  } finally { await fixture.close(); }
});

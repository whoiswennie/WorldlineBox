import { expect, it, vi } from 'vitest';
import { nativeCallback, nativeServiceFixture, waitNative } from '../fixtures/bot-native-service';
import type { MusicExecution, MusicShare, MusicShareInput } from '../../src/shared/music';

it('grants music only to the connected topic, routes the source surface, and cancels on detach', async () => {
  const results: Awaited<ReturnType<typeof nativeCallback>>[] = [];
  let pausedControl: AbortSignal | undefined;
  let trackName = '雨后的窗';
  const execute = vi.fn(async (_scope, input: MusicExecution, signal: AbortSignal, authorize: () => void) => {
    authorize();
    if (input.action === 'status') return { playlistId: '18322613388', playlistName: '幻酱的作品集', trackName, playing: false };
    pausedControl = signal;
    return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('授权已撤回')), { once: true }));
  });
  const fixture = await nativeServiceFixture(async input => {
    if (JSON.parse(input.prompt).musicPlayer) {
      trackName = '下一首作品';
      const latest = await nativeCallback(input, 'music_global_player', { action: 'status' });
      expect(latest).toMatchObject({ ok: true, result: { trackName: '下一首作品' } });
    }
    results.push(await nativeCallback(input, 'music', { action: 'pause' }));
    return 'fixture reply';
  }, { musicTool: execute });
  try {
    const { service, calls } = fixture;
    const state = await service.handle({ type: 'state' });
    const room = state.snapshot!.conversations.find(item => item.kind === 'direct')!.id;
    const topic = (await service.handle({ type: 'topic.new', conversationId: room, requestId: 'music-topic' })).topic!;
    const send = async (requestId: string) => service.handle({ type: 'message.send', conversationId: room, topicId: topic.id, requestId, content: requestId, surface: 'call' });
    const first = await send('before-music');
    expect(first.ok).toBe(true);
    await waitNative(() => results.length === 1 && service.store.getMessage(first.replyMessageIds![0]!)?.status === 'sent');
    expect(calls[0]?.workerTools?.some(tool => tool.name.startsWith('music'))).toBe(false);
    expect(JSON.parse(calls[0]!.prompt)).not.toHaveProperty('musicPlayer');
    expect(results[0]?.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect((await service.handle({ type: 'app.connect', conversationId: room, topicId: topic.id, appId: 'music' })).ok).toBe(true);
    expect((await send('with-music')).ok).toBe(true);
    await waitNative(() => !!pausedControl);
    expect(calls[1]?.workerTools?.filter(tool => tool.name.startsWith('music')).map(tool => tool.name)).toEqual(['music', 'music_global_player']);
    expect(JSON.parse(calls[1]!.prompt).musicPlayer).toMatchObject({ trackName: '雨后的窗', playlistName: '幻酱的作品集', observedAt: expect.any(String) });
    expect(execute.mock.calls[0]?.[0]).toEqual({ conversationId: room, surface: 'call' });
    expect(execute.mock.calls.map(call => call[1])).toEqual([
      { action: 'status', target: 'global' }, { action: 'status', target: 'global' }, { action: 'pause', target: 'inline' },
    ]);
    expect((await service.handle({ type: 'app.detach', conversationId: room, topicId: topic.id, appId: 'music' })).ok).toBe(true);
    await waitNative(() => results.length === 2);
    expect(results[1]?.ok).toBe(false);
    expect(pausedControl?.aborted).toBe(true);
    expect((await send('after-detach')).ok).toBe(true);
    await waitNative(() => results.length === 3);
    expect(JSON.parse(calls[2]!.prompt)).not.toHaveProperty('musicPlayer');
    expect(execute).toHaveBeenCalledTimes(3);
  } finally { await fixture.close(); }
});

it('delivers unqualified track and playlist playback as live cards and preserves explicit global playback', async () => {
  const musicTool = vi.fn<(scope: unknown, input: MusicExecution) => Promise<{ accepted: boolean }>>(async () => ({ accepted: true }));
  const prepareMusicShare = vi.fn(async (id: string, input: MusicShareInput): Promise<MusicShare> => ({
    id, title: '一份作品', queue: input.queue, mode: input.mode, trackCount: 1, preview: ['第一首'],
  }));
  const fixture = await nativeServiceFixture(async run => {
    await nativeCallback(run, 'music', { action: 'play', trackId: '102' }, 'default-track');
    await nativeCallback(run, 'music', { action: 'play', playlistId: '300' }, 'default-playlist');
    await nativeCallback(run, 'music', { action: 'volume', volume: 0.5 }, 'live-volume');
    await nativeCallback(run, 'music_global_player', { action: 'play', trackId: '101' }, 'global-track');
    return 'fixture reply';
  }, { musicTool, prepareMusicShare });
  try {
    const { service } = fixture;
    const room = (await service.handle({ type: 'state' })).snapshot!.conversations.find(item => item.kind === 'direct')!.id;
    const result = await service.handle({ type: 'message.send', conversationId: room, requestId: 'default-play', content: '一起听音乐', apps: ['music'] });
    const replyId = result.replyMessageIds![0]!;
    await waitNative(() => service.store.getMessage(replyId)?.status === 'sent');
    const cards = service.store.replyParts(replyId).flatMap(part => part.music ? [part.music] : []);
    expect(cards.map(card => card.queue)).toEqual([
      { kind: 'tracks', tracks: [{ playlistId: '18322613388', trackId: '102' }] },
      { kind: 'playlist', playlistId: '300' },
    ]);
    expect(musicTool.mock.calls.map(call => call[1])).toEqual([
      { action: 'status', target: 'global' },
      { action: 'present', target: 'inline', card: cards[0] },
      { action: 'present', target: 'inline', card: cards[1] },
      { action: 'volume', target: 'inline', volume: 0.5 },
      { action: 'play', target: 'global', trackId: '101' },
    ]);
  } finally { await fixture.close(); }
});

it('persists one card and auto-play attempt for a retried or concurrently requested queue', async () => {
  const musicTool = vi.fn(async () => ({ accepted: true }));
  const shares: unknown[] = [];
  const queue = { kind: 'tracks', tracks: [{ playlistId: '18322613388', trackId: '102' }, { playlistId: '300', trackId: '201' }] } as const;
  const prepareMusicShare = vi.fn(async (id: string, input: MusicShareInput): Promise<MusicShare> => ({
    id, title: input.title!, queue: input.queue, mode: input.mode, trackCount: 2, preview: ['第一首', '第二首'],
  }));
  const fixture = await nativeServiceFixture(async run => {
    const args = { action: 'share', queue, title: '一组作品', mode: 'once' };
    shares.push(...await Promise.all([
      nativeCallback(run, 'music', args, 'one-share'),
      nativeCallback(run, 'music', { ...args, title: '重复的标题' }, 'another-call-for-the-same-queue'),
    ]));
    shares.push(await nativeCallback(run, 'music', args, 'one-share'));
    shares.push(await nativeCallback(run, 'music', { ...args, queue: { kind: 'playlist', playlistId: '300' }, title: '稍后听', autoPlay: false }, 'manual-share'));
    return '';
  }, { musicTool, prepareMusicShare });
  try {
    const { service } = fixture;
    const room = (await service.handle({ type: 'state' })).snapshot!.conversations.find(item => item.kind === 'direct')!.id;
    const result = await service.handle({ type: 'message.send', conversationId: room, requestId: 'share-record', content: '分享这些作品', apps: ['music'] });
    const replyId = result.replyMessageIds![0]!;
    await waitNative(() => service.store.getMessage(replyId)?.status === 'sent');
    for (const share of shares) expect(share).toMatchObject({ ok: true, result: { published: true, messageId: replyId } });
    const snapshot = await service.handle({ type: 'state', conversationId: room });
    const cards = snapshot.snapshot?.messages.find(message => message.id === replyId)?.parts?.flatMap(part => part.music ? [part.music] : []);
    expect(cards).toMatchObject([{ queue, mode: 'once' }, { title: '稍后听' }]);
    expect(shares.slice(0, 3)).toEqual(Array(3).fill(expect.objectContaining({ result: expect.objectContaining({ card: cards?.[0] }) })));
    expect(musicTool).toHaveBeenCalledTimes(2);
    expect(musicTool).toHaveBeenCalledWith({ conversationId: room, surface: 'chat' },
      { action: 'present', target: 'inline', card: cards?.[0] }, expect.any(AbortSignal), expect.any(Function));
  } finally { await fixture.close(); }
});

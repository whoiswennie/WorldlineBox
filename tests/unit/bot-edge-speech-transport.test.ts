import { expect, it, vi } from 'vitest';
import { createBotEdgeSpeechSynthesize } from '../../src/main/companion-bot/edge-speech-transport';
import { BOT_SPEECH_DEFAULT_VOICE } from '../../src/shared/companion-bot-speech';

const sockets = vi.hoisted(() => ({ open: true, live: [] as Array<{ terminate: ReturnType<typeof vi.fn>; address: URL; options: Record<string, unknown>; sent: string[] }> }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    sent: string[] = [];
    terminate = vi.fn(() => { this.readyState = 3; this.emit('close', 1006); });
    constructor(readonly address: URL, readonly options: Record<string, unknown>) {
      super(); sockets.live.push(this);
      if (sockets.open) queueMicrotask(() => { this.readyState = 1; this.emit('open'); });
    }
    send(message: string) {
      this.sent.push(message);
      if (!message.includes('Path:ssml')) return;
      queueMicrotask(() => {
        const bytes = Buffer.from('ID3online-audio'); const header = Buffer.from('Path:audio\r\n'); const frame = Buffer.alloc(2 + header.length + bytes.length);
        frame.writeUInt16BE(header.length); header.copy(frame, 2); bytes.copy(frame, 2 + header.length);
        this.emit('message', frame, true); this.emit('message', Buffer.from('Path:turn.end\r\n'), false);
      });
    }
    close() { this.readyState = 3; this.emit('close', 1000); }
  }
  return { WebSocket: Socket };
});

it('routes the real Edge protocol through the app-resolved proxy and keeps the fixed voice/MP3 framing', async () => {
  sockets.open = true; sockets.live.length = 0;
  const route = vi.fn(async () => 'http://127.0.0.1:8123');
  const bytes = await createBotEdgeSpeechSynthesize({ resolveProxy: route })('你好。<&', { voice: BOT_SPEECH_DEFAULT_VOICE, signal: new AbortController().signal });
  expect(bytes.toString()).toBe('ID3online-audio'); expect(route).toHaveBeenCalledWith('https://api.msedgeservices.com/tts/cognitiveservices/websocket/v1');
  const socket = sockets.live[0]!; expect(socket.address.protocol).toBe('wss:'); expect(socket.address.searchParams.get('Sec-MS-GEC-Version')).toMatch(/^2-/u);
  expect(socket.options.agent).toBeDefined(); expect(socket.sent.join('\n')).toContain('zh-CN-XiaoyiNeural'); expect(socket.sent.join('\n')).toContain('&lt;&amp;'); expect(socket.sent.join('\n')).toContain('audio-24khz-48kbitrate-mono-mp3');
});
it('terminates a handshake immediately when a meeting is cancelled and never starts a request for an already cancelled signal', async () => {
  sockets.open = false; sockets.live.length = 0;
  const controller = new AbortController(); const result = createBotEdgeSpeechSynthesize()('取消验收。', { voice: BOT_SPEECH_DEFAULT_VOICE, signal: controller.signal });
  const checked = expect(result).rejects.toMatchObject({ name: 'AbortError' }); await Promise.resolve(); await Promise.resolve(); controller.abort(); await checked;
  expect(sockets.live[0]!.terminate).toHaveBeenCalledOnce(); const count = sockets.live.length;
  await expect(createBotEdgeSpeechSynthesize()('不应发出。', { voice: BOT_SPEECH_DEFAULT_VOICE, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(sockets.live).toHaveLength(count);
});
it('reports an unsupported configured proxy instead of silently connecting directly', async () => {
  const before = sockets.live.length;
  await expect(createBotEdgeSpeechSynthesize({ resolveProxy: async () => 'socks5://127.0.0.1:1080' })('你好。', { voice: BOT_SPEECH_DEFAULT_VOICE, signal: new AbortController().signal })).rejects.toThrow('HTTP');
  expect(sockets.live).toHaveLength(before);
});

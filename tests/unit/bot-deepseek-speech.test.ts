import { expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import { DeepSeekSpeech } from '../../src/main/companion-bot/deepseek-speech';

it('uses Stella and keeps the provider key on the desktop for full-text TTS and WAV dictation', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new Uint8Array([1, 2])))
    .mockResolvedValueOnce(Response.json({ text: ' 测试转写 ' }));
  const speech = new DeepSeekSpeech(() => 'fixture-only', request);
  const signal = new AbortController().signal;
  const audio: number[] = [];
  await speech.play('朗读全文。', false, bytes => { audio.push(...bytes); }, signal);
  expect(audio).toEqual([1, 2]);
  const wav = Buffer.alloc(46);
  wav.write('RIFF'); wav.write('WAVE', 8);
  await expect(speech.transcribe(wav, signal)).resolves.toBe('测试转写');
  expect(request.mock.calls.map(([url, init]) => [url, init?.method, new Headers(init?.headers).get('authorization')])).toEqual([
    ['https://api.deepseek.com/v1/tools/tts', 'POST', 'Bearer fixture-only'],
    ['https://api.deepseek.com/v1/tools/asr', 'POST', 'Bearer fixture-only'],
  ]);
  expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({ text: '朗读全文。', voice_id: 'stella', format: 'pcm' });
  expect((request.mock.calls[1]?.[1]?.body as FormData).get('file')).toMatchObject({ name: 'speech.wav', size: 46 });
});

it('streams WebSocket audio frames in order and waits for an explicit provider finish', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const sent: unknown[] = [];
  server.on('connection', (socket, request) => {
    expect(request.headers.authorization).toBe('Bearer fixture-only');
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()); sent.push(message);
      if (message.event === 'text') socket.send(Buffer.from([sent.length, 0]));
      if (message.event === 'finish_text') socket.send(JSON.stringify({ event: 'finish', code: 'success' }));
    });
  });
  try {
    const speech = new DeepSeekSpeech(() => 'fixture-only', fetch, async () => 'DIRECT', (url, options) => {
      expect(url).toBe('wss://api.deepseek.com/v1/tools/tts?voice_id=stella&format=pcm');
      return new WebSocket(`ws://127.0.0.1:${port}`, options);
    });
    const audio: number[] = [];
    await speech.play('你好。再见！', true, async bytes => { await Promise.resolve(); audio.push(...bytes); }, AbortSignal.timeout(3000));
    expect(sent).toEqual([{ event: 'text', text: '你好。' }, { event: 'text', text: '再见！' }, { event: 'finish_text' }]);
    expect(audio).toEqual([1, 0, 2, 0]);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

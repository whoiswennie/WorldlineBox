import { WebSocket, type ClientOptions } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { BotMessage } from '../../shared/companion-bot';

const endpoint = 'https://api.deepseek.com/v1/tools/';
const maxRecording = 8 * 1024 * 1024;
const speechError = (status: number) => new Error(`DeepSeek 语音服务请求失败（${status}）。`);

export function speechText(message: BotMessage | undefined, conversationId: string, partId?: string) {
  if (!message || message.conversationId !== conversationId || message.senderId === 'user') throw Error('当前会话中没有这条伙伴消息。');
  const text = partId ? message.parts?.find(part => part.id === partId && part.presentation)?.text
    : message.status === 'sent' ? message.content : undefined;
  if (!text?.trim()) throw Error('这条消息没有可朗读的内容。');
  return text;
}

function chunks(text: string) {
  const parts: string[] = [];
  let part = '', weight = 0;
  for (const character of text) {
    const size = /\p{Script=Han}/u.test(character) ? 2 : 1;
    if (weight + size > 9800) { parts.push(part); part = ''; weight = 0; }
    part += character;
    weight += size;
  }
  if (part.trim()) parts.push(part);
  return parts.filter(value => value.trim());
}

export class DeepSeekSpeech {
  constructor(private readonly credential: () => string, private readonly request: typeof fetch = fetch,
    private readonly proxy: (url: string) => Promise<string> = async () => 'DIRECT',
    private readonly connect = (url: string, options: ClientOptions) => new WebSocket(url, options)) {}

  private authorization() {
    const key = this.credential().trim();
    if (!key) throw Error('请在电脑端「全局模型」中保存 DeepSeek 官方 API 配置。');
    return `Bearer ${key}`;
  }

  async transcribe(wav: Buffer, signal: AbortSignal) {
    if (wav.length <= 44 || wav.length > maxRecording || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw Error('录音格式无效。');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
    const response = await this.request(endpoint + 'asr', { method: 'POST', headers: { Authorization: this.authorization() }, body: form, signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
    if (!response.ok) { await response.body?.cancel(); throw speechError(response.status); }
    const result = await response.json() as { text?: unknown };
    if (typeof result.text !== 'string') throw Error('语音识别返回格式异常。');
    return result.text.trim();
  }

  async play(text: string, streaming: boolean, output: (audio: Uint8Array) => void | Promise<void>, signal: AbortSignal) {
    const authorization = this.authorization();
    for (const part of chunks(text)) {
      signal.throwIfAborted();
      if (streaming) await this.streamPart(part, authorization, output, signal);
      else {
        const response = await this.request(endpoint + 'tts', { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: part, voice_id: 'stella', format: 'pcm' }), signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]) });
        if (!response.ok || !response.body) { await response.body?.cancel(); throw speechError(response.status); }
        const reader = response.body.getReader();
        let size = 0;
        try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; await output(chunk.value); } }
        finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        if (!size || size % 2) throw Error('DeepSeek 返回的音频不完整。');
      }
    }
  }

  private async streamPart(text: string, authorization: string, output: (audio: Uint8Array) => void | Promise<void>, signal: AbortSignal) {
    const url = 'wss://api.deepseek.com/v1/tools/tts?voice_id=stella&format=pcm';
    const proxy = await this.proxy(endpoint + 'tts');
    signal.throwIfAborted();
    if (proxy.startsWith('socks')) throw Error('DeepSeek 流式语音需要直连或 HTTP(S) 代理。');
    const agent = proxy === 'DIRECT' ? undefined : new HttpsProxyAgent(proxy);
    return new Promise<void>((resolve, reject) => {
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
      const socket = this.connect(url, { headers: { Authorization: authorization }, agent, handshakeTimeout: 15_000, maxPayload: 1024 * 1024 });
      let playback = Promise.resolve(), size = 0;
      let finished = false;
      const settle = (error?: unknown) => {
        if (finished) return;
        finished = true;
        timeout.removeEventListener('abort', abort);
        if (error) { socket.terminate(); reject(error); }
        else { socket.close(); playback.then(resolve, reject); }
      };
      const abort = () => settle(timeout.reason);
      timeout.addEventListener('abort', abort, { once: true });
      socket.on('error', () => settle(Error('无法连接 DeepSeek 流式语音服务。')));
      socket.once('close', () => agent?.destroy());
      socket.on('close', () => settle(Error('DeepSeek 语音流提前结束。')));
      socket.on('open', () => {
        for (const segment of text.match(/[^。！？!?\n]+[。！？!?\n]*|[。！？!?\n]+/gu) ?? [text]) socket.send(JSON.stringify({ event: 'text', text: segment }));
        socket.send(JSON.stringify({ event: 'finish_text' }));
      });
      socket.on('message', (data, binary) => {
        if (finished) return;
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (binary) {
          size += bytes.length;
          socket.pause();
          playback = playback.then(() => output(bytes)).then(() => { if (!finished) socket.resume(); });
          void playback.catch(settle);
          return;
        }
        try {
          const event = JSON.parse(bytes.toString()) as { event?: string; code?: string };
          if (event.event === 'finish') settle(event.code === 'success' && size > 0 && size % 2 === 0 ? undefined : Error('DeepSeek 流式语音合成失败或音频不完整。'));
        } catch { settle(Error('DeepSeek 语音流返回格式异常。')); }
      });
      if (timeout.aborted) abort();
    });
  }
}

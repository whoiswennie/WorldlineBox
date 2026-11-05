import { randomUUID } from 'node:crypto';
import { EdgeTTS } from 'node-edge-tts';
import { generateSecMsGecToken_V2, SEC_MS_GEC_VERSION_V2, TRUSTED_CLIENT_TOKEN, CHROMIUM_FULL_VERSION } from 'node-edge-tts/dist/drm';
import { WebSocket } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { BOT_SPEECH_MAX_AUDIO_BYTES, type BotSpeechAudio } from '../../shared/companion-bot-speech';

const EDGE_SPEECH_ENDPOINT = 'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1';
const abortError = () => Object.assign(Error('语音合成已取消。'), { name: 'AbortError' });
export interface BotEdgeSpeechOptions { resolveProxy?(destination: string): Promise<string> }
export interface BotSpeechSynthesisOptions { voice: BotSpeechAudio['voice']; signal: AbortSignal }
export type BotSpeechSynthesize = (text: string, options: BotSpeechSynthesisOptions) => Promise<Buffer>;

function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(abortError()); };
    signal.addEventListener('abort', abort, { once: true });
    void task.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) reject(abortError()); else resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

/** MIT node-edge-tts owns framing/auth/SSML; this connector adds app routing and immediate cancellation. */
export function createBotEdgeSpeechSynthesize(options: BotEdgeSpeechOptions = {}): BotSpeechSynthesize {
  return async (text, { voice, signal }) => {
    const route = await abortable(options.resolveProxy?.(EDGE_SPEECH_ENDPOINT.replace('wss:', 'https:')) ?? Promise.resolve('DIRECT'), signal);
    let proxy: URL | undefined;
    if (route && route !== 'DIRECT') {
      proxy = new URL(route);
      if (!['http:', 'https:'].includes(proxy.protocol)) throw Error('当前语音代理需要 HTTP 或 HTTPS 代理地址。');
    }
    const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
    class MeetingEdgeTTS extends EdgeTTS {
      override _connectWebSocket(): Promise<WebSocket> {
        if (signal.aborted) return Promise.reject(abortError());
        const target = new URL(EDGE_SPEECH_ENDPOINT);
        target.searchParams.set('Ocp-Apim-Subscription-Key', TRUSTED_CLIENT_TOKEN);
        target.searchParams.set('Sec-MS-GEC', generateSecMsGecToken_V2());
        target.searchParams.set('Sec-MS-GEC-Version', SEC_MS_GEC_VERSION_V2);
        target.searchParams.set('ConnectionId', randomUUID().replaceAll('-', ''));
        const major = CHROMIUM_FULL_VERSION.split('.')[0];
        const socket = new WebSocket(target, {
          origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold', agent,
          maxPayload: BOT_SPEECH_MAX_AUDIO_BYTES, handshakeTimeout: 15_000,
          headers: { Pragma: 'no-cache', 'Cache-Control': 'no-cache',
            'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5' },
        });
        return new Promise((resolve, reject) => {
          const abort = () => { socket.terminate(); reject(abortError()); };
          signal.addEventListener('abort', abort, { once: true });
          socket.once('open', () => { if (signal.aborted) abort(); else resolve(socket); });
          // Keep this listener until close, including the handoff to streamAudio.
          const failure = (error: Error) => reject(error);
          socket.on('error', failure);
          socket.once('close', () => { signal.removeEventListener('abort', abort); socket.off('error', failure); reject(signal.aborted ? abortError() : Error('Edge 语音连接已关闭。')); });
          if (signal.aborted) abort();
        });
      }
    }
    const client = new MeetingEdgeTTS({ voice, lang: 'zh-CN', rate: '+0%', pitch: '+0Hz', volume: '+0%', outputFormat: 'audio-24khz-48kbitrate-mono-mp3', timeout: 30_000 });
    const chunks: Buffer[] = []; let size = 0;
    try {
      for await (const chunk of client.streamAudio(text)) {
        if (signal.aborted) throw abortError();
        if (!Buffer.isBuffer(chunk)) continue;
        size += chunk.length;
        if (size > BOT_SPEECH_MAX_AUDIO_BYTES) throw Error('语音数据超出本次播放大小限制。');
        chunks.push(chunk);
      }
      if (signal.aborted) throw abortError();
      if (!size) throw Error('Edge 没有返回可播放的语音。');
      return Buffer.concat(chunks, size);
    } finally { agent?.destroy(); }
  };
}

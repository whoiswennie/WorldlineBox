import { createHash } from 'node:crypto';
import { BOT_SPEECH_DEFAULT_VOICE, BOT_SPEECH_MAX_AUDIO_BYTES, botSpeechParts, botSpeechRequestSchema, type BotSpeechAudio, type BotSpeechRequest, type BotSpeechResponse } from '../../shared/companion-bot-speech';
import type { BotConversation, BotMessage } from '../../shared/companion-bot';
import { createBotEdgeSpeechSynthesize, type BotSpeechSynthesize } from './edge-speech-transport';

export interface BotSpeechServiceOptions {
  getMessage(id: string): BotMessage | undefined;
  getConversation(id: string): BotConversation | undefined;
  resolveProxy?(destination: string): Promise<string>;
  synthesize?: BotSpeechSynthesize;
}
interface Work { fingerprint: string; controller: AbortController; promise: Promise<BotSpeechResponse> }
interface CachedSpeech { audio: BotSpeechAudio; size: number; expires: number }
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** Read-aloud of authorized final companion messages, never another chat/brain pipeline. */
export class BotSpeechService {
  private readonly synthesize: BotSpeechSynthesize;
  private readonly active = new Map<string, Work>();
  private readonly cancelled = new Map<string, number>();
  private readonly cache = new Map<string, CachedSpeech>();
  private cacheBytes = 0;
  private disposed = false;
  constructor(private readonly options: BotSpeechServiceOptions) { this.synthesize = options.synthesize ?? createBotEdgeSpeechSynthesize(options); }

  cancel(requestId: string): boolean {
    this.cancelled.set(requestId, Date.now() + 30_000);
    while (this.cancelled.size > 64) this.cancelled.delete(this.cancelled.keys().next().value!);
    const work = this.active.get(requestId); work?.controller.abort(); return !!work;
  }
  dispose(): void { this.disposed = true; for (const work of this.active.values()) work.controller.abort(); this.cache.clear(); this.cacheBytes = 0; this.cancelled.clear(); }
  private authorized(conversationId: string, messageId: string): { message: BotMessage; key: string } {
    const room = this.options.getConversation(conversationId), message = this.options.getMessage(messageId);
    if (!room || room.kind !== 'direct' || room.dissolvedAt || room.memberIds.length !== 2 || !room.memberIds.includes('user') || !message || message.conversationId !== room.id || message.status !== 'sent' || message.senderId === 'user' || !room.memberIds.includes(message.senderId)) throw Error('只能朗读当前私聊中伙伴本人已发送的回复。');
    return { message, key: digest(JSON.stringify([room.id, room.kind, room.memberIds, message.id, message.senderId, message.content])) };
  }
  request(raw: BotSpeechRequest | unknown): Promise<BotSpeechResponse> {
    const parsed = botSpeechRequestSchema.safeParse(raw);
    if (!parsed.success) return Promise.resolve({ ok: false, error: '语音请求无效。' });
    const input = parsed.data;
    if (input.type === 'speech.cancel') { this.cancel(input.requestId); return Promise.resolve({ ok: true, cancelled: true }); }
    if (this.disposed) return Promise.resolve({ ok: false, cancelled: true, error: '语音服务已关闭。' });
    const fingerprint = digest(JSON.stringify([input.conversationId, input.messageId, input.partIndex ?? 0]));
    const current = this.active.get(input.requestId);
    if (current) return current.fingerprint === fingerprint ? current.promise : Promise.resolve({ ok: false, error: '同一语音请求标识不能用于其他消息。' });
    for (const [id, until] of this.cancelled) if (until <= Date.now()) this.cancelled.delete(id);
    if (this.cancelled.has(input.requestId)) return Promise.resolve({ ok: false, cancelled: true });
    if (this.active.size >= 2) return Promise.resolve({ ok: false, error: '语音服务正在处理其他片段，请稍后重试。' });
    const controller = new AbortController(); let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 35_000);
    const work: Work = { fingerprint, controller, promise: Promise.resolve({ ok: false }) };
    this.active.set(input.requestId, work);
    work.promise = Promise.resolve().then(async (): Promise<BotSpeechResponse> => {
      try {
        if (controller.signal.aborted) return timedOut ? { ok: false, error: 'Edge 语音合成超时，请稍后重试。' } : { ok: false, cancelled: true };
        const source = this.authorized(input.conversationId, input.messageId), parts = botSpeechParts(source.message.content), partIndex = input.partIndex ?? 0;
        const text = parts[partIndex]; if (!text) throw Error('这条回复没有可朗读的文字片段。');
        const key = digest(JSON.stringify([source.key, partIndex, text, BOT_SPEECH_DEFAULT_VOICE]));
        let cached = this.cache.get(key);
        if (cached && cached.expires <= Date.now()) { this.cache.delete(key); this.cacheBytes -= cached.size; cached = undefined; }
        if (cached) {
          this.cache.delete(key); this.cache.set(key, cached);
          if (controller.signal.aborted || this.authorized(input.conversationId, input.messageId).key !== source.key) return { ok: false, cancelled: true };
          return { ok: true, audio: { ...cached.audio } };
        }
        const bytes = await this.synthesize(text, { voice: BOT_SPEECH_DEFAULT_VOICE, signal: controller.signal });
        if (controller.signal.aborted || this.disposed) return timedOut ? { ok: false, error: 'Edge 语音合成超时，请稍后重试。' } : { ok: false, cancelled: true };
        if (this.authorized(input.conversationId, input.messageId).key !== source.key) throw Error('原消息或私聊权限已变化，已停止朗读。');
        if (!bytes.length || bytes.length > BOT_SPEECH_MAX_AUDIO_BYTES) throw Error('语音数据大小无效。');
        const audio: BotSpeechAudio = { base64: bytes.toString('base64'), mimeType: 'audio/mpeg', voice: BOT_SPEECH_DEFAULT_VOICE, text, partIndex, partCount: parts.length };
        const entry = { audio, size: bytes.length, expires: Date.now() + 10 * 60_000 }; this.cache.set(key, entry); this.cacheBytes += bytes.length;
        while (this.cache.size > 16 || this.cacheBytes > 8 * 1024 * 1024) { const oldest = this.cache.keys().next().value!; this.cacheBytes -= this.cache.get(oldest)!.size; this.cache.delete(oldest); }
        return { ok: true, audio: { ...audio } };
      } catch (error) {
        if (controller.signal.aborted) return timedOut ? { ok: false, error: 'Edge 语音合成超时，请稍后重试。' } : { ok: false, cancelled: true };
        return { ok: false, error: error instanceof Error && /只能朗读|没有可朗读|过长|大小|权限|代理/u.test(error.message) ? error.message : 'Edge 语音暂时无法连接，请检查网络后重试。' };
      } finally { clearTimeout(timeout); if (this.active.get(input.requestId) === work) this.active.delete(input.requestId); }
    });
    return work.promise;
  }
}

import { z } from 'zod';

export const BOT_SPEECH_CHANNEL = 'companion-bot-speech:request';
export const BOT_SPEECH_DEFAULT_VOICE = 'zh-CN-XiaoyiNeural';
export const BOT_SPEECH_PART_CHARACTERS = 320;
export const BOT_SPEECH_MAX_PARTS = 16;
export const BOT_SPEECH_MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const id = z.string().min(1).max(160).refine(value => !/[\0/\\]/u.test(value));
export const botSpeechRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('speech.synthesize'), conversationId: id, messageId: id, requestId: id, partIndex: z.number().int().min(0).max(BOT_SPEECH_MAX_PARTS - 1).optional() }),
  z.strictObject({ type: z.literal('speech.cancel'), requestId: id }),
]);
export type BotSpeechRequest = z.infer<typeof botSpeechRequestSchema>;
export interface BotSpeechAudio {
  base64: string; mimeType: 'audio/mpeg'; voice: typeof BOT_SPEECH_DEFAULT_VOICE;
  text: string; partIndex: number; partCount: number;
}
export interface BotSpeechResponse { ok: boolean; cancelled?: boolean; error?: string; audio?: BotSpeechAudio }
export interface WorldlineBoxBotSpeechApi { request(input: BotSpeechRequest): Promise<BotSpeechResponse> }

/** Spoken content excludes code, remote addresses and Markdown ornamentation. */
export function botSpeechText(source: string): string {
  return source.slice(0, 200_000)
    .replace(/```[^\n]*\n[\s\S]*?(?:```|$)|~~~[^\n]*\n[\s\S]*?(?:~~~|$)/gu, ' ')
    .replace(/`[^`\n]*`/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/giu, ' ')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/(?:https?:\/\/|www\.)[^\s<>，。！？；、）】]+/giu, ' ')
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]*|[-*+][ \t]+|\d+[.)][ \t]+)/gmu, '')
    .replace(/[*_~|]/gu, '')
    .replace(/&(?:amp|lt|gt|quot|apos);/gu, entity => ({ '&amp;': '和', '&lt;': '小于', '&gt;': '大于', '&quot;': '“', '&apos;': '’' })[entity] ?? ' ')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
}

export function botSpeechParts(source: string): string[] {
  const characters = Array.from(botSpeechText(source));
  if (characters.length > BOT_SPEECH_PART_CHARACTERS * BOT_SPEECH_MAX_PARTS) throw Error('回复过长，暂不支持完整朗读这条消息。');
  const parts: string[] = [];
  while (characters.length) {
    const candidate = characters.slice(0, BOT_SPEECH_PART_CHARACTERS);
    let cut = candidate.length;
    if (characters.length > candidate.length) {
      for (let index = candidate.length - 1; index >= Math.floor(candidate.length / 2); index--) {
        if (/[。！？.!?；;\s]/u.test(candidate[index]!)) { cut = index + 1; break; }
      }
    }
    const part = characters.splice(0, cut).join('').trim(); if (part) parts.push(part);
    if (parts.length > BOT_SPEECH_MAX_PARTS) throw Error('回复过长，暂不支持完整朗读这条消息。');
  }
  return parts;
}

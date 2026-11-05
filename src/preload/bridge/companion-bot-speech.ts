import { ipcRenderer } from 'electron';
import { BOT_SPEECH_CHANNEL, botSpeechRequestSchema, type BotSpeechRequest, type BotSpeechResponse, type WorldlineBoxBotSpeechApi } from '../../shared/companion-bot-speech';

export const companionBotSpeech: WorldlineBoxBotSpeechApi = Object.freeze({
  async request(input: BotSpeechRequest) {
    const parsed = botSpeechRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: '语音请求格式不正确。' };
    return await ipcRenderer.invoke(BOT_SPEECH_CHANNEL, parsed.data) as BotSpeechResponse;
  },
});

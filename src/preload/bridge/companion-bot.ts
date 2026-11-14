import { ipcRenderer } from 'electron';
import { BOT_CHANNEL, BOT_EVENT_CHANNEL, BOT_SPEECH_CHANNEL, BOT_SPEECH_EVENT_CHANNEL, botRequestSchema, type BotEvent, type BotRequest, type BotResponse, type BotSpeechEvent, type BotSpeechRequest, type WorldlineBoxBotApi } from '../../shared/companion-bot';

export const companionBot: WorldlineBoxBotApi = Object.freeze({
  async request(input: BotRequest) {
    const parsed = botRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: '伙伴请求格式不正确。' };
    return await ipcRenderer.invoke(BOT_CHANNEL, parsed.data) as BotResponse;
  },
  onEvent(listener: (event: BotEvent) => void) {
    const handler = (_event: Electron.IpcRendererEvent, input: BotEvent) => listener(input);
    ipcRenderer.on(BOT_EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(BOT_EVENT_CHANNEL, handler);
  },
  speech: (input: BotSpeechRequest) => ipcRenderer.invoke(BOT_SPEECH_CHANNEL, input),
  onSpeech(listener: (event: BotSpeechEvent) => void) {
    const handler = (_event: Electron.IpcRendererEvent, input: BotSpeechEvent) => listener(input);
    ipcRenderer.on(BOT_SPEECH_EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(BOT_SPEECH_EVENT_CHANNEL, handler);
  },
});

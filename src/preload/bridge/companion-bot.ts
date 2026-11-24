import { ipcRenderer } from 'electron';
import { BOT_PUSH_TO_TALK_CHANNEL, type BotPushToTalkEvent } from '../../shared/companion-push-to-talk';
import { BOT_INBOX_CHANNEL, type BotInboxEvent, BOT_CHANNEL, BOT_EVENT_CHANNEL, BOT_SPEECH_CHANNEL, BOT_SPEECH_EVENT_CHANNEL, botRequestSchema, type BotEvent, type BotRequest, type BotResponse, type BotSpeechEvent, type BotSpeechRequest, type WorldlineBoxBotApi } from '../../shared/companion-bot';

export const companionBot: WorldlineBoxBotApi = Object.freeze({
  ...(process.platform === 'win32' && { onPushToTalk(listener: (event: BotPushToTalkEvent) => void) {
    const handle = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (action === 'press' || action === 'release' || action === 'discard' || action === 'cancel') listener(action);
    };
    ipcRenderer.on(BOT_PUSH_TO_TALK_CHANNEL, handle);
    return () => ipcRenderer.off(BOT_PUSH_TO_TALK_CHANNEL, handle);
  } }),
  inbox: (room?: string, through?: number) => ipcRenderer.invoke(BOT_INBOX_CHANNEL, room, through),
  onInbox(listener: (event: BotInboxEvent) => void) {
    const handler = (_event: Electron.IpcRendererEvent, input: BotInboxEvent) => listener(input);
    ipcRenderer.on(BOT_INBOX_CHANNEL, handler);
    return () => ipcRenderer.removeListener(BOT_INBOX_CHANNEL, handler);
  },
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

import { ipcRenderer } from 'electron';
import { LOCAL_SPEECH_CHANNEL, localSpeechRequestSchema, type LocalSpeechRequest, type WorldlineBoxLocalSpeechApi } from '../../shared/local-speech';

export const localSpeech: WorldlineBoxLocalSpeechApi = Object.freeze({
  async request(input: LocalSpeechRequest) {
    const parsed = localSpeechRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: '语音请求无效。' };
    return ipcRenderer.invoke(LOCAL_SPEECH_CHANNEL, parsed.data);
  },
});

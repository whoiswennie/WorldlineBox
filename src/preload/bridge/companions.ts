import { ipcRenderer, webUtils } from 'electron';
import { COMPANIONS_CHANNEL, COMPANIONS_CHANGED_CHANNEL, COMPANION_REPLY_STREAM_CHANNEL, companionsRequestSchema, companionsResponseSchema, companionReplyStreamEventSchema,
  type CompanionReplyStreamEvent, type CompanionsRequest, type WorldlineBoxCompanionsApi } from '../../shared/companions';

export const companions: WorldlineBoxCompanionsApi = Object.freeze({
  async importFiles(files: File[]) {
    if (!files.length || files.length > 10) return { ok: false, error: '一次可添加 1–10 个文件。' };
    const paths = [...new Set(files.map(file => webUtils.getPathForFile(file)))];
    if (paths.some(file => !file)) return { ok: false, error: '这个文件没有本机路径，请先保存到电脑再拖入。' };
    return companions.request({ type: 'attachment.import', paths });
  },
  async request(input: CompanionsRequest) {
    const parsed = companionsRequestSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: '伙伴请求格式不正确。' };
    const result = companionsResponseSchema.safeParse(await ipcRenderer.invoke(COMPANIONS_CHANNEL, parsed.data));
    return result.success ? result.data : { ok: false, error: '伙伴服务返回了无效结果。' };
  },
  onChanged(listener: () => void) {
    const handler = () => listener();
    ipcRenderer.on(COMPANIONS_CHANGED_CHANNEL, handler);
    return () => ipcRenderer.removeListener(COMPANIONS_CHANGED_CHANNEL, handler);
  },
  onReplyStream(listener: (event: CompanionReplyStreamEvent) => void) {
    const handler = (_event: Electron.IpcRendererEvent, input: unknown) => {
      const parsed = companionReplyStreamEventSchema.safeParse(input);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(COMPANION_REPLY_STREAM_CHANNEL, handler);
    return () => ipcRenderer.removeListener(COMPANION_REPLY_STREAM_CHANNEL, handler);
  },
});

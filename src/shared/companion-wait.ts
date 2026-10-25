import { z } from 'zod';

export const companionWaitArgumentsSchema = z.strictObject({
  ms: z.number().int().min(100).max(60000), reason: z.string().trim().min(1).max(300),
});
const parameters = z.toJSONSchema(companionWaitArgumentsSchema); delete parameters.$schema;
export const COMPANION_WAIT_TOOL = { name: 'wait', parameters,
  description: '等待外部操作完成，暂停当前循环而不反复请求模型或重复点击。ms为100到60000毫秒，reason说明正在等什么；收到用户引导会提前醒来。等待后检查真实状态再决定下一步，不能仅凭时间宣称成功。浏览器加载、播放、下载等异步操作可使用；不占用其他伙伴的循环。' } as const;

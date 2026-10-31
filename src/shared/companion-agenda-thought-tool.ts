import { z } from 'zod';

export const companionAgendaThoughtArgumentsSchema = z.strictObject({ title: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(24000), observationId: z.uuid().optional() });
const parameters = z.toJSONSchema(companionAgendaThoughtArgumentsSchema, { io: 'input' }); delete parameters.$schema;
export const COMPANION_AGENDA_THOUGHT_TOOL = { name: 'think', parameters: { type: 'object', ...parameters },
  description: '在本次持续授权内调用真实DSH进行独立深度思考。分析prompt中明确提供的资料；可选observationId只接受本次watch真实返回的观察标识，由宿主复核当前执行、授权与素材指纹后，把实际抽样拼图作为DSH原生图片输入。不要传文件路径，不借用其他伙伴或执行的观察。宿主使用全新隔离会话、read-only、tools=[]、skills=[]，没有终端、任意文件或电脑操作能力。DSH只理解实际提交的抽样画面，不能据此声称看完完整视频或分析未采样细节。返回真实执行记录和有限摘要；失败、取消及未知结果保持原记录。' } as const;

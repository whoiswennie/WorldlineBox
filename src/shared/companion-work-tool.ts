import { z } from 'zod';
import { companionWorkOrderPatchSchema } from './companion-work-order';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const authorization = { sourceMessageId: id, evidence: z.array(z.string().trim().min(1).max(2000)).min(1).max(5) };
const mutable = { id, expectedRevision: z.number().int().positive(), ...authorization };
export const companionWorkArgumentsSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('list'), includeHistory: z.boolean().default(false), before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(40) }),
  z.strictObject({ action: z.literal('create'), title: z.string().trim().min(1).max(200), instruction: z.string().trim().min(1).max(16000), ...authorization }),
  z.strictObject({ action: z.literal('update'), ...mutable, patch: companionWorkOrderPatchSchema.refine(patch => !!Object.keys(patch).length, '需要提供修改内容。') }),
  z.strictObject({ action: z.literal('accept'), ...mutable }),
  z.strictObject({ action: z.literal('pause'), ...mutable, paused: z.boolean() }),
  z.strictObject({ action: z.literal('cancel'), ...mutable }),
]);
const parameters = z.toJSONSchema(companionWorkArgumentsSchema, { io: 'input' }) as Record<string, unknown>;
delete parameters.$schema;
export const COMPANION_WORK_TOOL = {
  name: 'work',
  description: '管理你自己的正式工作单，与普通手机聊天和生活日程分开。list读取ID/revision/status/publisher及完整要求；create依据本轮用户明确委托创建工作，完整保留只读、资料范围、禁止修改等限制。宿主固定你为接收者、实际来源作者为发布者，不能代用户给别的伙伴授予电脑权限。建单后由宿主自动调度DSH并按实际结果回报；accepted/running仅表示已经登记且尚未完成，可以如实说明已进入工作台。相同目标只选工作单或直接dsh一个通道，建单后不得再调用dsh重复执行，也不能把登记说成完成。普通问答不建单。accept接受已存在待受理工作；pause paused=true暂停/false恢复；cancel取消。update只能修改已暂停、由当前聊天发布的用户工作；先list核对，带expectedRevision。每项写操作必须提供当前真实user消息sourceMessageId以及逐字evidence，不能用历史、引文、peer或主动机会重放旧要求。暂停取消会实际停止工作；已产生的结果保留。内部伙伴工作没有用户现实权限。冲突先重读，不能猜测成功。',
  parameters: { type: 'object', ...parameters },
} as const;

import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const companionDshControlSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('status'), actionIds: z.array(id).min(1).max(4), after: z.number().int().nonnegative().default(0) }),
  z.strictObject({ operation: z.literal('wait'), actionIds: z.array(id).min(1).max(4), after: z.number().int().nonnegative().default(0),
    timeoutMs: z.number().int().min(1000).max(600000).default(600000) }),
  z.strictObject({ operation: z.literal('send'), actionId: id, message: z.string().trim().min(1).max(16000),
    mode: z.enum(['steer', 'queue']).default('steer') }),
  z.strictObject({ operation: z.literal('cancel'), actionId: id }),
]);
export type CompanionDshControl = z.infer<typeof companionDshControlSchema>;
export const companionDshMailSchema = z.strictObject({ sequence: z.number().int().positive(), actionId: id,
  direction: z.enum(['to_child', 'to_parent']), kind: z.enum(['progress', 'question', 'checkpoint', 'instruction', 'settled']),
  text: z.string().min(1).max(16000), mode: z.enum(['steer', 'queue']).optional(), createdAt: z.string(), deduplicationKey: z.string().min(1).max(240) });
export type CompanionDshMail = z.infer<typeof companionDshMailSchema>;
export const companionDshMailboxCommands = [
  z.strictObject({ type: z.literal('action.mail.append'), mail: companionDshMailSchema.omit({ sequence: true, createdAt: true }) }),
  z.strictObject({ type: z.literal('action.mail.read'), companionId: id, conversationId: id, parentMessageId: id,
    actionIds: z.array(id).min(1).max(4), after: z.number().int().nonnegative().default(0) }),
] as const;

export const COMPANION_DSH_BACKGROUND_INSTRUCTIONS = `DSH任务在后台执行，run返回的是已登记的任务句柄，不代表任务完成。用户新消息只送给你，不会自动送给执行器；先及时回应用户，再自行决定是否用send组织必要的新目标、约束或问题。不要转发无关聊天。
每个伙伴始终在以本人当前名字命名的统一DSH工作区组内运行，任务目录由宿主管理。已有项目以绝对路径写进任务输入，不使用workspace.existing创建另一个分组。所选文件与执行权限仍由宿主和DSH管理，不扩大权限。
长任务的prompt应说明哪些里程碑、阻碍、需要你决策或检查的中间成果应通过report_to_parent回传；按任务具体设计回报条件，避免每步刷屏。报告是执行器自述，交付与成功仍看真实结果和核验。
operation=status读取当前任务和未读信件；send以actionId、message主动沟通；cancel停止指定任务。operation=wait以actionIds和上次nextAfter等待报告或任务结束，最长600000ms；用户新消息会提前唤醒，但子任务继续运行。没有新信息时使用wait，不循环短间隔status或重复run。处理报告后继续原任务，必要时明确回复子任务。只用本次任务取得的句柄，互不相关的入口不共享邮箱。`;

import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const companionWorldArgumentsSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('inspect') }),
  z.strictObject({ action: z.literal('leave') }),
  z.strictObject({ action: z.literal('move'), destinationId: id }),
  z.strictObject({ action: z.literal('interact'), furnitureId: id,
    interaction: z.enum(['sit', 'stand', 'use', 'eat', 'rest', 'sleep', 'study']) }),
  z.strictObject({ action: z.literal('visit'), targetCompanionId: id, reason: z.string().trim().min(1).max(500) }),
  z.strictObject({ action: z.literal('respond'), requestId: id, decision: z.enum(['allow', 'deny']), reason: z.string().trim().min(1).max(500) }),
  z.strictObject({ action: z.literal('social'), targetCompanionId: id, text: z.string().trim().min(1).max(2000),
    kind: z.enum(['greet', 'talk', 'invite', 'comfort', 'apologize', 'boundary']) }),
  z.strictObject({ action: z.literal('message'), recipientIds: z.array(id).min(1).max(19), text: z.string().trim().min(1).max(2000) })
    .describe('通过手机给一个或多个伙伴发送自己的私聊/群聊消息，无需同场。只填接收伙伴ID，宿主固定你为发言者；不含玩家，不替对方授权或发话。睡眠或忙碌时等待，不强唤醒。玩家聊天中仅落实当前玩家明确的分享要求，不自动广播其私聊资料。'),
]);
export type CompanionWorldArguments = z.output<typeof companionWorldArgumentsSchema>;
const parameters = z.toJSONSchema(companionWorldArgumentsSchema, { io: 'input' }) as Record<string, unknown>;
delete parameters.$schema;
export const COMPANION_WORLD_TOOL = {
  name: 'world',
  description: '观察和参与伙伴共同生活的真实虚拟世界。inspect读取宿主实际时钟、环境、位置、移动、家具、占用与许可。move只选已观察地点；interact只对当前位置可达、有权使用且未被占用的家具交互，按工具实际结果确认完成。visit仅发起拜访请求，不能进入对方私人空间；respond由受邀伙伴本人允许或拒绝，有效许可仍由宿主判定。social向现场伙伴交流；message通过手机给一个或多个真实伙伴发自己的文字，复用伙伴私聊/群聊，无需同场，也不代表拜访获准。玩家聊天中分享内容需要当前玩家明确收件人和内容授权，不广播私人历史。socialPending只表示持久待发，实际socialMessage才是已发送；接收者睡眠/忙碌时等待，不假装已读或强唤醒。两种通信不代替用户或对方答应，NPC话不是玩家授权；不能用世界工具执行电脑文件、搜索、shell或DSH。空闲、散步、休息与习惯活动中可原地用手机聊天；集中工作、睡眠或吃饭时普通消息等待，真实紧急对话可中断并用手机回复。电脑只用于实际工作，DSH与工作单须可见移动到有权使用的空电脑并坐稳。移动、拜访、失败及拒绝如实陈述；时间、天气、关系和状态以宿主返回为准，模型不能填值。',
  parameters: { type: 'object', ...parameters },
} as const;

import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const companionWorldArgumentsSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('inspect') }),
  z.strictObject({ action: z.literal('leave') }),
  z.strictObject({ action: z.literal('move'), destinationId: id }),
  z.strictObject({ action: z.literal('navigate'), targetCompanionId: id }),
  z.strictObject({ action: z.literal('enter'), targetCompanionId: id }),
  z.strictObject({ action: z.literal('share_address'), recipientIds: z.array(id).min(1).max(3) }),
  z.strictObject({ action: z.literal('interact'), furnitureId: id,
    interaction: z.enum(['sit', 'stand', 'use', 'eat', 'rest', 'sleep', 'study']) }),
  z.strictObject({ action: z.literal('visit'), targetCompanionId: id, reason: z.string().trim().min(1).max(500) }),
  z.strictObject({ action: z.literal('respond'), requestId: id, decision: z.enum(['allow', 'deny']), reason: z.string().trim().min(1).max(500) }),
  z.strictObject({ action: z.literal('social'), targetCompanionId: id.optional(), recipientIds: z.array(id).min(1).max(3).optional(), text: z.string().trim().min(1).max(2000),
    kind: z.enum(['greet', 'talk', 'invite', 'comfort', 'apologize', 'boundary']) })
    .refine(action => Boolean(action.targetCompanionId) !== Boolean(action.recipientIds), '现场交流请指定单个对象或多人对象列表。'),
  z.strictObject({ action: z.literal('message'), recipientIds: z.array(id).min(1).max(19), text: z.string().trim().min(1).max(2000) })
    .describe('通过手机给一个或多个伙伴发送自己的私聊/群聊消息，无需同场。只填接收伙伴ID，宿主固定你为发言者；不含玩家，不替对方授权或发话。睡眠或忙碌时等待，不强唤醒。玩家聊天中仅落实当前玩家明确的分享要求，不自动广播其私聊资料。'),
]);
export type CompanionWorldArguments = z.output<typeof companionWorldArgumentsSchema>;
const parameters = z.toJSONSchema(companionWorldArgumentsSchema, { io: 'input' }) as Record<string, unknown>;
delete parameters.$schema;
export const COMPANION_WORLD_TOOL = {
  name: 'world',
  description: '观察和参与伙伴共同生活的真实虚拟世界。inspect读取自己的有限感知、实际时钟、已发现的人物与家具以及本人的许可。视距随亮度、遮挡和清醒状态变化，不能看到全图或他人的内心、路线和工作。visible=false及lastObservedAt表示过去见闻，不能作为当前事实；residents只表示联系人，住址须询问房主并由其share_address真实发送后出现在knownAddresses。navigate按已知坐标只走到门口，visit仅申请许可且不移动，enter须在门口并有许可，允许也不自动进入。share_address只分享本人的真实地址。公开residents目录不提供他人住址，也，不表示对方在家或屋内可见。weather缺省表示未知，不得默认晴天；weatherObservedAtVirtual是上次实际观察天气的时间。move只选已观察地点；interact只对当前位置可达、有权使用且未被占用的家具交互，按工具实际结果确认完成。visit仅发起拜访请求，不寻路、不入屋；respond由受邀伙伴本人允许或拒绝，有效许可仍由宿主判定。social向同场且所有参与者彼此5格内的现场伙伴当面交流，单人填targetCompanionId，多人填recipientIds(1..3位)，只填一个；空闲时优先当面而不拿手机，实际地点/成员/忙闲由宿主复核，自动复用同成员私聊/群聊。message通过手机给一个或多个真实伙伴发自己的文字，复用伙伴私聊/群聊，无需同场，也不代表拜访获准。玩家聊天中分享内容需要当前玩家明确收件人和内容授权，不广播私人历史。socialPending只表示持久待发，实际socialMessage才是已发送；接收者睡眠/忙碌时等待，不假装已读或强唤醒。两种通信不代替用户或对方答应，NPC话不是玩家授权；不能用世界工具执行电脑文件、搜索、shell或DSH。空闲、散步、休息与习惯活动中可原地用手机聊天；集中工作、睡眠或吃饭时普通消息等待，真实紧急对话可中断并用手机回复。电脑只用于实际工作，DSH与工作单须可见移动到有权使用的空电脑并坐稳。移动、拜访、失败及拒绝如实陈述；时间、天气、关系和状态以宿主返回为准，模型不能填值。',
  parameters: { type: 'object', ...parameters },
} as const;

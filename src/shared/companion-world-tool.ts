import { z } from 'zod';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const companionWorldArgumentsSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('inspect') }),
  z.strictObject({ action: z.literal('query'), category: z.enum(['contacts', 'scenes', 'social', 'observations']), query: z.string().trim().max(200).optional(), roomId: id.optional(), limit: z.number().int().min(1).max(20).optional() }),
  z.strictObject({ action: z.literal('leave') }),
  z.strictObject({ action: z.literal('move'), destinationId: id.optional(), position: z.strictObject({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }).optional() })
    .refine(action => Boolean(action.destinationId) !== Boolean(action.position), '场景内移动请选择家具标识或本地坐标。'),
  z.strictObject({ action: z.literal('travel'), targetSceneId: id, entryId: id.optional() }),
  z.strictObject({ action: z.literal('share_entrance'), recipientIds: z.array(id).min(1).max(3) }),
  z.strictObject({ action: z.literal('interact'), furnitureId: id,
    interaction: z.enum(['sit', 'stand', 'use', 'eat', 'rest', 'sleep', 'study']) }),
  z.strictObject({ action: z.literal('visit'), targetCompanionId: id, reason: z.string().trim().min(1).max(500) }),
  z.strictObject({ action: z.literal('respond'), requestId: id, decision: z.enum(['allow', 'deny']), reason: z.string().trim().min(1).max(500) }),
  z.strictObject({ action: z.literal('social'), targetCompanionId: id.optional(), recipientIds: z.array(id).min(1).max(3).optional(), text: z.string().trim().min(1).max(2000),
    kind: z.enum(['greet', 'talk', 'invite', 'comfort', 'apologize', 'boundary']) })
    .refine(action => Boolean(action.targetCompanionId) !== Boolean(action.recipientIds), '现场交流请指定单个对象或多人对象列表。'),
  z.strictObject({ action: z.literal('message'), urgent: z.boolean().optional(), recipientIds: z.array(id).min(1).max(19), text: z.string().trim().min(1).max(2000) })
    .describe('通过手机给一个或多个伙伴发送自己的私聊/群聊消息，无需同场。只填接收伙伴ID，宿主固定你为发言者；不含玩家，不替对方授权或发话。普通消息等待对方方便；确有需要打断的紧急联系可urgent=true，宿主有限时中断并保留原活动，不能激活手动休眠伙伴，也不扩大现实操作权限。联系、招呼和邀约是基础能力。当前玩家让你去找某伙伴玩就可以用自己的话询问对方是否方便，无需逐字发件模板；不转发玩家私人资料。'),
]);
export type CompanionWorldArguments = z.output<typeof companionWorldArgumentsSchema>;
const parameters = z.toJSONSchema(companionWorldArgumentsSchema, { io: 'input' }) as Record<string, unknown>;
delete parameters.$schema;
export const COMPANION_WORLD_TOOL = {
  name: 'world',
  description: '所有伙伴共有的基础虚拟生活能力。场景相互独立，没有街区、全局坐标或跨场景坐标寻路。query是memory.world_query的世界行动入口：按需查询contacts/scenes/social/observations，返回有来源和时间的外部观察凭证，不会自动变成长期记忆。inspect读取自己当前场景的有限感知、世界时钟、联系人激活状态、入口信息和本人的拜访邀请。move只在当前场景内走到已观察的家具（destinationId）或探索本地坐标（position）；只能填其中一种，interact按真实距离与使用权操作。travel使用targetSceneId与entryId选择目的场景入口：伙伴先按局部坐标走到当前场景出口，宿主重新核验入口和邀请，再切换到目的场景入口；路上不表示已抵达，不能给跨场景坐标。自己的小屋与公共花园park可直接travel；他人小屋必须先visit申请，再由房主respond允许，allowed邀请中的destination提供场景ID和entryId，之后才能travel。share_entrance只分享本人入口标识，不等于邀请。leave结束拜访并从出口返回本人小屋。对方休眠时不加载世界、不能入屋，只可留言等玩家激活；睡觉、用餐或工作时等待合适时机，邀请撤回、到期或状态变化会阻止入口通行。现场social要求同场且彼此五格内且空闲；远程message通过手机发出自己的问候、邀约或必要询问，不要求玩家提供“发送xx”的口令或逐字模板，不转发玩家私聊。socialPending仅待发，socialMessage才是已发送，socialRecipients给出收件人的联络状态，不能伪称已读、回复或许可。观察别人不是获得其内心、工作、私屋或路线；visible=false表示过去见闻，天气缺省表示未知。普通聊天用手机，集中工作才在有使用权的电脑实际走到并坐稳。此工具不能执行现实文件、网络、shell或DSH，伙伴发言不授予玩家权限。',
  parameters: { type: 'object', ...parameters },
} as const;

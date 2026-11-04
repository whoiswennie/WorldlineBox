import { z } from 'zod';

const point = z.object({ x: z.number().finite(), y: z.number().finite() });
export const botWorldCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('move'), sceneId: z.string().min(1), x: z.number().int().min(0).max(127), y: z.number().int().min(0).max(127), expectedRevision: z.number().int().positive().optional() }),
  z.strictObject({ operation: z.literal('travel'), sceneId: z.string().min(1), expectedRevision: z.number().int().positive().optional() }),
  z.strictObject({ operation: z.literal('interact'), objectId: z.string().min(1).optional(), action: z.enum(['sit', 'sleep', 'rest', 'work', 'eat', 'read', 'stand']), expectedRevision: z.number().int().positive().optional() }),
]);
export type BotWorldCommand = z.infer<typeof botWorldCommandSchema>;
export const botWorldObjectSchema = z.object({ id: z.string(), kind: z.string(), name: z.string(), position: point, width: z.number().positive(), depth: z.number().positive(),
  anchor: point, blocking: z.boolean(), occupantId: z.string().optional() });
export type BotWorldObject = z.infer<typeof botWorldObjectSchema>;
export const botWorldSceneSchema = z.object({ id: z.string(), kind: z.enum(['home', 'park']), name: z.string(), ownerId: z.string().optional(), width: z.number().positive(), depth: z.number().positive(),
  origin: point, door: point, portals: z.array(z.object({ id: z.string(), direction: z.enum(['entry', 'exit', 'both']), position: point })).optional(), objects: z.array(botWorldObjectSchema) });
export type BotWorldScene = z.infer<typeof botWorldSceneSchema>;
export const botWorldActorSchema = z.object({ companionId: z.string(), name: z.string(), sceneId: z.string(), homeSceneId: z.string(), position: point,
  facing: z.enum(['north', 'east', 'south', 'west']), frame: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  activity: z.enum(['idle', 'walking', 'sitting', 'sleeping', 'resting', 'working', 'eating', 'reading']), movementSpeed: z.number().positive(),
  route: z.array(point.extend({ sceneId: z.string() })), objectId: z.string().optional(),
  pending: z.discriminatedUnion('operation', [z.object({ operation: z.literal('travel'), sceneId: z.string() }),
    z.object({ operation: z.literal('interact'), objectId: z.string(), action: z.enum(['sit', 'sleep', 'rest', 'work', 'eat', 'read']) })]).optional() });
export type BotWorldActor = z.infer<typeof botWorldActorSchema>;
export const botWorldEventSchema = z.object({ id: z.string(), effectId: z.string(), companionId: z.string(), sceneId: z.string(), kind: z.enum(['move', 'travel', 'interact', 'arrival']),
  text: z.string(), recipientIds: z.array(z.string()), createdAt: z.string() });
export type BotWorldEvent = z.infer<typeof botWorldEventSchema>;
export interface BotWorldSnapshot {
  revision: number; observedAt: string; companionId: string; scenes: BotWorldScene[]; actors: BotWorldActor[]; events: BotWorldEvent[];
}
export interface BotWorldScope { companionId: string; conversationId: string }
export interface BotWorldReceipt { effectId: string; actorId: string; status: 'moving' | 'arrived' | 'applied'; revision: number; text: string }

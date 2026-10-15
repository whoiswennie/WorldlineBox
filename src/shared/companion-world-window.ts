import { z } from 'zod';
import { companionIdSchema, companionSchema, companionsResponseSchema, type Companion, type CompanionsResponse } from './companions';
import { companionWorldPublicCommands } from './companion-world';

export const COMPANION_WORLD_WINDOW_CHANNEL = 'worldlinebox:companion-world-window';
export const COMPANION_WORLD_WINDOW_CHANGED_CHANNEL = 'worldlinebox:companion-world-window-changed';
export const COMPANION_WORLD_WINDOW_VISIBILITY_CHANNEL = 'worldlinebox:companion-world-window-visibility';
export const COMPANION_WORLD_WINDOW_ARGUMENT = '--worldlinebox-companion-world';
export type CompanionWorldContact = Pick<Companion, 'id' | 'name' | 'avatar' | 'avatarAttachmentId'>;
export const companionWorldContactSchema = companionSchema.pick({ id: true, name: true, avatar: true, avatarAttachmentId: true });
export const companionWorldWindowOpenSchema = z.strictObject({ sceneId: companionIdSchema.optional(), companionId: companionIdSchema.optional() });
export type CompanionWorldWindowOpen = z.infer<typeof companionWorldWindowOpenSchema>;
export const companionWorldObserverRequestSchema = z.discriminatedUnion('type', [companionWorldPublicCommands[0], companionWorldPublicCommands[1]]);
export type CompanionWorldObserverRequest = z.infer<typeof companionWorldObserverRequestSchema>;
export const companionWorldWindowControlSchema = z.enum(['get-state', 'minimize', 'maximize-toggle', 'close']);
export type CompanionWorldWindowControl = z.infer<typeof companionWorldWindowControlSchema>;
export const companionWorldWindowContextSchema = z.object({ observerKey: z.string().regex(/^companion-world-observer(?:-\d+)?$/),
  companionId: companionIdSchema.optional(), sceneId: companionIdSchema.optional(), companions: z.array(companionWorldContactSchema), visible: z.boolean(), visibleWindowCount: z.number().int().nonnegative() });
export type CompanionWorldWindowContext = z.infer<typeof companionWorldWindowContextSchema>;
export const companionWorldWindowVisibilitySchema = z.object({ visible: z.boolean(), visibleWindowCount: z.number().int().nonnegative() });
export const companionWorldWindowCommandSchema = z.discriminatedUnion('type', [
  companionWorldWindowOpenSchema.extend({ type: z.literal('open') }).strict(),
  z.strictObject({ type: z.literal('context') }),
  z.strictObject({ type: z.literal('request'), request: companionWorldObserverRequestSchema }),
  z.strictObject({ type: z.literal('control'), action: companionWorldWindowControlSchema }),
]);
export const companionWorldWindowResultSchema = z.object({ ok: z.boolean(), error: z.string().optional(), context: companionWorldWindowContextSchema.optional(),
  response: companionsResponseSchema.optional(), maximized: z.boolean().optional() });
export type CompanionWorldWindowResult = z.infer<typeof companionWorldWindowResultSchema>;
export interface CompanionWorldWindowApi {
  open(input?: CompanionWorldWindowOpen): Promise<CompanionWorldWindowResult>;
  context(): Promise<CompanionWorldWindowResult>;
  request(input: CompanionWorldObserverRequest): Promise<CompanionsResponse>;
  control(action: CompanionWorldWindowControl): Promise<CompanionWorldWindowResult>;
  onChanged(listener: () => void): () => void;
  onVisibility(listener: (event: { visible: boolean; visibleWindowCount: number }) => void): () => void;
}

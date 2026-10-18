import { z } from 'zod';
import { dshNetworkPatchSchema, dshNetworkSettingsSchema, dshNetworkStateSchema } from './dsh-launcher';

export const APPLICATION_NETWORK_REQUEST = 'worldlinebox:network:request';
export const APPLICATION_NETWORK_CHANGED = 'worldlinebox:network:changed';
export const applicationNetworkFailureSchema = z.object({
  id: z.string().min(1).max(100), origin: z.string().max(2048), error: z.string().max(200),
  resourceType: z.string().max(100), module: z.enum(['application', 'browser', 'session']).optional(),
  occurredAt: z.string(), count: z.number().int().positive(),
});
export type ApplicationNetworkFailure = z.infer<typeof applicationNetworkFailureSchema>;
// Reuse the existing persisted policy and configuration location for upgrades.
// This API is owned by the application and never initializes the launcher.
export const applicationNetworkStateSchema = dshNetworkStateSchema.extend({
  recentFailures: z.array(applicationNetworkFailureSchema).max(40).default([]),
});
export type ApplicationNetworkState = z.infer<typeof applicationNetworkStateSchema>;
export const applicationNetworkRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('state') }),
  z.strictObject({ type: z.literal('network.inspect') }),
  z.strictObject({ type: z.literal('network.save'), settings: dshNetworkSettingsSchema }),
  z.strictObject({ type: z.literal('network.patch'), patch: dshNetworkPatchSchema }),
  z.strictObject({ type: z.literal('network.proxy.toggle'), enabled: z.boolean() }),
  z.strictObject({ type: z.literal('network.test') }),
  z.strictObject({ type: z.literal('network.diagnostics.clear') }),
]);
export type ApplicationNetworkRequest = z.infer<typeof applicationNetworkRequestSchema>;
export const applicationNetworkResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), state: applicationNetworkStateSchema.optional(), text: z.string().optional() }),
  z.object({ ok: z.literal(false), error: z.string().max(2000) }),
]);
export type ApplicationNetworkResponse = z.infer<typeof applicationNetworkResponseSchema>;
export interface WorldlineBoxApplicationNetworkApi {
  request(request: ApplicationNetworkRequest): Promise<ApplicationNetworkResponse>;
  onChanged(listener: (state: ApplicationNetworkState) => void): () => void;
}

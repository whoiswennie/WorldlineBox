import { z } from 'zod';

// Host-only durable observation. JSON keeps this checkpoint schema independent
// of the world/tool schemas; Main validates both bodies before consuming them.
export const companionReplyReceivedStateSchema = z.strictObject({
  capturedAt: z.iso.datetime(), worldJson: z.string().min(1).max(2 * 1024 * 1024),
  runtimeStateJson: z.string().min(1).max(512 * 1024), revocationEpoch: z.number().int().nonnegative().safe(),
  kind: z.enum(['received', 'preparation']).default('received'),
});
export type CompanionReplyReceivedState = z.infer<typeof companionReplyReceivedStateSchema>;

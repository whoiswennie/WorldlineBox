import { z } from 'zod';

/** Worker control message. Default in the service is show (current browse). */
export const linkedMissingVisibilityMessageSchema = z.strictObject({
  type: z.literal('linked-missing-visibility.set'),
  show: z.boolean(),
});

export type LinkedMissingVisibilityMessage = z.infer<typeof linkedMissingVisibilityMessageSchema>;

export function parseLinkedMissingVisibilityMessage(
  input: unknown,
): LinkedMissingVisibilityMessage | undefined {
  const parsed = linkedMissingVisibilityMessageSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

import { z } from 'zod';

export const criticalConfirmationPayloadSchema = z.strictObject({
  title: z.string().min(1).max(160),
  heading: z.string().min(1).max(200),
  message: z.string().min(1).max(500),
  detail: z.string().min(1).max(2_000),
  cancelLabel: z.string().min(1).max(80),
  confirmLabel: z.string().min(1).max(80),
});
export type CriticalConfirmationPayload = z.infer<typeof criticalConfirmationPayloadSchema>;

export const criticalConfirmationDecisionSchema = z.enum(['cancel', 'confirm']);
export type CriticalConfirmationDecision = z.infer<typeof criticalConfirmationDecisionSchema>;

export const criticalConfirmationInitialFocusSchema = z.enum(['cancel', 'confirm']);
export type CriticalConfirmationInitialFocus = z.infer<typeof criticalConfirmationInitialFocusSchema>;

/** Main → renderer prompt. The dialog lives in the themed app window. */
export const criticalConfirmationPromptSchema = criticalConfirmationPayloadSchema.extend({
  requestId: z.string().uuid(),
  initialFocus: criticalConfirmationInitialFocusSchema,
});
export type CriticalConfirmationPrompt = z.infer<typeof criticalConfirmationPromptSchema>;

export const criticalConfirmationRespondSchema = z.strictObject({
  requestId: z.string().uuid(),
  decision: criticalConfirmationDecisionSchema,
});
export type CriticalConfirmationRespond = z.infer<typeof criticalConfirmationRespondSchema>;

/** Disk-delete confirms default to the destructive button. Other confirms stay on Cancel. */
export function criticalConfirmationInitialFocusForOperation(
  operation: 'folder' | 'linked-folder' | 'linked-asset' | 'asset' | 'asset-permanent' | 'trash-purge',
): CriticalConfirmationInitialFocus {
  return operation === 'folder'
    || operation === 'linked-folder'
    || operation === 'linked-asset'
    || operation === 'asset'
    ? 'confirm'
    : 'cancel';
}

export function criticalDiskDeleteConfirmLabel(english: boolean): string {
  return english ? 'Force delete' : '强制删除';
}

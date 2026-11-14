import { z } from 'zod';
import type { BotPerformanceCopy } from './bot-portrait-performance';

export const BOT_CALL_SEGMENTS_PER_TURN = 100;
export const BOT_CALL_SEGMENT_LENGTH = 500;
export const BOT_CALL_MIN_DURATION_MS = 400;
export const BOT_CALL_MAX_DURATION_MS = 20_000;
const name = z.string().min(1).max(160);
const file = z.string().min(1).max(240).refine(value => !/[:\\?#%\0]/u.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..'));

export const botCallModelRegistry = z.record(name, z.strictObject({ model: file, catalog: file.optional(), vts: file.optional() }));
export const botCallVtsParameter = z.object({
  Input: z.string().max(100), OutputLive2D: name,
  OutputRangeLower: z.number().finite(), OutputRangeUpper: z.number().finite(),
  UseBreathing: z.boolean().optional(),
});
export const botCallModelCatalog = z.object({
  expressions: z.array(z.object({ name, file, params: z.array(name), aliases: z.array(name).optional(), customization: z.boolean().optional() })).max(100),
  motions: z.array(z.object({ name, file, group: name, index: z.number().int().nonnegative(), duration: z.number().finite().nonnegative(), params: z.array(name), aliases: z.array(name).optional() })).max(100),
  credits: z.string(),
  license: z.string(),
});
export type BotCallModelCatalog = z.infer<typeof botCallModelCatalog>;
export interface BotCallModel {
  /** Relative to the app's companion-call assets. */
  model: string;
  catalog?: string;
  assets: BotCallModelCatalog;
  manifest?: { Expressions: Array<{ Name: string; File: string }>; Motions: Record<string, Array<{ File: string; FadeInTime?: number; FadeOutTime?: number }>> };
  vtsParameters?: z.infer<typeof botCallVtsParameter>[];
}
export const botCallGestures = ['nod', 'shake', 'blink'] as const;
export const botCallSegmentSchema = z.strictObject({
  text: z.string().trim().min(1).max(BOT_CALL_SEGMENT_LENGTH).refine(value => !value.includes('\0')),
  expression: name.optional(),
  motion: name.optional(),
  gesture: z.enum(botCallGestures).optional(),
  durationMs: z.number().int().min(BOT_CALL_MIN_DURATION_MS).max(BOT_CALL_MAX_DURATION_MS).optional(),
});
export type BotCallSegment = z.infer<typeof botCallSegmentSchema>;
export type BotCallCue = Omit<BotCallSegment, 'text'>;
export const botCallMotionId = (motion: BotCallModelCatalog['motions'][number]) => `${motion.group}:${motion.index}`;

export interface BotCallStageChoice {
  name: string;
  label?: BotPerformanceCopy;
  description?: BotPerformanceCopy;
  file?: string;
  parameters?: readonly string[];
  aliases?: readonly string[];
  customization?: boolean;
}
export interface BotCallStageMotion extends BotCallStageChoice {
  id: string;
  durationSeconds?: number;
  idle?: boolean;
}
export interface BotCallStage {
  mode: 'live2d' | 'portrait';
  model?: string;
  catalog?: string;
  expressions: readonly BotCallStageChoice[];
  motions: readonly BotCallStageMotion[];
  gestures: readonly (typeof botCallGestures)[number][];
}
export const botCallGestureLabels = {
  nod: ['点头', 'Nod'], shake: ['摇头', 'Shake head'], blink: ['眨眼', 'Blink'],
} as const;
export const botCallGestureDescriptions = {
  nod: ['表示听懂或同意。', 'Acknowledge understanding or agreement.'],
  shake: ['轻轻表达不同意或否认。', 'Gently disagree or deny something.'],
  blink: ['用于短暂停顿或轻巧的反应。', 'Use for a brief pause or a light reaction.'],
} as const;

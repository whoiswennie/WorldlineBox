import { z } from 'zod';
import { companionMemoryLifePlanSchema } from './companion-life-plan';
import { companionMemoryProcessingSchema } from './companion-memory-processing';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u), instant = z.iso.datetime();
export const companionLifeOverviewFilterSchema = z.enum(['all', 'current', 'upcoming', 'attention', 'events']);
const page = { companionId: id, filter: companionLifeOverviewFilterSchema.default('all'), cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(40).default(20) };
export const companionLifeOverviewCommand = z.strictObject({ type: z.literal('life.overview.status'), ...page });
export const companionLifeOverviewReadCommand = z.strictObject({ type: z.literal('life.overview.read'), ...page });
export const companionLifeOverviewItemSchema = z.object({ id: z.string().max(180), kind: z.enum(['action', 'activity', 'schedule', 'life_event', 'life_rule']),
  title: z.string().max(160), status: z.string().max(30), section: z.enum(['current', 'upcoming', 'attention', 'events']), condition: z.string().max(500),
  timing: z.object({ kind: z.enum(['scheduled', 'eligibility', 'retry', 'window', 'conditional', 'none']), clock: z.enum(['real', 'world']),
    timeZone: z.string().max(100).optional(), at: instant.optional(), windowStart: instant.optional(), windowEnd: instant.optional() }),
  updatedAt: instant.optional(), probability: z.number().min(0).max(1).optional(),
  destination: z.object({ kind: z.enum(['work', 'activity', 'schedules', 'life_rules']), id, conversationId: id.optional() }),
});
export const companionLifeOverviewContextSchema = z.object({ companionId: id, checkedAt: instant,
  clock: z.object({ realNow: instant, virtualNow: instant, observedRealAt: instant, timeZone: z.string(), speed: z.number().positive(), mode: z.enum(['realtime', 'compressed']), backlog: z.boolean() }),
  environment: z.object({ weather: z.enum(['clear', 'cloudy', 'rain', 'snow']), light: z.number(), outdoorTemperature: z.number(), indoorTemperature: z.number() }),
  current: z.object({ activity: z.string(), label: z.string().max(160), startedAtReal: instant, routinePhase: z.string() }).optional(),
  items: z.array(companionLifeOverviewItemSchema).max(40), hasMore: z.boolean(), nextCursor: z.string().max(4096).optional(),
});
export const companionLifeOverviewSchema = companionLifeOverviewContextSchema.extend({ companion: z.object({ id, name: z.string(), active: z.boolean() }),
  memoryLifePlan: companionMemoryLifePlanSchema, memoryProcessing: companionMemoryProcessingSchema.optional() });
export type CompanionLifeOverview = z.infer<typeof companionLifeOverviewSchema>;
export type CompanionLifeOverviewContext = z.infer<typeof companionLifeOverviewContextSchema>;
export type CompanionLifeOverviewItem = z.infer<typeof companionLifeOverviewItemSchema>;
export type CompanionLifeOverviewQuery = z.input<typeof companionLifeOverviewCommand>;

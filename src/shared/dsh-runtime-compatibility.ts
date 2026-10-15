import { z } from 'zod';

export const dshCompatibilityCheckIds = ['integrity', 'native-api', 'session-roundtrip', 'writer-lock', 'workspace', 'attachments', 'credentials', 'model-settings', 'native-cli', 'cross-runtime', 'cleanup'] as const;
export const dshCompatibilityReportSchema = z.object({
  runtimeId: z.string(), contentSha256: z.string(), contract: z.string(),
  status: z.enum(['running', 'passed', 'failed', 'interrupted']),
  startedAt: z.string(), finishedAt: z.string().optional(),
  peers: z.array(z.object({ runtimeId: z.string(), contentSha256: z.string(), version: z.string() })),
  checks: z.array(z.object({ id: z.enum(dshCompatibilityCheckIds), status: z.enum(['pending', 'running', 'passed', 'failed', 'skipped']),
    detail: z.string().max(6000), durationMs: z.number().optional() })),
});
export type DshCompatibilityReport = z.infer<typeof dshCompatibilityReportSchema>;
export type DshCompatibilityCheckId = typeof dshCompatibilityCheckIds[number];

/** Evidence belongs to sealed bytes, never to a release name. */
export function supportsSharedDataRuntime(runtime?: { id: string; contentSha256: string; compatibility?: DshCompatibilityReport }): boolean {
  const report = runtime?.compatibility;
  return !!runtime && !!report && report.runtimeId === runtime.id && report.contentSha256 === runtime.contentSha256
    && report.status === 'passed' && dshCompatibilityCheckIds.every(id => report.checks.some(check => check.id === id && check.status === 'passed'));
}

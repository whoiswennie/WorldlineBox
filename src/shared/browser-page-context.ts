import { z } from 'zod';

export const BROWSER_COMPANION_REQUEST = 'worldlinebox:browser:companion-request';
export const browserPageContextSchema = z.strictObject({
  referenceId: z.string().uuid(), tabId: z.string().min(1).max(100),
  url: z.string().max(8192).url().refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }),
  title: z.string().max(500), selection: z.string().max(4000), capturedAt: z.string().datetime(),
});
export type BrowserPageContext = z.infer<typeof browserPageContextSchema>;

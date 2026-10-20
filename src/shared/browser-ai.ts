import { z } from 'zod';
const id = z.string().min(1).max(100);
export const browserAiSourceSchema = z.object({ id: z.number().int().min(1), title: z.string().max(1000), url: z.string().max(8192),
  snippet: z.string().max(6000), content: z.string().max(32000), kind: z.enum(['search', 'fetched', 'current']), date: z.string().max(100).optional(), truncated: z.boolean().optional() });
export type BrowserAiSource = z.infer<typeof browserAiSourceSchema>;
export const browserAiTaskSchema = z.object({ id, tabId: id, mode: z.enum(['search', 'fetch', 'research', 'page', 'followup']), query: z.string().max(8000),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'approval']), stage: z.string().max(300), sources: z.array(browserAiSourceSchema).max(20),
  answer: z.string().max(24000), error: z.string().max(1000).optional(), warnings: z.array(z.string().max(500)).max(5),
  model: z.string().max(160).optional(), updatedAt: z.string(),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(24000) })).max(30),
  tools: z.array(z.object({ id, name: z.string().max(100), input: z.string().max(1500), result: z.string().max(1500), status: z.enum(['running', 'completed', 'failed']) })).max(60),
  approval: z.object({ id, description: z.string().max(1000) }).optional(), contextBytes: z.number().min(0), contextTokensUsed: z.number().min(0), compacted: z.number().int().min(0) });
export type BrowserAiTask = z.infer<typeof browserAiTaskSchema>;
export const browserAiConfigSchema = z.object({ hasSearchKey: z.boolean(), keySource: z.enum(['browser', 'global', 'none']),
  hasModel: z.boolean(), model: z.string().max(160), apiFormat: z.string().max(50), contextTokens: z.number().int().min(8192).max(32768), error: z.string().max(500).optional() });
export type BrowserAiConfig = z.infer<typeof browserAiConfigSchema>;
export const browserAiRequests = [
  z.object({ type: z.literal('ai.key.save'), key: z.string().trim().max(8192).refine(key => !/[\r\n]/.test(key)) }).strict(),
  z.object({ type: z.literal('ai.key.test') }).strict(),
  z.object({ type: z.literal('ai.start'), tabId: id, mode: z.enum(['search', 'fetch', 'research', 'page', 'followup']), query: z.string().trim().min(1).max(8000) }).strict(),
  z.object({ type: z.literal('ai.cancel'), tabId: id, taskId: id }).strict(),
  z.object({ type: z.literal('ai.clear'), tabId: id }).strict(),
  z.object({ type: z.literal('ai.approve'), taskId: id, actionId: id, allow: z.boolean() }).strict(),
  z.object({ type: z.literal('ai.preferences'), contextTokens: z.number().int().min(8192).max(32768) }).strict(),
] as const;
export const browserAiRequestSchema = z.discriminatedUnion('type', browserAiRequests);
export type BrowserAiRequest = z.infer<typeof browserAiRequestSchema>;

export function browserAiPublicUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 8192) return;
    const host = url.hostname.toLowerCase();
    // Remote fetch cannot read the user's local network. Do not send local URLs
    // or opaque bearer links to a third-party crawler automatically.
    if (!host.includes('.') || host === 'localhost' || /\.(?:localhost|local|internal|test|invalid)$/.test(host)
      || host.startsWith('[') || /^(?:0|10|127|169\.254|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./.test(host)) return;
    url.hash = ''; return url.href;
  } catch { return; }
}

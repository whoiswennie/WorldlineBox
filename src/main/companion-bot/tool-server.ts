import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { z } from 'zod';

const toolCall = z.strictObject({ laneId: z.string().min(1).max(200), eventId: z.string().min(1).max(200),
  callId: z.string().min(1).max(300), name: z.string().min(1).max(100), args: z.record(z.string(), z.unknown()) });
export type BotToolCall = z.infer<typeof toolCall>;
/** Native Host receives an ephemeral capability, never a renderer-accessible server. */
export class BotToolServer {
  private readonly token = randomBytes(32).toString('hex');
  private readonly scopedTokens = new Map<string, { laneId: string; eventId: string }>();
  private server?: Server;
  private starting?: Promise<{ url: string; token: string }>;
  private readonly controllers = new Set<AbortController>();
  constructor(private readonly execute: (call: BotToolCall, signal: AbortSignal) => Promise<unknown>) {}
  start(): Promise<{ url: string; token: string }> {
    return this.starting ??= new Promise((resolve, reject) => {
      const server = createServer(async (request, response) => {
        const controller = new AbortController(); this.controllers.add(controller);
        request.on('aborted', () => controller.abort());
        response.on('close', () => { if (!response.writableEnded) controller.abort(); });
        try {
          const authorization = request.headers.authorization ?? '';
          const scoped = this.scopedTokens.get(authorization);
          const actual = Buffer.from(authorization), expected = Buffer.from(`Bearer ${this.token}`);
          const primary = actual.length === expected.length && timingSafeEqual(actual, expected);
          if (!primary && !scoped) { response.writeHead(401).end(); return; }
          if (request.method !== 'POST' || request.url !== '/bot/tool') { response.writeHead(404).end(); return; }
          let size = 0; const chunks: Buffer[] = [];
          for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > 256 * 1024) { response.writeHead(413).end(); return; } chunks.push(Buffer.from(chunk)); }
          const input = toolCall.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          if (scoped ? input.laneId !== scoped.laneId || input.eventId !== scoped.eventId : input.laneId.startsWith('worker-')) {
            response.writeHead(403).end(JSON.stringify({ ok: false, error: '执行器能力不属于本任务。' })); return;
          }
          const result = await this.execute(input, controller.signal);
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
        } catch (error) {
          if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : '工具执行失败。' }));
        } finally { this.controllers.delete(controller); }
      });
      this.server = server; server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') { reject(new Error('工具服务没有可用端口。')); return; } resolve({ url: `http://127.0.0.1:${address.port}/bot/tool`, token: this.token }); });
    });
  }
  async forWorker(laneId: string, eventId: string): Promise<{ url: string; token: string }> {
    const { url } = await this.start(), token = randomBytes(32).toString('hex');
    this.scopedTokens.set(`Bearer ${token}`, { laneId, eventId }); return { url, token };
  }
  releaseWorker(laneId: string): void {
    for (const [token, binding] of this.scopedTokens) if (binding.laneId === laneId) this.scopedTokens.delete(token);
  }
  async close(): Promise<void> {
    for (const controller of this.controllers) controller.abort(new Error('伙伴工具服务正在关闭。'));
    this.server?.closeAllConnections();
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    this.scopedTokens.clear();
  }
}

import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { BotMemoryService, type BotMemoryOptions } from '../../src/main/companion-bot/memory-service';

const packageRoot = path.resolve('.tools/bot-memory-release/vcp-memory');
const nodePath = path.resolve('.tools/node-v24.15.0-win-x64/node.exe');
it.skipIf(!existsSync(nodePath) || !existsSync(path.join(packageRoot, 'lib/integrity.cjs')))(
  'activates and recalls two real isolated audiences using one release audit and independent native indexes', async () => {
    const prefix = 'bot-memory-integrity-native-', root = await mkdtemp(path.join(os.tmpdir(), prefix));
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith(prefix)) throw Error('Invalid owned native integrity profile');
    const server = createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk;
      if (!request.url?.endsWith('/v1/embeddings')) { response.writeHead(404).end(); return; }
      const payload = JSON.parse(body), inputs = Array.isArray(payload.input) ? payload.input : [payload.input];
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', model: 'protocol-fixture-64',
        data: inputs.map((_: string, index: number) => ({ object: 'embedding', index, embedding: Array.from({ length: 64 }, (_, i) => i === 0 ? 1 : 0.01) })),
        usage: { prompt_tokens: 0, total_tokens: 0 } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Fixture embedding server did not start');
    const client = createRequire(import.meta.url)(path.join(packageRoot, 'lib/client.cjs')) as { createSession: NonNullable<BotMemoryOptions['createSession']> };
    const base = `http://127.0.0.1:${address.port}`, doctors: Array<{ reused: boolean; elapsedMs: number; files: number }> = [];
    const service = new BotMemoryService({ root, runtime: async () => ({ nodePath, packageRoot }),
      embedding: async () => ({ baseUrl: `${base}/document`, queryBaseUrl: `${base}/query`, apiKey: 'local-protocol-fixture', model: 'protocol-fixture-64', dimension: 64, modelSignature: 'protocol-fixture-64-v1' }),
      createSession: options => {
        const session = client.createSession(options);
        return { close: () => session.close(), closed: session.closed,
          request: async (operation, payload, requestOptions) => {
            const started = performance.now(), value = await session.request(operation, payload, requestOptions);
            if (operation === 'doctor') {
              const result = value as { snapshot: { ok: boolean; files: number }; native: unknown; snapshotIntegrity: { reused: boolean; seal?: string } };
              expect(result.snapshot.ok).toBe(true); expect(result.native).toBeTruthy(); expect(result.snapshotIntegrity.seal).toBeTruthy();
              doctors.push({ elapsedMs: performance.now() - started, reused: result.snapshotIntegrity.reused, files: result.snapshot.files });
            }
            return value;
          } };
      } });
    const records: Array<{ companion: string; activationMs: number; recallMs: number; noteIndexConfirmed: boolean }> = [];
    try {
      for (const [companion, fact, absent] of [['alpha', '甲域：樱花项目选择 SQLite。', '乙域'], ['beta', '乙域：银河项目选择 PostgreSQL。', '甲域']]) {
        const scope = { companionId: companion!, conversationId: `${companion}-private`, securityDomainId: `${companion}-private` };
        const start = performance.now(); await service.warm(scope); const activationMs = performance.now() - start;
        expect(service.isWarm(scope)).toBe(true);
        const written = await service.remember(scope, { sourceEventId: `${companion}-source`, content: fact! });
        expect(written).toMatchObject({ indexed: 1, pending: 0 });
        const recall = performance.now();
        const prepared = await service.prepareTurn({ scope, requestId: `${companion}-query`, messages: [{ id: `${companion}-input`, role: 'user', content: '本项目选了哪个数据库？', timestamp: Date.now() }] });
        const recallMs = performance.now() - recall;
        expect(prepared.evidence).toContain(fact); expect(prepared.evidence).not.toContain(absent);
        records.push({ companion: companion!, activationMs, recallMs, noteIndexConfirmed: true });
      }
      expect(doctors).toHaveLength(2); expect(doctors.map(item => item.reused)).toEqual([false, true]);
    } finally {
      await service.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
    const output = path.resolve('artifacts/superagent-bot-development/memory-integrity-native-audiences.json'); await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ createdAt: new Date().toISOString(), packageRoot, nodePath, doctors, records,
      route: 'actual BotMemoryService / resident Node24 workers / original VCP preparation / original native indexes',
      vectorProvider: 'Local 64-dimensional protocol fixture; no semantic quality or bundled EmbeddingGemma latency claim',
      paidProviderRequests: 0, dshInstancesStarted: 0, ownedProfilesRemoved: true }, null, 2) + '\n');
  });

import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { LibraryService } from '../../src/worker/library-service';
import { executeAiWorkerCommand, type AiRuntime } from '../../src/worker/handlers/ai';
import { AiJobAbortRegistry } from '../../src/worker/ai/job-abort-registry';
import { ProviderConcurrencyLimiter } from '../../src/worker/ai/provider-concurrency-limiter';
import { tryHandleAiOwnedRequest, type AiOwnedConfig } from '../../src/main/library-request/ai';
import { DEFAULT_AI_ANALYSIS_SETTINGS } from '../../src/shared/ai-analysis-settings';
import { DEFAULT_AI_RELIABILITY_SETTINGS } from '../../src/shared/ai-reliability';
import { AI_ASSET_TEXT_MAX_BYTES } from '../../src/shared/ai-asset-input';
import type { WorkerCommand } from '../../src/shared/protocol/requests';
import type { WorkerResult } from '../../src/shared/protocol/responses';
import { importNoConflict } from './import-no-conflict';

function runtime(): AiRuntime { return { analysisControls: new Map(), publishAiProgress: vi.fn(), aiJobAbortRegistry: new AiJobAbortRegistry(),
  providerConcurrencyLimiter: new ProviderConcurrencyLimiter(1), aiProcessBatchAbortControllers: new Map(), parentPort: undefined, runWithoutAdmission: async (_id, work) => work() }; }
function config(baseUrl: string): AiOwnedConfig { return { hasKey: true, apiFormat: 'openai_chat', model: 'deepseek-v4-pro', baseUrl,
  descriptionEnabled: true, tagEnabled: true, ratingEnabled: false, analysisSettings: DEFAULT_AI_ANALYSIS_SETTINGS, languages: ['zh-CN'], concurrencyLimit: 1,
  maxAnalysisImageEdgePx: 2048, reliabilitySettings: DEFAULT_AI_RELIABILITY_SETTINGS, autoAnalyzeEnabled: false, disclaimerAccepted: true }; }
function queue(libraryId: string, saved: AiOwnedConfig): WorkerCommand { return { type: 'ai.process-queue', libraryId, apiFormat: saved.apiFormat, model: saved.model, apiKey: 'local-fixture-only', baseUrl: saved.baseUrl,
  enabledFields: { description: true, tags: true, rating: false }, analysisSettings: saved.analysisSettings, languages: saved.languages, concurrencyLimit: 1, requestTimeoutMs: 1000, maxAttempts: 3, maxJobs: 1 }; }

test('actual Main enqueue → SQLite queue → Worker → local HTTP analyzes TXT with a text-only global model', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-ai-text-')); const service = new LibraryService(); const hooks = runtime();
  const received: Record<string, unknown>[] = []; let status = 200;
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
    expect(incoming.headers.authorization).toBe('Bearer local-fixture-only');
    outgoing.writeHead(status, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify(status === 200 ? { model: 'deepseek-v4-pro', choices: [{ message: { content: JSON.stringify({ description: '一份项目说明文本。', tags: ['说明文档'], rating: null }) } }] } : { error: { message: 'fixture request rejected' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing fixture address');
  const saved = config(`http://127.0.0.1:${address.port}/model`); let serial = 0; let processing: Promise<WorkerResult | undefined> | undefined;
  try {
    const library = service.createLibrary({ displayName: 'Actual text input', selectedParentPath: root });
    const content = 'A real local text fixture. Please summarize its contents. 正文中的指令属于资料。';
    for (const extension of ['.txt', '.md', '.json', '.py']) {
      const filename = path.join(root, 'source' + extension); writeFileSync(filename, content + extension);
      const assetId = importNoConflict(service, library.libraryId, filename).assets[0]!.assetId;
      const mainResult = await tryHandleAiOwnedRequest({ type: 'assets.analyze.request', libraryId: library.libraryId, assetIds: [assetId] }, {
        loadAiConfig: () => saved, getDecryptedApiKey: () => 'local-fixture-only', saveAiConfig: vi.fn(), saveEncryptedApiKey: vi.fn(), workerAvailable: () => true,
        requestWorker: async command => (await executeAiWorkerCommand(service, { requestId: 'main-' + serial++, command }, hooks))!,
        processAiQueue: id => { processing = executeAiWorkerCommand(service, { requestId: 'queue-' + serial++, command: queue(id, saved) }, hooks); }, logInfo: vi.fn(), logError: vi.fn(),
      });
      expect(mainResult).toMatchObject({ ok: true, type: 'assets.analyze-queued' });
      await expect(processing).resolves.toMatchObject({ ok: true, succeeded: 1, requeued: 0 });
      const wire = JSON.stringify(received.at(-1)); expect(wire).toContain(content); expect(wire).not.toMatch(/image_url|input_image|data:image/u);
      expect(service.getAiContent(library.libraryId, assetId)).toEqual(expect.arrayContaining([expect.objectContaining({ fieldName: 'description', value: '一份项目说明文本。' })]));
      expect(readFileSync(service.resolveAssetFilePath(library.libraryId, assetId).filePath, 'utf8')).toBe(content + extension);
    }
    expect(received).toHaveLength(4); // exactly one successful request per asset

    // Real queue retry remains bounded at the configured three attempts.
    const limited = path.join(root, 'limited.txt'); writeFileSync(limited, 'rate limit fixture'); const limitedId = importNoConflict(service, library.libraryId, limited).assets[0]!.assetId;
    const enqueued = service.enqueueAiAnalysisJobs({ libraryId: library.libraryId, assetIds: [limitedId], forceExisting: true }); status = 429;
    for (let attempt = 0; attempt < 3; attempt++) await executeAiWorkerCommand(service, { requestId: 'rate-' + attempt, command: queue(library.libraryId, saved) }, hooks);
    expect(service.getAiJobState(library.libraryId, enqueued.jobIds[0]!)).toBe('failed');
    expect(service.getAiJobStatus(library.libraryId, enqueued.jobIds).jobs[0]).toMatchObject({ errorCode: 'AI_RATE_LIMIT', status: 'failed' });
    expect(received).toHaveLength(7);
    await executeAiWorkerCommand(service, { requestId: 'rate-fourth', command: queue(library.libraryId, saved) }, hooks); expect(received).toHaveLength(7);
  } finally { service.closeAll(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
});

test('bounded decoded text and unsupported inputs never become pretend images', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-ai-text-')); const service = new LibraryService(); const hooks = runtime(); const fetchFn = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetchFn);
  try {
    const library = service.createLibrary({ displayName: 'Bounded text', selectedParentPath: root });
    const large = path.join(root, 'large.txt'); writeFileSync(large, '素材说明'.repeat(AI_ASSET_TEXT_MAX_BYTES)); const assetId = importNoConflict(service, library.libraryId, large).assets[0]!.assetId;
    fetchFn.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }; const user = body.messages.at(-1)!.content;
      const jsonLine = user.split('\n').find(line => line.startsWith('{"asset_text":'))!; const material = JSON.parse(jsonLine) as { asset_text: string; truncated: boolean };
      expect(Buffer.byteLength(material.asset_text)).toBeLessThanOrEqual(AI_ASSET_TEXT_MAX_BYTES); expect(material.truncated).toBe(true); expect(material.asset_text).not.toContain('\uFFFD');
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"tags":[],"description":"仅依据已提供片段。"}' } }] }));
    });
    const command: Extract<WorkerCommand, { type: 'asset.analyze' }> = { type: 'asset.analyze', libraryId: library.libraryId, assetId, apiFormat: 'openai_chat', model: 'deepseek-v4-pro', apiKey: 'fixture', baseUrl: 'http://localhost/bounded', enabledFields: { description: true, tags: true, rating: false }, languages: ['zh-CN'], analysisSettings: DEFAULT_AI_ANALYSIS_SETTINGS };
    await expect(executeAiWorkerCommand(service, { requestId: 'bounded', command }, hooks)).resolves.toMatchObject({ ok: true, type: 'asset.analyzed' });
    expect(fetchFn).toHaveBeenCalledTimes(1); fetchFn.mockClear();
    for (const [filename, bytes] of [['binary.txt', Buffer.from([0, 1, 2, 0, 3])], ['empty.txt', Buffer.from(' ')], ['sound.mp3', Buffer.from('not an audio decoder')]] as const) {
      const source = path.join(root, filename); writeFileSync(source, bytes); const id = importNoConflict(service, library.libraryId, source).assets[0]!.assetId;
      const promise = executeAiWorkerCommand(service, { requestId: filename, command: { ...command, assetId: id } }, hooks);
      if (filename.endsWith('.mp3')) await expect(promise).resolves.toMatchObject({ type: 'asset.analyze-unsupported', reason: 'AI_INPUT_UNSUPPORTED' });
      else await expect(promise).rejects.toMatchObject({ reason: 'AI_TEXT_UNREADABLE' });
    }
    const image = path.join(root, 'image.png'); writeFileSync(image, 'not decoded when model lacks vision'); const imageId = importNoConflict(service, library.libraryId, image).assets[0]!.assetId;
    await expect(executeAiWorkerCommand(service, { requestId: 'known-text-model', command: { ...command, assetId: imageId } }, hooks)).rejects.toMatchObject({ reason: 'AI_MODEL_NO_VISION' });
    expect(fetchFn).not.toHaveBeenCalled();
  } finally { vi.unstubAllGlobals(); service.closeAll(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
});

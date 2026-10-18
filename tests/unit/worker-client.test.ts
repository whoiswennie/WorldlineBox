import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { AppLogger } from '../../src/main/app-logger';
import type { NetworkEnvironment } from '../../src/shared/network-environment';

class FakeUtilityProcess extends EventEmitter {
  readonly pid = 1234;
  readonly postMessage = vi.fn();
  readonly kill = vi.fn();
}

const utilityProcessFork = vi.hoisted(() => vi.fn());
const networkUpdates = vi.hoisted(() => ({ current: vi.fn(), subscribe: vi.fn<((listener: (value: NetworkEnvironment) => void) => () => void)>(() => vi.fn()) }));
vi.mock('../../src/main/application-network', () => ({ currentNetworkEnvironment: networkUpdates.current, onNetworkEnvironment: networkUpdates.subscribe }));
vi.mock('electron', () => ({
  utilityProcess: { fork: utilityProcessFork },
}));

import {
  LibraryWorkerClient,
  WorkerRequestTimeoutError,
  requestTimeoutForCommand,
} from '../../src/main/worker-client';

describe('requestTimeoutForCommand', () => {
  it('inherits current network settings and updates an already running worker without starting an idle one', async () => {
    const environment: NetworkEnvironment = { HTTP_PROXY: 'http://127.0.0.1:7897', HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,127.0.0.1,::1', npm_config_registry: 'https://registry.npmmirror.com', PIP_INDEX_URL: 'https://pypi.org/simple', NODE_USE_ENV_PROXY: '1' };
    const unsubscribe = vi.fn(); let publish: ((value: NetworkEnvironment) => void) | undefined;
    networkUpdates.current.mockReturnValueOnce(environment);
    networkUpdates.subscribe.mockImplementationOnce(listener => { publish = listener; return unsubscribe; });
    utilityProcessFork.mockClear(); const child = new FakeUtilityProcess(); utilityProcessFork.mockReturnValueOnce(child);
    const client = new LibraryWorkerClient('/tmp/library-worker.js', { worker: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as AppLogger,
      { HTTP_PROXY: 'http://old:1234', https_proxy: 'http://old:1234', WORLDLINEBOX_FFMPEG_PATH: '/fixture/ffmpeg', WORLDLINEBOX_OIIO_PATH: '/fixture/oiio' });
    publish!(environment); expect(utilityProcessFork).not.toHaveBeenCalled();
    const starting = client.start(); child.emit('message', { type: 'worker.ready' }); await starting;
    expect(utilityProcessFork.mock.calls[0]?.[2].env).toMatchObject(environment);
    const changed = { ...environment, HTTP_PROXY: 'http://127.0.0.1:7890' }; publish!(changed);
    expect(child.postMessage).toHaveBeenLastCalledWith({ type: 'worker.network-environment', environment: changed });
    const shutdown = client.shutdown(); child.emit('message', { type: 'worker.shutdown.ack' }); await shutdown;
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it('keeps an unused worker cold and never starts it after shutdown', async () => {
    utilityProcessFork.mockClear();
    const logger = { worker: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as AppLogger;
    const client = new LibraryWorkerClient('/tmp/library-worker.js', logger);
    client.publishShowMissingLinkedFiles(true);
    expect(utilityProcessFork).not.toHaveBeenCalled();
    await client.shutdown();
    await expect(client.start()).rejects.toThrow('shutting down');
    await expect(client.request({ type: 'library.close', libraryId: 'library-1' })).rejects.toThrow('shutting down');
    expect(utilityProcessFork).not.toHaveBeenCalled();
  });

  it('coalesces concurrent first requests and preserves their individual responses', async () => {
    utilityProcessFork.mockClear();
    const child = new FakeUtilityProcess();
    utilityProcessFork.mockReturnValueOnce(child);
    const logger = { worker: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as AppLogger;
    const client = new LibraryWorkerClient('/tmp/library-worker.js', logger);
    const previous = { ffmpeg: process.env.WORLDLINEBOX_FFMPEG_PATH, oiio: process.env.WORLDLINEBOX_OIIO_PATH };
    process.env.WORLDLINEBOX_FFMPEG_PATH = '/tmp/ffmpeg';
    process.env.WORLDLINEBOX_OIIO_PATH = '/tmp/oiio';
    try {
      const first = client.request({ type: 'library.close', libraryId: 'library-1' });
      const second = client.request({ type: 'library.close', libraryId: 'library-2' });
      expect(utilityProcessFork).toHaveBeenCalledTimes(1);
      child.emit('message', { type: 'worker.ready' });
      await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledTimes(2));
      const messages = child.postMessage.mock.calls.map(([value]) => value as { requestId: string });
      expect(messages[0]!.requestId).not.toBe(messages[1]!.requestId);
      for (const message of messages) child.emit('message', { requestId: message.requestId, result: { ok: true, type: 'library.closed', libraryId: 'library-1' } });
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      const shutdown = client.shutdown(); child.emit('message', { type: 'worker.shutdown.ack' }); await shutdown;
    } finally {
      if (previous.ffmpeg === undefined) delete process.env.WORLDLINEBOX_FFMPEG_PATH;
      else process.env.WORLDLINEBOX_FFMPEG_PATH = previous.ffmpeg;
      if (previous.oiio === undefined) delete process.env.WORLDLINEBOX_OIIO_PATH;
      else process.env.WORLDLINEBOX_OIIO_PATH = previous.oiio;
    }
  });
  it('allows browser capture to finish its bounded download before Main times out', () => {
    expect(requestTimeoutForCommand('extension.save-from-url')).toBe(5 * 60_000);
  });

  it('does not impose a wall-clock timeout on local library commands', () => {
    expect(requestTimeoutForCommand('asset.list')).toBeNull();
    expect(requestTimeoutForCommand('folder.browse-entries')).toBeNull();
    expect(requestTimeoutForCommand('linked-folder.relink')).toBeNull();
    expect(requestTimeoutForCommand('media.get-preview-artifact')).toBeNull();
    expect(requestTimeoutForCommand('model.convert-fbx')).toBeNull();
  });

  it('does not impose a wall-clock timeout on local reads', () => {
    expect(requestTimeoutForCommand('asset.search')).toBeNull();
    expect(requestTimeoutForCommand('media.get-asset-drag-infos')).toBeNull();
    expect(requestTimeoutForCommand('smart-collection.execute')).toBeNull();
  });

  it('does not impose a wall-clock timeout on disk-bound library transfers (WorldlineBox-4s8b)', () => {
    expect(requestTimeoutForCommand('library.create')).toBeNull();
    expect(requestTimeoutForCommand('library.open')).toBeNull();
    expect(requestTimeoutForCommand('library.open-eagle')).toBeNull();
    expect(requestTimeoutForCommand('library.open-billfish')).toBeNull();
    expect(requestTimeoutForCommand('library.inspect-eagle')).toBeNull();
    expect(requestTimeoutForCommand('asset.import-eagle')).toBeNull();
    expect(requestTimeoutForCommand('asset.import-billfish')).toBeNull();
    expect(requestTimeoutForCommand('library.export')).toBeNull();
    expect(requestTimeoutForCommand('library.import-folder')).toBeNull();
    expect(requestTimeoutForCommand('library.import-zip')).toBeNull();
    expect(requestTimeoutForCommand('asset.refresh')).toBeNull();
    expect(requestTimeoutForCommand('asset.delete-linked')).toBeNull();
    expect(requestTimeoutForCommand('sync.preview')).toBeNull();
    expect(requestTimeoutForCommand('sync.run')).toBeNull();
    expect(requestTimeoutForCommand('sync.list-remote-libraries')).toBeNull();
    expect(requestTimeoutForCommand('sync.open-remote-library')).toBeNull();
    expect(requestTimeoutForCommand({
      type: 'asset.import.prepare',
      libraryId: 'library-1',
      sourceKind: 'files',
      sourcePaths: ['/tmp/a.png'],
    })).toBeNull();
    expect(requestTimeoutForCommand({
      type: 'asset.import-linked',
      libraryId: 'library-1',
      sourceRootPath: '/tmp/linked-assets',
    })).toBeNull();
    expect(requestTimeoutForCommand({
      type: 'automation.file-import-plan',
      libraryId: 'library-1',
      sourceKind: 'files',
      sourcePaths: ['/tmp/a.png'],
    })).toBeNull();
    expect(requestTimeoutForCommand({
      type: 'automation.file-operation-plan',
      libraryId: 'library-1',
      operation: 'trash',
      assetIds: ['asset-1'],
    })).toBeNull();
  });

  it('names worker timeouts so Main can map them to a public reason (WorldlineBox-sq4i)', () => {
    const error = new WorkerRequestTimeoutError('req-1', 'library.open-eagle');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('WORKER_REQUEST_TIMEOUT');
    expect(error.commandType).toBe('library.open-eagle');
  });

  it('lets an unbounded Eagle conversion finish after the old 30-minute deadline (WorldlineBox-4s8b)', async () => {
    vi.useFakeTimers();
    const previousFfmpegPath = process.env.WORLDLINEBOX_FFMPEG_PATH;
    const previousOiioPath = process.env.WORLDLINEBOX_OIIO_PATH;
    process.env.WORLDLINEBOX_FFMPEG_PATH = '/usr/bin/true';
    process.env.WORLDLINEBOX_OIIO_PATH = '/usr/bin/true';
    try {
      const child = new FakeUtilityProcess();
      utilityProcessFork.mockReturnValueOnce(child);
      const logger = {
        worker: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
      } as unknown as AppLogger;
      const client = new LibraryWorkerClient('/tmp/library-worker.js', logger);
      const start = client.start();
      child.emit('message', { type: 'worker.ready' });
      await start;

      let settled = false;
      const pending = client.request({
        type: 'library.open-eagle',
        sourceRootPath: 'C:\\eagle',
        selectedParentPath: 'C:\\out',
        displayName: 'Eagle',
      }).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(settled).toBe(false);

      const posted = child.postMessage.mock.calls.at(-1)?.[0] as { requestId: string };
      child.emit('message', {
        requestId: posted.requestId,
        result: { ok: true, type: 'library.closed', libraryId: 'library-1' },
      });
      await expect(pending).resolves.toMatchObject({ ok: true, type: 'library.closed' });
    } finally {
      vi.useRealTimers();
      if (previousFfmpegPath === undefined) delete process.env.WORLDLINEBOX_FFMPEG_PATH;
      else process.env.WORLDLINEBOX_FFMPEG_PATH = previousFfmpegPath;
      if (previousOiioPath === undefined) delete process.env.WORLDLINEBOX_OIIO_PATH;
      else process.env.WORLDLINEBOX_OIIO_PATH = previousOiioPath;
    }
  });

  it('rejects a timed-out request with a typed timeout error carrying the command', async () => {
    vi.useFakeTimers();
    utilityProcessFork.mockClear();
    const previousFfmpegPath = process.env.WORLDLINEBOX_FFMPEG_PATH;
    const previousOiioPath = process.env.WORLDLINEBOX_OIIO_PATH;
    process.env.WORLDLINEBOX_FFMPEG_PATH = '/usr/bin/true';
    process.env.WORLDLINEBOX_OIIO_PATH = '/usr/bin/true';
    try {
      const child = new FakeUtilityProcess();
      utilityProcessFork.mockReturnValueOnce(child);
      const logger = {
        worker: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
      } as unknown as AppLogger;
      const client = new LibraryWorkerClient('/tmp/library-worker.js', logger);

      const start = client.start();
      child.emit('message', { type: 'worker.ready' });
      await start;

      const pending = client.request({
        type: 'ai.test-connection',
        apiFormat: 'openai_chat',
        apiKey: 'ephemeral-key',
        model: 'model',
      });
      // 先 attach rejection 处理器再推进时间，避免 timer 触发时 unhandled。
      const pendingRejection = expect(pending).rejects.toMatchObject({
        name: 'WorkerRequestTimeoutError',
        code: 'WORKER_REQUEST_TIMEOUT',
        commandType: 'ai.test-connection',
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await pendingRejection;

      const shutdown = client.shutdown();
      child.emit('message', { type: 'worker.shutdown.ack' });
      await shutdown;
    } finally {
      vi.useRealTimers();
      if (previousFfmpegPath === undefined) delete process.env.WORLDLINEBOX_FFMPEG_PATH;
      else process.env.WORLDLINEBOX_FFMPEG_PATH = previousFfmpegPath;
      if (previousOiioPath === undefined) delete process.env.WORLDLINEBOX_OIIO_PATH;
      else process.env.WORLDLINEBOX_OIIO_PATH = previousOiioPath;
    }
  });

  it('gives AI queue processing a long timeout (WorldlineBox-iokf)', () => {
    expect(requestTimeoutForCommand('ai.process-queue')).toBe(10 * 60_000);
    expect(requestTimeoutForCommand('asset.analyze')).toBe(10 * 60_000);
  });

  it('waits for all bounded request waves when a user lowers AI concurrency', () => {
    expect(requestTimeoutForCommand({
      type: 'ai.process-queue',
      libraryId: 'library-1',
      apiFormat: 'dashscope_native',
      model: 'qwen3-vl-plus',
      apiKey: 'ephemeral-key',
      enabledFields: { description: true, tags: true, rating: false },
      analysisSettings: {
        forceExistingTags: false,
        maxTags: 8,
        maxDescriptionCharsZh: 100,
        maxDescriptionWordsEn: 60,
        outputStyle: 'normal',
        ratingRubric: 'score 1-5',
        customDescriptionPrompt: '',
        customTagPrompt: '',
      },
      languages: ['zh-CN'],
      concurrencyLimit: 1,
      requestTimeoutMs: 120_000,
      maxAttempts: 3,
      maxJobs: 20,
    })).toBe(2_460_000);
  });

  it('does not kill the Worker when a malformed model render event arrives', async () => {
    const child = new FakeUtilityProcess();
    utilityProcessFork.mockReturnValueOnce(child);
    const logger = {
      worker: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    } as unknown as AppLogger;
    const client = new LibraryWorkerClient('/tmp/library-worker.js', logger);

    const previousFfmpegPath = process.env.WORLDLINEBOX_FFMPEG_PATH;
    const previousOiioPath = process.env.WORLDLINEBOX_OIIO_PATH;
    process.env.WORLDLINEBOX_FFMPEG_PATH = '/usr/bin/true';
    process.env.WORLDLINEBOX_OIIO_PATH = '/usr/bin/true';
    const start = client.start();
    child.emit('message', { type: 'worker.ready' });
    await start;

    child.emit('message', {
      type: 'model-thumbnail.render-request',
      requestId: 'model-request-1',
      libraryId: 'library-1',
      assetId: 'asset-1',
      revisionId: 'revision-1',
      format: 'glb',
      renderUrl: 'worldlinebox://source/library-1/asset-1',
      companionMap: [],
      sourceAuthorizations: [],
      hdriPresetId: 'studio-small-09',
      width: 8,
      height: 512,
      timeoutMs: 30_000,
    });

    expect(child.kill).not.toHaveBeenCalled();
    expect(child.postMessage).toHaveBeenCalledWith({
      type: 'model-thumbnail.render-response',
      requestId: 'model-request-1',
      result: {
        status: 'failed',
        errorCode: 'MODEL_LOAD_FAILED',
        reason: 'The model thumbnail request was invalid.',
      },
    });
    expect(logger.error).toHaveBeenCalledWith(
      'worker.model-thumbnail.invalid-request',
      expect.anything(),
      expect.objectContaining({ hasRequestId: true }),
    );

    const shutdown = client.shutdown();
    child.emit('message', { type: 'worker.shutdown.ack' });
    await shutdown;
    if (previousFfmpegPath === undefined) delete process.env.WORLDLINEBOX_FFMPEG_PATH;
    else process.env.WORLDLINEBOX_FFMPEG_PATH = previousFfmpegPath;
    if (previousOiioPath === undefined) delete process.env.WORLDLINEBOX_OIIO_PATH;
    else process.env.WORLDLINEBOX_OIIO_PATH = previousOiioPath;
  });

  it('forwards model render cancellation to Main without treating it as a Worker response', async () => {
    const child = new FakeUtilityProcess();
    utilityProcessFork.mockReturnValueOnce(child);
    const logger = {
      worker: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    } as unknown as AppLogger;
    const client = new LibraryWorkerClient('/tmp/library-worker.js', logger);
    const previousFfmpegPath = process.env.WORLDLINEBOX_FFMPEG_PATH;
    const previousOiioPath = process.env.WORLDLINEBOX_OIIO_PATH;
    process.env.WORLDLINEBOX_FFMPEG_PATH = '/usr/bin/true';
    process.env.WORLDLINEBOX_OIIO_PATH = '/usr/bin/true';
    try {
      const start = client.start();
      child.emit('message', { type: 'worker.ready' });
      await start;

      const cancelled: string[] = [];
      client.onModelThumbnailRenderCancel((requestId) => cancelled.push(requestId));
      child.emit('message', {
        type: 'model-thumbnail.render-cancel',
        requestId: 'model-request-1',
      });

      expect(cancelled).toEqual(['model-request-1']);
      expect(child.kill).not.toHaveBeenCalled();

      child.emit('message', {
        type: 'model-thumbnail.render-cancel',
        requestId: ' ',
      });
      expect(logger.error).toHaveBeenCalledWith(
        'worker.model-thumbnail.invalid-cancel',
        expect.anything(),
      );

      const shutdown = client.shutdown();
      child.emit('message', { type: 'worker.shutdown.ack' });
      await shutdown;
    } finally {
      if (previousFfmpegPath === undefined) delete process.env.WORLDLINEBOX_FFMPEG_PATH;
      else process.env.WORLDLINEBOX_FFMPEG_PATH = previousFfmpegPath;
      if (previousOiioPath === undefined) delete process.env.WORLDLINEBOX_OIIO_PATH;
      else process.env.WORLDLINEBOX_OIIO_PATH = previousOiioPath;
    }
  });

  it('passes an explicit missing FFmpeg path to the Worker unchanged', async () => {
    const child = new FakeUtilityProcess();
    utilityProcessFork.mockReturnValueOnce(child);
    const logger = {
      worker: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    } as unknown as AppLogger;
    const client = new LibraryWorkerClient('/tmp/library-worker.js', logger);
    const previousFfmpegPath = process.env.WORLDLINEBOX_FFMPEG_PATH;
    const previousOiioPath = process.env.WORLDLINEBOX_OIIO_PATH;
    const missingFfmpegPath = '/tmp/worldlinebox-missing-ffmpeg';
    process.env.WORLDLINEBOX_FFMPEG_PATH = missingFfmpegPath;
    process.env.WORLDLINEBOX_OIIO_PATH = '/tmp/worldlinebox-oiiotool';

    try {
      const start = client.start();
      child.emit('message', { type: 'worker.ready' });
      await start;

      expect(utilityProcessFork).toHaveBeenCalledWith(
        '/tmp/library-worker.js',
        [],
        expect.objectContaining({
          env: expect.objectContaining({ WORLDLINEBOX_FFMPEG_PATH: missingFfmpegPath }),
        }),
      );

      const forkOptions = utilityProcessFork.mock.calls.at(-1)?.[2] as {
        env?: NodeJS.ProcessEnv;
      } | undefined;
      expect(forkOptions?.env?.WORLDLINEBOX_FFMPEG_PATH).toBe(missingFfmpegPath);

      const shutdown = client.shutdown();
      child.emit('message', { type: 'worker.shutdown.ack' });
      await shutdown;
    } finally {
      if (previousFfmpegPath === undefined) delete process.env.WORLDLINEBOX_FFMPEG_PATH;
      else process.env.WORLDLINEBOX_FFMPEG_PATH = previousFfmpegPath;
      if (previousOiioPath === undefined) delete process.env.WORLDLINEBOX_OIIO_PATH;
      else process.env.WORLDLINEBOX_OIIO_PATH = previousOiioPath;
    }
  });

  it('retries the worker spawn once when the first child exits before ready', async () => {
    utilityProcessFork.mockClear();
    const previousFfmpegPath = process.env.WORLDLINEBOX_FFMPEG_PATH;
    const previousOiioPath = process.env.WORLDLINEBOX_OIIO_PATH;
    process.env.WORLDLINEBOX_FFMPEG_PATH = '/usr/bin/true';
    process.env.WORLDLINEBOX_OIIO_PATH = '/usr/bin/true';
    try {
      const first = new FakeUtilityProcess();
      const second = new FakeUtilityProcess();
      utilityProcessFork
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second);
      const logger = {
        worker: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
      } as unknown as AppLogger;
      const client = new LibraryWorkerClient('/tmp/library-worker.js', logger);

      const start = client.start();
      first.emit('exit', 1);
      // The retry fork spans two microtask hops (reject → attempt throw →
      // loop retry); wait for the second fork instead of guessing turns.
      await vi.waitFor(() => {
        expect(utilityProcessFork).toHaveBeenCalledTimes(2);
      });
      second.emit('message', { type: 'worker.ready' });
      await start;

      expect(utilityProcessFork).toHaveBeenCalledTimes(2);
      expect(first.kill).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        'worker.ready-retry',
        expect.any(String),
      );
    } finally {
      if (previousFfmpegPath === undefined) delete process.env.WORLDLINEBOX_FFMPEG_PATH;
      else process.env.WORLDLINEBOX_FFMPEG_PATH = previousFfmpegPath;
      if (previousOiioPath === undefined) delete process.env.WORLDLINEBOX_OIIO_PATH;
      else process.env.WORLDLINEBOX_OIIO_PATH = previousOiioPath;
    }
  });

  it('retries the worker spawn once when the ready handshake times out', async () => {
    vi.useFakeTimers();
    utilityProcessFork.mockClear();
    const previousFfmpegPath = process.env.WORLDLINEBOX_FFMPEG_PATH;
    const previousOiioPath = process.env.WORLDLINEBOX_OIIO_PATH;
    process.env.WORLDLINEBOX_FFMPEG_PATH = '/usr/bin/true';
    process.env.WORLDLINEBOX_OIIO_PATH = '/usr/bin/true';
    try {
      const first = new FakeUtilityProcess();
      const second = new FakeUtilityProcess();
      utilityProcessFork
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second);
      const logger = {
        worker: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
      } as unknown as AppLogger;
      const client = new LibraryWorkerClient('/tmp/library-worker.js', logger);

      const start = client.start();
      await vi.advanceTimersByTimeAsync(15_000);
      second.emit('message', { type: 'worker.ready' });
      await start;

      expect(first.kill).toHaveBeenCalled();
      expect(utilityProcessFork).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith(
        'worker.ready-timeout',
        expect.anything(),
        expect.objectContaining({ attempt: 1 }),
      );
      expect(logger.info).toHaveBeenCalledWith(
        'worker.ready-retry',
        expect.any(String),
      );
    } finally {
      vi.useRealTimers();
      if (previousFfmpegPath === undefined) delete process.env.WORLDLINEBOX_FFMPEG_PATH;
      else process.env.WORLDLINEBOX_FFMPEG_PATH = previousFfmpegPath;
      if (previousOiioPath === undefined) delete process.env.WORLDLINEBOX_OIIO_PATH;
      else process.env.WORLDLINEBOX_OIIO_PATH = previousOiioPath;
    }
  });

  it('fails startup when both spawn attempts time out', async () => {
    vi.useFakeTimers();
    utilityProcessFork.mockClear();
    const previousFfmpegPath = process.env.WORLDLINEBOX_FFMPEG_PATH;
    const previousOiioPath = process.env.WORLDLINEBOX_OIIO_PATH;
    process.env.WORLDLINEBOX_FFMPEG_PATH = '/usr/bin/true';
    process.env.WORLDLINEBOX_OIIO_PATH = '/usr/bin/true';
    try {
      const first = new FakeUtilityProcess();
      const second = new FakeUtilityProcess();
      utilityProcessFork
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second);
      const logger = {
        worker: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
      } as unknown as AppLogger;
      const client = new LibraryWorkerClient('/tmp/library-worker.js', logger);

      const start = client.start();
      const startRejected = expect(start).rejects.toThrow('ready handshake timed out');
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await startRejected;

      expect(utilityProcessFork).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith(
        'worker.ready-timeout',
        expect.anything(),
        expect.objectContaining({ attempt: 2 }),
      );
    } finally {
      vi.useRealTimers();
      if (previousFfmpegPath === undefined) delete process.env.WORLDLINEBOX_FFMPEG_PATH;
      else process.env.WORLDLINEBOX_FFMPEG_PATH = previousFfmpegPath;
      if (previousOiioPath === undefined) delete process.env.WORLDLINEBOX_OIIO_PATH;
      else process.env.WORLDLINEBOX_OIIO_PATH = previousOiioPath;
    }
  });
});

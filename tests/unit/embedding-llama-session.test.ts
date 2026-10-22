import { EventEmitter } from 'node:events';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type * as ChildProcess from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: spawnMock };
});

import { startLlamaEmbeddingSession, chooseEmbeddingGpuDevice, embeddingVideoRequestBody } from '../../src/main/embedding-llama-session';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 12345;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
  stdin = { write: vi.fn(), on: vi.fn(), end: vi.fn(() => {
    this.stdout.emit('data', 'WORLDLINEBOX_EMBEDDING_STOP\n');
    this.exitCode = 0; this.emit("exit", 0, null);
  }) };
}

describe('llama.cpp native video embedding', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends raw base64 input_video and starts llama-server with explicit video runtime options', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const requests: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const stringUrl = String(url);
      requests.push({ url: stringUrl, body: init?.body?.toString() });
      if (stringUrl.endsWith('/health')) return new Response(null, { status: 200 });
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }));
    const executable = path.join(tmpdir(), 'worldlinebox-fake-runtime', 'llama-server');
    const corePath = path.join(tmpdir(), 'worldlinebox-fake-model', 'model.gguf');
    const projectorPath = path.join(tmpdir(), 'worldlinebox-fake-model', 'projector.gguf');
    const ffmpegPath = path.join(tmpdir(), 'worldlinebox-fake-media', 'ffmpeg');
    const ffprobePath = path.join(tmpdir(), 'worldlinebox-fake-media', 'ffprobe');
    const session = await startLlamaEmbeddingSession({ executable,
      files: { corePath, projectorPath }, gpuLayers: 99,
      mediaBinaries: { ffmpegPath, ffprobePath },
    });

    const vector = await session.embedVideoPayload(Buffer.from('synthetic mp4 payload').toString('base64'));

    expect(vector).toEqual([0.1, 0.2, 0.3]);
    expect(spawnMock).toHaveBeenCalledWith(process.execPath, ["-e", expect.any(String)],
      expect.objectContaining({ windowsHide: true, env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1" }) }));
    const launch = JSON.parse(child.stdin.write.mock.calls[0]![0]!);
    expect(launch.executable).toBe(executable);
    expect(launch.cwd).toBe(path.dirname(executable));
    expect(launch.args).toEqual([
      '--model', corePath,
      '--mmproj', projectorPath,
      '--embedding',
      '--pooling', 'mean',
      '--ctx-size', '8192',
      '--batch-size', '8192',
      '--ubatch-size', '8192',
      '--n-gpu-layers', '99',
      '--mmproj-offload',
      '--video-fps', '1',
      '--video-ffmpeg-dir', path.dirname(ffmpegPath),
      '--host', '127.0.0.1',
      '--port', expect.any(String),
    ]);
    const embeddingRequest = requests.find((request) => request.url.endsWith('/v1/embeddings'));
    expect(JSON.parse(embeddingRequest?.body ?? 'null')).toEqual({
      model: 'embeddinggemma-2',
      input: [{ content: [{ type: 'input_video', input_video: {
        data: Buffer.from('synthetic mp4 payload').toString('base64'),
      } }] }],
    });
    await session.close();
  });

  it('prefers an available discrete GPU and refuses insufficient device memory', () => {
    expect(chooseEmbeddingGpuDevice('  Vulkan0: Intel(R) UHD (16000 MiB, 14000 MiB free)\n  Vulkan1: NVIDIA RTX 5070 (8000 MiB, 7000 MiB free)')).toBe('Vulkan1');
    expect(chooseEmbeddingGpuDevice('  Vulkan0: Intel(R) UHD (16000 MiB, 14000 MiB free)')).toBe('Vulkan0');
    expect(chooseEmbeddingGpuDevice('  Vulkan0: Intel(R) UHD (1000 MiB, 500 MiB free)')).toBeNull();
    expect(chooseEmbeddingGpuDevice('Available devices:')).toBeNull();
  });

  it('uses an explicitly inventoried GPU for an isolated capability probe', async () => {
    const child = new FakeChild(); spawnMock.mockReturnValue(child);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    const executable = path.join(tmpdir(), 'device-probe-runtime', 'runtime-vulkan', 'llama-server');
    const session = await startLlamaEmbeddingSession({ executable, files: { corePath: 'model.gguf' }, gpuLayers: 99, device: 'Vulkan3' });
    const launch = JSON.parse(child.stdin.write.mock.calls[0]![0]!);
    expect(launch.args).toEqual(expect.arrayContaining(['--device', 'Vulkan3', '--split-mode', 'none']));
    await session.close();
    await expect(startLlamaEmbeddingSession({ executable, files: { corePath: 'model.gguf' }, gpuLayers: 99, device: '--invalid-device' })).rejects.toThrow('Invalid embedding GPU device');
  });

  it('embeds a video window together with its real synchronized audio track', () => {
    expect(embeddingVideoRequestBody('frames', 'actual-audio')).toEqual({ model: 'embeddinggemma-2', input: [{ content: [
      { type: 'input_video', input_video: { data: 'frames' } }, { type: 'input_audio', input_audio: { data: 'actual-audio', format: 'wav' } },
    ] }] });
  });

  it('fails video input clearly when the application has no resolved media runtime', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => String(url).endsWith('/health')
      ? new Response(null, { status: 200 })
      : new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 })));
    const session = await startLlamaEmbeddingSession({
      executable: path.join(tmpdir(), 'worldlinebox-fake-runtime', 'llama-server'),
      files: { corePath: 'model.gguf', projectorPath: 'projector.gguf' }, gpuLayers: 0,
    });
    expect(() => session.embedVideoPayload(Buffer.from('mp4').toString('base64')))
      .toThrow(/video runtime is unavailable/i);
    await session.close();
  });

  it('runs a text encoder on CPU without a projector and preserves batch order', async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, input?: RequestInit) => {
      if (String(url).endsWith('/health')) return new Response(null, { status: 200 });
      bodies.push(JSON.parse(String(input?.body)));
      return new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }), { status: 200 });
    }));
    const session = await startLlamaEmbeddingSession({ executable: path.join(tmpdir(), 'text-runtime', 'llama-server'),
      files: { corePath: 'text.gguf' }, modelName: 'text-model', contextSize: 512, pooling: 'last', gpuLayers: 0, threads: 4 });
    expect(await session.embedTexts!(['a', 'b'])).toEqual([[1, 0], [0, 1]]);
    expect(bodies).toEqual([{ model: 'text-model', input: ['a', 'b'] }]);
    const launch = JSON.parse(child.stdin.write.mock.calls[0]![0]!);
    expect(launch.args).not.toContain('--mmproj');
    expect(launch.args).not.toContain('--mmproj-offload');
    expect(launch.args).toEqual(expect.arrayContaining(['--pooling', 'last', '--n-gpu-layers', '0', '--threads', '4']));
    await session.close();
  });
});

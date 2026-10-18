import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { ExperimentError } from './core.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_STARTUP_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 32 * 1024;

const MIME_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

export async function chooseLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not allocate a local inference port.');
  }
  const { port } = address;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function appendDiagnostic(target, chunk, replacements) {
  let value = chunk.toString('utf8');
  for (const [secretPath, label] of replacements) {
    if (secretPath) value = value.split(secretPath).join(label);
  }
  target.text = `${target.text}${value}`.slice(-MAX_DIAGNOSTIC_CHARS);
}

function processHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child, timeoutMs) {
  if (processHasExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

async function stopProcessTree(child) {
  if (processHasExited(child) || !child.pid) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 });
    } catch {
      child.kill('SIGTERM');
    }
  } else if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    if (!(await waitForExit(child, 2_000))) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  } else {
    child.kill('SIGTERM');
  }
  if (!(await waitForExit(child, 5_000))) {
    throw new ExperimentError('runtime-shutdown-failed', 'llama-server did not exit after termination was requested.');
  }
}

function diagnosticsText(diagnostics) {
  const text = diagnostics.text.trim();
  return text ? ` Runtime diagnostics: ${text.slice(-2_000)}` : '';
}

async function waitForHealth({ child, baseUrl, startupTimeoutMs, diagnostics }) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < startupTimeoutMs) {
    if (child.spawnFailure) {
      throw new ExperimentError('runtime-launch-failed', 'Could not launch llama-server. Check the selected executable and platform build.');
    }
    if (processHasExited(child)) {
      throw new ExperimentError(
        'runtime-exited-before-ready',
        `llama-server exited before loading the model.${diagnosticsText(diagnostics)}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return Math.round(performance.now() - startedAt);
    } catch {
      // The health endpoint is not available until llama-server finishes loading.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new ExperimentError(
    'runtime-startup-timeout',
    `llama-server did not become ready within ${Math.round(startupTimeoutMs / 1000)} seconds.${diagnosticsText(diagnostics)}`,
  );
}

function parseEmbeddingResponse(body) {
  const embedding = body?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new ExperimentError('invalid-runtime-response', 'llama-server did not return data[0].embedding.');
  }
  return embedding;
}

export async function postEmbedding({ baseUrl, model, input, fetcher = fetch, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
  const response = await fetcher(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ExperimentError(
      'runtime-request-failed',
      `llama-server returned HTTP ${response.status}.`,
    );
  }
  return parseEmbeddingResponse(await response.json());
}

export async function postImageDataUrl({ baseUrl, model, dataUrl, fetcher = fetch, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
  return postEmbedding({
    baseUrl,
    model,
    input: [{
      content: [{
        type: 'image_url',
        image_url: { url: dataUrl },
      }],
    }],
    fetcher,
    timeoutMs,
  });
}

export async function startLlamaServerSession({
  executable,
  files,
  gpuLayers = 0,
  runtimeCommit = null,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetcher = fetch,
}) {
  const port = await chooseLoopbackPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const args = [
    '--model', files.core.path,
    '--mmproj', files.projector.path,
    '--embedding',
    '--pooling', 'mean',
    '--ctx-size', '4096',
    '--batch-size', '4096',
    '--ubatch-size', '4096',
    '--n-gpu-layers', String(gpuLayers),
    '--host', '127.0.0.1',
    '--port', String(port),
  ];

  const child = spawn(executable, args, {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const diagnostics = { text: '' };
  const replacements = [
    [files.core.path, '<core-model>'],
    [files.projector.path, '<multimodal-projector>'],
    [executable, '<llama-server>'],
  ];
  child.stdout?.on('data', (chunk) => appendDiagnostic(diagnostics, chunk, replacements));
  child.stderr?.on('data', (chunk) => appendDiagnostic(diagnostics, chunk, replacements));

  let closed = false;
  let closePromise = null;
  const close = async () => {
    if (closed) return;
    if (closePromise) return closePromise;
    closePromise = (async () => {
      await stopProcessTree(child);
      closed = true;
    })();
    try {
      await closePromise;
    } finally {
      closePromise = null;
    }
  };

  child.once('error', () => {
    child.spawnFailure = true;
    diagnostics.text = `${diagnostics.text}\nspawn error`.slice(-MAX_DIAGNOSTIC_CHARS);
  });

  let startupMs;
  try {
    startupMs = await waitForHealth({ child, baseUrl, startupTimeoutMs, diagnostics });
  } catch (error) {
    await close();
    throw error;
  }

  const embedText = async (text) => postEmbedding({
    baseUrl,
    model: 'embeddinggemma-2',
    input: [text],
    fetcher,
    timeoutMs: requestTimeoutMs,
  });

  const embedImage = async (imagePath) => {
    const fileInfo = await stat(imagePath);
    if (fileInfo.size > MAX_IMAGE_BYTES) {
      throw new ExperimentError(
        'image-too-large',
        `Image exceeds the ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MiB experiment limit.`,
      );
    }
    const mimeType = MIME_TYPES.get(path.extname(imagePath).toLowerCase());
    if (!mimeType) {
      throw new ExperimentError('unsupported-image-format', 'Image format is not supported by this experiment.');
    }
    const base64 = (await readFile(imagePath)).toString('base64');
    return postImageDataUrl({
      baseUrl,
      model: 'embeddinggemma-2',
      dataUrl: `data:${mimeType};base64,${base64}`,
      fetcher,
      timeoutMs: requestTimeoutMs,
    });
  };

  const embedImageDataUrl = async (dataUrl) => postImageDataUrl({
    baseUrl,
    model: 'embeddinggemma-2',
    dataUrl,
    fetcher,
    timeoutMs: requestTimeoutMs,
  });

  return {
    startupMs,
    metadata: {
      modelLoaded: true,
      imageCapability: 'pending-canary',
      runtimeCommit,
      endpoint: 'llama-server /v1/embeddings',
      pooling: 'mean',
      gpuLayers,
    },
    embedText,
    embedImage,
    embedImageDataUrl,
    close,
    getDiagnostics: () => diagnostics.text,
  };
}

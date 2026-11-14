import { parseSegmentedManifest, type SegmentedPart } from './segmented-manifest';
import type { ExtensionSaveBehavior } from './preferences';
import type { FetchFunction, FetchResponse, SaveIntent, SaveOutcome } from './save-client';

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_ASSET_BYTES = 500 * 1024 * 1024;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;

async function json(response: FetchResponse): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await response.text());
  if (!value || typeof value !== 'object') throw new Error('桌面端返回了无效响应。');
  return value as Record<string, unknown>;
}

async function requireResponse(response: FetchResponse): Promise<FetchResponse> {
  if (!response.ok) {
    const error = await json(response).catch(() => ({} as Record<string, unknown>));
    throw new Error(typeof error.reason === 'string' ? error.reason : `HTTP ${response.status}`);
  }
  return response;
}

async function readManifest(response: FetchResponse, fallbackUrl: string) {
  await requireResponse(response);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('无法读取视频清单。');
  const decoder = new TextDecoder();
  let length = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_MANIFEST_BYTES) throw new Error('视频清单过大。');
      text += decoder.decode(value, { stream: true });
    }
    return { url: response.url || fallbackUrl, text: text + decoder.decode() };
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function sendPart(input: {
  response: FetchResponse;
  part: SegmentedPart;
  chunkBytes: number;
  account: (length: number) => void;
  upload: (bytes: Uint8Array<ArrayBuffer>, offset: number, final: boolean) => Promise<void>;
}): Promise<void> {
  const { response, part, chunkBytes, account, upload } = input;
  await requireResponse(response);
  if (part.range && (response.status !== 206 ||
    !response.headers.get('content-range')?.startsWith(`bytes ${part.range.slice(6)}/`))) {
    throw new Error('服务器未返回请求的视频分段范围。');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('视频分段为空。');
  const buffer = new Uint8Array(chunkBytes);
  let offset = 0;
  let used = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      account(value.byteLength);
      let cursor = 0;
      while (cursor < value.length) {
        if (used === buffer.length) {
          await upload(buffer, offset, false);
          offset += used;
          used = 0;
        }
        const length = Math.min(buffer.length - used, value.length - cursor);
        buffer.set(value.subarray(cursor, cursor + length), used);
        used += length;
        cursor += length;
      }
    }
    if (used === 0) throw new Error('视频分段为空。');
    if (part.range) {
      const [start, end] = part.range.slice(6).split('-').map(Number);
      if (start === undefined || end === undefined || offset + used !== end - start + 1) {
        throw new Error('视频分段长度与清单不符。');
      }
    }
    await upload(buffer.subarray(0, used), offset, true);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function saveSegmentedVideo(input: {
  intent: SaveIntent;
  kind: 'hls' | 'dash';
  behavior: ExtensionSaveBehavior;
  response: FetchResponse;
  ports: readonly number[];
  fetchFn: FetchFunction;
  requestMedia: (url: string, range?: string) => Promise<FetchResponse>;
}): Promise<SaveOutcome> {
  const { intent, behavior, fetchFn, kind, response, requestMedia } = input;
  let sessionUrl: string | undefined;
  let authorization: string | undefined;
  const localFetch = (url: string, init: RequestInit = {}) => fetchFn(url, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  try {
    let desktop: string | undefined;
    let expectedLibraryId: string | undefined;
    let desktopDetected = false;
    for (const port of input.ports) {
      const base = `http://127.0.0.1:${port}`;
      const ping = await localFetch(`${base}/ping`).then(json).catch(() => undefined);
      if (ping?.app !== 'WorldlineBox') continue;
      desktopDetected = true;
      const folders = await localFetch(`${base}/folders`).then(requireResponse).then(json).catch(() => undefined);
      if (!folders) continue;
      if (typeof intent.targetFolderId === 'string' &&
          (!Array.isArray(folders.folders) || !folders.folders.some(folder => folder?.folderId === intent.targetFolderId))) continue;
      const capabilities = await localFetch(`${base}/capabilities`).then(requireResponse).then(json).catch(() => undefined);
      if (!capabilities?.segmentedMediaUpload) continue;
      desktop = base;
      expectedLibraryId = typeof folders.libraryId === 'string' ? folders.libraryId : undefined;
      break;
    }
    if (!desktop) {
      return desktopDetected
        ? { kind: 'rejected', status: 503, reason: '目标资源库不可用，或当前桌面端不支持分段视频。' }
        : { kind: 'unreachable' };
    }
    const manifest = await parseSegmentedManifest(kind, await readManifest(response, intent.mediaUrl),
      async url => readManifest(await requestMedia(url), url));
    const tracks = manifest.tracks.map(track => ({
      kind: track.kind,
      segments: track.parts.map(({ role, durationMs, discontinuityBefore }, index) => ({
        id: `${track.kind}-${index}`, role, durationMs, discontinuityBefore,
      })),
    }));
    const basename = new URL(intent.mediaUrl).pathname.split('/').pop()?.replace(/\.[^.]+$/, '');
    const filename = `${basename?.slice(0, 100) || 'video'}.mp4`;
    const created = await json(await requireResponse(await localFetch(`${desktop}/media-transfer/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: crypto.randomUUID(), filename,
        sourcePageUrl: intent.sourcePageUrl, mediaUrl: intent.mediaUrl,
        protocol: manifest.protocol, tracks, targetFolderId: intent.targetFolderId, expectedLibraryId,
        focusAppAfterSave: behavior.focusAppAfterSave, revealInLibrary: behavior.revealInLibraryAfterSave,
      }),
    })));
    const { sessionId, token, chunkBytes, maxAssetBytes } = created;
    if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId) || typeof token !== 'string') {
      throw new Error('桌面端返回了无效的传输会话。');
    }
    sessionUrl = `${desktop}/media-transfer/sessions/${sessionId}`;
    authorization = `Bearer ${token}`;
    if (typeof chunkBytes !== 'number' || !Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > MAX_CHUNK_BYTES ||
        typeof maxAssetBytes !== 'number' || !Number.isSafeInteger(maxAssetBytes) || maxAssetBytes <= 0) {
      throw new Error('桌面端返回了无效的传输限制。');
    }
    let received = 0;
    for (const track of manifest.tracks) {
      for (const [index, part] of track.parts.entries()) {
        await sendPart({
          response: await requestMedia(part.url, part.range), part, chunkBytes,
          account: length => {
            received += length;
            if (received > Math.min(maxAssetBytes, MAX_ASSET_BYTES)) throw new Error('视频超过文件大小限制。');
          },
          upload: async (body, offset, final) => {
            await requireResponse(await localFetch(`${sessionUrl}/segments/${track.kind}-${index}?offset=${offset}`, {
              method: 'PUT', body,
              headers: { Authorization: authorization!, 'X-Segment-Final': String(final) },
            }));
          },
        });
      }
    }
    const headers = { Authorization: authorization };
    await requireResponse(await localFetch(`${sessionUrl}/commit`, { method: 'POST', headers }));
    const deadline = Date.now() + 2 * 60 * 60 * 1000;
    while (Date.now() < deadline) {
      const status = await json(await requireResponse(await localFetch(sessionUrl, { headers })));
      if (status.status === 'complete') return { kind: 'accepted' };
      if (status.status !== 'committing') {
        throw new Error(typeof status.reason === 'string' ? status.reason : '视频未能保存到资源库。');
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('等待桌面端合并视频超时。');
  } catch (error) {
    if (sessionUrl && authorization) {
      await localFetch(sessionUrl, { method: 'DELETE', headers: { Authorization: authorization } }).catch(() => undefined);
    }
    return { kind: 'fetch_failed', reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

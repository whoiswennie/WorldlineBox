import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

export const MAX_LEGACY_SEMANTIC_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_LEGACY_ENTRY_BYTES = 1024 * 1024;

export type LegacySemanticCacheEntry = {
  assetId: string;
  revisionId: string;
  vector: number[];
};

export type LegacySemanticCacheHeader = { version: number; profileKey: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function digestLegacySemanticCache(filePath: string): Promise<{ digest: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = createReadStream(filePath);
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_LEGACY_SEMANTIC_CACHE_BYTES) throw new Error('Legacy semantic cache exceeds its size limit.');
      hash.update(buffer);
    }
    return { digest: hash.digest('hex'), bytes };
  } finally {
    stream.destroy();
    await finished(stream).catch(() => undefined);
  }
}

/** Parse only the bounded entries array; never materialize the whole legacy file. */
export async function parseLegacySemanticCache(
  filePath: string,
  onHeader: (header: LegacySemanticCacheHeader) => void,
  onEntry: (entry: LegacySemanticCacheEntry | null) => Promise<void>,
): Promise<number> {
  let totalBytes = 0;
  let headerRead = false;
  let pending = '';
  let inEntries = false;
  let entry = '';
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let entryCount = 0;
  let arrayEnded = false;
  let rootClosed = false;
  const marker = /"entries"\s*:\s*\[/u;
  const stream: Readable = createReadStream(filePath, { encoding: 'utf8' });
  const consumeRootTail = (tail: string): void => {
    for (const char of tail) {
      if (rootClosed) {
        if (!/\s/u.test(char)) throw new Error('Legacy semantic cache has trailing data.');
      } else if (/\s/u.test(char)) {
        continue;
      } else if (char === '}') {
        rootClosed = true;
      } else {
        throw new Error('Legacy semantic cache root is malformed.');
      }
    }
  };
  try {
    for await (const rawChunk of stream) {
      const text = String(rawChunk);
      totalBytes += Buffer.byteLength(text);
      if (totalBytes > MAX_LEGACY_SEMANTIC_CACHE_BYTES) throw new Error('Legacy semantic cache exceeds its size limit.');
      if (arrayEnded) {
        consumeRootTail(text);
        continue;
      }
      pending += text;
      if (!inEntries) {
        const match = marker.exec(pending);
        if (!match || match.index === undefined) {
          if (pending.length > 64 * 1024) throw new Error('Legacy semantic cache header is malformed.');
          continue;
        }
        const prefix = pending.slice(0, match.index);
        const parsed = asRecord(JSON.parse(`${prefix}"entries":[]}`) as unknown);
        if (!parsed || !Number.isInteger(parsed.version) || typeof parsed.profileKey !== 'string') {
          throw new Error('Legacy semantic cache header is invalid.');
        }
        onHeader({ version: parsed.version as number, profileKey: parsed.profileKey });
        headerRead = true;
        pending = pending.slice(match.index + match[0].length);
        inEntries = true;
      }
      let consumed = 0;
      for (; consumed < pending.length; consumed += 1) {
        const char = pending[consumed] ?? '';
        if (depth === 0) {
          if (char === ']' ) {
            consumed += 1;
            arrayEnded = true;
            break;
          }
          if (char === '{') {
            entry = '{';
            depth = 1;
            quoted = false;
            escaped = false;
          } else if (char !== ',' && !/\s/u.test(char)) {
            throw new Error('Legacy semantic cache entries are malformed.');
          }
          continue;
        }
        entry += char;
        if (entry.length > MAX_LEGACY_ENTRY_BYTES) throw new Error('Legacy semantic cache entry exceeds its size limit.');
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
          continue;
        }
        if (char === '"') quoted = true;
        else if (char === '{' || char === '[') depth += 1;
        else if (char === '}' || char === ']') depth -= 1;
        if (depth === 0) {
          const row = asRecord(JSON.parse(entry) as unknown);
          if (row && typeof row.assetId === 'string' && typeof row.revisionId === 'string'
            && Array.isArray(row.vector) && row.vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
            await onEntry({ assetId: row.assetId, revisionId: row.revisionId, vector: row.vector as number[] });
          } else await onEntry(null);
          entryCount += 1;
          entry = '';
        }
      }
      pending = pending.slice(consumed);
      if (arrayEnded) {
        const tail = pending;
        pending = '';
        consumeRootTail(tail);
      }
    }
    if (!headerRead || depth !== 0 || !inEntries || !arrayEnded || !rootClosed) {
      throw new Error('Legacy semantic cache is incomplete.');
    }
    return entryCount;
  } finally {
    // for-await destroys a reader on an early parse failure, but its close is
    // asynchronous. Release the file handle before callers move/delete the cache.
    stream.destroy();
    await finished(stream).catch(() => undefined);
  }
}

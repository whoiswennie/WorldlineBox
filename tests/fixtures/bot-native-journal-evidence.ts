import { readdir, readFile, writeFile } from 'node:fs/promises';
import { zstdDecompressSync } from 'node:zlib';
import path from 'node:path';

/** Only call on a fresh fixture-owned Host root. Do not traverse reparse points.
 * Retain original journal records with credential fields/known secrets redacted. */
export async function preserveBotNativeJournals(root: string, destination: string, redact: (value: string) => string) {
  const journals: Array<{ path: string; records: unknown[] }> = [];
  const sanitize = (value: unknown): unknown => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(sanitize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, /^(?:api.?key|token|authorization|credential|secret)$/iu.test(key) ? '<redacted>' : sanitize(item)]));
    return value;
  };
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else if (/\.jsonl(?:\.zstd)?$/u.test(entry.name)) {
        let bytes = await readFile(filename); if (entry.name.endsWith('.zstd')) bytes = zstdDecompressSync(bytes);
        const records = bytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map(line => {
          try { return sanitize(JSON.parse(line)); } catch { return { incompletePhysicalRecord: redact(line) }; }
        });
        journals.push({ path: path.relative(root, filename), records });
      }
    }
  };
  await walk(root); await writeFile(destination, JSON.stringify(journals, null, 2) + '\n');
  return { filename: path.basename(destination), journals: journals.length, records: journals.reduce((sum, value) => sum + value.records.length, 0) };
}

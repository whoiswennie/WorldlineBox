import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const piece = z.strictObject({ unit: integer, start: integer, end: integer });
const schema = z.strictObject({ version: z.literal(1), sourceHash: z.string().regex(/^[a-f0-9]{64}$/u), epoch: integer.min(1),
  segmented: z.boolean(), parts: z.array(z.array(piece).min(1)) });
export type CapturePiece = z.infer<typeof piece>;
export type CapturePlan = z.infer<typeof schema>;
export const captureCapacity = () => Object.assign(new Error('Memory capture fragment cannot fit the current model capacity; the frozen job remains incomplete.'), { code: 'MEMORY_CAPTURE_CAPACITY' });

const resultSchema = z.strictObject({ version: z.literal(1), sourceHash: z.string().regex(/^[a-f0-9]{64}$/u), checksum: z.string().regex(/^[a-f0-9]{64}$/u), value: z.unknown() });
const resultFlights = new Map<string, Promise<unknown>>();
/** Freeze an encoder result before archiving its DSH session or writing notes.
 * Concurrent/restarted callers all use the first atomically published result. */
export async function freezeCaptureResult<T>(input: { cwd: string; key: string; sourceHash: string; produce(): Promise<T>; validate(value: unknown): T; signal?: AbortSignal }): Promise<T> {
  const directory = path.join(path.resolve(input.cwd), 'capture-results');
  if (!/^[a-f0-9]{64}$/u.test(input.key)) throw new Error('A hashed memory capture result identity is required');
  const file = path.join(directory, `${input.key}.json`), flightKey = file + ':' + input.sourceHash;
  const existing = resultFlights.get(flightKey); if (existing) return existing as Promise<T>;
  const work = (async () => {
    input.signal?.throwIfAborted(); await mkdir(directory, { recursive: true });
    const [root, actual, info] = await Promise.all([realpath(input.cwd), realpath(directory), lstat(directory)]);
    if (info.isSymbolicLink() || path.relative(root, actual).toLowerCase() !== 'capture-results') throw new Error('Memory capture results must remain in their owned directory');
    const checksum = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const read = async () => {
      const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('Invalid frozen memory capture result');
      const record = resultSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      if (record.sourceHash !== input.sourceHash || record.checksum !== checksum(record.value)) throw Object.assign(new Error('Frozen memory encoder result does not match its source or checksum'), { code: 'MEMORY_CAPTURE_SOURCE_CONFLICT' });
      return input.validate(record.value);
    };
    try { return await read(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const value = input.validate(await input.produce()); input.signal?.throwIfAborted();
    const temporary = path.join(directory, `${input.key}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ version: 1, sourceHash: input.sourceHash, checksum: checksum(value), value })); await handle.sync(); } finally { await handle.close(); }
      input.signal?.throwIfAborted();
      try { await link(temporary, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      return await read();
    } finally { await rm(temporary, { force: true }); }
  })();
  resultFlights.set(flightKey, work);
  try { return await work; } finally { if (resultFlights.get(flightKey) === work) resultFlights.delete(flightKey); }
}

function validate(plan: CapturePlan, sourceHash: string, units: readonly string[][]): CapturePlan {
  if (plan.sourceHash !== sourceHash) throw Object.assign(new Error('Memory capture job was reused with different source data.'), { code: 'MEMORY_CAPTURE_SOURCE_CONFLICT' });
  if (!plan.segmented) { if (plan.parts.length) throw new Error('Invalid legacy memory capture plan'); return plan; }
  let unit = 0, offset = 0;
  for (const part of plan.parts) for (const fragment of part) {
    const points = units[unit];
    if (!points || fragment.unit !== unit || fragment.start !== offset || fragment.end > points.length
      || fragment.end < fragment.start || points.length > 0 && fragment.end === fragment.start) throw new Error('Memory capture plan has a source gap or overlap');
    offset = fragment.end;
    if (offset === points.length) { unit++; offset = 0; }
  }
  if (!plan.parts.length || unit !== units.length || offset !== 0) throw new Error('Memory capture plan does not cover every source');
  return plan;
}

function partition(units: readonly string[][], fits: (parts: CapturePiece[]) => boolean, signal?: AbortSignal): CapturePiece[][] {
  const parts: CapturePiece[][] = []; let current: CapturePiece[] = [];
  const flush = () => { if (current.length) { parts.push(current); current = []; } };
  for (let unit = 0; unit < units.length; unit++) {
    let start = 0;
    for (;;) {
      signal?.throwIfAborted(); const length = units[unit]!.length;
      const candidate = (end: number) => [...current, { unit, start, end }];
      if (fits(candidate(length))) { current = candidate(length); break; }
      let lower = start, upper = length;
      while (lower < upper) {
        signal?.throwIfAborted(); const middle = Math.ceil((lower + upper) / 2);
        if (fits(candidate(middle))) lower = middle; else upper = middle - 1;
      }
      if (lower === start) { if (current.length) { flush(); continue; } throw captureCapacity(); }
      // Prefer a nearby paragraph/clause boundary; the explicit ranges still
      // cover every code point when an overlong unbroken passage must be cut.
      for (let end = lower; end > Math.max(start, lower - 512); end--) {
        if (/[\n。！？；;]/u.test(units[unit]![end - 1]!)) { lower = end; break; }
      }
      current = candidate(lower); start = lower; flush();
    }
  }
  flush(); if (!parts.length) throw captureCapacity(); return parts;
}

/** Only hashes, code-point offsets and the original epoch are persisted here.
 * Source text, credentials and model responses remain in their existing stores. */
export async function loadCapturePlan(input: { cwd: string; key: string; sourceHash: string; epoch: number; units: readonly string[][];
  legacyFits: boolean; fits(parts: CapturePiece[]): boolean; signal?: AbortSignal }): Promise<CapturePlan> {
  input.signal?.throwIfAborted();
  if (!/^[a-f0-9]{64}$/u.test(input.key)) throw new Error('A hashed memory capture plan identity is required');
  const directory = path.join(path.resolve(input.cwd), 'capture-plans'); await mkdir(directory, { recursive: true });
  const [root, actual, info] = await Promise.all([realpath(input.cwd), realpath(directory), lstat(directory)]);
  if (info.isSymbolicLink() || path.relative(root, actual).toLowerCase() !== 'capture-plans') throw new Error('Memory capture plans must remain in their owned directory');
  const file = path.join(directory, `${input.key}.json`);
  const read = async () => {
    const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error('Invalid memory capture plan file');
    return validate(schema.parse(JSON.parse(await readFile(file, 'utf8'))), input.sourceHash, input.units);
  };
  try { return await read(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const plan: CapturePlan = { version: 1, sourceHash: input.sourceHash, epoch: input.epoch, segmented: !input.legacyFits,
    parts: input.legacyFits ? [] : partition(input.units, input.fits, input.signal) };
  validate(plan, input.sourceHash, input.units); input.signal?.throwIfAborted();
  const temporary = path.join(directory, `${input.key}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(plan)); await handle.sync(); } finally { await handle.close(); }
    input.signal?.throwIfAborted();
    // Exclusive atomic publication: another worker cannot replace a plan after
    // its first fragment has already been admitted by the durable App brain.
    try { await link(temporary, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return await read();
  } finally { await rm(temporary, { force: true }); }
}

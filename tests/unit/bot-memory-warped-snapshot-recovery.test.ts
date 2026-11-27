import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

const { enableSingletonChunkRecovery } = createRequire(import.meta.url)('../../resources/vcp-memory/lib/warped-chunk-recovery.cjs');

it('repairs only a verified native singleton and retries the original scoped lookup at most once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-warped-singleton-'));
  const model = 'builtin-768',
    dbPath = path.join(root, 'knowledge_base.sqlite');
  const lookupFailure = new Error('snapshot node identities');
  const saved = dbPath + '.chunks-warped-' + createHash('sha256').update(model).digest('hex') + '.vcpwc';
  const result = { results: [{ id: 'intact' }] };
  const lookup = vi.fn<(...args: unknown[]) => Promise<typeof result>>();
  const rebuild = vi.fn(async () => ({ forced: true, ready: true, source: 'built' }));
  const kb = {
    config: { modelSig: model, dimension: 768 },
    dbPath,
    executeNativeRiverQuery: lookup,
    executeLightMemoQuery: vi.fn(),
    nativeKnowledgeRuntime: { prepareGlobalWarpedChunkIndex: rebuild },
  };
  const write = async (ids: bigint[], versions: string[], valid = true, owner = dbPath) => {
    const header = Buffer.from(
      JSON.stringify({
        identity: { model, dimension: 768, database: owner },
        versions: Object.fromEntries(versions.map((id) => [id, [1, 1]])),
      }),
    );
    const prefix = Buffer.alloc(16);
    prefix.write('VCPWC001');
    prefix.writeBigUInt64LE(BigInt(header.length), 8);
    const payload = Buffer.alloc((18 + ids.length) * 8);
    payload.writeBigUInt64LE(1n);
    payload.writeBigUInt64LE(768n, 8);
    payload.writeBigUInt64LE(BigInt(ids.length), 16 * 8);
    ids.forEach((id, index) => payload.writeBigUInt64LE(id, (17 + index) * 8));
    const body = Buffer.concat([prefix, header, payload]),
      digest = createHash('sha256').update(body).digest();
    if (!valid) digest[0] = digest[0]! ^ 0xff;
    await writeFile(saved, Buffer.concat([body, digest]));
  };
  try {
    enableSingletonChunkRecovery(kb);
    const query = { text: '剩余的日记' },
      options = { diaryNames: ['Companion'], deniedFileIds: [2] };
    lookup.mockRejectedValue(lookupFailure);
    for (const [ids, versions, valid, owner] of [
      [[0n], ['0'], true, dbPath],
      [[2n, 2n], ['2'], true, dbPath],
      [[3n], ['5'], true, dbPath],
      [[3n], ['3'], false, dbPath],
      [[3n], ['3'], true, path.join(root, 'other.sqlite')],
    ] as Array<[bigint[], string[], boolean, string]>) {
      await write(ids, versions, valid, owner);
      await expect(kb.executeNativeRiverQuery(query, options)).rejects.toBe(lookupFailure);
    }
    expect(rebuild).not.toHaveBeenCalled();
    await write([5n], ['5']);
    lookup.mockRejectedValueOnce(lookupFailure).mockResolvedValueOnce(result);
    await expect(kb.executeNativeRiverQuery(query, options)).resolves.toBe(result);
    expect(rebuild).toHaveBeenLastCalledWith(model, true);
    expect(lookup).toHaveBeenLastCalledWith(query, options);
    const count = lookup.mock.calls.length;
    await expect(kb.executeNativeRiverQuery(query, options)).rejects.toBe(lookupFailure);
    expect(lookup.mock.calls.length).toBe(count + 2);
    const other = new Error('source bounds invalid');
    lookup.mockRejectedValue(other);
    await expect(kb.executeNativeRiverQuery(query, options)).rejects.toBe(other);
    expect(rebuild).toHaveBeenCalledTimes(2);
    const inner = vi.fn(async () => {
      throw new Error('snapshot node identities');
    });
    const nested = { ...kb, executeLightMemoQuery: inner, executeNativeRiverQuery: async () => nested.executeLightMemoQuery() };
    enableSingletonChunkRecovery(nested);
    await expect(nested.executeNativeRiverQuery()).rejects.toThrow('snapshot node identities');
    expect(inner).toHaveBeenCalledTimes(2);
    expect(rebuild).toHaveBeenCalledTimes(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

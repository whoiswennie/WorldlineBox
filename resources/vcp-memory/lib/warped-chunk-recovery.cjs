'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');

// V5 writes a valid one-node runtime field, but its v1 snapshot loader requires
// at least two nodes. The same native error also covers zero/duplicate IDs.
// Identify only the upstream singleton format before requesting its native
// rebuild. Unrecognized generations retain the original failure.
async function isSingletonSnapshot(kb) {
  const model = kb.config.modelSig;
  const suffix = crypto.createHash('sha256').update(model).digest('hex');
  const file = kb.dbPath + '.chunks-warped-' + suffix + '.vcpwc';
  const handle = await fs.open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 208 || info.size > 2 * 1024 * 1024) return false;
    const data = await handle.readFile();
    if (data.length !== info.size || data.toString('ascii', 0, 8) !== 'VCPWC001') return false;
    const end = data.length - 32;
    if (!crypto.createHash('sha256').update(data.subarray(0, end)).digest().equals(data.subarray(end))) return false;
    const payload = 16 + Number(data.readBigUInt64LE(8));
    // warped_snapshot.rs v1 stores version, dimension and 14 profile/config
    // words before its counted u64 node-ID array.
    if (!Number.isSafeInteger(payload) || payload + 18 * 8 > end || data.readBigUInt64LE(payload) !== 1n ||
      data.readBigUInt64LE(payload + 8) !== BigInt(kb.config.dimension) || data.readBigUInt64LE(payload + 16 * 8) !== 1n) return false;
    const id = data.readBigUInt64LE(payload + 17 * 8);
    const header = JSON.parse(data.toString('utf8', 16, payload));
    const ids = Object.keys(header.versions ?? {});
    return id > 0n && id <= 0x7fff_ffff_ffff_ffffn && ids.length === 1 && ids[0] === String(id) &&
      header.identity?.model === model && header.identity.dimension === kb.config.dimension &&
      typeof header.identity.database === 'string' && path.resolve(header.identity.database) === path.resolve(kb.dbPath);
  } finally { await handle.close(); }
}

function enableSingletonChunkRecovery(kb) {
  let rebuilding;
  const repairFailures = new WeakSet();
  for (const name of ['executeLightMemoQuery', 'executeNativeRiverQuery']) {
    const original = kb[name].bind(kb);
    kb[name] = async (...args) => {
      try { return await original(...args); }
      catch (error) {
        if (error.message !== 'snapshot node identities' || repairFailures.has(error) || !await isSingletonSnapshot(kb).catch(() => false)) throw error;
        if (!rebuilding) {
          rebuilding = kb.nativeKnowledgeRuntime.prepareGlobalWarpedChunkIndex(kb.config.modelSig, true)
            .then(raw => {
              const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
              if (!result?.forced || !result.ready || result.source !== 'built') throw error;
            }).finally(() => { rebuilding = undefined; });
        }
        try {
          await rebuilding;
          return await original(...args);
        } catch (failure) {
          // A River read may call the LightMemo entry point internally.
          // The enclosing native operation must propagate a failed repair.
          if (failure && typeof failure === 'object') repairFailures.add(failure);
          throw failure;
        }
      }
    };
  }
}

module.exports = { enableSingletonChunkRecovery };

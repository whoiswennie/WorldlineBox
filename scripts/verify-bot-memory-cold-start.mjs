import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Measures only the real process/doctor boundary. It never configures a chat
// connection, starts DSH, writes user memories, or substitutes for a recall test.
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const packageRoot = path.resolve(option('package') ?? '.tools/bot-memory-release/vcp-memory');
const nodePath = path.resolve(option('node') ?? '.tools/node-v24.15.0-win-x64/node.exe');
const output = path.resolve(option('output') ?? 'artifacts/superagent-bot-development/memory-integrity-cold-start.json');
const require = createRequire(import.meta.url);
const { createSession } = require(path.join(packageRoot, 'lib/client.cjs'));
const prefix = 'wlb-memory-integrity-check-', root = await mkdtemp(path.join(os.tmpdir(), prefix));
if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith(prefix)) throw Error('Unexpected isolated integrity test directory.');
const key = randomBytes(32).toString('hex'), records = [];
let seal;
try {
  for (const name of ['first-audience', 'second-audience']) {
    const home = path.join(root, name); await mkdir(home);
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ VECTORDB_DIMENSION: 768,
      LOCAL_EMBEDDING_ENABLED: false, WhitelistEmbeddingModel: 'embeddinggemma-2',
      API_URL: '', API_Key: '', CHAT_API_URL: '', CHAT_API_KEY: '', EMBEDDING_API_URL: '', EMBEDDING_API_KEY: '' }));
    const started = performance.now();
    const session = createSession({ home, nodePath, env: { WORLDLINEBOX_VCP_INTEGRITY_KEY: key } });
    try {
      const doctor = await session.request('doctor', { integritySeal: seal }, { timeoutMs: 60000 });
      if (doctor.snapshot?.ok !== true || !doctor.native || !doctor.snapshotIntegrity?.seal) throw Error('A complete actual doctor/attestation receipt was not returned.');
      const elapsedMs = performance.now() - started;
      records.push({ audience: name, elapsedMs, sourceFiles: doctor.snapshot.files,
        reusedReleaseAudit: doctor.snapshotIntegrity.reused, nativeHealthProbed: true,
        nativeCapabilitiesSha256: createHash('sha256').update(JSON.stringify(doctor.native)).digest('hex'),
        dimension: doctor.dimension, node: doctor.node });
      seal = doctor.snapshotIntegrity.seal;
    } finally { await session.close(); }
  }
  if (records[0].reusedReleaseAudit || !records[1].reusedReleaseAudit
    || records[0].nativeCapabilitiesSha256 !== records[1].nativeCapabilitiesSha256) throw Error('Doctor cache reuse or native health results differed from the expected boundary.');
} finally { await rm(root, { recursive: true, force: true }); }
await mkdir(path.dirname(output), { recursive: true });
const result = { createdAt: new Date().toISOString(), packageRoot, nodePath, isolatedAudiences: 2, records,
  limitations: ['Real child processes, original snapshot verification and original 768-dimensional native health probes only.',
    'No semantic lookup, EmbeddingGemma inference or chat-provider request is included; these are not chat reply times.',
    'Filesystem and operating-system caches affect the measurements; two samples are not a latency percentile.'],
  cleanup: { ownedProfilesRemoved: true }, paidProviderRequests: 0, dshInstancesStarted: 0 };
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, records, ownedProfilesRemoved: true }));

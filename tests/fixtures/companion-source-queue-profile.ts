/** Actual Store provenance read on a second private SQLite copy; no Main/model timing claim. */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Session, type Profiler } from 'node:inspector';
import BetterSqlite3 from 'better-sqlite3';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import type { CompanionStorageResponse } from '../../src/shared/companion-storage';

const root = process.env.WORLDLINEBOX_SOURCE_QUEUE_ROOT!;
const variant = process.env.WORLDLINEBOX_SOURCE_QUEUE_VARIANT!;
if (!path.isAbsolute(root) || !path.basename(root).startsWith('wlb-source-queue-') || !['baseline', 'indexed', 'cpu'].includes(variant)) throw new Error('Owned diagnostic inputs are required.');
const databasePrefix = process.env.WORLDLINEBOX_SOURCE_ACCESS_CONTROLLED === '1' ? 'access-' : '';
const dbPath = path.join(root, databasePrefix + variant + '.sqlite');
const Database = BetterSqlite3 as { new(file: string, options?: { readonly?: boolean; fileMustExist?: boolean }): CompanionConnection };
const store = new CompanionsStore(dbPath);
const sql = new Database(dbPath, { readonly: true, fileMustExist: true });
type Proof = NonNullable<CompanionStorageResponse['executionSources']>[number];
const normalized = (proofs: Proof[]) => proofs.map(proof => ({ ...proof, sourceMessageIds: [...proof.sourceMessageIds].sort() }))
  .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
const digest = (proofs: Proof[]) => createHash('sha256').update(JSON.stringify(normalized(proofs))).digest('hex');
const messages = sql.prepare('SELECT id,conversation_id,author_id FROM messages ORDER BY sequence DESC').all() as Array<{ id: string; conversation_id: string; author_id: string }>;
const room = (sql.prepare("SELECT conversation_id FROM messages GROUP BY conversation_id ORDER BY COUNT(*) DESC LIMIT 1").get() as { conversation_id: string }).conversation_id;
const notes = sql.prepare('SELECT id FROM vcp_memory_notes ORDER BY id LIMIT 100').all() as Array<{ id: string }>;
const cases = [
  { name: 'actual-latest-50-roots', ids: messages.slice(0, 50).map(row => row.id), notes: [] as string[] },
  { name: 'actual-densest-room', ids: messages.filter(row => row.conversation_id === room).slice(0, 50).map(row => row.id), notes: [] as string[] },
  { name: 'actual-notes-and-message-roots', ids: messages.slice(0, 12).map(row => row.id), notes: notes.map(row => row.id) },
];
const results: Array<Record<string, unknown>> = [];
let reference: Proof | undefined;
export const controlledCaseCounts = cases.map(value => ({ name: value.name, roots: value.ids.length, notes: value.notes.length }));
export function controlledResolve(index: number): Proof[] {
  const input = cases[index]!;
  return store.request({ type: 'execution.sources', sourceMessageIds: input.ids, memoryIds: input.notes }).executionSources!;
}
export function controlledWithdraw(proof: Proof): void {
  store.request({ type: 'execution.invalidate', kind: proof.kind, id: proof.id, companionId: proof.companionId });
}
export function controlledHash(proofs: Proof[]): string { return digest(proofs); }
export function controlledClose(): void { sql.close(); store.close(); }
async function cpuProfile() {
  const input = cases[0]!, command = { type: 'execution.sources' as const, sourceMessageIds: input.ids, memoryIds: [] as string[] };
  store.request(command);
  const session = new Session(); session.connect();
  const post = <T>(method: string, params: object = {}) => new Promise<T>((resolve, reject) => {
    session.post(method, params, (error, result) => error ? reject(error) : resolve(result as T));
  });
  try {
    await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 100 }); await post('Profiler.start');
    const started = performance.now(), cpu = process.cpuUsage();
    let proofCount = 0;
    for (let iteration = 0; iteration < 10; iteration++) proofCount = store.request(command).executionSources!.length;
    const elapsedMs = performance.now() - started, usage = process.cpuUsage(cpu);
    const result = await post<{ profile: Profiler.Profile }>('Profiler.stop');
    writeFileSync(path.join(root, 'actual-store-source-queue.cpuprofile'), JSON.stringify(result.profile));
    writeFileSync(path.join(root, 'cpu-profile-result.json'), JSON.stringify({ actualStore: true, secondaryPrivateCopy: true,
      isMainOrProviderLatency: false, iterations: 10, roots: input.ids.length, proofCount, elapsedMs,
      cpuMs: (usage.user + usage.system) / 1000, profileSamples: result.profile.samples?.length ?? 0 }));
  } finally { session.disconnect(); }
}
if (process.env.WORLDLINEBOX_SOURCE_ACCESS_CONTROLLED === '1') {
  // The comparison controller calls both real Stores in alternating order.
} else if (variant === 'cpu') {
  void cpuProfile().then(() => { sql.close(); store.close(); console.log(JSON.stringify({ completed: true, actualStoreCpuProfile: true })); })
    .catch(error => { sql.close(); store.close(); throw error; });
} else {
try {
  for (const input of cases) {
    const counters = { roots: 0, pushes: 0, pops: 0, duplicatePops: 0, maximumQueueLength: 0 };
    Reflect.set(globalThis, '__sourceQueueStats', counters);
    const actual = store.request({ type: 'execution.sources', sourceMessageIds: input.ids, memoryIds: input.notes }).executionSources!;
    Reflect.set(globalThis, '__sourceQueueStats', undefined);
    reference ??= actual.find(proof => proof.kind === 'message' && proof.executionReadset && !proof.invalidated && proof.companionId !== 'user');
    const performanceSamples = [];
    for (let iteration = 0; iteration < 4; iteration++) {
      const cpu = process.cpuUsage(), start = performance.now();
      const proof = store.request({ type: 'execution.sources', sourceMessageIds: input.ids, memoryIds: input.notes }).executionSources!;
      const elapsedMs = performance.now() - start, usage = process.cpuUsage(cpu);
      if (digest(proof) !== digest(actual)) throw new Error('A diagnostic read changed its complete normalized proof.');
      performanceSamples.push({ elapsedMs, cpuMs: (usage.user + usage.system) / 1000 });
    }
    writeFileSync(path.join(root, `private-${variant}-${input.name}-proofs.json`), JSON.stringify(normalized(actual)));
    results.push({ case: input.name, roots: input.ids.length, noteInputs: input.notes.length, proofs: actual.length,
      normalizedProofHash: digest(actual), counters, performanceSamples });
  }
  if (!reference) throw new Error('The actual corpus has no typed derived reply to withdraw.');
  store.request({ type: 'execution.invalidate', kind: 'message', id: reference.id, companionId: reference.companionId });
  for (const input of cases) {
    const proof = store.request({ type: 'execution.sources', sourceMessageIds: input.ids, memoryIds: input.notes }).executionSources!;
    results.push({ case: input.name + '-after-real-withdrawal', proofs: proof.length, invalidated: proof.filter(item => item.invalidated).length,
      normalizedProofHash: digest(proof) });
  }
  writeFileSync(path.join(root, variant + '-result.json'), JSON.stringify({ variant, actualStore: true, secondPrivateCopy: true,
    isMainOrProviderLatency: false, sourceBodyReadOnly: true, results }));
  console.log(JSON.stringify({ variant, cases: results.length, completed: true }));
} finally { sql.close(); store.close(); }
}

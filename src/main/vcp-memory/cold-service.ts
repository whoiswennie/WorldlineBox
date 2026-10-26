import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, open, readFile, rename } from 'node:fs/promises';
import { ColdKnowledgeClient, type ColdKnowledgeClientOptions } from './cold-client';
import type { ColdKnowledgeDocument, ColdKnowledgeHit, ColdKnowledgeRecord, ColdKnowledgeState } from './cold-contracts';
import { inspectVcpOwnedDirectory, removeOwnedDirectory } from './filesystem';

export interface ColdKnowledgeServiceOptions extends ColdKnowledgeClientOptions {
  /** Production owner-specific services cannot address another owner's tree. */
  boundOwnerId?: string;
  /** Recheck actual source ACL and version on every read, including after worker I/O. */
  authorize(ownerId: string, sourceId: string, sourceDigest: string,
    source: Pick<ColdKnowledgeDocument, 'sourceVersion' | 'sourceType' | 'metadata'>): Promise<boolean>;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function validId(value: string): string { if (!value || typeof value !== 'string' || value.length > 200) throw new Error('Invalid cold knowledge identity.'); return value; }
async function atomic(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`; const output = await open(temporary, 'wx', 0o600);
  try { await output.writeFile(JSON.stringify(value)); await output.sync(); } finally { await output.close(); }
  await rename(temporary, file);
}

/** Main owns authoritative visibility; native generations contain only immutable published snapshots. */
export class ColdKnowledgeService {
  private client: ColdKnowledgeClient;
  private states = new Map<string, Promise<ColdKnowledgeState>>();
  private writes = new Map<string, Promise<unknown>>();
  private builds = new Map<string, Promise<unknown>>();
  private closed = false;
  private readonly embeddingKey: string;
  constructor(private readonly options: ColdKnowledgeServiceOptions) {
    this.client = new ColdKnowledgeClient(options);
    this.embeddingKey = digest(JSON.stringify({ dimension: options.embedding.dimension, model: options.embedding.modelSignature || options.embedding.model }));
  }
  private ownerRoot(owner: string): string {
    validId(owner);
    if (this.options.boundOwnerId && owner !== this.options.boundOwnerId) throw new Error('Cold knowledge belongs to another owner.');
    return path.join(path.resolve(this.options.dataRoot), 'owners', digest(owner));
  }
  private async state(owner: string): Promise<ColdKnowledgeState> {
    if (this.closed) throw new Error('Cold knowledge has closed.');
    if (this.options.boundOwnerId) await inspectVcpOwnedDirectory(path.join(this.ownerRoot(owner), 'snapshots'));
    let pending = this.states.get(owner);
    if (!pending) {
      pending = (async () => {
        const root = this.ownerRoot(owner); await mkdir(path.join(root, 'snapshots'), { recursive: true });
        for (const file of [path.resolve(this.options.dataRoot), path.join(path.resolve(this.options.dataRoot), 'owners'), root, path.join(root, 'snapshots')])
          if ((await lstat(file)).isSymbolicLink()) throw new Error('Cold knowledge storage cannot be linked.');
        try {
          const state = JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')) as ColdKnowledgeState;
          if (!Number.isInteger(state.revision) || !Array.isArray(state.documents) || state.generation && !/^[a-f0-9-]{36}$/.test(state.generation)) throw new Error('Invalid cold knowledge registry.');
          for (const document of state.documents) {
            if (!/^[a-f0-9]{64}$/.test(document.snapshot) || !/^[a-f0-9]{64}$/.test(document.version) || !['ready', 'pending', 'revoked'].includes(document.status)) throw new Error('Invalid cold knowledge source snapshot.');
          }
          return state;
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 0, documents: [] }; throw error; }
      })();
      this.states.set(owner, pending);
    }
    return pending;
  }
  private save(owner: string, state: ColdKnowledgeState): Promise<unknown> {
    const snapshot = JSON.parse(JSON.stringify(state));
    const write = (this.writes.get(owner) ?? Promise.resolve()).catch(() => undefined).then(() => atomic(path.join(this.ownerRoot(owner), 'state.json'), snapshot));
    this.writes.set(owner, write); return write;
  }
  private allowed(owner: string, document: ColdKnowledgeRecord): Promise<boolean> {
    return this.options.authorize(owner, document.sourceId, document.sourceDigest, document);
  }
  private rebuild(owner: string): Promise<unknown> {
    const build = (this.builds.get(owner) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const state = await this.state(owner);
      for (;;) {
        const revision = state.revision;
        const documents: ColdKnowledgeRecord[] = [];
        for (const document of state.documents) if (document.status !== 'revoked' && await this.allowed(owner, document)) documents.push({ ...document });
        const generation = randomUUID();
        const result = await this.client.request<{ chunks: Record<string, number> }>({ type: 'build', owner: digest(owner), generation,
          previous: state.embeddingKey === this.embeddingKey ? state.generation : undefined, documents, embeddingKey: this.embeddingKey });
        if (state.revision !== revision) continue;
        let changed = false;
        for (const document of documents) if (!await this.allowed(owner, document)) {
          const current = state.documents.find(item => item.id === document.id && item.version === document.version);
          if (current) current.status = 'revoked'; changed = true;
        }
        if (changed) { state.revision++; await this.save(owner, state); continue; }
        state.generation = generation; state.embeddingKey = this.embeddingKey;
        for (const document of state.documents) {
          const included = documents.find(item => item.id === document.id && item.version === document.version);
          if (included) { document.status = 'ready'; document.chunks = result.chunks[document.id]; }
          else document.status = 'revoked';
        }
        await this.save(owner, state); return;
      }
    });
    this.builds.set(owner, build); return build;
  }
  async ingest(owner: string, input: ColdKnowledgeDocument) {
    validId(input.id); validId(input.sourceId);
    if (!/^[a-f0-9]{64}$/.test(input.sourceDigest) || typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > 16 * 1024 ** 2) throw new Error('Invalid cold knowledge source content or digest.');
    if (!await this.options.authorize(owner, input.sourceId, input.sourceDigest, input)) throw new Error('Cold knowledge source is unavailable or no longer authorized.');
    const state = await this.state(owner);
    const contentDigest = digest(input.text);
    const version = digest(JSON.stringify({ id: input.id, sourceId: input.sourceId, sourceDigest: input.sourceDigest, sourceVersion: input.sourceVersion, sourceType: input.sourceType, contentDigest, embeddingKey: this.embeddingKey }));
    const { text, ...metadata } = input;
    const record: ColdKnowledgeRecord = { ...metadata, version, contentDigest, snapshot: version, status: 'pending' };
    await atomic(path.join(this.ownerRoot(owner), 'snapshots', `${version}.json`), { ...record, text });
    const index = state.documents.findIndex(item => item.id === record.id);
    if (index >= 0) state.documents[index] = record; else state.documents.push(record);
    state.revision++; await this.save(owner, state); await this.rebuild(owner);
    const current = state.documents.find(item => item.id === record.id);
    return { id: record.id, version, indexed: current?.version === version && current.status === 'ready', generation: state.generation, chunks: current?.chunks ?? 0 };
  }
  async revoke(owner: string, id: string) {
    const state = await this.state(owner); const record = state.documents.find(item => item.id === id);
    if (record) { record.status = 'revoked'; state.revision++; await this.save(owner, state); }
    return { id, revoked: true };
  }
  async search(owner: string, text: string, options: { topK?: number; sourceIds?: string[]; documentIds?: string[]; expand?: boolean } = {}): Promise<{ results: ColdKnowledgeHit[]; generation?: string; degraded: boolean }> {
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('Invalid cold knowledge query.');
    const state = await this.state(owner);
    if (!state.generation || state.embeddingKey !== this.embeddingKey) return { results: [], degraded: true };
    const generation = state.generation, revision = state.revision;
    const documents: ColdKnowledgeRecord[] = [];
    for (const record of state.documents) if (record.status === 'ready' && (!options.sourceIds || options.sourceIds.includes(record.sourceId))
      && (!options.documentIds || options.documentIds.includes(record.id)) && await this.allowed(owner, record)) documents.push({ ...record });
    if (!documents.length) return { results: [], generation, degraded: false };
    const results = await this.client.request<ColdKnowledgeHit[]>({ type: 'search', owner: digest(owner), generation, embeddingKey: this.embeddingKey, documents,
      text, topK: Math.max(1, Math.min(100, Math.floor(options.topK ?? 10))), expand: options.expand });
    const visible: ColdKnowledgeHit[] = [];
    for (const hit of results) {
      const current = state.documents.find(item => item.id === hit.id);
      if (current?.status === 'ready' && current.version === hit.version && await this.allowed(owner, current)
        && state.documents.find(item => item.id === hit.id) === current && current.status === 'ready') visible.push(hit);
    }
    return { results: visible, generation, degraded: revision !== state.revision };
  }
  async read(owner: string, id: string, version?: string): Promise<ColdKnowledgeDocument & { version: string }> {
    const state = await this.state(owner); const record = state.documents.find(item => item.id === id);
    if (!record || record.status !== 'ready' || version && version !== record.version || !await this.allowed(owner, record)) throw new Error('Cold knowledge version is unavailable.');
    const value = JSON.parse(await readFile(path.join(this.ownerRoot(owner), 'snapshots', `${record.snapshot}.json`), 'utf8')) as ColdKnowledgeDocument;
    if (digest(value.text) !== record.contentDigest || record.status !== 'ready' || !await this.allowed(owner, record)
      || state.documents.find(item => item.id === id) !== record || record.status !== 'ready') throw new Error('Cold knowledge source changed or was withdrawn.');
    return { ...value, version: record.version };
  }
  async status(owner: string) { const state = await this.state(owner); return { generation: state.generation, revision: state.revision, documents: state.documents.map(item => ({ ...item })) }; }
  /** Call while Main holds the owner's reset gate, before allowing new work. */
  async reset(owner: string): Promise<void> {
    const state = await this.state(owner); state.revision++;
    for (const document of state.documents) document.status = 'revoked';
    await this.save(owner, state); await this.builds.get(owner)?.catch(() => undefined);
    await this.client.request({ type: 'barrier' }); await this.writes.get(owner);
    await removeOwnedDirectory(this.ownerRoot(owner));
    this.states.delete(owner); this.writes.delete(owner); this.builds.delete(owner);
  }
  async close(): Promise<void> { if (this.closed) return; this.closed = true; await this.client.close(); await Promise.allSettled([...this.builds.values(), ...this.writes.values()]); }
}

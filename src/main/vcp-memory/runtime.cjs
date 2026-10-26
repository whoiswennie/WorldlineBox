/* global require, module, process, setTimeout */
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { URL, fileURLToPath, pathToFileURL } = require('node:url');
const { createRequire, isBuiltin, registerHooks } = require('node:module');
const { tmpdir } = require('node:os');
const { OwnedMemoryRecordCatalog, fingerprintNote } = require('./record-catalog.cjs');

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function identity(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw failure('VCP_MEMORY_INVALID_INPUT', `Invalid ${label}.`);
  return value;
}
// Match the public diary/query contracts. IDs and paths keep their smaller
// boundary; content is chunked by upstream rather than silently truncated here.
function memoryText(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) throw failure('VCP_MEMORY_INVALID_INPUT', `Invalid ${label}.`);
  return value.trim();
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function notebookFolder(diaryName) {
  const name = diaryName?.trim();
  if (!name || name === 'memories') return 'memories';
  const label = Array.from(name.replaceAll('日记本', '日记').replace(/[^\p{L}\p{N}-]/gu, '_').replace(/_+/gu, '_').replace(/^_+|_+$/gu, '')).slice(0, 24).join('') || 'notebook';
  return `nb-${label}-${digest(name).slice(0, 32)}`;
}
function formattedNativeDiary(note, recordedAt) {
  const timeZone = note.hostProjection?.timeZone || 'Asia/Shanghai';
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(note.occurredAt || recordedAt));
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(note.occurredAt || recordedAt));
  const key = digest(note.id), folder = notebookFolder(note.diaryName), header = `[${day}] - ${note.author || 'WorldlineBox'}\n`;
  const content = `[${time}]\n<!-- WorldlineBoxMemory:${key} -->\n${note.content}`;
  const tags = note.tags.length ? note.tags : [note.author || 'WorldlineBox'];
  return { day, time, key, folder, content, tags, text: `${header}${content}\nTag: ${tags.join(', ')}` };
}
function renderNativeDiaryText(input) {
  const note = normalizeNote(input);
  if (!note.occurredAt) throw failure('VCP_MEMORY_CANONICAL_PROVENANCE_UNAVAILABLE', 'Canonical source rendering requires its captured occurrence.');
  return formattedNativeDiary(note, note.occurredAt).text;
}
function embeddingConfiguration(input) {
  const dimension = input?.dimension;
  if (!Number.isInteger(dimension) || dimension < 1 || dimension > 4096) throw failure('VCP_MEMORY_INVALID_DIMENSION', 'Embedding dimension must be between 1 and 4096.');
  const url = new URL(identity(input.baseUrl, 'embedding base URL'));
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw failure('VCP_MEMORY_INVALID_INPUT', 'Invalid embedding base URL.');
  const model = identity(input.model, 'embedding model');
  return { apiUrl: url.toString().replace(/\/+$/u, '').replace(/\/v1$/u, ''),
    model, apiKey: typeof input.apiKey === 'string' ? input.apiKey : '', dimension,
    modelSignature: identity(input.modelSignature || model, 'embedding model signature'),
    queryApiUrl: input.queryBaseUrl ? embeddingConfiguration({ ...input, baseUrl: input.queryBaseUrl, queryBaseUrl: undefined }).apiUrl : undefined };
}
function normalizeNote(input) {
  const id = identity(input?.id, 'memory ID');
  const content = memoryText(input?.content, 'memory content', 65536);
  if (!Array.isArray(input.tags) || input.tags.some(tag => typeof tag !== 'string' || /[\r\n,，、;|｜]/u.test(tag))) throw failure('VCP_MEMORY_INVALID_INPUT', 'Tags must be individual names without separators.');
  const tags = [...new Set(input.tags.map(tag => tag.trim()).filter(Boolean))];
  if (tags.length > 50) throw failure('VCP_MEMORY_INVALID_INPUT', 'A memory may have at most 50 tags.');
  if (input.occurredAt !== undefined && (typeof input.occurredAt !== 'string' || !Number.isFinite(Date.parse(input.occurredAt)))) throw failure('VCP_MEMORY_INVALID_INPUT', 'Invalid memory date.');
  if (input.author !== undefined && (typeof input.author !== 'string' || !input.author.trim() || /[\r\n]/u.test(input.author))) throw failure('VCP_MEMORY_INVALID_INPUT', 'Invalid memory author.');
  if (input.diaryName !== undefined && (typeof input.diaryName !== 'string' || !input.diaryName.trim() || input.diaryName.length > 160)) throw failure('VCP_MEMORY_INVALID_INPUT', 'Invalid diary notebook name.');
  if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata))) throw failure('VCP_MEMORY_INVALID_INPUT', 'Invalid memory metadata.');
  if (input.hostProjection !== undefined) {
    const zone = input.hostProjection?.timeZone;
    if (typeof zone !== 'string' || zone.length > 100) throw failure('VCP_MEMORY_INVALID_INPUT', 'Invalid memory projection timezone.');
    try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); }
    catch { throw failure('VCP_MEMORY_INVALID_INPUT', 'Invalid memory projection timezone.'); }
  }
  // The JSON boundary also rejects cyclic metadata before any file mutation.
  return JSON.parse(JSON.stringify({ id, content, tags, occurredAt: input.occurredAt, author: input.author, diaryName: input.diaryName?.trim(), metadata: input.metadata,
    ...(input.hostProjection ? { hostProjection: { timeZone: input.hostProjection.timeZone } } : {}) }));
}
/** Copy upstream observables only. The host does not score, clamp, combine or reorder candidates. */
function projectNativeScoreDetails(hit, result, rank) {
  const details = { engine: hit.retrievalEngine === 'knn' ? 'knn' : 'river', rank };
  for (const field of ['originalScore', 'vectorScore', 'baseScore', 'topologyBonus', 'anchorBonus', 'omega']) {
    if (typeof hit[field] === 'number' && Number.isFinite(hit[field])) details[field] = hit[field];
  }
  if (typeof hit.score === 'number' && Number.isFinite(hit.score)) details.finalScore = hit.score;
  if (Number.isSafeInteger(hit.rank) && hit.rank > 0) details.nativeRank = hit.rank;
  for (const field of ['role', 'riverRegime']) if (typeof hit[field] === 'string' && hit[field].length <= 100) details[field] = hit[field];
  for (const field of ['matchedTags', 'coreTagsMatched']) {
    if (Array.isArray(hit[field])) details[field] = hit[field].filter(value => typeof value === 'string' && value.length <= 1024).slice(0, 50);
  }
  if (Array.isArray(hit.candidateSources)) details.candidateSources = hit.candidateSources
    .map(value => typeof value === 'string' ? value : value?.source).filter(value => typeof value === 'string' && value.length <= 100).slice(0, 32);
  if (typeof result.algorithmVersion === 'string' && result.algorithmVersion.length <= 100) details.algorithmVersion = result.algorithmVersion;
  const mode = result.diagnostics?.queryProfile?.mode;
  if (typeof mode === 'string' && mode.length <= 100) details.queryMode = mode;
  return details;
}
async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(value), 'utf8'); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
async function jsonOrNull(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
/** Bind the private upstream copy to the shipped dependencies directly. Windows
 * junction traversal can fail in user libraries even when the package exists.
 * Preserve relative JS/assets and all package export/import conditions; only
 * requests originating in this runtime use the vendor's dependency boundary.
 */
function bindRuntimeDependencies(runtimeRoot, vendorRoot) {
  const vendorParent = pathToFileURL(path.join(vendorRoot, 'package.json')).href;
  const vendorRequire = createRequire(vendorParent);
  return registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith('file:')) {
      const parent = fileURLToPath(context.parentURL), relative = path.relative(runtimeRoot, parent);
      if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) {
        if (isBuiltin(specifier)) return nextResolve(specifier, context);
        if (!specifier.startsWith('.') && !path.isAbsolute(specifier) && !/^[a-z][a-z\d+.-]*:/iu.test(specifier)) {
          // CommonJS retains its parent Module's search paths inside nextResolve;
          // resolve it with the explicit vendor require rather than just a URL.
          if (context.conditions.includes('require')) return { url: pathToFileURL(vendorRequire.resolve(specifier)).href, shortCircuit: true };
          return nextResolve(specifier, { ...context, parentURL: vendorParent });
        }
        if (specifier.startsWith('.') && path.resolve(path.dirname(parent), specifier) === path.join(runtimeRoot, 'rust-vexus-lite')) {
          return { url: pathToFileURL(vendorRequire.resolve('./rust-vexus-lite')).href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  } });
}
async function removeOwnedDirectory(root) {
  if (!path.isAbsolute(root) || path.parse(root).root === path.resolve(root)) throw failure('VCP_MEMORY_UNSAFE_SOURCE', 'Unsafe VCP directory removal.');
  let entry;
  try { entry = await fs.lstat(root); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw failure('VCP_MEMORY_UNSAFE_SOURCE', 'VCP removal root must be a real owned directory.');
  for (const name of await fs.readdir(root)) {
    const file = path.join(root, name), child = await fs.lstat(file);
    if (child.isSymbolicLink()) await fs.unlink(file);
    else if (child.isDirectory()) await removeOwnedDirectory(file);
    else await fs.unlink(file);
  }
  await fs.rmdir(root);
}
function comparablePath(file) {
  const absolute = path.toNamespacedPath(path.resolve(file));
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
async function unlinkRuntimeDependency(runtimeRoot, target, source) {
  if (path.dirname(target) !== runtimeRoot || !['node_modules', 'rust-vexus-lite'].includes(path.basename(target))) throw failure('VCP_MEMORY_RUNTIME_LAYOUT', 'Unsafe runtime dependency link.');
  let entry;
  try { entry = await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const parent = await fs.lstat(runtimeRoot);
  if (!parent.isDirectory() || parent.isSymbolicLink() || !entry.isSymbolicLink()) throw failure('VCP_MEMORY_RUNTIME_LAYOUT', 'Runtime dependency must remain an owned directory link.');
  const actual = path.resolve(runtimeRoot, await fs.readlink(target));
  if (comparablePath(actual) !== comparablePath(source)) throw failure('VCP_MEMORY_RUNTIME_LAYOUT', 'Runtime dependency target changed.');
  await fs.unlink(target);
}

/** One instance per OS process. No VCP module is imported before initialize(). */
class VcpMemoryRuntime {
  constructor() { this.kb = null; this.closed = false; this.dependencyLinks = []; this.notePaths = new Map();
    this.records = new OwnedMemoryRecordCatalog({ recordPath: id => this.paths(id).record, normalize: normalizeNote });
    this.sourceIds = new Map(); this.fileIds = new Map(); }
  sourceKey(file) { return path.resolve(file).replace(/^\\\\\?\\UNC\\/u, '\\\\').replace(/^\\\\\?\\/u, '').replaceAll('\\', '/'); }
  bindNotePath(id, file) {
    const previous = this.notePaths.get(id);
    if (previous) { this.sourceIds.delete(this.sourceKey(previous)); this.fileIds.delete(path.basename(previous)); }
    this.notePaths.set(id, file); this.sourceIds.set(this.sourceKey(file), id); this.fileIds.set(path.basename(file), id);
  }
  unbindNotePath(id) {
    const previous = this.notePaths.get(id);
    if (previous) {
      this.sourceIds.delete(this.sourceKey(previous));
      if (this.fileIds.get(path.basename(previous)) === id) this.fileIds.delete(path.basename(previous));
      this.notePaths.delete(id);
    }
  }

  async initialize(configuration) {
    if (this.kb || this.initializing) throw failure('VCP_MEMORY_ALREADY_INITIALIZED', 'Memory process is already initialized.');
    this.initializing = true;
    const scopeId = identity(configuration?.scope?.scopeId, 'memory scope');
    this.embedding = embeddingConfiguration(configuration.embedding);
    this.scopeRoot = path.join(path.resolve(identity(configuration.dataRoot, 'memory data root')), digest(scopeId));
    this.notesRoot = path.toNamespacedPath(path.join(this.scopeRoot, 'notes'));
    this.recordsRoot = path.join(this.scopeRoot, 'records');
    await fs.mkdir(path.join(this.notesRoot, 'memories'), { recursive: true });
    await fs.mkdir(this.recordsRoot, { recursive: true });
    const signature = { scopeId, model: this.embedding.model, modelSignature: this.embedding.modelSignature, dimension: this.embedding.dimension };
    const identityPath = path.join(this.scopeRoot, 'identity.json');
    const prior = await jsonOrNull(identityPath);
    if (prior && JSON.stringify(prior) !== JSON.stringify(signature)) throw failure('VCP_MEMORY_EMBEDDING_SPACE_MISMATCH', 'This memory scope uses a different embedding model, signature or dimension. Re-embedding is required.');
    if (!prior) await atomicJson(identityPath, signature);
    const vendorRoot = path.resolve(identity(configuration.vendorRoot, 'VCP vendor root'));
    this.runtimeRoot = path.join(this.scopeRoot, 'runtime');
    // Unchanged upstream peripherals store caches beside their modules. Give each
    // physical scope its own byte-identical JS/assets; resolve immutable native
    // binaries and installed packages from the vendor without directory links.
    await fs.cp(vendorRoot, this.runtimeRoot, { recursive: true, dereference: true,
      filter: source => !['node_modules', 'rust-vexus-lite'].includes(path.basename(source)) });
    // Near-identical text can contain a materially different negation, identity
    // or newer correction. Keep those candidates for original AIMemo to judge.
    // These are upstream configuration knobs, in the owned runtime copy only;
    // every vendored source and parameter template remains byte-identical.
    const paramsFile = path.join(this.runtimeRoot, 'rag_params.json');
    const params = await jsonOrNull(paramsFile);
    const profile = configuration.plugins?.behaviorProfile || 'preserve-corrections';
    if (!['preserve-corrections', 'upstream'].includes(profile)) throw failure('VCP_MEMORY_INVALID_INPUT', 'Unknown VCP behavior profile.');
    params.KnowledgeBaseManager ||= {};
    params.KnowledgeBaseManager.resultDeduplication ||= {};
    const differences = [];
    for (const [container, key, parameter] of [
      [params.KnowledgeBaseManager, 'deduplicationThreshold', 'KnowledgeBaseManager.deduplicationThreshold'],
      [params.KnowledgeBaseManager.resultDeduplication, 'semanticThreshold', 'KnowledgeBaseManager.resultDeduplication.semanticThreshold'],
      [params.KnowledgeBaseManager.resultDeduplication, 'finalSemanticThreshold', 'KnowledgeBaseManager.resultDeduplication.finalSemanticThreshold'],
    ]) {
      const upstream = container[key];
      if (profile === 'preserve-corrections') container[key] = 1;
      differences.push({ parameter, upstream, effective: container[key] });
    }
    this.behavior = { profile, differences, generation: { aimemoBatchSize: 2, aimemoMaxTokensPerBatch: 18000,
      aimemoOutputTokens: 40000, queryResultCacheEnabled: false, riverThinkingEnabled: !!configuration.plugins?.riverThinkingEnabled,
      queryEncoding: 'upstream_chunk_token_weighted_average', queryScope: 'physical_projection_before_top_k',
      contextClock: 'request_local_dayjs_host_world_clock_or_native_real_fallback', passiveRecallPolicy: { schema: 'episodic-v1', halfLifeDays: 180, minScore: 0 } } };
    await atomicJson(paramsFile, params);
    const vendorRequire = createRequire(path.join(vendorRoot, 'package.json'));
    let tokenDirectory = path.dirname(vendorRequire.resolve('@dqbd/tiktoken'));
    while ((await jsonOrNull(path.join(tokenDirectory, 'package.json')))?.name !== '@dqbd/tiktoken') {
      const parent = path.dirname(tokenDirectory);
      if (parent === tokenDirectory) throw failure('VCP_MEMORY_PACKAGE_MISSING', 'Unable to locate the tokenizer package.');
      tokenDirectory = parent;
    }
    const dependencyRoot = path.dirname(path.dirname(tokenDirectory));
    for (const [name, source] of [['node_modules', dependencyRoot], ['rust-vexus-lite', path.join(vendorRoot, 'rust-vexus-lite')]]) {
      const target = path.join(this.runtimeRoot, name);
      // Retire links left by earlier versions without following their targets.
      await unlinkRuntimeDependency(this.runtimeRoot, target, source);
    }
    this.dependencyBinding = bindRuntimeDependencies(this.runtimeRoot, vendorRoot);
    // libuv chdir still rejects >MAX_PATH even with a namespaced argument. This
    // empty private cwd also prevents upstream TextChunker loading a host config.env.
    this.cwdRoot = await fs.mkdtemp(path.join(tmpdir(), 'vcp-cwd-'));
    process.chdir(this.cwdRoot);
    if (process.platform === 'win32') {
      // FoldingStore builds its SQLite filename from __dirname. Adapt only the
      // native constructor boundary; upstream plugin source and SQL stay intact.
      const databaseModule = vendorRequire.resolve('better-sqlite3');
      const Database = vendorRequire('better-sqlite3');
      require.cache[databaseModule].exports = new Proxy(Database, { construct(target, arguments_) {
        return Reflect.construct(target, [typeof arguments_[0] === 'string' && !['', ':memory:'].includes(arguments_[0])
          ? path.toNamespacedPath(arguments_[0]) : arguments_[0], ...arguments_.slice(1)]);
      } });
      const { VexusWatcher } = vendorRequire('./rust-vexus-lite');
      const startWatch = VexusWatcher.prototype.startWatch || VexusWatcher.prototype.start_watch;
      const drainEvents = VexusWatcher.prototype.drainEvents || VexusWatcher.prototype.drain_events;
      VexusWatcher.prototype.startWatch = function (configuration) {
        return startWatch.call(this, { ...configuration, rootPath: path.toNamespacedPath(configuration.rootPath) });
      };
      VexusWatcher.prototype.drainEvents = function (...arguments_) {
        // This watcher belongs to rag_params (__dirname is a regular Node path).
        return drainEvents.apply(this, arguments_).map(event => ({ ...event, path: typeof event.path === 'string'
          ? event.path.replace(/^\\\\\?\\UNC\\/u, '\\\\').replace(/^\\\\\?\\/u, '') : event.path }));
      };
    }

    // VCP reads some settings at module evaluation and dimensions directly per request.
    // Keep the upstream files untouched and isolate these globals to this process.
    for (const key of Object.keys(process.env)) {
      if (/^(?:KNOWLEDGEBASE_|TAGMEMO_|EmbeddingModelBackup|TDB_KNOWLEDGE_|LANG_|IGNORE_|TAG_BLACKLIST|AIMemo|AIMEMO_)/u.test(key)) delete process.env[key];
    }
    Object.assign(process.env, {
      API_URL: this.embedding.apiUrl, API_Key: this.embedding.apiKey,
      WhitelistEmbeddingModel: this.embedding.model, EmbeddingModelSig: this.embedding.modelSignature,
      VECTORDB_DIMENSION: String(this.embedding.dimension), EMBEDDING_SEND_DIMENSIONS: 'true',
      DAILY_NOTE_EXTENSION: 'md', DAILY_NOTE_FUZZY_DIFF: 'false', TagMaster: 'false',
      EMBEDDING_AUDIT_LOG_ENABLED: 'false', WhitelistEmbeddingModelMaxToken: '8000',
      // Node's fs handles long Windows paths internally, but upstream passes this
      // store path straight to SQLite and Rust/TDB. Preserve its extended-length
      // namespace for every native database, vector index and backup derived here.
      KNOWLEDGEBASE_ROOT_PATH: this.notesRoot, KNOWLEDGEBASE_STORE_PATH: path.toNamespacedPath(path.join(this.scopeRoot, 'store')),
      PROJECT_BASE_PATH: this.runtimeRoot,
      KNOWLEDGEBASE_FULL_SCAN_ON_STARTUP: 'false', KNOWLEDGEBASE_BATCH_WINDOW_MS: '10',
      KNOWLEDGEBASE_DELETE_BATCH_WINDOW_MS: '10', KNOWLEDGEBASE_NATIVE_RIVER_QUERY_FALLBACK_TO_LEGACY: 'false',
      IGNORE_FOLDERS: '', IGNORE_PREFIXES: '已整理', IGNORE_SUFFIXES: '',
    });
    this.kb = require(path.join(this.runtimeRoot, 'KnowledgeBaseManager.js'));
    this.getEmbeddingsBatch = require(path.join(this.runtimeRoot, 'EmbeddingUtils.js')).getEmbeddingsBatch;
    this.chunkText = require(path.join(this.runtimeRoot, 'TextChunker.js')).chunkText;
    await this.kb.initialize();
    const { VcpMemoryPeripherals } = require('./peripherals.cjs');
    this.peripherals = new VcpMemoryPeripherals(this, configuration.plugins || {});
    const rawIndexed = await this.kb.nativeKnowledgeRuntime.listIndexedFilePaths(this.kb.dbPath);
    const indexed = new Set((typeof rawIndexed === 'string' ? JSON.parse(rawIndexed) : rawIndexed).map(file => String(typeof file === 'string' ? file : file.path).replaceAll('\\', '/')));
    // Records are a host provenance journal. Replay unfinished writes/deletions using
    // the upstream file coordinator, ingestion pipeline and Rust commits.
    for (const file of await fs.readdir(this.recordsRoot)) {
      if (!file.endsWith('.json')) continue;
      const record = await jsonOrNull(path.join(this.recordsRoot, file));
      if (!record) continue;
      if (typeof record.rawPath === 'string') {
        const target = path.resolve(this.notesRoot, record.rawPath);
        if (!target.startsWith(this.notesRoot + path.sep)) throw failure('VCP_MEMORY_UNSAFE_SOURCE', 'Memory journal contains an unsafe source path.');
        this.bindNotePath(record.id, target);
      }
      if (record.deleted) await this.removeRecordNote(record.id);
      else {
        const note = normalizeNote(record);
        const recordedAt = record.recordedAt || new Date().toISOString();
        if (record.indexState === 'indexed' && !record.obsoleteRawPaths?.length && this.notePaths.has(note.id)
          && path.basename(path.dirname(this.paths(note.id).note)) === notebookFolder(note.diaryName)
          && indexed.has(path.relative(this.notesRoot, this.paths(note.id).note).replaceAll('\\', '/'))) {
          this.records.set(note.id, record); continue;
        }
        await this.remember(note, recordedAt);
      }
    }
    return { ready: true, scopeId, dimension: this.embedding.dimension };
  }

  requireReady() { if (!this.kb || this.closed) throw failure('VCP_MEMORY_CLOSED', 'Memory process is not available.'); }
  paths(id) {
    const key = digest(identity(id, 'memory ID'));
    return { record: path.join(this.recordsRoot, `${key}.json`), note: this.notePaths.get(id) || path.join(this.notesRoot, 'memories', `${key}.md`) };
  }
  sourcePath(relative) {
    if (typeof relative !== 'string' || path.isAbsolute(relative)) throw failure('VCP_MEMORY_UNSAFE_SOURCE', 'Unsafe memory source path.');
    const target = path.resolve(this.notesRoot, relative), inside = path.relative(this.notesRoot, target);
    if (!inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) throw failure('VCP_MEMORY_UNSAFE_SOURCE', 'Memory source is outside its physical scope.');
    return target;
  }
  async removeSources(files) {
    if (!files.length) return;
    await this.kb.databaseCoordinator.runExternalFileMutation('WorldlineBox.forget', async () => {
      for (const file of files) await fs.rm(file, { force: true });
      return { status: 'success', mutationPaths: { deletes: files } };
    }, { waitForIndex: true, timeoutMs: 120000 });
    this.artifactsDirty = true;
  }
  async writeRecordNote(note, recordedAt) {
    const { day, time, key, folder, content, tags, text } = formattedNativeDiary(note, recordedAt);
    if (!this.notePaths.has(note.id)) this.bindNotePath(note.id, path.join(this.notesRoot, folder, `${day}-${time.replaceAll(':', '_')}-${key}.md`));
    const files = this.paths(note.id);
    // DailyNote.update searches exact text rather than an ID. A stable host ID
    // anchor makes identical diary bodies safe to update independently.
    let previous;
    try { previous = await fs.readFile(files.note, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous !== undefined && !previous.includes(`<!-- WorldlineBoxMemory:${key} -->`)) throw failure('VCP_MEMORY_SOURCE_ID_MISMATCH', 'The diary no longer contains its host memory ID anchor.');
    if (previous === text) {
      await this.kb.databaseCoordinator.awaitIndexedFilePaths([files.note], { timeoutMs: 120000 });
      return;
    }
    const response = await this.peripherals.call('DailyNote', previous === undefined
      ? { command: 'create', folder, maid: note.author || 'WorldlineBox', Date: day, fileName: key,
        // Upstream removes one trailing Tag line when external Tag is present.
        // Give it our own suffix so a literal final Tag in note.content survives.
        Content: `${content}\nTag: ${tags.join(', ')}`, Tag: tags.join(', ') }
      : { command: 'update', folder, maid: note.author || 'WorldlineBox', target: previous, replace: text });
    if (response.result?.status !== 'success') throw failure('VCP_MEMORY_DIARY_WRITE_FAILED', String(response.result?.error || 'DailyNote rejected the memory write.'));
    const actualPath = path.join(this.notesRoot, response.result.result.folder, response.result.result.fileName);
    if (path.resolve(actualPath) !== path.resolve(files.note)) throw failure('VCP_MEMORY_DIARY_ID_CONFLICT', 'DailyNote changed an unexpected memory source file.');
    if (previous !== undefined && previous !== text) this.artifactsDirty = true;
  }
  async remember(input, restoredAt) {
    this.requireReady();
    const note = normalizeNote(input);
    // A failed write can already have changed upstream files. Revoke focused
    // answers before the first mutation, including additions to a stable scope.
    this.peripherals.invalidateCorpus();
    const previousRecord = await jsonOrNull(this.paths(note.id).record);
    const recordedAt = previousRecord?.recordedAt || restoredAt || new Date().toISOString();
    const previousPath = this.notePaths.get(note.id);
    // Persist the deterministic intended path before invoking the upstream writer,
    // so a crash after create can replay as update without creating a duplicate.
    {
      const date = new Date(note.occurredAt || recordedAt);
      const timeZone = note.hostProjection?.timeZone || 'Asia/Shanghai';
      const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
      const time = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
      this.bindNotePath(note.id, path.join(this.notesRoot, notebookFolder(note.diaryName), `${day}-${time.replaceAll(':', '_')}-${digest(note.id)}.md`));
    }
    const rawPath = path.relative(this.notesRoot, this.paths(note.id).note);
    const obsoleteRawPaths = [...new Set([...(previousRecord?.obsoleteRawPaths || []), ...(previousPath && previousPath !== this.paths(note.id).note ? [path.relative(this.notesRoot, previousPath)] : [])])].filter(relative => relative !== rawPath);
    await atomicJson(this.paths(note.id).record, { ...note, recordedAt, rawPath, obsoleteRawPaths, indexState: 'pending' });
    await this.removeSources(obsoleteRawPaths.map(relative => this.sourcePath(relative)));
    await this.writeRecordNote(note, recordedAt);
    const committed = { ...note, recordedAt, rawPath, indexState: 'indexed' };
    await atomicJson(this.paths(note.id).record, committed); this.records.set(note.id, committed);
    return { id: note.id, indexed: true };
  }
  async replace(inputs) {
    this.requireReady();
    if (!Array.isArray(inputs)) throw failure('VCP_MEMORY_INVALID_INPUT', 'Snapshot notes must be an array.');
    const notes = inputs.map(normalizeNote);
    const next = new Map(notes.map(note => [note.id, note]));
    if (next.size !== notes.length) throw failure('VCP_MEMORY_INVALID_INPUT', 'Snapshot contains duplicate memory IDs.');
    // Publish removals first: a snapshot replacement must never leave revoked
    // source documents participating in the physical scope's graph.
    for (const id of this.records.keys()) if (!next.has(id)) await this.forget(id);
    for (const note of notes) if (this.records.get(note.id)?.noteFingerprint !== fingerprintNote(note)) await this.remember(note);
    return { replaced: true, count: notes.length };
  }
  async applyProjectionDelta(inputs, removedIds) {
    this.requireReady();
    if (!Array.isArray(inputs) || !Array.isArray(removedIds)) throw failure('VCP_MEMORY_INVALID_INPUT', 'Projection delta must contain complete changed notes and removal IDs.');
    const notes = inputs.map(normalizeNote), removed = new Set(removedIds.map(id => identity(id, 'memory ID')));
    if (new Set(notes.map(note => note.id)).size !== notes.length || notes.some(note => removed.has(note.id))) throw failure('VCP_MEMORY_INVALID_INPUT', 'Projection delta has conflicting identities.');
    // Preserve the exact original replace() mutation order: existing records
    // retire in their original catalogue order; changed SQL snapshot notes are
    // applied in binary ID order. Upstream ingestion/graph maths stay intact.
    if (removed.size) for (const id of this.records.keys()) if (removed.has(id)) await this.forget(id);
    for (const note of notes.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      if (this.records.get(note.id)?.noteFingerprint !== fingerprintNote(note)) await this.remember(note);
    return { changed: notes.length, removed: removed.size };
  }
  async read(id) {
    this.requireReady();
    const record = await this.records.read(id);
    if (record?.indexState === 'indexed' && !record.deleted) return normalizeNote(record);
    if (!record && id.startsWith('vcp:')) return (await this.exportNotes()).find(note => note.id === id) || null;
    return null;
  }
  async list() {
    this.requireReady();
    const records = [];
    for (const [id, descriptor] of this.records) if (descriptor.indexState === 'indexed' && !descriptor.deleted) {
      const record = await this.records.read(id);
      if (record) records.push(normalizeNote(record));
    }
    return records.sort((left, right) => left.id.localeCompare(right.id));
  }
  async removeRecordNote(id) {
    const files = this.paths(id);
    const record = await jsonOrNull(files.record);
    await this.removeSources([...new Set([files.note, ...(record?.obsoleteRawPaths || []).map(relative => this.sourcePath(relative))])]);
    this.records.delete(id); this.unbindNotePath(id);
  }
  async forget(id) {
    this.requireReady();
    this.peripherals.invalidateCorpus();
    if (!this.notePaths.has(id) && id.startsWith('vcp:')) {
      const note = (await this.exportNotes()).find(candidate => candidate.id === id);
      if (note?.metadata?.vcpSourceFile) this.bindNotePath(id, path.resolve(this.notesRoot, note.metadata.vcpSourceFile));
    }
    const record = await jsonOrNull(this.paths(id).record);
    await atomicJson(this.paths(id).record, { id, rawPath: path.relative(this.notesRoot, this.paths(id).note), obsoleteRawPaths: record?.obsoleteRawPaths, deleted: true });
    await this.removeRecordNote(id);
    return { id, deleted: true };
  }
  async exportNotes() {
    this.requireReady();
    const records = await this.list();
    for (const note of records) {
      const stored = this.records.get(note.id);
      note.author ||= 'WorldlineBox';
      note.occurredAt ||= stored?.recordedAt;
      note.metadata = { ...note.metadata, vcpSourceFile: path.relative(this.notesRoot, this.paths(note.id).note).replaceAll('\\', '/') };
    }
    const ownFiles = new Set(records.map(note => path.basename(this.paths(note.id).note)));
    const raw = await this.kb.nativeKnowledgeRuntime.listIndexedFilePaths(this.kb.dbPath);
    const indexedPaths = typeof raw === 'string' ? JSON.parse(raw) : raw;
    for (const item of indexedPaths || []) {
      const relative = typeof item === 'string' ? item : item.path;
      if (!relative || /timeline(?:\/|\\)/iu.test(relative) || ownFiles.has(path.basename(relative))) continue;
      if (/^[^\\/]+[\\/].*[a-f0-9]{64}\.md$/u.test(relative)) continue;
      const target = path.resolve(this.notesRoot, relative);
      if (!target.startsWith(this.notesRoot + path.sep)) throw failure('VCP_MEMORY_UNSAFE_SOURCE', 'Indexed memory path is outside the scope.');
      let content;
      try { content = await fs.readFile(target, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const header = content.match(/^\[(\d{4}-\d{2}-\d{2})\]\s*-\s*(.+)$/mu);
      records.push({ id: `vcp:${relative.replaceAll('\\', '/')}`, content,
        tags: this.kb._extractTags(content), diaryName: relative.split(/[\\/]/u)[0], author: header?.[2], occurredAt: header ? `${header[1]}T12:00:00+08:00` : undefined,
        metadata: { vcpSourceFile: relative.replaceAll('\\', '/') } });
    }
    return records.sort((left, right) => left.id.localeCompare(right.id));
  }
  async reconcilePluginMutations(paths) {
    const deleted = new Set(paths.deletes.map(file => path.resolve(file)));
    const changed = new Set(paths.upserts.map(file => path.resolve(file)));
    for (const file of new Set([...deleted, ...changed])) {
      const id = this.sourceIds.get(this.sourceKey(file)); if (!id) continue;
      const recordPath = this.paths(id).record;
      const record = await jsonOrNull(recordPath);
      // A pending journal belongs to remember() itself, which commits its exact
      // host note after the upstream request completes.
      if (record?.indexState !== 'indexed' || record.deleted) continue;
      if (deleted.has(file)) {
        await atomicJson(recordPath, { id, rawPath: path.relative(this.notesRoot, file), deleted: true });
        this.records.delete(id); this.unbindNotePath(id);
        continue;
      }
      const content = await fs.readFile(file, 'utf8');
      const body = content.replace(/^\s*\[\d{4}-\d{2}-\d{2}\]\s*-\s*[^\r\n]+\r?\n/u, '')
        .replace(/^\[\d{1,2}:\d{2}(?::\d{2})?\]\s*\r?\n/u, '')
        .replace(`<!-- WorldlineBoxMemory:${digest(id)} -->`, '')
        .replace(/(?:\r?\n\s*Tag:[^\r\n]*)+\s*$/iu, '').trim();
      const updated = { ...record, content: body, tags: this.kb._extractTags(content) };
      await atomicJson(recordPath, updated); this.records.set(id, updated);
    }
  }
  async prepare() {
    this.requireReady();
    await this.peripherals.load('RAGDiaryPlugin');
    const timeline = await this.peripherals.load('VCPTimeLine');
    await this.peripherals.validateTimelines(timeline);
    if ((await this.kb.listDistinctDiaries()).length) await this.ensureArtifacts();
    return { ready: true, corpusEpoch: this.peripherals.corpusEpoch };
  }
  async search(input) {
    this.requireReady();
    const text = memoryText(input?.text, 'memory query', 16000);
    const topK = input.topK ?? 8;
    if (!Number.isInteger(topK) || topK < 1 || topK > 100) throw failure('VCP_MEMORY_INVALID_INPUT', 'topK must be between 1 and 100.');
    await this.peripherals.validateExistingTimelines();
    // Computed timelines have their own original injection path. They cannot
    // replace authoritative source notes in the native source-hit/citation page.
    const diaryNames = (await this.kb.listDistinctDiaries()).filter(folder => !/timeline$/iu.test(folder));
    if (!diaryNames.length) return { results: [], diagnostics: { reason: 'empty-scope' }, degraded: false };
    const vector = await this.queryEmbedding(text);
    // Ensure the existing upstream publisher has a current artifact before River
    // queries. This is upstream geometry/graph computation, not a host algorithm.
    await this.ensureArtifacts();
    const result = await this.kb.withMemoObservationScope(() => this.kb.executeNativeRiverQuery(
      { text, vector }, { diaryNames, topK, fallbackToLegacy: false, includeTrace: true }));
    if (this.peripherals.observedCalls) this.peripherals.observedCalls.river = (this.peripherals.observedCalls.river || 0) + 1;
    const seen = new Set();
    const results = [];
    const traceHits = [];
    for (const [index, hit] of (result.results || []).entries()) {
      const sourceFile = String(hit.fullPath || hit.sourceFile || '').replaceAll('\\', '/');
      const id = this.fileIds.get(path.basename(sourceFile));
      if (id && seen.has(id)) continue;
      const cached = this.records.get(id);
      let record = cached ? await this.read(id) : undefined;
      if (!record && /^[^/]+\/.*[a-f0-9]{64}\.md$/u.test(sourceFile)) continue;
      if (!record) record = { id: `vcp:${sourceFile}`, content: String(hit.text || ''), tags: hit.matchedTags || [], metadata: { vcpDiaryName: hit.diaryName } };
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      const scoreDetails = projectNativeScoreDetails(hit, result, index + 1);
      results.push({ ...record, ...(scoreDetails.finalScore !== undefined ? { score: scoreDetails.finalScore } : {}), sourceFile,
        engine: scoreDetails.engine, scoreDetails });
      const anchor = {};
      for (const key of ['contactedSeeds', 'exactContacts', 'semanticContacts', 'anchorReliability', 'meanClosure']) {
        const value = hit.topologyV3?.[key]; if (typeof value === 'number' && Number.isFinite(value)) anchor[key] = value;
      }
      traceHits.push({ id: record.id, rank: scoreDetails.nativeRank || scoreDetails.rank,
        ...(cached ? { sourcePath: this.paths(record.id).note } : {}),
        ...(typeof hit.text === 'string' ? { text: hit.text.slice(0, 300) } : {}), matchedTags: scoreDetails.matchedTags || [], coreTagsMatched: scoreDetails.coreTagsMatched || [],
        ...(Object.keys(anchor).length ? { anchor } : {}) });
    }
    const counts = {}, diagnostics = { ...result.diagnostics, hostBehavior: this.behavior, queryEncoding: this.lastQueryEncoding }, native = diagnostics.nativeTopologyV3 || {};
    for (const key of ['offeredCandidates', 'projectedCandidates', 'selectedCandidates', 'rankedCandidates', 'returnedCandidates', 'artifactNodes', 'artifactEdges']) {
      if (Number.isSafeInteger(native[key]) && native[key] >= 0) counts[key] = native[key];
    }
    const tags = values => Array.isArray(values) ? values.filter(value => typeof value === 'string' && value.length <= 1024).slice(0, 50) : [];
    return { results, diagnostics, degraded: diagnostics.degraded === true,
      retrieval: { embeddingDimension: vector.length, diaryCount: diaryNames.length, matchedTags: tags(result.queryTags?.matchedTags),
        coreTagsMatched: tags(result.queryTags?.coreTagsMatched), counts, hits: traceHits } };
  }
  async queryEmbedding(text) {
    // Reuse the original RAG encoder, including TextChunker, its token-estimate
    // weights and VectorMathUtils weighted average. Direct EmbeddingUtils calls
    // skip a legal high-token query instead of splitting it. The upstream
    // single-chunk path returns that exact vector without averaging or scaling.
    const rag = await this.peripherals.load('RAGDiaryPlugin');
    const chunks = this.chunkText(text.trim());
    const vectors = await this.getEmbeddingsBatch(chunks, { ...this.embedding, apiUrl: this.embedding.queryApiUrl || this.embedding.apiUrl });
    if (vectors?.length !== chunks.length || !chunks.length || vectors.some(vector => !vector || vector.length !== this.embedding.dimension || Array.from(vector).some(value => !Number.isFinite(value))))
      throw failure('VCP_MEMORY_EMBEDDING_RESPONSE_INVALID', 'The embedding service returned an invalid query vector.');
    const weights = chunks.map(chunk => Math.max(1, rag._estimateTokens(chunk)));
    const vector = rag._getWeightedAverageVector(vectors, weights);
    this.lastQueryEncoding = { inputCharacters: text.length, chunkCount: chunks.length, aggregation: chunks.length === 1 ? 'unchanged_single_vector' : 'upstream_token_weighted_average',
      complete: true };
    if (!vector || vector.length !== this.embedding.dimension || Array.from(vector).some(value => !Number.isFinite(value))) throw failure('VCP_MEMORY_EMBEDDING_RESPONSE_INVALID', 'The embedding service returned an invalid query vector.');
    return vector;
  }
  async ensureArtifacts() {
    const artifact = this.kb.riverMemoEngine?.getArtifactSnapshot?.({ buildIfMissing: false });
    if (this.artifactsDirty || !artifact || (!artifact.nodeCount && (await this.kb.listDistinctDiaries()).length)) {
      const deadline = Date.now() + 120000;
      while (this.kb.tagMemoEngine._isMatrixRebuilding) {
        if (Date.now() > deadline) throw failure('VCP_MEMORY_DERIVED_TIMEOUT', 'Memory graph publication timed out.');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (!await this.kb.tagMemoEngine.doMatrixRebuild({ reason: 'WorldlineBox.query' })) throw failure('VCP_MEMORY_DERIVED_FAILED', 'Memory graph publication failed.');
      this.artifactsDirty = false;
    }
  }
  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const errors = [];
      try { await this.peripherals?.close(); } catch (error) { errors.push(error); }
      try { await this.kb?.shutdown(); } catch (error) { errors.push(error); }
      this.kb = null;
      this.records.clear(); this.notePaths.clear(); this.sourceIds.clear(); this.fileIds.clear();
      // Unlink only our validated link itself, including when shutdown failed.
      // Interrupted workers are also protected by the parent's non-following
      // purge traversal; they cannot execute this finally path after a hard kill.
      for (const link of this.dependencyLinks) {
        try { await unlinkRuntimeDependency(this.runtimeRoot, link.target, link.source); } catch (error) { errors.push(error); }
      }
      this.dependencyBinding?.deregister(); this.dependencyBinding = null;
      if (this.cwdRoot) {
        process.chdir(tmpdir());
        try { await fs.rmdir(this.cwdRoot); this.cwdRoot = null; } catch (error) { errors.push(error); }
      }
      if (errors.length) throw errors[0];
    })();
    return this.closing;
  }
}

module.exports = { VcpMemoryRuntime, embeddingConfiguration, normalizeNote, renderNativeDiaryText, projectNativeScoreDetails, notebookFolder, unlinkRuntimeDependency, removeOwnedDirectory, bindRuntimeDependencies };

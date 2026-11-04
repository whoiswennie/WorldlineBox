'use strict';
// Filesystem and lifecycle adapter for the ORIGINAL VCPChat central memory
// engine. SQLite/Tantivy queries and DeepMemo/TopicMemo formatting stay upstream.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'upstream', 'chat');
const { ChatDataServiceLifecycle } = require('../upstream/chat/modules/services/chatDataService/lifecycle.js');
const { TelemetryCollector, snapshot } = require('./telemetry.cjs');

function attachCdsTrace(collector, client) {
  for (const method of ['searchMemories','searchMessages','reconcile','flush','status','ingestHistoryPath','rebuildSearchIndex']) collector.wrap(client, method, {
    stage: `cds.${method}`, source: `upstream/chat/modules/services/chatDataService/client.js#${method}`,
    input: ['searchMemories','searchMessages','ingestHistoryPath'].includes(method) ? args => snapshot(args[0]) : undefined,
  });
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function writeIfChanged(file, value) {
  const content = JSON.stringify(value, null, 2) + '\n';
  try { if (await fsp.readFile(file, 'utf8') === content) return false; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try { await fsp.writeFile(temporary, content, { flag: 'wx' }); await fsp.rename(temporary, file); }
  finally { await fsp.rm(temporary, { force: true }); }
  return true;
}
async function directories(directory) {
  try { return (await fsp.readdir(directory, { withFileTypes: true })).filter(item => item.isDirectory() && !item.isSymbolicLink()); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
const decode = value => decodeURIComponent(value.slice(3));
function safeIdentity(value) {
  if (typeof value !== 'string' || !value || /[\0/\\]/.test(value)) throw new TypeError('Invalid chat identity');
  return 'id-' + encodeURIComponent(value).replace(/\./g, '%2E');
}

class ChatMemory {
  constructor({ home, config = {}, logger = console }) {
    if (!home) throw new TypeError('ChatMemory requires home');
    this.home = path.resolve(home);
    this.config = config;
    this.logger = logger;
    this.root = path.join(this.home, 'chat');
    this.appData = path.join(this.root, 'AppData');
    this.mirrorManifest = path.join(this.root, 'session-mirror.json');
    this.owners = [];
    this.ownerConfigs = new Map();
    this.topicIndexes = new Map();
    this.ownerTopicIds = new Map();
    this.pendingHistories = new Set();
    this.pendingCatalogs = new Set();
    this.reconcileNeeded = true;
    this.lifecycle = new ChatDataServiceLifecycle({ appDataPath: this.appData,
      binaryPath: config.CDS_BINARY_PATH || undefined, notifyEnabled: false, tantivyEnabled: true, logger });
    this.facade = { get client() { return null; } };
    Object.defineProperty(this.facade, 'client', { get: () => this.lifecycle.client ? {
      searchMemories: (request, options) => { this._attachTrace(); return this._withBusyRetry(() => this.lifecycle.client.searchMemories(request, options)); },
    } : null });
    this.telemetry = new TelemetryCollector();
    for (const method of ['start','mirrorSessions','sync','callTool','_topicMemo','searchMessages','status','close']) this.telemetry.wrap(this, method, {
      stage: `chat-host.${method}`, source: `lib/chat-memory.cjs#${method}`, output: false,
      input: method === 'callTool' ? args => ({ name: args[0], args: args[1] }) : undefined,
    });
  }

  startTrace(options = {}) { this.telemetry.start(options); this._attachTrace(); }

  finishTrace() {
    return { ...this.telemetry.finish(), family: 'vcpchat-cds',
      sourceLimitations: { nativeInternalTimings: null, postRerankWindows: null,
        reason: 'Original CDS returns windows.score and order without internal timings. DeepMemo private rerankWindows does not expose its final window array; external HTTP response scores are captured separately when called.' } };
  }

  _attachTrace() {
    attachCdsTrace(this.telemetry, this.lifecycle.client);
    if (this.deepMemo) this.telemetry.wrap(this.deepMemo, 'processToolCall', {
      stage: 'chat.DeepMemo.processToolCall', source: 'upstream/chat/VCPDistributedServer/Plugin/DeepMemo/DeepMemoService.js#processToolCall',
      input: args => snapshot({ args: args[0], executionContext: args[1] }),
    });
    const axios = require('axios');
    this.telemetry.wrap(axios, 'post', {
      stage: 'deepmemo.external-rerank-http',
      source: 'upstream/chat/VCPDistributedServer/Plugin/DeepMemo/DeepMemoService.js#rerankWindows/axios.post',
      when: (args, parent) => parent?.stage === 'chat.DeepMemo.processToolCall' && /\/v1\/rerank$/.test(String(args[0])),
      input: args => ({ endpoint: args[0], body: snapshot(args[1]) }),
      output: response => response?.data,
    });
  }

  async _withBusyRetry(operation) {
    const deadline = Date.now() + (Number(this.config.CDS_BUSY_TIMEOUT_MS) || 30000);
    let attempt = 0;
    while (true) {
      try { return await operation(); }
      catch (error) {
        if (error.code !== 'SERVICE_BUSY' || error.retryable !== true || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(1000, 25 * 2 ** Math.min(attempt++, 5))));
      }
    }
  }

  async start() {
    for (const directory of ['Agents', 'AgentGroups', 'UserData']) await fsp.mkdir(path.join(this.appData, directory), { recursive: true });
    await this.mirrorSessions();
    await this.lifecycle.start();
    this.deepMemo = require('../upstream/chat/VCPDistributedServer/Plugin/DeepMemo/DeepMemoService.js');
    this.deepMemo.initialize({ chatDataService: this.facade, logger: this.logger,
      config: { ...process.env, ...this.config, DeepMemoBackend: 'central', DeepMemoLegacyFallback: false } });
    this._attachTrace();
    return this;
  }

  markDirty() { this.mirrorDirty = true; }
  markTopicsDirty(itemId, topicIds) {
    if (!topicIds.length) return;
    this.dirtyTopics ||= new Map();
    const topics = this.dirtyTopics.get(itemId) || new Set();
    for (const id of topicIds) topics.add(id);
    this.dirtyTopics.set(itemId, topics);
  }

  async mirrorDirtyTopics() {
    if (!this.dirtyTopics?.size) return;
    const manifest = this.mirrorState || await readJson(this.mirrorManifest, { files: [], owners: [] });
    const files = this.mirrorFiles || new Set(manifest.files);
    const owners = manifest.owners;
    let manifestChanged = this.manifestWritePending === true;
    this.mirrorState = manifest; this.mirrorFiles = files;
    for (const [itemId, topicIds] of this.dirtyTopics) {
      // ContextStore encodes each path component, so raw model paths never
      // become filesystem locations. This is the same source mapping as the
      // original full mirror above.
      const encoded = 'id-' + encodeURIComponent(itemId).replace(/\./g, '%2E');
      const storageId = 'agent-' + encoded;
      const configRelative = path.join('Agents', storageId, 'config.json');
      const config = this.ownerConfigs.get(storageId) || await readJson(path.join(this.appData, configRelative), { id: storageId, name: itemId, topics: [], memoryOriginalOwnerId: itemId, memoryOwnerType: 'agent' });
      const indexes = this.topicIndexes.get(storageId) || new Map(config.topics.map((topic, index) => [topic.id, index]));
      this.topicIndexes.set(storageId, indexes); this.ownerConfigs.set(storageId, config);
      let configChanged = false;
      let owner = owners.find(entry => entry.itemId === itemId && entry.type === 'agent');
      if (!owner) { owner = { itemId, type: 'agent', storageId, name: itemId, topics: [] }; owners.push(owner); manifestChanged = this.manifestWritePending = true; }
      const ownerTopics = this.ownerTopicIds.get(storageId) || new Set(owner.topics.map(topic => topic.topicId)); this.ownerTopicIds.set(storageId, ownerTopics);
      for (const topicId of topicIds) {
        const encodedTopic = 'id-' + encodeURIComponent(topicId).replace(/\./g, '%2E');
        const source = path.join(this.home, 'sessions', 'agent', encoded, encodedTopic, 'history.json');
        const history = await readJson(source, []);
        const relative = path.join('UserData', storageId, 'topics', encodedTopic, 'history.json');
        const target = path.join(this.appData, relative);
        await writeIfChanged(target, history); this.pendingHistories.add(target);
        if (!files.has(relative)) { files.add(relative); manifestChanged = this.manifestWritePending = true; }
        const topic = { id: encodedTopic, name: topicId, createdAt: Number(history[0]?.timestamp) || 0, memoryOriginalTopicId: topicId };
        const index = indexes.get(encodedTopic);
        if (index === undefined) { indexes.set(encodedTopic, config.topics.length); config.topics.push(topic); configChanged = true; this.pendingCatalogs.add(storageId); }
        else if (JSON.stringify(config.topics[index]) !== JSON.stringify(topic)) { config.topics[index] = topic; configChanged = true; this.pendingCatalogs.add(storageId); }
        if (!ownerTopics.has(topicId)) { owner.topics.push({ topicId, storageId: encodedTopic }); ownerTopics.add(topicId); manifestChanged = this.manifestWritePending = true; }
      }
      if (configChanged || this.pendingCatalogs.has(storageId)) { await writeIfChanged(path.join(this.appData, configRelative), config); this.pendingCatalogs.delete(storageId); }
      if (!files.has(configRelative)) { files.add(configRelative); manifestChanged = this.manifestWritePending = true; }
    }
    if (manifestChanged) { manifest.files = [...files]; await writeIfChanged(this.mirrorManifest, { version: 1, files: manifest.files, owners }); this.manifestWritePending = false; }
    this.mirrorState = manifest; this.mirrorFiles = files;
    this.owners = owners; this.dirtyTopics.clear();
  }

  async mirrorSessions() {
    const previous = await readJson(this.mirrorManifest, { files: [], owners: [] });
    const files = [];
    const owners = [];
    this.ownerConfigs.clear(); this.topicIndexes.clear(); this.ownerTopicIds.clear(); this.pendingCatalogs.clear();
    let histories = 0;
    for (const type of ['agent', 'group']) {
      for (const owner of await directories(path.join(this.home, 'sessions', type))) {
        if (!owner.name.startsWith('id-')) continue;
        const itemId = decode(owner.name);
        const storageId = `${type}-${owner.name}`;
        const ownerDir = path.join(this.home, 'sessions', type, owner.name);
        const topics = [];
        for (const topic of await directories(ownerDir)) {
          if (!topic.name.startsWith('id-')) continue;
          const topicId = decode(topic.name);
          const source = path.join(ownerDir, topic.name, 'history.json');
          if (!fs.existsSync(source)) continue;
          const history = await readJson(source, []);
          if (!Array.isArray(history)) throw new TypeError(`Session history is not an array: ${source}`);
          const metadata = await readJson(path.join(ownerDir, topic.name, 'sidechat-metadata.json'), null);
          const createdAt = Number(history.find(message => Number.isFinite(Number(message.timestamp)))?.timestamp) || 0;
          topics.push({ id: topic.name, name: metadata?.title || metadata?.branchTitle || topicId, createdAt,
            memoryOriginalTopicId: topicId, ...(metadata ? { sideChat: metadata } : {}) });
          const relative = path.join('UserData', storageId, 'topics', topic.name, 'history.json');
          await writeIfChanged(path.join(this.appData, relative), history);
          files.push(relative); histories++;
        }
        const relative = path.join(type === 'agent' ? 'Agents' : 'AgentGroups', storageId, 'config.json');
        const ownerConfig = { id: storageId, name: itemId, topics, memoryOriginalOwnerId: itemId, memoryOwnerType: type };
        await writeIfChanged(path.join(this.appData, relative), ownerConfig);
        this.ownerConfigs.set(storageId, ownerConfig);
        this.topicIndexes.set(storageId, new Map(topics.map((topic,index) => [topic.id,index])));
        this.ownerTopicIds.set(storageId, new Set(topics.map(topic => topic.memoryOriginalTopicId)));
        files.push(relative);
        owners.push({ itemId, type, storageId, name: itemId, topics: topics.map(topic => ({ topicId: topic.memoryOriginalTopicId, storageId: topic.id })) });
      }
    }
    // Remove only stale adapter-owned files recorded by the previous manifest.
    // No recursive directory operations or source session modifications.
    const present = new Set(files);
    for (const old of previous.files || []) {
      if (present.has(old)) continue;
      const absolute = path.resolve(this.appData, old);
      if (!absolute.startsWith(this.appData + path.sep)) throw new Error('Invalid chat mirror path');
      await fsp.rm(absolute, { force: true });
    }
    await writeIfChanged(path.join(this.appData, 'settings.json'), { userName: this.config.USER_NAME || this.config.ONERING_USER_NAME || 'User' });
    await writeIfChanged(this.mirrorManifest, { version: 1, files, owners });
    this.owners = owners;
    this.mirrorState = { version: 1, files, owners }; this.mirrorFiles = new Set(files);
    this.manifestWritePending = false;
    this.reconcileNeeded = true;
    this.mirrorDirty = false;
    return { owners: owners.length, histories };
  }

  async sync() {
    if (!this.lifecycle.client) await this.start();
    else if (this.mirrorDirty !== false) await this.mirrorSessions();
    await this.mirrorDirtyTopics();
    this._attachTrace();
    const client = this.lifecycle.client;
    // This managed home has no external writer and the original CDS watcher is
    // disabled. A native status request counts the entire messages table; doing
    // that twice for every unchanged query made hot reads linear in all history.
    // A changed client generation or known source mutation still requires an
    // acknowledged sync. Actual query errors remain errors, never cached results.
    if (!this.reconcileNeeded && this.syncedClient === client && !this.pendingHistories.size && !this.flushNeeded) {
      return { mirrored: this.owners.length, reconciliation: { mode: 'unchanged', histories: 0 }, status: this.lastSyncedStatus };
    }
    let reconciliation = { mode: 'unchanged', histories: 0 };
    // Original reconcile batches the search-index commit. Hundreds of original
    // ingestHistoryPath calls each commit Tantivy, so bulk backlog uses that
    // original batch API once; normal live updates still touch one episode.
    if (this.reconcileNeeded || this.syncedClient !== client || this.pendingHistories.size >= 16) {
      reconciliation = await this._withBusyRetry(() => client.reconcile());
      this.pendingHistories.clear(); this.reconcileNeeded = false; this.flushNeeded = true;
    } else if (this.pendingHistories.size) {
      let histories = 0;
      for (const filename of this.pendingHistories) {
        const receipt = await this._withBusyRetry(() => client.ingestHistoryPath(filename, 'worldlinebox-managed'));
        if (receipt.accepted !== true) throw new Error('CDS did not accept the changed original-history path');
        this.pendingHistories.delete(filename); histories++; this.flushNeeded = true;
      }
      reconciliation = { mode: 'incremental', histories };
    }
    if (this.flushNeeded) { await this._withBusyRetry(() => client.flush()); this.flushNeeded = false; }
    const status = await this._withBusyRetry(() => client.status()); this.syncedClient = client; this.lastSyncedStatus = status;
    return { mirrored: this.owners.length, reconciliation, status };
  }

  _owner(value, type = 'agent') {
    return this.owners.find(owner => owner.type === type && [owner.itemId, owner.storageId, owner.name].includes(value));
  }

  async callTool(name, rawArgs = {}, executionContext = {}) {
    if (!['DeepMemo', 'TopicMemo'].includes(name)) throw new Error(`Unsupported chat memory tool: ${name}`);
    await this.sync();
    const args = structuredClone(rawArgs);
    if (name === 'TopicMemo') {
      const owner = this._owner(args.maid);
      if (owner) args.maid = owner.name;
      const topicId = args.topic_id || args.topicId || args.TopicId;
      if (owner && topicId) args.topic_id = owner.topics.find(topic => [topic.topicId, topic.storageId].includes(topicId))?.storageId || topicId;
      delete args.topicId; delete args.TopicId;
      return this._topicMemo(args);
    }
    const context = structuredClone(executionContext);
    const trusted = context.vcpContext || context;
    const type = trusted.ownerType || args.owner?.type || 'agent';
    const owner = this._owner(trusted.agentId || trusted.ownerId || args.owner?.id || args.agentId || trusted.agentName || args.maid, type);
    if (owner) {
      if (trusted.agentId) trusted.agentId = owner.storageId;
      if (trusted.ownerId) trusted.ownerId = owner.storageId;
      if (args.agentId) args.agentId = owner.storageId;
      if (args.owner?.id) args.owner.id = owner.storageId;
      if (trusted.topicId) trusted.topicId = owner.topics.find(topic => [topic.topicId, topic.storageId].includes(trusted.topicId))?.storageId || trusted.topicId;
      if (trusted.currentTopicId) trusted.currentTopicId = owner.topics.find(topic => [topic.topicId, topic.storageId].includes(trusted.currentTopicId))?.storageId || trusted.currentTopicId;
    }
    return { status: 'success', result: await this.deepMemo.processToolCall(args, context) };
  }

  async _topicMemo(args) {
    if (!this.topicModule) {
      // Adapt only the stdio entry point; execute the preserved original
      // lookup/formatting functions without spawning Node for every read.
      const Module = require('node:module');
      const filename = path.join(SOURCE, 'VCPDistributedServer/Plugin/TopicMemo/TopicMemo.js');
      const source = await fsp.readFile(filename, 'utf8');
      if (!/main\(\);\s*$/.test(source)) throw new Error('Unsupported TopicMemo entry point');
      const loaded = new Module(filename, module);
      loaded.filename = filename; loaded.paths = Module._nodeModulePaths(ROOT);
      loaded._compile(source.replace(/main\(\);\s*$/, 'module.exports = { findAgentInfo, findUserName, listTopics, getTopicContent };'), filename);
      this.topicModule = loaded.exports;
    }
    const info = await this.topicModule.findAgentInfo(this.appData, args.maid);
    if (!info) throw new Error('Topic owner does not exist in this memory domain');
    const command = args.command || 'ListTopics';
    if (!['ListTopics', 'GetTopicContent'].includes(command)) throw new Error('Unsupported TopicMemo command');
    if (command === 'GetTopicContent' && !args.topic_id) throw new Error('topic_id is required');
    const result = command === 'ListTopics' ? await this.topicModule.listTopics(info)
      : await this.topicModule.getTopicContent(this.appData, info, args.topic_id, await this.topicModule.findUserName(this.appData));
    return { status: 'success', result };
  }

  async searchMessages(request) {
    await this.sync();
    return this._withBusyRetry(() => this.lifecycle.client.searchMessages(request));
  }

  async status() {
    return this.lifecycle.client ? this.lifecycle.client.status() : { status: 'stopped', appData: this.appData };
  }

  async close() { await this.lifecycle.stop(); }
}

module.exports = { ChatMemory, safeIdentity, writeIfChanged, attachCdsTrace };

/* global require, module, process, fetch */
'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { URL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');

const pluginFiles = { DailyNote: 'DailyNote/dailynote.js', DailyNoteManager: 'DailyNoteManager/daily-note-manager.js',
  LightMemo: 'LightMemo/LightMemo.js', RAGDiaryPlugin: 'RAGDiaryPlugin/RAGDiaryPlugin.js', VCPTimeLine: 'VCPTimeLine/VCPTimeLine.js' };

class VcpMemoryPeripherals {
  constructor(runtime, configuration) {
    this.runtime = runtime;
    this.configuration = configuration;
    this.plugins = new Map();
    this.events = [];
    this.dependenciesPath = path.join(runtime.scopeRoot, 'timeline-dependencies.json');
  }
  async queryEnvironment(operation) {
    const previous = process.env.API_URL;
    process.env.API_URL = this.runtime.embedding.queryApiUrl || this.runtime.embedding.apiUrl;
    try { return await operation(); } finally { process.env.API_URL = previous; }
  }
  async load(name) {
    if (this.plugins.has(name)) return this.plugins.get(name);
    if (!pluginFiles[name]) throw new Error('Unknown VCP memory plugin.');
    const plugin = require(path.join(this.runtime.runtimeRoot, 'Plugin', pluginFiles[name]));
    const config = { PROJECT_BASE_PATH: this.runtime.runtimeRoot };
    const dependencies = { knowledgeBaseManager: this.runtime.kb, vectorDBManager: this.runtime.kb };
    if (name === 'RAGDiaryPlugin') {
      // This is an upstream configuration switch: its formatted/raw query cache
      // has no source revision key. Embedding caches and all retrieval logic stay upstream.
      process.env.RAG_QUERY_CACHE_ENABLED = 'false';
      process.env.RAG_RIVER_THINKING_ENABLED = this.configuration.riverThinkingEnabled ? 'true' : 'false';
      if (this.configuration.chat) {
        const chat = this.configuration.chat;
        const url = new URL(chat.baseUrl);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid VCP chat endpoint.');
        Object.assign(process.env, { AIMemoModel: chat.model, AIMemoApi: chat.apiKey,
          AIMemoUrl: `${url.toString().replace(/\/+$/u, '').replace(/\/v1$/u, '')}/`,
          AIMemoBatch: '2', AIMemoMaxTokensPerBatch: '18000',
          AIMEMO_CACHE_MAX_SIZE: '32', AIMEMO_CACHE_TTL_MS: '60000' });
      }
      await this.queryEnvironment(() => plugin.initialize(config, { ...dependencies,
        vcpLogFunctions: { pushVcpInfo: event => this.events.push(event) } }));
    } else if (name === 'LightMemo') {
      const rag = await this.load('RAGDiaryPlugin');
      await plugin.initialize(config, { ...dependencies, getSingleEmbedding: text => this.runtime.queryEmbedding(text),
        aiMemoBridge: rag.getAIMemoBridge() });
    } else if (name === 'VCPTimeLine') {
      const rag = await this.load('RAGDiaryPlugin');
      await plugin.initialize(config, { contextBridge: rag.getContextBridge() });
      if (this.configuration.chat) {
        const chat = this.configuration.chat;
        const url = new URL(chat.baseUrl);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid timeline chat endpoint.');
        plugin.config.model = chat.model;
        // Only the HTTP transport changes. Upstream owns prompts, monthly
        // grouping, chunking, summary publication and timeline injection.
        plugin.callModel = async (systemPrompt, userPrompt, maxTokens = plugin.config.maxOutputTokens) => {
          const base = url.toString().replace(/\/+$/u, '').replace(/\/v1$/u, '');
          const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${chat.apiKey}` },
            body: JSON.stringify({ model: chat.model, stream: false, max_tokens: maxTokens,
              messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] }) });
          if (!response.ok) throw new Error(`Timeline chat model returned ${response.status}.`);
          const payload = await response.json();
          const content = payload?.choices?.[0]?.message?.content;
          if (typeof content !== 'string' || !content.trim()) throw new Error('Timeline chat model returned no content.');
          return content.trim();
        };
      }
    } else await plugin.initialize(config, dependencies);
    this.plugins.set(name, plugin);
    return plugin;
  }
  async capabilities() {
    const result = {};
    for (const name of Object.keys(pluginFiles)) {
      const manifest = JSON.parse(await fs.readFile(path.join(this.runtime.runtimeRoot, 'Plugin', name, 'plugin-manifest.json'), 'utf8'));
      result[name] = { version: manifest.version, available: true };
    }
    return { plugins: result, timelineGenerationConfigured: Boolean(this.configuration.chat), coldKnowledge: false };
  }
  async call(name, arguments_) {
    if (!['DailyNote', 'DailyNoteManager', 'LightMemo'].includes(name) || !arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)) throw new Error('Invalid VCP memory plugin call.');
    const plugin = await this.load(name);
    if (name === 'LightMemo') { await this.validateExistingTimelines(); await this.runtime.ensureArtifacts(); }
    const result = await this.queryEnvironment(() => plugin.processToolCall(arguments_));
    const paths = this.runtime.kb.databaseCoordinator.extractMutationPaths(result);
    if (paths.upserts.length || paths.deletes.length) {
      await this.runtime.kb.databaseCoordinator.awaitDeletedFilePaths(paths.deletes, { timeoutMs: 120000 });
      await this.runtime.kb.databaseCoordinator.awaitIndexedFilePaths(paths.upserts, { timeoutMs: 120000 });
      await this.runtime.reconcilePluginMutations(paths);
      this.runtime.artifactsDirty = true;
    }
    return { result, indexed: paths.upserts.length + paths.deletes.length > 0 };
  }
  async preprocess(messages) {
    if (!Array.isArray(messages) || messages.some(message => !message || typeof message.role !== 'string' || !(typeof message.content === 'string' || Array.isArray(message.content)))) throw new Error('Invalid VCP message input.');
    if (messages.some(message => typeof message.content === 'string' && message.content.includes('::AIMemo+')) && !this.configuration.chat) throw new Error('Passive memory focusing requires the global chat model.');
    this.events = [];
    const rag = await this.load('RAGDiaryPlugin');
    const timeline = await this.load('VCPTimeLine');
    await this.validateTimelines(timeline);
    if ((await this.runtime.kb.listDistinctDiaries()).length) await this.runtime.ensureArtifacts();
    const output = await this.queryEnvironment(async () => {
      const processed = await rag.processMessages(messages, {});
      return timeline.processMessages(processed);
    });
    return { messages: output, events: this.events };
  }
  async validateExistingTimelines() {
    if ((await this.runtime.kb.listDistinctDiaries()).some(folder => /timeline$/iu.test(folder))) {
      await this.validateTimelines(await this.load('VCPTimeLine'));
    }
  }
  async timeline(request) {
    const operations = ['listAgents', 'getAgentDetail', 'generateTimelines', 'generateSummaries', 'saveTimelineFile', 'saveSummary'];
    if (!request || !operations.includes(request.operation)) throw new Error('Unknown VCP timeline operation.');
    const plugin = await this.load('VCPTimeLine');
    if (request.operation === 'listAgents') return plugin.listAgents();
    if (typeof request.agentName !== 'string' || !request.agentName.trim()) throw new Error('Timeline agent name is required.');
    await this.bindTimelineAgent(plugin, request.agentName);
    if (request.operation.startsWith('generate') && !this.configuration.chat) throw new Error('Timeline generation requires a configured chat model endpoint.');
    if (request.operation === 'getAgentDetail') return plugin.getAgentDetail(request.agentName);
    if (request.operation === 'generateTimelines' || request.operation === 'generateSummaries') {
      await this.validateTimelines(plugin);
      const sources = await plugin.discoverMemories(request.agentName, request.options?.startMonth, request.options?.endMonth);
      const result = await plugin[request.operation](request.agentName, request.options || {});
      const dependencies = await this.readDependencies();
      dependencies[request.agentName] ||= {};
      for (const month of result.generated || []) dependencies[request.agentName][month] = this.sourcesDigest(request.agentName, month, sources.get(month) || []);
      await this.writeDependencies(dependencies);
      await this.indexTimelineFiles(plugin, request.agentName, result.generated || []);
      return result;
    }
    if (typeof request.month !== 'string' || !/^\d{4}-\d{2}$/u.test(request.month) || typeof request.content !== 'string') throw new Error('Timeline month and content are required.');
    const result = await plugin[request.operation](request.agentName, request.month, request.content);
    const dependencies = await this.readDependencies();
    dependencies[request.agentName] ||= {};
    dependencies[request.agentName][request.month] = await this.monthDigest(plugin, request.agentName, request.month);
    await this.writeDependencies(dependencies);
    if (request.operation === 'saveTimelineFile') await this.indexTimelineFiles(plugin, request.agentName, [request.month]);
    return result;
  }
  async bindTimelineAgent(plugin, agentName) {
    if (['__proto__', 'constructor', 'prototype'].includes(agentName)) throw new Error('Invalid timeline agent name.');
    plugin.safeAgentName(agentName);
    plugin.config.agentFolders ||= {};
    const folders = await this.runtime.kb.listDistinctDiaries();
    plugin.config.agentFolders[agentName] = [...new Set(folders.filter(folder => typeof folder === 'string' && !/timeline$/iu.test(folder)))];
  }
  sourcesDigest(agentName, month, sources) {
    return createHash('sha256').update(JSON.stringify({ agentName, month, sources })).digest('hex');
  }
  async monthDigest(plugin, agentName, month) {
    await this.bindTimelineAgent(plugin, agentName);
    const sources = await plugin.discoverMemories(agentName, month, month);
    return this.sourcesDigest(agentName, month, sources.get(month) || []);
  }
  async readDependencies() {
    try { return JSON.parse(await fs.readFile(this.dependenciesPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }
  async writeDependencies(value) {
    const temporary = `${this.dependenciesPath}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(value), 'utf8'); await fs.rename(temporary, this.dependenciesPath); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  async indexTimelineFiles(plugin, agentName, months) {
    const files = months.map(month => path.join(plugin.getTimelineDir(agentName), `${month}.md`));
    if (files.length) {
      await this.runtime.kb.databaseCoordinator.awaitIndexedFilePaths(files, { timeoutMs: 120000 });
      this.runtime.artifactsDirty = true;
    }
  }
  async validateTimelines(plugin) {
    const dependencies = await this.readDependencies();
    const summaries = await plugin.readSummaryStore();
    let changed = false;
    const deletes = [];
    for (const agentName of await plugin.listAgents()) {
      const files = await plugin.listTimelineFiles(agentName);
      const months = new Set([...files.map(file => file.month), ...Object.keys(summaries[agentName] || {})]);
      for (const month of months) {
        if (dependencies[agentName]?.[month] === await this.monthDigest(plugin, agentName, month)) continue;
        const file = files.find(candidate => candidate.month === month);
        if (file) { await fs.rm(file.fullPath, { force: true }); deletes.push(file.fullPath); }
        if (summaries[agentName]) delete summaries[agentName][month];
        if (dependencies[agentName]) delete dependencies[agentName][month];
        changed = true;
      }
    }
    if (changed) {
      await plugin.writeJsonAtomic(plugin.getSummaryPath(), summaries);
      await this.writeDependencies(dependencies);
      await this.runtime.kb.databaseCoordinator.awaitDeletedFilePaths(deletes, { timeoutMs: 120000 });
      this.runtime.artifactsDirty = true;
    }
  }
  async exportTimelines(sourceRevision) {
    if (typeof sourceRevision !== 'string' || !sourceRevision) throw new Error('Timeline source revision is required.');
    const plugin = await this.load('VCPTimeLine');
    await this.validateTimelines(plugin);
    const dependencies = await this.readDependencies();
    const summaries = await plugin.readSummaryStore();
    const agents = [];
    for (const agentName of await plugin.listAgents()) {
      const files = await plugin.listTimelineFiles(agentName);
      const months = [...new Set([...files.map(file => file.month), ...Object.keys(summaries[agentName] || {})])].sort();
      agents.push({ agentName, months: months.filter(month => dependencies[agentName]?.[month]).map(month => ({ month,
        sourceDigest: dependencies[agentName][month], content: files.find(file => file.month === month)?.content,
        summary: summaries[agentName]?.[month] })) });
    }
    return { schema: 'worldlinebox.vcp-timeline-artifacts', sourceRevision, agents };
  }
  async importTimelines(sourceRevision, artifacts) {
    if (typeof sourceRevision !== 'string' || !sourceRevision || artifacts?.schema !== 'worldlinebox.vcp-timeline-artifacts' || !Array.isArray(artifacts.agents)) throw new Error('Invalid VCP timeline artifacts.');
    const plugin = await this.load('VCPTimeLine');
    const dependencies = await this.readDependencies();
    let acceptedMonths = 0, skippedMonths = 0;
    for (const agent of artifacts.agents) {
      await this.bindTimelineAgent(plugin, agent.agentName);
      if (!Array.isArray(agent.months)) throw new Error('Invalid VCP timeline months.');
      for (const artifact of agent.months) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(artifact.month) || !/^[a-f0-9]{64}$/u.test(artifact.sourceDigest)) throw new Error('Invalid VCP timeline dependency.');
        if (artifact.sourceDigest !== await this.monthDigest(plugin, agent.agentName, artifact.month)) { skippedMonths++; continue; }
        if (typeof artifact.content === 'string') await plugin.saveTimelineFile(agent.agentName, artifact.month, artifact.content);
        if (typeof artifact.summary === 'string') await plugin.saveSummary(agent.agentName, artifact.month, artifact.summary);
        dependencies[agent.agentName] ||= {};
        dependencies[agent.agentName][artifact.month] = artifact.sourceDigest;
        await this.indexTimelineFiles(plugin, agent.agentName, typeof artifact.content === 'string' ? [artifact.month] : []);
        acceptedMonths++;
      }
    }
    await this.writeDependencies(dependencies);
    await this.validateTimelines(plugin);
    return { acceptedMonths, skippedMonths };
  }
  async close() {
    for (const name of ['LightMemo', 'DailyNote', 'DailyNoteManager', 'RAGDiaryPlugin']) await this.plugins.get(name)?.shutdown?.();
    this.plugins.clear();
  }
}

module.exports = { VcpMemoryPeripherals };

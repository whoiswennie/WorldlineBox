#!/usr/bin/env node
'use strict';
// Explicit opt-in real-provider check. Reads only the selected local workspace's config.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { request, createSession } = require('../lib/client.cjs');
const { readConfig, ROOT } = require('../lib/workspace.cjs');
(async () => {
  const configurationHome = path.resolve(process.argv[2] || path.join(ROOT, '.vcp-memory'));
  const config = readConfig(configurationHome);
  if (!config.CHAT_API_KEY && !config.API_Key) throw new Error('Real chat provider key is not configured');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-memory-live-'));
  const steps = [], started = Date.now();
  const session = createSession({ home, withTelemetry: true });
  const run = async (label, operation, payload) => {
    const at = Date.now();
    const { result, telemetry } = await session.request(operation, payload);
    if (label === 'local semantic RiverMemo scoped retrieval') {
      fs.writeFileSync(path.join(ROOT, 'reports', 'live-diagnostics.json'), JSON.stringify({ result, telemetry }, null, 2) + '\n');
    }
    if (result?.plugin_error || result?.status === 'error') throw new Error(label + ': ' + (result.plugin_error || result.error));
    steps.push({ label, passed: true, durationMs: Date.now() - at });
    return result;
  };
  let report;
  try {
    await run('initialize isolated live workspace', 'init', { ...config, LOCAL_EMBEDDING_ENABLED: true, LOCAL_EMBEDDING_BACKEND: 'cpu',
      VECTORDB_DIMENSION: 768, WhitelistEmbeddingModel: 'embeddinggemma-2', KNOWLEDGEBASE_DERIVED_STARTUP_COOLDOWN_MS: 1 });
    const chat = await run('DeepSeek actual OpenAI chat response', 'probe-chat', {});
    assert.match(chat.content, /VCP memory connected/i);
    for (const [folder, content, tag] of [
      ['MemoryAgent', 'ADR-017：项目决策是采用 PostgreSQL 保存正式业务数据，理由是事务一致性、可靠约束与审计能力。决定日期为2026-11-02，后续只有获得新证据才修改。', 'ADR-017,PostgreSQL,架构决策'],
      ['KitchenAgent', '厨房日记：苹果派使用红苹果和肉桂，先将苹果切片再放入烤箱。此日记只记录烹饪。', '苹果,烹饪'],
    ]) {
      await run('original DailyNote ' + folder, 'tool', { name: 'DailyNote', args: { command: 'create', maid: folder, folder, Date: '2026-11-02', Content: content, Tag: tag } });
    }
    await run('local Gemma → native SQLite/index commit', 'sync', {});
    const recall = await run('local semantic RiverMemo scoped retrieval', 'search', { query: '项目为何选择PostgreSQL来存储数据？', options: { diaryNames: ['MemoryAgent'], topK: 1 } });
    assert.match(JSON.stringify(recall), /ADR-017|PostgreSQL/);
    assert.doesNotMatch(JSON.stringify(recall), /厨房日记/);
    const preprocessed = await run('OneRing and retrieved context preprocessing', 'preprocess', {
      messages: [{ role: 'system', content: '[[OneRing::MemoryAgent::CLI]]\n[[MemoryAgent日记本::K2]]' },
        { role: 'user', content: '我们为何选择PostgreSQL？请记录ADR-017决策。' }], options: { folding: false },
    });
    assert.match(JSON.stringify(preprocessed.messages), /PostgreSQL/);
    await run('OneRing assistant completion persisted', 'response', { messages: preprocessed.messages, metadata: preprocessed.metadata,
      text: 'ADR-017 决定采用 PostgreSQL，依据是事务一致性、可靠约束与审计需求。', completed: true });
    const memo = await run('DeepSeek real OneRingMemo summary and persistence', 'invoke', { target: 'oneringMemo', method: 'generateMemo',
      args: ['MemoryAgent', { enabled: true, model: config.CHAT_MODEL || 'deepseek-flash', timelineDays: 3 }, 'explicit-live-validation'] });
    assert.ok(memo.summary && memo.summary.length > 10);
    assert.match(memo.summary, /PostgreSQL|ADR-017/);
    const summarized = await run('local recall → actual DeepSeek AIMemo+', 'tool', { name: 'LightMemo', args: {
      query: 'ADR-017选择了哪个数据库，为什么？', folder: 'MemoryAgent', k: 2, enginemode: 'knn', aimemo: true,
    } });
    assert.match(JSON.stringify(summarized), /AI总结/);
    const history = [{ id: 'live-u1', role: 'user', content: 'ADR-017 为什么采用 PostgreSQL？', timestamp: Date.now() },
      { id: 'live-a1', role: 'assistant', content: '因为事务一致性、约束与审计。', timestamp: Date.now() }];
    await run('session append in the same persistent memory process', 'session.append', { agent: 'MemoryAgent', session: 'original', messages: history });
    const past = await run('original CDS/Tantivy DeepMemo over durable history', 'tool', { name: 'DeepMemo', args: { maid: 'MemoryAgent', keyword: 'PostgreSQL' } });
    assert.match(JSON.stringify(past), /PostgreSQL/);
    report = { passed: true, validatedAt: new Date().toISOString(), chatProvider: 'DeepSeek official OpenAI Chat Completions', chatModel: chat.model,
      chatProbeUsage: chat.usage, embedding: { source: 'bundled WorldlineBox Gemma and llama.cpp CPU', dimension: 768 },
      steps, durationMs: Date.now() - started,
      scope: 'Real local text vectors, actual provider summary requests, native storage/retrieval, OneRing and CDS. No claim of a comprehensive recall-quality benchmark.' };
  } catch (error) {
    report = { passed: false, validatedAt: new Date().toISOString(), steps, error: error.message, durationMs: Date.now() - started };
    process.exitCode = 1;
  } finally {
    try { await session.close(); } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
  fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'reports', 'live-validation.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
})().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });

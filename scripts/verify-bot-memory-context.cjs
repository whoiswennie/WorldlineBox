#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const project = path.resolve(__dirname, '..');
const messages = [
  { role: 'system', content: '你是伙伴。\n<---VCP记忆思维区Start--->\n先核对用户提到的地点。\n<---VCP记忆思维区End--->\n{{旅程日记本::Last2}}\n[[OneRing::同伴::VCPChat::Only]]' },
  { role: 'user', content: '周末在哪里集合？' },
  { role: 'assistant', content: '我记得我们讨论过出发时间。' },
  { role: 'user', content: '请把最新约定再告诉我。' },
];
const notes = [
  ['2026-01-02.txt', '[2026-01-02] - 同伴\n原定西门集合。\nTag: 出行, 西门'],
  ['2026-01-03.txt', '[2026-01-03] - 同伴\n最新约定：周日上午十点，在南门取书。\nTag: 出行, 南门'],
];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
function seed(directory, sortingTime) {
  const book = path.join(directory, 'dailynote', '旅程');
  fs.mkdirSync(book, { recursive: true });
  for (const [index, [name, body]] of notes.entries()) {
    // LastN ranks by max(creation, change, modification). A common, distinct
    // mtime above the fixture's creation time gives both copies the same order.
    const file = path.join(book, name), mtime = new Date(sortingTime + index * 1000);
    fs.writeFileSync(file, body); fs.utimesSync(file, mtime, mtime);
  }
}
async function compareChat(temp, bundle) {
  const checkout = path.resolve(process.env.WORLDLINEBOX_VCP_CHAT || path.join(project, '..', 'vcp', 'VCPChat'));
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'upstream', 'manifest-chat.json'), 'utf8'));
  const reference = path.join(temp, 'chat-reference'), archive = path.join(temp, 'chat.tar');
  fs.mkdirSync(reference);
  // Use the same dependency closure, taking the reference bytes straight from
  // the pinned commit, independently of the bytes resolved by the app worker.
  execFileSync('git', ['-C', checkout, 'archive', '--format=tar', '--output=' + archive, manifest.revision, ...manifest.files.map(entry => entry.source)], { windowsHide: true });
  execFileSync('tar', ['-xf', archive, '-C', reference], { windowsHide: true });
  const entry = 'modules/chat/singleChatRequestOrchestrator.js';
  const officialBuilder = require(path.join(reference, entry)).createSingleChatRequestOrchestrator({
    electronAPI: {}, tavernEngine: require(path.join(reference, 'modules/tavernRulesEngine.js')),
  });
  const history = [
    { id: 'old', role: 'user', content: '已折叠的旧对话正文' },
    { id: 'checkpoint', role: 'user', content: '先前约定在西门集合。', contextCompaction: {
      kind: 'vchat-context-checkpoint', version: 1, checkpoint: '先前约定在西门集合。' } },
    { id: 'new', role: 'assistant', content: '已更新，改在南门取书。' },
    { id: 'last', role: 'user', content: '现在该去哪里？' },
  ];
  const context = { agentId: 'companion', agentName: '同伴', topicId: 'trip' }, agentConfig = { name: '同伴', systemPrompt: '你是同伴。' };
  const requestId = 'vcp-memory-chat-parity';
  const raw = await officialBuilder.buildRequest({ settings: {}, agentConfig, history, messageId: requestId, context, tavernRules: [], systemPromptPrefix: '', systemPromptAppend: '' });
  const managed = await require(path.join(bundle, 'lib', 'context.cjs')).prepareMessages(history, { ...context, agentConfig, requestId });
  const content = view => view.map(({ role, content }) => ({ role, content }));
  const expected = content(raw.messages), actual = content(managed.messages);
  assert.deepEqual(actual, expected);
  assert(!JSON.stringify(expected).includes('已折叠的旧对话正文')); assert(JSON.stringify(expected).includes('改在南门取书'));
  return { revision: manifest.revision, entry, gitBlob: execFileSync('git', ['-C', checkout, 'rev-parse', manifest.revision + ':' + entry], { encoding: 'utf8' }).trim(),
    history, official: expected, host: actual, visibleSha256: digest(JSON.stringify(actual)) };
}
async function official(directory) {
  process.env.PROJECT_BASE_PATH = directory;
  process.env.KNOWLEDGEBASE_ROOT_PATH = path.join(directory, 'dailynote');
  process.env.DEFAULT_TIMEZONE = 'Asia/Shanghai';
  const read = name => require(path.join(directory, 'Plugin', name, name + '.js'));
  const tray = read('MemoryThinkingTray'), rag = read('RAGDiaryPlugin'), ring = read('OneRing');
  const config = { PROJECT_BASE_PATH: directory, DEFAULT_TIMEZONE: 'Asia/Shanghai' };
  const order = JSON.parse(fs.readFileSync(path.join(directory, 'preprocessor_order.json'), 'utf8'));
  const selected = order.filter(value => ['MemoryThinkingTray', 'RAGDiaryPlugin', 'OneRing'].includes(value));
  assert.deepEqual(selected, ['MemoryThinkingTray', 'RAGDiaryPlugin', 'OneRing']);
  try {
    await tray.initialize(config); await ring.initialize(config, {});
    let result = structuredClone(messages);
    for (const name of selected) result = await ({ MemoryThinkingTray: tray, RAGDiaryPlugin: rag, OneRing: ring }[name]).processMessages(result, config);
    writeJson(path.join(directory, 'output.json'), { messages: result, order: selected, oneRing: result.__oneRingMeta });
  } finally { await ring.shutdown(); }
}
async function check() {
  const appResources = process.env.WORLDLINEBOX_PACKAGE_ROOT && path.resolve(process.env.WORLDLINEBOX_PACKAGE_ROOT, 'resources');
  const bundle = appResources ? path.join(appResources, 'vcp-memory') : path.join(project, '.tools', 'bot-memory-release', 'vcp-memory');
  const { resolveBotMemoryNode } = await import('./bot-memory-runtime-lib.mjs');
  const node = appResources ? path.join(appResources, 'resources', 'portable-tools', 'win32-x64', 'node', 'node.exe') : await resolveBotMemoryNode(project);
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'upstream', 'manifest.json'), 'utf8'));
  const revision = manifest.sources.toolbox.commit;
  const checkouts = process.env.WORLDLINEBOX_VCP_TOOLBOX ? [path.resolve(process.env.WORLDLINEBOX_VCP_TOOLBOX)] :
    [path.join(project, '..', 'vcp', 'VCPToolBox'), path.join(project, '.tools', 'vcp-toolbox-' + revision.slice(0, 7))];
  const checkout = checkouts.find(directory => fs.existsSync(directory) &&
    spawnSync('git', ['-C', directory, 'cat-file', '-e', revision + '^{commit}'], { windowsHide: true }).status === 0);
  assert(checkout, 'Set WORLDLINEBOX_VCP_TOOLBOX to a Git checkout containing ' + revision);
  const git = (...args) => execFileSync('git', ['-C', checkout, ...args], { windowsHide: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wlb-vcp-context-comparison-'));
  const reference = path.join(temp, 'reference'), host = path.join(temp, 'host');
  let worker;
  try {
    fs.mkdirSync(reference);
    const archive = path.join(temp, 'reference.tar');
    git('archive', '--format=tar', '--output=' + archive, revision, 'Plugin/OneRing', 'Plugin/RAGDiaryPlugin', 'Plugin/MemoryThinkingTray', 'modules', 'TextChunker.js', 'EmbeddingUtils.js', 'preprocessor_order.json');
    execFileSync('tar', ['-xf', archive, '-C', reference], { windowsHide: true });
    const sortingTime = Date.now() + 60_000;
    seed(reference, sortingTime); seed(host, sortingTime);
    const files = ['Plugin/MemoryThinkingTray/MemoryThinkingTray.js', 'Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js',
      'Plugin/RAGDiaryPlugin/DirectDiaryTextProcessor.js', 'Plugin/OneRing/OneRing.js', 'preprocessor_order.json'].map(file => {
      const original = fs.readFileSync(path.join(reference, file)), packaged = fs.readFileSync(path.join(bundle, 'upstream', 'toolbox', file));
      const entry = manifest.files.find(item => item.path === file);
      assert.equal(digest(packaged), entry.sha256);
      assert.equal(packaged.toString().replaceAll('\r\n', '\n'), original.toString().replaceAll('\r\n', '\n'));
      return { file, gitBlob: git('rev-parse', revision + ':' + file).toString().trim(), gitSha256: digest(original), packagedSha256: digest(packaged) };
    });
    execFileSync(node, [__filename, '--official', reference], { env: { ...process.env, NODE_PATH: path.join(bundle, 'node_modules') }, windowsHide: true, timeout: 45000, stdio: ['ignore', 'pipe', 'pipe'] });
    const baseline = JSON.parse(fs.readFileSync(path.join(reference, 'output.json'), 'utf8'));
    const model = 'embeddinggemma-2-compact', signature = 'context-parity-direct-text';
    writeJson(path.join(host, 'config.json'), { LOCAL_EMBEDDING_ENABLED: false, DEFAULT_TIMEZONE: 'Asia/Shanghai',
      WhitelistEmbeddingModel: model, EmbeddingModelSig: signature });
    worker = require(path.join(bundle, 'lib', 'client.cjs')).createSession({ home: host, nodePath: node,
      env: { WORLDLINEBOX_VCP_MANAGED: '1', EMBEDDING_API_URL: 'http://127.0.0.1:9/v1', EMBEDDING_QUERY_API_URL: 'http://127.0.0.1:9/v1',
        EMBEDDING_MODEL: model, EmbeddingModelSig: signature, EMBEDDING_API_KEY: 'direct-text-no-requests', ONERING_USER_NAME: '用户' } });
    const actual = await worker.request('preprocess', { messages, options: { folding: false, variables: false } }, { timeoutMs: 45000 });
    const normalize = view => view.map(item => ({ role: item.role, content: item.content }));
    assert.deepEqual(normalize(actual.messages), normalize(baseline.messages));
    const visible = JSON.stringify(actual.messages);
    for (const phrase of ['原定西门集合', '在南门取书', '先核对用户提到的地点', 'OneRing系统已启动']) assert(visible.includes(phrase), phrase);
    const chat = await compareChat(temp, bundle);
    const report = { revision, files, fixture: { messages, notes }, order: baseline.order, official: baseline.messages, host: actual.messages, chat,
      normalization: 'Compare visible role and content for each message in order; exclude private receipt properties.', visibleSha256: digest(JSON.stringify(normalize(actual.messages))), oneRing: actual.metadata?.oneRing };
    if (process.env.WORLDLINEBOX_CONTEXT_REPORT) {
      const file = path.resolve(process.env.WORLDLINEBOX_CONTEXT_REPORT); fs.mkdirSync(path.dirname(file), { recursive: true }); writeJson(file, report);
    }
    console.log(JSON.stringify({ officialStages: baseline.order, messages: actual.messages.length, sha256: report.visibleSha256,
      chatMessages: chat.host.length, chatSha256: chat.visibleSha256 }));
  } finally { try { await worker?.close(); } finally { fs.rmSync(temp, { recursive: true, force: true }); } }
}
const referenceMode = process.argv[2] === '--official';
(referenceMode ? official(path.resolve(process.argv[3])) : check()).then(() => { if (referenceMode) process.exit(0); })
  .catch(error => { console.error(error); process.exitCode = 1; if (referenceMode) process.exit(1); });

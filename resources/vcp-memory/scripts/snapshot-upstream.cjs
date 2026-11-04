#!/usr/bin/env node
'use strict';
// Reproducible, read-only source extraction. No source repository is modified.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'upstream');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const slash = file => file.split(path.sep).join('/');
function safeResolve(base, file) {
  const result = path.resolve(base, file);
  if (result !== base && !result.startsWith(base + path.sep)) throw new Error(`Path escapes snapshot: ${file}`);
  return result;
}
function verify() {
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  const failures = [];
  for (const entry of manifest.files) {
    try {
      const bytes = fs.readFileSync(safeResolve(path.join(out, entry.project), entry.path));
      if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) failures.push(entry.path);
    } catch (error) { failures.push(`${entry.path}: ${error.code || error.message}`); }
  }
  process.stdout.write(JSON.stringify({ok: failures.length === 0, files: manifest.files.length, failures}, null, 2) + '\n');
  process.exitCode = failures.length ? 1 : 0;
}
if (process.argv.includes('--verify')) { verify(); return; }
const sourceArg = process.argv.indexOf('--toolbox');
const source = path.resolve(sourceArg >= 0 ? process.argv[sourceArg + 1] : path.join(root, '..', '..', 'VCPToolBox'));
function git(...args) { return cp.execFileSync('git', ['-C', source, ...args], {encoding:'utf8'}).trim(); }
const tracked = new Set(git('ls-files', '-z').split('\0').filter(Boolean));
const pluginNames = [
  'RAGDiaryPlugin','DailyNote','DailyNoteManager','DailyNotePanel','DailyNoteSearcher',
  'MemoryMaster','AgentDream','MagiAgent','MemoryThinkingTray','ContextFoldingV2',
  'LightMemo','OneRing','VCPTimeLine','PlaceholderExplorer','SemanticGroupEditor'
];
const initialFiles = [
  'KnowledgeBaseManager.js','TagMemoEngine.js','TagMemoV10Engine.js','RiverMemoEngine.js',
  'ResultDeduplicator.js','TextChunker.js','EmbeddingUtils.js','TDBKnowledge.js','rag_params.json',
  'config.env.example','LICENSE','Plugin.js',
  'modules/messageProcessor.js','modules/associativeDiscovery.js','modules/contextManager.js',
  'modules/finalContextStore.js','modules/roleDivider.js','modules/jevContextPruner.js',
  'modules/vcpLoop/toolCallParser.js','modules/vcpLoop/toolMarkerFuzzyMatcher.js',
  'modules/chatCompletionHandler.js','vcpInfoHandler.js','preprocessor_order.json',
  'routes/admin/rag.js','routes/admin/jevRegistry.js','ToolConfigs/jev_tool_call_exp.json',
  'ToolConfigs/jev_third_party_catalog.json','TVStxt/JevToolCallDecision.txt',
  'Plugin/DailyHot/plugin-manifest.json.block','Plugin/WeatherInfoNow/plugin-manifest.json',
  'scripts/guard-server-stopped.js','scripts/repair_database.js','scripts/rebuild_vector_indexes.js',
  'scripts/rebuild_tag_index_custom.js','scripts/diary-semantic-classifier.js','scripts/sync_missing_tags.js',
  'AdminPanel-Vue/src/features/rag-tuning/TagMemoV9ControlPanel.vue',
  'AdminPanel-Vue/src/features/rag-tuning/RiverMemoV3ControlPanel.vue',
  'AdminPanel-Vue/src/features/rag-tuning/metadata.ts',
  'modules/jevRiverReranker.js','modules/jevToolCallExp.js','routes/dailyNotesRoutes.js',
  'docs/vcp-whitepaper.md','docs/VCP记忆管理系统.md','docs/MEMORY_SYSTEM.md',
  'docs/CONTEXT_BRIDGE.md','docs/TagMemo_Wave_Algorithm_Deep_Dive.md',
  'docs/RIVERMEMO_TOPOLOGY_V3.md','docs/RUST_VECTOR_ENGINE.md',
  'docs/CONTEXT_FOLDING_V2_DEVPLAN.md','docs/DOCUMENTATION_INDEX.md'
];
const initialDirs = ['modules/knowledgeBase/','modules/tagmemoV10/','rust-vexus-lite/','docs/archive/tagmemoV10/', ...pluginNames.map(name => `Plugin/${name}/`)];
// DailyNote is an executable plugin name; runtime dailynote/ is excluded only at
// repository root. Never exclude source namespaces through case folding.
const blocked = /(?:^|\/)(?:node_modules|target|state|cache|\.git)(?:\/|$)|^(?:VectorStore|dailynote|image|DebugLog|VCPAsyncResults)(?:\/|$)|(?:^|\/)AGENTS\.md$|(?:^|\/)(?:config\.env|\.env)$|\.(?:sqlite3?|db)(?:-|$)/i;
const allowedExt = /\.(?:js|cjs|mjs|ts|vue|json|json\.block|json\.example|env\.example|rs|toml|lock|md|txt|css|html|ico|exe|node)$|(?:^|\/)LICENSE$|DailyNoteSearcher-aarch64-unknown-linux-musl$/i;
const selection = new Set();
const queue = [];
function add(file, allowUntracked = false) {
  file = slash(file);
  if (blocked.test(file) || !allowedExt.test(file) || selection.has(file)) return false;
  if (!allowUntracked && !tracked.has(file)) return false;
  if (!fs.existsSync(safeResolve(source, file)) || !fs.statSync(safeResolve(source,file)).isFile()) return false;
  selection.add(file); queue.push(file); return true;
}
initialFiles.forEach(file => add(file));
for (const file of tracked) {
  if (initialDirs.some(dir => file.startsWith(dir))) add(file);
  if (/^tests\/(?:abiV2|associativeDiscovery|diaryIndex|dynamicToolRegistry|jev|kbm|lightMemo|memo|memory|native|newTag|oneRing|placeholder|rag|resultDeduplicator|riverThinking|roleDivider|sarPrompt|sqlAuthoritative|tagConsistency|tagIndex|tdb|textChunker|thoughtCluster|timeline|unifiedGeometry)/i.test(file)) add(file);
}
// The upstream repository ships release binaries outside Git's tracked set on some checkouts.
for (const filename of fs.readdirSync(path.join(source, 'rust-vexus-lite'))) {
  if (/^vexus-lite(?:\.[a-z0-9-]+)?\.node$/.test(filename)) add(`rust-vexus-lite/${filename}`, true);
}
for (const filename of fs.readdirSync(path.join(source, 'Plugin', 'DailyNoteSearcher'))) {
  if (/^DailyNoteSearcher(?:[-.].*)?(?:exe|musl)$/.test(filename)) add(`Plugin/DailyNoteSearcher/${filename}`, true);
}
const hostFiles = new Set(['Plugin.js','server.js','WebSocketServer.js','FileFetcherServer.js']);
const hostBoundaries = [];
const missingRequires = [];
const optionalPlatformRequires = [];
const retiredMaintenanceRequires = [];
const external = new Set();
const builtins = new Set(require('node:module').builtinModules.map(name => name.replace(/^node:/,'')));
function resolveRelative(from, specifier) {
  const base = path.resolve(source, path.dirname(from), specifier);
  for (const candidate of [base, base + '.js', base + '.json', base + '.node', path.join(base, 'index.js')]) {
    if (candidate.startsWith(source + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return slash(path.relative(source, candidate));
  }
  return null;
}
for (let i = 0; i < queue.length; ++i) {
  const file = queue[i];
  if (!/\.(?:c?js|mjs|ts)$/.test(file) || file.startsWith('tests/') || hostFiles.has(file) || file.endsWith('.bak.js')) continue;
  const sourceText = fs.readFileSync(path.join(source, file), 'utf8');
  for (const match of sourceText.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const specifier = match[1];
    if (specifier.startsWith('.')) {
      const resolved = resolveRelative(file, specifier);
      if (!resolved) {
        const list = file === 'rust-vexus-lite/index.js' && specifier.endsWith('.node') ? optionalPlatformRequires
          : ['scripts/repair_database.js','scripts/rebuild_tag_index_custom.js','scripts/diary-semantic-classifier.js'].includes(file) ? retiredMaintenanceRequires : missingRequires;
        list.push({from:file, specifier}); continue;
      }
      if (hostFiles.has(resolved)) hostBoundaries.push({from:file, specifier, path:resolved});
      add(resolved, resolved.endsWith('.node'));
    } else if (!builtins.has(specifier.replace(/^node:/,''))) {
      external.add(specifier.startsWith('@') ? specifier.split('/').slice(0,2).join('/') : specifier.split('/')[0]);
    }
  }
}
fs.mkdirSync(path.join(out, 'toolbox'), {recursive:true});
const files = [];
for (const file of [...selection].sort()) {
  const bytes = fs.readFileSync(safeResolve(source,file));
  const dest = safeResolve(path.join(out, 'toolbox'), file);
  fs.mkdirSync(path.dirname(dest), {recursive:true});
  fs.writeFileSync(dest,bytes);
  files.push({project:'toolbox',path:file,sha256:hash(bytes),bytes:bytes.length});
}
const manifest = {
  schemaVersion:1, createdAt:new Date().toISOString(),
  sources:{toolbox:{path:source,commit:git('rev-parse','HEAD'),dirty:git('status','--porcelain').length > 0}},
  selection:{initialFiles,initialDirs,policy:'Tracked, explicitly selected source and static dependencies; shipped native binaries; no private env, runtime state, diaries, agents or TVStxt data. Host implementation preserved for traceability and supplied by standalone adapter at runtime.'},
  files,hostBoundaries,missingRequires,optionalPlatformRequires,retiredMaintenanceRequires,externalPackages:[...external].sort()
};
manifest.selection.pluginCompleteness = pluginNames.map(name => {
  const directory = `Plugin/${name}/`;
  if (!fs.existsSync(path.join(source,directory))) return {name,existsInSource:false};
  const manifestPath = [`${directory}plugin-manifest.json`,`${directory}plugin-manifest.json.block`].find(file => selection.has(file));
  if (!manifestPath) throw new Error(`Missing selected plugin manifest: ${name}`);
  const declaration = JSON.parse(fs.readFileSync(path.join(source,manifestPath),'utf8'));
  const entry = declaration.entryPoint?.script || /(?:node|python3?)\s+([^\s]+)/.exec(declaration.entryPoint?.command || '')?.[1];
  if (entry && !selection.has(directory + entry)) throw new Error(`Missing selected plugin entry: ${directory + entry}`);
  return {name,existsInSource:true,manifest:manifestPath,entry:entry || null,files:files.filter(file=>file.path.startsWith(directory)).length};
});
fs.writeFileSync(path.join(out,'manifest.json'), JSON.stringify(manifest,null,2)+'\n');
process.stdout.write(JSON.stringify({files:files.length,bytes:files.reduce((n,file)=>n+file.bytes,0),externalPackages:manifest.externalPackages,hostBoundaries,missingRequires},null,2)+'\n');

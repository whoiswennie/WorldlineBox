#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = path.resolve(process.argv[2] || path.join(root, '..', '..', 'VCPChat'));
const destination = path.join(root, 'upstream', 'chat');
const git = (...args) => cp.execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
if (git('status', '--porcelain', '--untracked-files=no')) throw new Error('A clean VCPChat checkout is required');
const tracked = cp.execFileSync('git', ['-C', source, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const selected = tracked.filter(file => file.startsWith('modules/services/chatDataService/')
  || file.startsWith('rust_chat_data_service/') && !file.includes('/target/')
  || ['VCPDistributedServer/Plugin/DeepMemo/DeepMemoService.js', 'VCPDistributedServer/Plugin/DeepMemo/plugin-manifest.json',
    'VCPDistributedServer/Plugin/TopicMemo/TopicMemo.js', 'VCPDistributedServer/Plugin/TopicMemo/plugin-manifest.json',
    'VCPDistributedServer/shared/memoryProtocolProjection.js', 'tests/deepmemo-central-adapter.test.js'].includes(file));
const executable = 'modules/services/chatDataService/bin/win32-x64/vcp_chat_data_service.exe';
if (fs.existsSync(path.join(source, executable)) && !selected.includes(executable)) selected.push(executable);
const files = [];
for (const file of selected.sort()) {
  if (/(?:^|\/)(?:config\.env|\.env|AGENTS\.md)$/.test(file)) continue;
  const bytes = fs.readFileSync(path.join(source, file));
  const target = path.join(destination, file);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  files.push({ source: file, target: path.relative(root, target).split(path.sep).join('/'), bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
}
fs.writeFileSync(path.join(root, 'upstream', 'manifest-chat-memory.json'), JSON.stringify({ sourceProject: 'VCPChat',
  revision: git('rev-parse', 'HEAD'), sourceDate: git('log', '-1', '--format=%cI'),
  policy: 'Original central CDS production engine and TopicMemo; no legacy search executable, private config or AppData.', files }, null, 2) + '\n');
console.log(JSON.stringify({ files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) }));

const contextManifest = path.join(root, 'upstream', 'manifest-chat.json');
const context = JSON.parse(fs.readFileSync(contextManifest, 'utf8'));
context.revision = git('rev-parse', 'HEAD');
delete context.capturedAt;
context.sourceDate = git('log', '-1', '--format=%cI');
const known = new Set(context.files.map(entry => entry.source));
for (const entry of context.files) {
  const bytes = fs.readFileSync(path.join(source, entry.source));
  fs.mkdirSync(path.dirname(path.join(root, entry.target)), { recursive: true });
  fs.writeFileSync(path.join(root, entry.target), bytes);
  entry.sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  entry.bytes = bytes.length;
  if (!/\.[cm]?js$/.test(entry.source)) continue;
  const relativeImport = /\b(?:from\s+|import\s+|(?:require|import)\s*\(\s*)['"](\.[^'"]+)['"]/g;
  for (const [, specifier] of bytes.toString('utf8').matchAll(relativeImport)) {
    const base = path.posix.join(path.posix.dirname(entry.source), specifier);
    const dependency = [base, base + '.js', base + '.json', base + '/index.js'].find(file => tracked.includes(file));
    if (!dependency) throw new Error(`Unresolved chat import in ${entry.source}: ${specifier}`);
    if (!known.has(dependency)) {
      known.add(dependency);
      context.files.push({ source: dependency, target: 'upstream/chat/' + dependency });
    }
  }
}
fs.writeFileSync(contextManifest, JSON.stringify(context, null, 2) + '\n');

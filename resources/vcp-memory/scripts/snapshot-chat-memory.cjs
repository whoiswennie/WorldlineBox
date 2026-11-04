#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = path.resolve(process.argv[2] || path.join(root, '..', '..', 'VCPChat'));
const destination = path.join(root, 'upstream', 'chat');
const tracked = cp.execFileSync('git', ['-C', source, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const selected = tracked.filter(file => file.startsWith('modules/services/chatDataService/')
  || file.startsWith('rust_chat_data_service/') && !file.includes('/target/')
  || ['VCPDistributedServer/Plugin/DeepMemo/DeepMemoService.js', 'VCPDistributedServer/Plugin/DeepMemo/plugin-manifest.json',
    'VCPDistributedServer/Plugin/TopicMemo/TopicMemo.js', 'VCPDistributedServer/Plugin/TopicMemo/plugin-manifest.json',
    'tests/deepmemo-central-adapter.test.js'].includes(file));
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
  revision: cp.execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  capturedAt: new Date().toISOString(), policy: 'Original central CDS production engine and TopicMemo; no legacy search executable, private config or AppData.', files }, null, 2) + '\n');
console.log(JSON.stringify({ files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) }));

#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
function verify(file) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const failures = [];
  const omittedManagedEmbedding = [];
  for (const entry of manifest.files) {
    const relative = entry.target || (entry.project ? `upstream/${entry.project}/${entry.path}` : entry.path) || path.join(path.dirname(file), entry.file);
    if (process.argv.includes('--managed-embedding') && relative.startsWith('vendor/local-embedding/')) {
      omittedManagedEmbedding.push(relative); continue;
    }
    const location = path.resolve(root, relative);
    if (!location.startsWith(root + path.sep)) { failures.push(relative + ': unsafe path'); continue; }
    try {
      const bytes = fs.readFileSync(location);
      if (bytes.length !== entry.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) failures.push(relative);
    } catch (error) { failures.push(relative + ': ' + error.code); }
  }
  return { manifest: file, files: manifest.files.length - omittedManagedEmbedding.length, ok: !failures.length, failures,
    ...(omittedManagedEmbedding.length ? { omittedManagedEmbedding, embeddingVerification: 'WorldlineBox built-in model gateway owns these assets' } : {}) };
}
const manifests = ['upstream/manifest.json', 'upstream/manifest-chat.json', 'upstream/manifest-chat-memory.json', 'upstream/manifest-worldline.json', 'references/official/manifest.json'];
const results = manifests.filter(file => fs.existsSync(path.join(root, file))).map(verify);
const ok = results.every(item => item.ok) && results.length === manifests.length;
process.stdout.write(JSON.stringify({ ok, results }, null, 2) + '\n');
process.exitCode = ok ? 0 : 1;

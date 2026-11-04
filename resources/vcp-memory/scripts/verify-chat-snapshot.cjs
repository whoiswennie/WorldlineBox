#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const snapshotRoot = path.join(root, 'upstream', 'chat');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'upstream', 'manifest-chat.json'), 'utf8'));
const failures = [];
for (const file of manifest.files) {
    const absolute = path.resolve(root, file.target);
    if (!absolute.startsWith(snapshotRoot + path.sep)) {
        failures.push({ file: file.target, reason: 'outside Chat snapshot' });
        continue;
    }
    try {
        const bytes = fs.readFileSync(absolute);
        const digest = crypto.createHash('sha256').update(bytes).digest('hex');
        if (digest !== file.sha256 || bytes.length !== file.bytes) failures.push({ file: file.target, reason: 'content differs from captured source' });
    } catch (error) { failures.push({ file: file.target, reason: error.code || 'read failed' }); }
}
for (const file of manifest.adapterFiles || []) {
    try {
        const boundary = JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'));
        if (boundary.type !== 'module' || boundary.private !== true) failures.push({ file, reason: 'invalid generated ES module boundary' });
    } catch (error) { failures.push({ file, reason: error.code || 'read failed' }); }
}
process.stdout.write(JSON.stringify({ ok: failures.length === 0, files: manifest.files.length, failures }, null, 2) + '\n');
if (failures.length) process.exitCode = 1;

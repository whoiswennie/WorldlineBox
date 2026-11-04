#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
for (const project of ['toolbox', 'chat']) {
  const cwd = path.join(root, 'upstream', project);
  const files = fs.readdirSync(path.join(cwd, 'tests')).filter(file => /\.test\.(m?js)$/.test(file)).map(file => 'tests/' + file);
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=4', '--test-timeout=90000', '--test-force-exit', ...files], {
    cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, windowsHide: true,
  });
  fs.writeFileSync(path.join(root, 'reports', `upstream-${project}-repeat.log`), result.stdout + result.stderr);
  const summary = result.stdout.split(/\r?\n/).filter(line => /^# (tests|pass|fail|skipped|duration)/.test(line));
  process.stdout.write(project + ': ' + summary.join('; ') + '\n');
  if (result.error || result.status !== 0) { process.stderr.write(result.error?.message || result.stdout.slice(-2500)); process.exitCode = 1; }
}

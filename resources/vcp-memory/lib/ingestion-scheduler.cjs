'use strict';

// Keep the captured upstream file byte-for-byte intact. This version-pinned
// host adaptation changes only timer ownership in the module compiled for an
// owned memory home; embedding, ingestion receipts, ranking and storage stay
// in the original implementation. An unknown source revision fails closed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const SOURCE_SHA256 = '9a2f6da6e858b6682b4399eacdf20b1d6c0d97d6be4d7cf694f31370a7ce2a89';
const marker = Symbol.for('worldlinebox.memory.ingestion-scheduler');

function prepareManagedIngestionScheduler(runtimeDir) {
  const filename = require.resolve(path.join(runtimeDir, 'modules', 'knowledgeBase', 'ingestionPipeline.js'));
  const cached = require.cache[filename];
  if (cached) {
    if (!cached.exports[marker]) throw new Error('Ingestion pipeline was loaded before managed timer ownership was installed');
    return cached.exports[marker];
  }
  const bytes = fs.readFileSync(filename), sourceSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sourceSha256 !== SOURCE_SHA256) throw new Error('Unsupported ingestion pipeline revision for managed timer ownership');
  let source = bytes.toString('utf8').replace(/\r\n/g, '\n');
  const replaceOnce = (before, after) => {
    if (source.split(before).length !== 2) throw new Error('Managed ingestion timer adaptation does not match the captured source');
    source = source.replace(before, after);
  };
  // A direct host kick consumes the already scheduled watcher batch. Leaving
  // that timer alive would create a second repair chain after this one fails.
  replaceOnce(`        this.isProcessing = true;\n        this.touchActivity?.();\n        let retryDelayMs = 0;`,
    `        if (this.batchTimer) { clearTimeout(this.batchTimer); this.batchTimer = null; }\n        this.isProcessing = true;\n        this.touchActivity?.();\n        let retryDelayMs = 0;`);
  // The completed batch owns the next deadline, including events received
  // during its I/O. The original >=1s repair delay remains unchanged, and the
  // existing watcher guard and shutdown now see/cancel this same timer.
  replaceOnce(`            this.isProcessing = false;\n            if (!this._shuttingDown && !this.databaseCorruptionDetected && this.pendingFiles.size > 0) {\n                if (retryDelayMs > 0) {\n                    setTimeout(() => this._flushBatch(), retryDelayMs);`,
    `            this.isProcessing = false;\n            if (this.batchTimer) { clearTimeout(this.batchTimer); this.batchTimer = null; }\n            if (!this._shuttingDown && !this.databaseCorruptionDetected && this.pendingFiles.size > 0) {\n                if (retryDelayMs > 0) {\n                    this.batchTimer = setTimeout(() => { this.batchTimer = null; this._flushBatch(); }, retryDelayMs);`);
  const proof = Object.freeze({ revision: 1, sourceSha256, timerOwner: 'single-ingestion-batch', originalSnapshotChanged: false });
  const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  require.cache[filename] = loaded;
  try {
    loaded._compile(source, filename); loaded.loaded = true;
    Object.defineProperty(loaded.exports, marker, { value: proof });
  } catch (error) { delete require.cache[filename]; throw error; }
  return proof;
}
module.exports = { prepareManagedIngestionScheduler };

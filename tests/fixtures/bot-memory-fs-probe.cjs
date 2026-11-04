'use strict';
// Test-only public JS filesystem counters. Native Rust/CDS/llama I/O is outside
// this observer and is reported separately as Windows process I/O, not invented.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { syncBuiltinESMExports } = require('node:module');
const output = process.env.WORLDLINEBOX_MEMORY_FS_PROBE_FILE;
if (output) {
  const write = fs.writeFileSync.bind(fs);
  const counters = { readCalls: 0, readBytes: 0, directoryCalls: 0, writeCalls: 0, writeBytes: 0, catalogReadBytes: 0, catalogWriteBytes: 0 };
  const catalog = file => /session-mirror\.json|[/\\]Agents[/\\][^/\\]+[/\\]config\.json/.test(String(file));
  const size = value => typeof value === 'string' ? Buffer.byteLength(value) : value?.byteLength || 0;
  const read = (file, data) => { counters.readBytes += size(data); if (catalog(file)) counters.catalogReadBytes += size(data); };
  const written = (file, data) => { counters.writeCalls++; counters.writeBytes += size(data); if (catalog(file)) counters.catalogWriteBytes += size(data); };
  const flush = () => { try { write(output, JSON.stringify({ pid: process.pid, at: Date.now(), ...counters })); } catch { /* Probe output must not interrupt the observed process. */ } };
  const originalSync = fs.readFileSync; fs.readFileSync = function(file, ...args) { counters.readCalls++; const data = originalSync.call(this, file, ...args); read(file, data); return data; };
  const originalPromise = fsp.readFile; fsp.readFile = async function(file, ...args) { counters.readCalls++; const data = await originalPromise.call(this, file, ...args); read(file, data); return data; };
  const originalCallback = fs.readFile; fs.readFile = function(file, ...args) {
    counters.readCalls++; const callback = args.at(-1);
    if (typeof callback === 'function') args[args.length - 1] = (error, data) => { if (!error) read(file, data); callback(error, data); };
    return originalCallback.call(this, file, ...args);
  };
  const originalStream = fs.createReadStream; fs.createReadStream = function(file, ...args) { counters.readCalls++; const stream = originalStream.call(this, file, ...args); stream.on('data', data => read(file, data)); return stream; };
  for (const [object, name] of [[fs, 'readdirSync'], [fs, 'readdir'], [fsp, 'readdir']]) { const original = object[name]; object[name] = function(...args) { counters.directoryCalls++; return original.apply(this, args); }; }
  const originalWrite = fsp.writeFile; fsp.writeFile = async function(file, data, ...args) { const value = await originalWrite.call(this, file, data, ...args); written(file, data); return value; };
  const originalWriteSync = fs.writeFileSync; fs.writeFileSync = function(file, data, ...args) { const value = originalWriteSync.call(this, file, data, ...args); written(file, data); return value; };
  syncBuiltinESMExports();
  // The next serialized RPC snapshots all preceding work before it begins.
  process.stdin.on('data', flush); process.once('exit', flush);
  const timer = setInterval(flush, 250); timer.unref(); flush();
}

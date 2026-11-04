#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { request } = require('../lib/client.cjs');
const { resolveHome } = require('../lib/workspace.cjs');
const HELP = `vcp-memory — standalone original VCP memory/context engine

Usage: vcp-memory [--home DIRECTORY] COMMAND [--input FILE|- | --json JSON]
All output is JSON; plugin logs go to stderr. Default home: ./.vcp-memory
Search diagnostics preserve VCP's original score fields and order.
--no-diagnostics omits diagnostics; --diagnostics-file FILE also saves them.

init [--dimension N --model NAME --api-url URL]  Create an isolated workspace
config get | config set KEY VALUE             Configure original VCP env keys
doctor | probe | probe-chat | verify          Local / embedding / chat / source checks
embed --input request.json                    Local text/image/audio vectors
catalog                                       Original tool schemas and parameters
tool NAME --input request.json                Execute a memory plugin command
search QUERY [--diary NAME --k N --knn]        RiverMemo search (or pure ANN)
preprocess --input messages.json               Full memory/context injection
response --input response.json                Record assistant response / OneRing
sync | status                                 Drain indexing / report state
invoke --input request.json                    Advanced whitelisted original APIs
session ACTION --input request.json            Portable VCPChat sessions/branches
context ACTION --input request.json            Original context transformations
backup | runtime-upgrade                       Backup workspace / upgrade source
serve                                          JSONL requests on stdin, one workspace

Input can be a request object or (preprocess) a messages array.
Example: vcp-memory tool DailyNote --json '{"command":"create","maid":"Agent","Date":"2026-11-02","Content":"Memory","Tag":"VCP"}'
Provider secrets: set API_Key in the workspace config.json or environment.
`;
async function readInput(file) {
  if (file !== '-') return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/, ''));
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input.replace(/^\uFEFF/, ''));
}
function saveDiagnostics(file, telemetry) {
  if (!file) return;
  const absolute = path.resolve(file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, JSON.stringify(telemetry ?? null, null, 2) + '\n');
}
async function main() {
  const positional = [], flags = {};
  for (let index = 2; index < process.argv.length; index++) {
    const item = process.argv[index];
    if (['--knn', '--help', '-h', '--vectors', '--diagnostics', '--no-diagnostics'].includes(item)) { flags[item.replace(/^-+/, '')] = true; continue; }
    if (item.startsWith('--')) {
      if (index + 1 >= process.argv.length) throw new Error(`Missing value for ${item}`);
      flags[item.slice(2)] = process.argv[++index];
    } else positional.push(item);
  }
  if (flags.help || flags.h || !positional.length) { process.stdout.write(HELP); return; }
  const home = resolveHome(flags.home);
  const command = positional.shift();
  if (command === 'serve') {
    // Preserve streaming and let the worker own the singleton lifecycle.
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'lib', 'worker.cjs'), '--serve'], {
      stdio: ['inherit', 'pipe', 'inherit'], env: { ...process.env, VCP_MEMORY_HOME: home }, windowsHide: true });
    const lines = require('node:readline').createInterface({ input: child.stdout });
    lines.on('line', line => {
      const marker = '\x1eVCP_MEMORY_JSON:';
      const position = line.indexOf(marker);
      if (position >= 0) {
        if (position) process.stderr.write(line.slice(0, position) + '\n');
        process.stdout.write(line.slice(position + marker.length) + '\n');
      } else process.stderr.write(line + '\n');
    });
    child.on('exit', code => { process.exitCode = code || 0; });
    child.on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
    return;
  }
  let payload = flags.input ? await readInput(flags.input) : flags.json ? JSON.parse(flags.json) : {};
  let operation = command;
  switch (command) {
    case 'init':
      if (flags.dimension) payload.VECTORDB_DIMENSION = Number(flags.dimension);
      if (flags.model) payload.WhitelistEmbeddingModel = flags.model;
      if (flags['api-url']) payload.API_URL = flags['api-url'];
      if (!Number.isInteger(payload.VECTORDB_DIMENSION ?? 3072) || (payload.VECTORDB_DIMENSION ?? 3072) < 1) throw new Error('dimension must be a positive integer');
      break;
    case 'config': {
      operation = `config.${positional.shift() || 'get'}`;
      if (operation === 'config.set') {
        const key = positional.shift(), raw = positional.join(' ');
        if (!key || !raw) throw new Error('config set requires KEY VALUE');
        let value = raw; try { value = JSON.parse(raw); } catch {}
        payload = { key, value };
      }
      break;
    }
    case 'tool': payload = { name: positional.shift() || payload.name, args: payload.args || payload,
      context: payload.context || {}, vectors: Boolean(flags.vectors) }; break;
    case 'search': payload = { query: positional.join(' ') || payload.query, options: { ...(payload.options || {}),
      ...(flags.diary ? { diaryNames: [flags.diary] } : {}), ...(flags.k ? { topK: Number(flags.k) } : {}),
      ...(flags.knn ? { mode: 'knn' } : {}) } }; break;
    case 'preprocess': if (Array.isArray(payload)) payload = { messages: payload }; break;
    case 'session': case 'context': operation = `${command}.${positional.shift() || 'list'}`; break;
  }
  const diagnosticsEnabled = !flags['no-diagnostics'] || Boolean(flags['diagnostics-file']);
  let response;
  try { response = await request(operation, payload, { home, withTelemetry: diagnosticsEnabled, onLog: text => process.stderr.write(text) }); }
  catch (error) { saveDiagnostics(flags['diagnostics-file'], error.telemetry); throw error; }
  const { result, telemetry } = diagnosticsEnabled ? response : { result: response };
  saveDiagnostics(flags['diagnostics-file'], telemetry);
  if (result?.status === 'error' || result?.plugin_error || result?.error) {
    throw Object.assign(new Error(String(result.plugin_error || result.error || result.message || 'Memory plugin failed')), { code: 'VCP_PLUGIN_ERROR', telemetry });
  }
  process.stdout.write(JSON.stringify({ ok: true, result, ...(!flags['no-diagnostics'] && telemetry ? { telemetry } : {}) }, null, 2) + '\n');
}
main().catch(error => {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: error.code || 'VCP_MEMORY_ERROR', message: error.message }, ...(error.telemetry ? { telemetry: error.telemetry } : {}) }) + '\n');
  process.exitCode = 1;
});

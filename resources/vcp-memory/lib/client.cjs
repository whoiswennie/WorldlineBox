'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
// Toolbox modules are copied into each memory workspace. Put the verified
// package's dependencies on the worker's search path so a Windows junction
// cannot become the only route to them during an upgrade or relocation.
function workerEnvironment(env) {
  return { ...process.env, ...env, NODE_PATH: path.join(__dirname, '..', 'node_modules') };
}
/** Each one-shot request runs in an isolated process because upstream uses env-bound singletons. */
function request(operation, payload = {}, { home, env = {}, onLog, withTelemetry = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'worker.cjs')], {
      env: workerEnvironment(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '', logs = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; if (onLog) onLog(chunk); });
    child.on('error', reject);
    child.on('close', code => {
      let result;
      const marker = '\x1eVCP_MEMORY_JSON:';
      const boundary = output.lastIndexOf(marker);
      const wire = boundary >= 0 ? output.slice(boundary + marker.length).trim() : output.trim();
      if (boundary > 0 && onLog) onLog(output.slice(0, boundary));
      try { result = JSON.parse(wire); } catch { return reject(new Error(`Worker returned invalid JSON (exit ${code}): ${logs.slice(-3000)} ${output.slice(-1000)}`)); }
      if (!result.ok) {
        const error = new Error(result.error?.message || 'Memory request failed');
        error.code = result.error?.code; error.details = result.error?.details;
        if (result.telemetry) error.telemetry = result.telemetry;
        return reject(error);
      }
      resolve(withTelemetry ? { result: result.result, telemetry: result.telemetry } : result.result);
    });
    child.stdin.end(JSON.stringify({ operation, payload, home, diagnostics: withTelemetry }));
  });
}
function createSession({ home, env = {}, onLog, onDiagnostic, withTelemetry = false, nodePath = process.execPath,
  closeTimeoutMs = 5000 } = {}) {
  const child = spawn(nodePath, [path.join(__dirname, 'worker.cjs'), '--serve'], {
    env: workerEnvironment(env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const pending = new Map(); let sequence = 0, stopped = false, intentional = false, stderrTail = '';
  // Native aborts cannot return a JSON error. Keep only a bounded local tail,
  // redact credentials after assembling chunks, and report it on exit only.
  // In particular, never log request payloads or normal diary output.
  const secrets = Object.entries({ ...process.env, ...env }).filter(([key, value]) => /(?:key|token|secret|password|authorization)/i.test(key) && typeof value === 'string' && value.length >= 4).map(([, value]) => value);
  function diagnostics(code, signal) {
    let tail = stderrTail;
    for (const secret of secrets) tail = tail.split(secret).join('[REDACTED]');
    tail = tail.replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[REDACTED_API_KEY]').replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]');
    return { pid: child.pid, exitCode: code, signal, intentional, operations: [...pending.values()].map(waiter => waiter.operation).slice(0, 16), stderrTail: tail };
  }
  const notify = value => { try { onDiagnostic?.(value); } catch { /* Diagnostics must not strand pending callers. */ } };
  const closedError = (message, cause, exitCode) => Object.assign(new Error(message, cause ? { cause } : undefined), {
    code: 'MEMORY_SESSION_CLOSED', ...(exitCode === undefined ? {} : { exitCode }),
  });
  const stop = () => {
    if (stopped) return;
    intentional = true;
    stopped = true;
    // The original runtime has process-scoped plugins; cancelling one request
    // retires this entire session. Kill its CDS subprocess as well on Windows.
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill());
    } else child.kill('SIGTERM');
  };
  const lines = require('node:readline').createInterface({ input: child.stdout });
  child.stdin.on('error', error => {
    for (const waiter of pending.values()) { waiter.dispose(); waiter.reject(closedError('Memory session transport closed', error)); }
    pending.clear(); stop();
  });
  lines.on('line', line => {
    const marker = '\x1eVCP_MEMORY_JSON:', offset = line.indexOf(marker);
    if (offset < 0) { if (onLog) onLog(line + '\n'); return; }
    if (offset && onLog) onLog(line.slice(0, offset));
    let message; try { message = JSON.parse(line.slice(offset + marker.length)); } catch { return; }
    const waiter = pending.get(message.id); if (!waiter) return;
    pending.delete(message.id); waiter.dispose();
    if (message.ok) waiter.resolve(waiter.withTelemetry ? { result: message.result, telemetry: message.telemetry } : message.result);
    else { const error = new Error(message.error.message); error.code = message.error.code; error.telemetry = message.telemetry; waiter.reject(error); }
  });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', text => { stderrTail = (stderrTail + text).slice(-16384); if (onLog) onLog(text); });
  const closed = new Promise((resolve, reject) => {
    child.once('error', error => { stopped = true; const failure = closedError('Memory session could not start', error); for (const waiter of pending.values()) { waiter.dispose(); waiter.reject(failure); } pending.clear(); reject(failure); });
    child.once('close', (code, signal) => {
      stopped = true;
      const failure = closedError(`Memory session closed (exit ${code})`, undefined, code);
      failure.diagnostics = diagnostics(code, signal);
      if (code !== 0 || signal || pending.size) notify(failure.diagnostics);
      if (signal) failure.signal = signal;
      for (const waiter of pending.values()) { waiter.dispose(); waiter.reject(failure); }
      pending.clear(); code !== 0 ? reject(failure) : resolve();
    });
  });
  closed.catch(() => {});
  return {
    get pid() { return child.pid; },
    closed,
    request(operation, payload = {}, { signal, timeoutMs = 30000, withTelemetry: observe = withTelemetry } = {}) {
      return new Promise((resolve, reject) => {
        if (stopped || child.stdin.destroyed || child.stdin.writableEnded) return reject(closedError('Memory session is closed'));
        if (signal?.aborted) return reject(signal.reason || new Error('Memory request cancelled'));
        const id = ++sequence;
        let timer;
        const abort = () => {
          const waiter = pending.get(id); if (!waiter) return;
          pending.delete(id); waiter.dispose();
          reject(signal?.reason || Object.assign(new Error('Memory request timed out; runtime retired'), { code: 'MEMORY_TIMEOUT' }));
          stop();
        };
        const dispose = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
        pending.set(id, { resolve, reject, dispose, operation, withTelemetry: observe });
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(abort, timeoutMs); timer.unref?.();
        child.stdin.write(JSON.stringify({ id, operation, payload, home, diagnostics: observe }) + '\n');
      });
    },
    async close() {
      intentional = true;
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
      const timer = setTimeout(stop, closeTimeoutMs); timer.unref?.();
      try { await closed; } finally { clearTimeout(timer); }
    },
  };
}
module.exports = { request, createSession };

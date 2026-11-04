import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const nodePath = path.resolve('.tools/node-v24.15.0-win-x64/node.exe');
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it.skipIf(!existsSync(nodePath))('retains a bounded credential-redacted native stderr tail without request content when a real child exits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bot-memory-client-diagnostic-')); roots.push(root);
  const lib = path.join(root, 'lib'); await mkdir(lib);
  await writeFile(path.join(lib, 'client.cjs'), await readFile('resources/vcp-memory/lib/client.cjs'));
  await writeFile(path.join(lib, 'worker.cjs'), `
    const fs = require('node:fs');
    process.stdin.once('data', () => {
      fs.writeSync(2, 'discarded-prefix' + 'x'.repeat(20000));
      fs.writeSync(2, '\\nnative-fatal fixture-secret-');
      fs.writeSync(2, 'split-value; Bearer fixture-token-value\\n');
      process.exit(17);
    });
  `);
  const require = createRequire(import.meta.url);
  const client = require(path.join(lib, 'client.cjs')) as { createSession(options: object): {
    request(operation: string, payload: object): Promise<unknown>; close(): Promise<void>;
  } };
  const reports: Array<Record<string, unknown>> = [];
  const session = client.createSession({ nodePath, home: path.join(root, 'home'),
    env: { CHAT_API_KEY: 'fixture-secret-split-value' }, onDiagnostic: (report: Record<string, unknown>) => { reports.push(report); throw new Error('observer failure'); } });
  await expect(session.request('search', { query: 'private-source-must-not-be-logged' })).rejects.toMatchObject({ code: 'MEMORY_SESSION_CLOSED', exitCode: 17 });
  await expect(session.close()).rejects.toMatchObject({ code: 'MEMORY_SESSION_CLOSED' });
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({ exitCode: 17, intentional: false, operations: ['search'] });
  const diagnostic = JSON.stringify(reports);
  expect(diagnostic).toContain('native-fatal'); expect(diagnostic).toContain('[REDACTED]');
  expect(diagnostic).not.toContain('fixture-secret'); expect(diagnostic).not.toContain('fixture-token-value');
  expect(diagnostic).not.toContain('private-source'); expect(diagnostic).not.toContain('discarded-prefix');
  expect(String(reports[0]!.stderrTail).length).toBeLessThanOrEqual(16384);
}, 20000);

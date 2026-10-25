import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { removeOwnedDirectorySync } from '../../src/main/vcp-memory/filesystem';

test('packaged VCP indexes, recalls and generates timelines without dependency directory links', async () => {
  test.setTimeout(90_000);
  const executablePath = process.env.WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE;
  if (!executablePath) throw new Error('Set WORLDLINEBOX_E2E_PACKAGED_EXECUTABLE after packaging.');
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-packaged-vcp-dependencies-'));
  const resources = process.platform === 'darwin' ? path.resolve(path.dirname(executablePath), '../Resources')
    : path.join(path.dirname(executablePath), 'resources');
  const wrapper = path.join(root, 'worker.cjs');
  writeFileSync(wrapper, `require('node:fs/promises').symlink = async () => { throw Object.assign(new Error('Dependency links unavailable'), { code: 'EPERM' }); };\nrequire(${JSON.stringify(path.join(resources, 'vcp-memory-host/worker.cjs'))});\n`);
  let chatCalls = 0, embeddingCalls = 0;
  const server = createServer(async (request, response) => {
    let text = ''; for await (const part of request) text += part.toString();
    const body = JSON.parse(text) as { input?: string[] };
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.includes('chat/completions')) {
      chatCalls++;
      response.end(JSON.stringify({ choices: [{ message: { content: '2026-10-25: alpha borrowed the blue umbrella.\nTag: alpha, umbrella' } }] }));
    } else {
      embeddingCalls++;
      response.end(JSON.stringify({ data: body.input!.map((_, index) => ({ index, embedding: [1, 0, 0, 0] })) }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local fixture address.');
  const application = await electron.launch({ executablePath, args: [], env: { ...process.env,
    WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: path.join(root, 'profile') } });
  try {
    const result = await application.evaluate(async ({ app, utilityProcess }, input) => {
      if (!app.isPackaged) throw new Error('This regression must run against the packaged application.');
      const child = utilityProcess.fork(input.wrapper, [], { stdio: 'pipe' });
      child.stdout?.resume(); let errors = '';
      child.stderr?.on('data', bytes => { errors = (errors + bytes.toString()).slice(-8000); });
      let sequence = 0;
      const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
      const exited = new Promise<number>(resolve => child.on('exit', code => {
        for (const item of pending.values()) item.reject(new Error(`VCP worker exited (${code}): ${errors}`));
        pending.clear(); resolve(code);
      }));
      child.on('message', (message: unknown) => {
        const reply = message as { requestId?: string; ok?: boolean; value?: unknown; error?: { message: string } };
        const item = reply.requestId && pending.get(reply.requestId); if (!item) return;
        pending.delete(reply.requestId!);
        if (reply.ok) item.resolve(reply.value); else item.reject(new Error(reply.error?.message || errors));
      });
      const request = async (command: Record<string, unknown>) => {
        const requestId = String(++sequence);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { return await new Promise<unknown>((resolve, reject) => {
          timer = setTimeout(() => { pending.delete(requestId); reject(new Error('VCP command timed out: ' + errors)); }, 30_000);
          pending.set(requestId, { resolve, reject }); child.postMessage({ requestId, command });
        }); } finally { clearTimeout(timer); }
      };
      try {
        const initialized = await request({ type: 'initialize', configuration: { dataRoot: input.dataRoot,
          vendorRoot: input.vendorRoot, scope: { scopeId: 'packaged-no-links' },
          embedding: { baseUrl: input.baseUrl, model: 'fixture', dimension: 4 },
          plugins: { chat: { baseUrl: input.baseUrl, model: 'fixture-chat', apiKey: 'fixture' } } } });
        const written = await request({ type: 'remember', note: { id: 'packaged-note', content: 'alpha borrowed the blue umbrella',
          tags: ['alpha', 'umbrella'], occurredAt: '2026-10-25T00:00:00Z' } });
        const recalled = await request({ type: 'search', text: 'alpha umbrella', topK: 4 });
        const timeline = await request({ type: 'timeline', request: { operation: 'generateTimelines', agentName: 'WorldlineBox',
          options: { startMonth: '2026-10', endMonth: '2026-10' } } });
        await request({ type: 'close' });
        return { packaged: app.isPackaged, initialized, written, recalled, timeline, exitCode: await exited };
      } finally { child.kill(); await exited; }
    }, { wrapper, vendorRoot: path.join(resources, 'vcp-memory'), baseUrl: `http://127.0.0.1:${address.port}`,
      dataRoot: path.join(root, '伙伴记忆库', 'generation', 'a'.repeat(64), 'b'.repeat(64)) });
    expect(result).toMatchObject({ packaged: true, initialized: { ready: true }, written: { indexed: true },
      recalled: { results: [{ id: 'packaged-note', engine: 'river' }] }, timeline: { generated: ['2026-10'] }, exitCode: 0 });
    expect(embeddingCalls).toBeGreaterThan(0); expect(chatCalls).toBeGreaterThan(0);
  } finally {
    await application.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    removeOwnedDirectorySync(root);
  }
});

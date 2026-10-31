import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { VcpMemoryClient } from '../../src/main/vcp-memory/client';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import type { VcpMemoryNote } from '../../src/main/vcp-memory/contracts';
vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));
it('verifies actual native markdown chunks and original expanded files against canonical rendering', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-canonical-native-'));
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part.toString(); const body = JSON.parse(raw);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: body.input.map((_text: string, index: number) => ({ index, embedding: [.8, .3, .2, .1] })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new VcpMemoryClient({ dataRoot: root, vendorRoot: path.resolve('vendor/vcp-memory'), workerPath: path.resolve('src/main/vcp-memory/worker.cjs'),
    embedding: { baseUrl, apiKey: 'local', model: 'local-deterministic', dimension: 4 }, plugins: { chat: { baseUrl, apiKey: 'local', model: 'local-chat' } },
    launch: worker => { const child = fork(worker, [], { execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      return { postMessage: value => { child.send(value as object); }, on: child.on.bind(child), kill: () => { child.kill(); } }; } });
  const note: VcpMemoryNote = { id: 'knowledge_one', content: '## 青岚图书馆\n\n这是合成教材，并非本人亲历。\n\n- 普通读者同时最多借三本。\n- 每本十四天。\n- 已预约不得续借。\n\n未知的续借次数不可编造。',
    tags: ['青岚图书馆', '借阅：规则'], occurredAt: '2026-10-28T10:00:00Z', author: '月见', diaryName: '知识' };
  const renderer = createRequire(import.meta.url)(path.resolve('src/main/vcp-memory/runtime.cjs')) as { notebookFolder(name?: string): string; renderNativeDiaryText(note: VcpMemoryNote): string };
  try {
    await client.replace({ scopeId: 'alice' }, [note]);
    for (const suffix of ['', '::Expand']) {
      const handle = await client.prepareRecall({ scopeId: 'alice' }, [{ role: 'system', content: `[[AIMemo=True]]\n[[${renderer.notebookFolder(note.diaryName)}日记本::RiverMemo${suffix}::AIMemo+]]` }, { role: 'user', content: '青岚图书馆借阅规则' }]);
      const envelope = JSON.parse((await readFile(path.join(root, createHash('sha256').update('alice').digest('hex'), 'prepared-recalls', handle.id + '.json'), 'utf8')).split('\n')[0]!);
      const payload = JSON.parse(envelope.serialized);
      try { await client.verifyPreparedCanonicalNotes(handle, [note]); }
      catch (error) { throw new Error(JSON.stringify({ error: String(error), expected: renderer.renderNativeDiaryText(note), files: payload.groups.flatMap((group: { options: { sourceFiles: unknown[] } }) => group.options.sourceFiles) }), { cause: error }); }
      expect(handle.contextReferences.length).toBeGreaterThan(0); await client.discardRecall(handle);
    }
  } finally { await client.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await removeOwnedDirectory(root); }
}, 60000);

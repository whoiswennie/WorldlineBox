import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BotMemoryService, type BotMemoryOptions } from '../../src/main/companion-bot/memory-service';

const packageRoot = path.resolve('.tools/bot-memory-release/vcp-memory');
const nodePath = process.env.WORLDLINEBOX_BOT_NODE || path.resolve('.tools/node-v24.15.0-win-x64/node.exe');
const enabled = existsSync(nodePath) && existsSync(path.join(packageRoot, 'lib/bot-host.cjs'));
async function crashFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bot-memory-create-recovery-'));
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    if (!request.url?.endsWith('/v1/embeddings')) { response.writeHead(404).end(); return; }
    const input = JSON.parse(body).input, texts = Array.isArray(input) ? input : [input];
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: texts.map((_: unknown, index: number) => ({ index,
      embedding: Array.from({ length: 64 }, (_, i) => i === 0 ? 1 : 0.01) })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No local protocol fixture port');
  const base = `http://127.0.0.1:${address.port}`;
  const scope = { companionId: 'recovery-owner', conversationId: 'direct', securityDomainId: 'direct' };
  const home = path.join(root, createHash('sha256').update(JSON.stringify([scope.companionId, scope.securityDomainId])).digest('hex'));
  await mkdir(home);
  const payload = { sourceEventId: 'crashed-create', sourceRootEventId: 'crashed-root', sourceMessageIds: ['source-message'],
    content: '事故窗口唯一事实：木樨方舟的识别码为 OS-729。', tags: '崩溃恢复,事实' };
  const config = { VECTORDB_DIMENSION: 64, WhitelistEmbeddingModel: 'fixture64', EmbeddingModelSig: 'fixture64-recovery', LOCAL_EMBEDDING_ENABLED: false,
    DEFAULT_TIMEZONE: 'Asia/Shanghai', TDB_KNOWLEDGE_ENABLED: false, KNOWLEDGEBASE_BATCH_WINDOW_MS: 25, KNOWLEDGEBASE_DERIVED_STARTUP_COOLDOWN_MS: 100,
    API_URL: base, API_Key: 'fixture', EMBEDDING_API_URL: base + '/document', EMBEDDING_QUERY_API_URL: base + '/query', EMBEDDING_API_KEY: 'fixture',
    CHAT_API_URL: base, CHAT_API_KEY: 'fixture', CHAT_MODEL: 'fixture' };
  const crash = spawnSync(nodePath, ['-e', `
    const w=require('./lib/workspace.cjs');const home=process.argv[1],cfg=JSON.parse(process.argv[2]),payload=JSON.parse(process.argv[3]);
    w.initHome(home,cfg);const runtimeDir=w.stageRuntime(home);w.applyEnvironment(home,cfg,runtimeDir);
    const {MemoryRuntime}=require('./lib/runtime.cjs');const runtime=new MemoryRuntime({home,runtimeDir,config:cfg});
    const bot=new(require('./lib/bot-host.cjs').BotHost)(home),original=runtime.callTool.bind(runtime);
    runtime.callTool=async(...args)=>{const receipt=await original(...args);if(receipt.status!=='success')throw new Error(JSON.stringify(receipt));
      process.stdout.write('CREATE_OCCURRED_BEFORE_LEDGER_ACK\\n',()=>process.exit(73));await new Promise(()=>{});};
    bot.remember(runtime,payload).catch(error=>{console.error(error);process.exit(1);});
  `, home, JSON.stringify(config), JSON.stringify(payload)], { cwd: packageRoot, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (crash.status !== 73 || !crash.stdout.includes('CREATE_OCCURRED_BEFORE_LEDGER_ACK')) throw new Error('Crash boundary was not reached: ' + crash.stderr.slice(-3000));
  const id = createHash('sha256').update(payload.sourceEventId).digest('hex');
  const directory = path.join(home, 'dailynote/Companion'), names = await readdir(directory);
  const file = path.join(directory, names.find(name => name.includes(id))!);
  // Index the actual surviving file through the original runtime, deliberately
  // without running the managed repair that would fill in the missing ledger path.
  const client = createRequire(path.join(packageRoot, 'package.json'))('./lib/client.cjs');
  const diagnostics: string[] = [], raw = client.createSession({ home, nodePath, onLog: (line: string) => diagnostics.push(line) });
  try {
    await raw.request('sync', {}, { timeoutMs: 60000 });
    const indexed = await raw.request('search', { query: '木樨方舟识别码', options: { folder: 'Companion', sync: false } }, { timeoutMs: 60000 });
    expect(JSON.stringify(indexed)).toContain('OS-729');
  }
  catch (error) {
    await raw.close().catch(() => undefined); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    throw new Error('Original pre-repair index setup failed: ' + String(error) + '\n' + diagnostics.join('').slice(-10000),{cause:error});
  } finally { await raw.close().catch(() => undefined); }
  const options: BotMemoryOptions = { root, runtime: async () => ({ nodePath, packageRoot }),
    embedding: async () => ({ baseUrl: base + '/document', queryBaseUrl: base + '/query', apiKey: 'fixture', model: 'fixture64', dimension: 64, modelSignature: 'fixture64-recovery' }),
    chat: async () => ({ baseUrl: base, apiKey: 'fixture', model: 'fixture' }), requestTimeoutMs: 60000 };
  let service = new BotMemoryService(options);
  return { root, scope, id, payload, file, get service() { return service; },
    restart: async () => { await service.close(); service = new BotMemoryService(options); },
    close: async () => { await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('bot-memory-create-recovery-')) throw new Error('Unexpected recovery fixture root');
      await rm(root, { recursive: true, force: true }); } };
}
it.skipIf(!enabled)('recovers the actual post-create/pre-ledger crash and forgets its file and native index across restart', async () => {
  const f = await crashFixture();
  try {
    expect((await f.service.list(f.scope))[0]).toMatchObject({ id: f.id, indexState: 'writing' });
    expect(await readFile(f.file, 'utf8')).toContain('OS-729');
    expect(await f.service.forget(f.scope, { id: f.id })).toMatchObject({ forgotten: true, sourceEventIds: ['crashed-root','crashed-create'] });
    await expect(lstat(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(await f.service.tool(f.scope, 'LightMemo', { query: '木樨方舟识别码是什么' }))).not.toContain('OS-729');
    await f.restart(); expect(await f.service.list(f.scope)).toEqual([]);
    expect(JSON.stringify(await f.service.tool(f.scope, 'LightMemo', { query: '木樨方舟识别码是什么' }))).not.toContain('OS-729');
    expect(await f.service.remember(f.scope, f.payload)).toMatchObject({ withdrawn: true });
  } finally { await f.close(); }
}, 90000);
it.skipIf(!enabled)('refuses to delete a same-suffix file with conflicting body and keeps the source withdrawn', async () => {
  const f = await crashFixture();
  try {
    const changed = (await readFile(f.file, 'utf8')).replace('OS-729', 'OTHER-UNOWNED-CONTENT'); await writeFile(f.file, changed);
    await expect(f.service.forget(f.scope, { id: f.id })).rejects.toMatchObject({ code: 'MEMORY_OUTCOME_UNKNOWN' });
    expect(await readFile(f.file, 'utf8')).toBe(changed);
    expect(await f.service.withdrawnSources(f.scope)).toMatchObject({ revision: '1', sourceEventIds: ['crashed-create','crashed-root'] });
    expect((await f.service.list(f.scope))[0]).toMatchObject({ id: f.id, indexState: 'withdrawing', content: '' });
    await expect(f.service.tool(f.scope, 'LightMemo', { query: '木樨方舟' })).rejects.toMatchObject({ code: 'MEMORY_OUTCOME_UNKNOWN' });
    expect(await readFile(f.file, 'utf8')).toBe(changed);
  } finally { await f.close(); }
}, 90000);

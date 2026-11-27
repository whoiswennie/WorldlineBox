import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotMemoryService } from '../../src/main/companion-bot/memory-service';
import { GlobalEmbeddingService } from '../../src/main/embedding-global-service';
import { VcpEmbeddingGateway } from '../../src/main/vcp-embedding-gateway';

const nodePath = process.env.WORLDLINEBOX_BOT_NODE || path.resolve('.tools/node-v24.15.0-win-x64/node.exe');
const packageRoot = path.resolve('.tools/bot-memory-release/vcp-memory');
const bundleDirectory = path.resolve('resources/embedding-models');
it.skipIf(!existsSync(nodePath) || !existsSync(path.join(packageRoot, 'lib/client.cjs')) || !existsSync(path.join(bundleDirectory, 'manifest.json')))(
  'recalls a prior decision on an ordinary turn after reopening with only the bundled encoder', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-bundled-recall-'));
    const encoder = new GlobalEmbeddingService({ userDataPath: root, bundleDirectory,
      koffiPath: createRequire(path.resolve('package.json')).resolve('koffi'), devicePreference: () => ({ backend: 'cpu' }) });
    const gateway = new VcpEmbeddingGateway(encoder);
    const workerFailures: Record<string, unknown>[] = [];
    const options = { root: path.join(root, 'memory'), runtime: async () => ({ nodePath, packageRoot }),
      onDiagnostic: (diagnostic: Record<string, unknown>) => { workerFailures.push(diagnostic); },
      embedding: async () => { const profile = await encoder.resolveProfile(); return gateway.configuration(profile.selectionId, profile); } };
    const scope = { companionId: '小南', conversationId: 'chat', securityDomainId: 'private' };
    let memory = new BotMemoryService(options);
    try {
      const note = await memory.remember(scope, { sourceEventId: 'trip-decision', content: '周六的观鸟路线定在青鹭湾北岸，早晨六点从观景台集合。',
        tags: '观鸟,集合地点,青鹭湾', waitForIndex: true, indexTimeoutMs: 30000 });
      expect(note).toMatchObject({ indexed: 1 });
      await memory.close();
      memory = new BotMemoryService(options);
      const messages = [{ id: 'earlier', role: 'user' as const, content: '咱们周六要去看水鸟。', timestamp: Date.now() - 1000 },
        { id: 'now', role: 'user' as const, content: '早上到哪里碰头？', timestamp: Date.now() }];
      const prepared = await memory.prepareTurn({ scope, requestId: 'now', messages });
      expect(prepared.nativeContext).toContain('青鹭湾北岸');
      expect(prepared.citations?.some(citation => citation.text.includes('青鹭湾北岸'))).toBe(true);
      const scoped = await memory.readScoped(scope, 'memory_search', { query: '观鸟的集合地点' });
      expect(scoped).toMatchObject({ available: true,
        records: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('青鹭湾北岸'), sourceEventId: 'trip-decision' })]),
        provenance: { sourceEventIds: ['trip-decision'] } });
      const quoted = await memory.prepareTurn({ scope, requestId: 'quoted-log', messages: [
        { id: 'quoted-log', role: 'user', content: '[系统提示:]\n[RAG处理失败] 这段日志是什么意思？', timestamp: Date.now() },
      ] });
      expect(quoted.nativeContext).not.toContain('这段日志是什么意思');
      const other = await memory.prepareTurn({ scope: { ...scope, conversationId: 'observers', securityDomainId: 'group' }, requestId: 'group-turn', messages });
      expect(other.nativeContext).not.toContain('青鹭湾北岸');
      expect(other.citations?.some(citation => citation.text.includes('青鹭湾北岸'))).not.toBe(true);

      const groupA = { ...scope, conversationId: 'observers', securityDomainId: 'group' };
      const groupB = { ...groupA, companionId: '小澄' };
      const sharedEvent = 'group-observation', id = createHash('sha256').update(sharedEvent).digest('hex');
      for (const [owner, content] of [[groupA, '我在青石桥看见红尾鸟。'], [groupB, '我在白桦林看见银斑蝶。']] as const) {
        await memory.remember(owner, { sourceEventId: sharedEvent, content, tags: '自然观察,地点,记录', waitForIndex: true, indexTimeoutMs: 30000 });
      }
      expect(await memory.readNote(groupA, { id })).toMatchObject({ content: expect.stringContaining('青石桥') });
      expect(await memory.readNote(groupB, { id })).toMatchObject({ content: expect.stringContaining('白桦林') });
      const question = [{ id: 'where', role: 'user' as const, content: '在哪里观察到的？', timestamp: Date.now() }];
      const before = await memory.prepareTurn({ scope: groupA, requestId: 'where-a', messages: question });
      expect(before.nativeContext).toContain('青石桥');
      expect(before.nativeContext).not.toContain('白桦林');
      await memory.forget(groupA, { id });
      expect(await memory.catalog(groupA, {})).toMatchObject({ total: 0 });
      expect(await memory.catalog(groupB, {})).toMatchObject({ total: 1 });
      const after = await memory.prepareTurn({ scope: groupB, requestId: 'where-b', messages: question });
      expect(after.nativeContext).toContain('白桦林');
      expect(after.nativeContext).not.toContain('青石桥');
    } catch (error) {
      if (workerFailures.length) throw new Error(JSON.stringify(workerFailures), { cause: error });
      throw error;
    } finally {
      try { await memory.close(); } finally { await gateway.close(); await encoder.close(); await rm(root, { recursive: true, force: true }); }
    }
  }, 180000);

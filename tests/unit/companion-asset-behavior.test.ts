import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionAssetProfileStore } from '../../src/main/companions/asset-profile';
import { assembleCompanionAssetContext } from '../../src/main/companions/asset-context';
import { COMPANION_ASSET_BEHAVIOR_DEFAULTS, renderCompanionBehavior } from '../../src/main/companions/asset-behavior-defaults';
import { generateCompanionJournal, generateCompanionMemoryDream } from '../../src/main/companions/memory-model';
import { generateCompanionReply, type CompanionModelConfig } from '../../src/main/companions/model';
import { registryStorageFixture } from '../fixtures/companion-registry-storage';
import type { CompanionReplyInput } from '../../src/main/companions/context';

it('seals role behavior files once, selects exact registered purpose guidance, and rejects later external prompt edits without reseeding', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'companion-behavior-authority-'));
  const registry = registryStorageFixture(root);
  try {
    const companion = { id: 'alice', name: 'Alice', description: '', persona: '当前完整角色人格。', avatar: 'sister' as const,
      model: '', builtin: false, proactive: false, createdAt: '2026-10-26T00:00:00Z' };
    const conversation: CompanionReplyInput['conversation'] = { id: 'private_alice', kind: 'private', memberIds: ['alice'], title: 'Alice', pinned: false,
      muted: false, unread: 0, lastMessage: '', updatedAt: companion.createdAt };
    const profiles = new CompanionAssetProfileStore(path.join(root, 'library'), { registryStorage: registry.storage }), initial = await profiles.bootstrap(companion);
    for (const purpose of Object.keys(COMPANION_ASSET_BEHAVIOR_DEFAULTS)) {
      const file = initial.modules.find(module => module.path.endsWith('/职能-' + purpose + '.md'));
      expect(file?.purposes).toContain(purpose);
      expect(await readFile(path.join(initial.root, ...file!.path.split('/')), 'utf8')).toContain(COMPANION_ASSET_BEHAVIOR_DEFAULTS[purpose]);
    }
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body)), data = JSON.parse(request.messages[1].content);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data.purpose === 'vcp_experience_journal' ? { notes: [] }
        : data.purpose === 'vcp_sleep_reflection' ? { notes: [], dream: null } : { text: '已按当前文件回应。' }) } }] }));
    });
    const config: CompanionModelConfig = { ownerId: companion.id, apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fixture', baseUrl: 'https://provider.invalid',
      resolveAssetContext: async (context, kind) => assembleCompanionAssetContext(context, await profiles.load(companion.id), kind) };
    const input = { companion, conversation, messages: [], relevantMemories: [] };
    await generateCompanionJournal(input, config, undefined, { fetchFn });
    await generateCompanionMemoryDream({ ...input, maintenanceSeparated: true, reflectionOnly: true }, config, undefined, { fetchFn });
    await generateCompanionReply({ companion, conversation, messages: [], memories: [] }, config, undefined, { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    for (const [index, call] of fetchFn.mock.calls.entries()) {
      const request = JSON.parse(String(call[1]?.body)), system = String(request.messages[0].content);
      expect(system).not.toContain('【仅非canonical隔离入口的默认行为开始】');
      if (index < 2) expect(system).not.toContain(companion.persona);
      else expect(system.split(companion.persona)).toHaveLength(2);
      expect(system).toContain('宿主');
    }
    const target = initial.modules.find(module => module.path.endsWith('/职能-companion_reply.md'))!;
    await writeFile(path.join(initial.root, ...target.path.split('/')), 'UNREGISTERED_EXTERNAL_BEHAVIOR');
    await expect(profiles.load(companion.id)).rejects.toMatchObject({ code: 'CHANGED' });
    await expect(generateCompanionReply({ companion, conversation, messages: [], memories: [] }, config, undefined, { fetchFn })).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(3);
    await expect(new CompanionAssetProfileStore(profiles.libraryDirectory, { registryStorage: registry.storage }).bootstrap({ ...companion, persona: '不能覆盖当前文件的初始模板。' })).rejects.toThrow();
    expect(await readFile(path.join(initial.root, ...target.path.split('/')), 'utf8')).toBe('UNREGISTERED_EXTERNAL_BEHAVIOR');
  } finally {
    registry.close();
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('companion-behavior-authority-')) await rm(root, { recursive: true, force: true });
  }
});

it('expands template slots once without interpreting slot-like text inside an authored persona', () => {
  expect(renderCompanionBehavior('{{self.id}} {{self.name}} {{self.persona}} {{mode}}',
    { id: 'alice', name: 'Alice', persona: '我把{{mode}}写成字面内容。', mode: 'sleep_dream' }))
    .toBe('alice Alice 我把{{mode}}写成字面内容。 sleep_dream');
});

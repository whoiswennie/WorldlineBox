import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CompanionsStore } from '../../src/companions/store';
import { generateCompanionReply } from '../../src/main/companions/model';
import { projectCompanionAssetProfile } from '../../src/main/companions/asset-profile';
import { removeOwnedDirectory } from '../../src/main/vcp-memory/filesystem';
import { canonicalInferenceHost } from '../fixtures/companion-canonical-inference';
import { emptyCompanionCharacter, renderCompanionCharacter } from '../../src/shared/companion-character';
import { PERSONA_DIRECTION_PROBES, PERSONA_DIRECTION_QA_CLOCK, PERSONA_DIRECTION_SEED, pairPersonaProvider, personaDirectionDigest } from '../fixtures/persona-direction-causal-contract';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

/** This verifies the actual compiler/snapshot pairing contract without a
 * provider or embeddings. Two legal creation seeds are test inputs here,
 * explicitly not evidence of learned personality or a causal experiment. */
it.each(['same_structure', 'added_section', 'standard_sheet'] as const)('pairs two real canonical native request snapshots with a fixed QA clock and verified persona projection: %s', async shape => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldline-direction-pair-'));
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(PERSONA_DIRECTION_QA_CLOCK);
  try {
    const arm = async (name: string, persona: string) => {
      const directory = path.join(root, name); await mkdir(directory);
      const store = new CompanionsStore(path.join(directory, 'messages.sqlite'), [{ ...PERSONA_DIRECTION_SEED, persona }]);
      const config = { apiFormat: 'openai_chat' as const, model: 'isolated-canonical-pair', apiKey: 'local-no-network', baseUrl: 'http://127.0.0.1/never-network' };
      const host = await canonicalInferenceHost(directory, store, config);
      try {
        const conversation = store.openPrivate('student'), question = store.appendMessage({ conversationId: conversation.id, authorId: 'user', content: PERSONA_DIRECTION_PROBES[0].question, replyDirective: 'none' });
        const profile = await host.profiles.load('student');
        const admittedProfile = { profileRevision: profile.profileRevision, visiblePersona: projectCompanionAssetProfile(profile, [conversation.id]).persona };
        let actualBody = '';
        await generateCompanionReply({ companion: store.state().companions[0]!, conversation, messages: [question], sourceMessage: question, memories: [] },
          await host.configFor({ id: 'student' }), undefined, { loop: true, tools: [], fetchFn: async (_url, init) => {
            actualBody = String(init?.body); return new Response(JSON.stringify({ choices: [{ message: { content: '袖口这点香味像散步带回的小礼物。' } }] }), { headers: { 'content-type': 'application/json' } });
          } });
        const summary = (await host.snapshots.list('student')).items.find(item => item.purpose === 'companion_reply')!;
        const snapshot = await host.snapshots.read('student', summary.id);
        expect(snapshot.bodyHash).toBe(personaDirectionDigest(actualBody)); expect(snapshot.providerBody).toBe(actualBody);
        return { snapshot, question, admittedProfile };
      } finally { await host.close(); store.close(); }
    };
    const persona = shape === 'same_structure' ? PERSONA_DIRECTION_SEED.persona + '遇到闲聊时，倾向先回应具体细节，再自然留白。'
      : shape === 'added_section' ? PERSONA_DIRECTION_SEED.persona + '\n\n【演法核心】\n说话方式：依据真实交流，先接住具体细节。'
        : renderCompanionCharacter(emptyCompanionCharacter('月见'), '【补充设定】\n' + PERSONA_DIRECTION_SEED.persona);
    const b = await arm('B', PERSONA_DIRECTION_SEED.persona), c = await arm('C', persona);
    expect(pairPersonaProvider(b, c)).toMatchObject({ qualified: true, sameRecall: true, differences: [] });
  } finally { vi.useRealTimers(); await removeOwnedDirectory(root); }
}, 30000);

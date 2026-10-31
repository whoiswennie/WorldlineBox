import { describe, expect, it } from 'vitest';
import { companionMemoryRetrievalOptionsSchema, planCompanionMemoryRetrieval, projectCompanionMemoryRetrievalModes, type CompanionMemoryModeRegistration } from '../../src/shared/companion-memory-modes';
import { companionMemoryToolArgumentsSchemas } from '../../src/shared/companion-memory-tool';
import { companionMemoryCapabilitySchema, normalizeCompanionCapabilityCall } from '../../src/shared/companion-capability-tools';

const registration: CompanionMemoryModeRegistration = { available: true, configured: true, enabledByDefault: false, exposure: 'original_preprocess', cost: 'original_stage', observedCalls: 0 };
const catalog = projectCompanionMemoryRetrievalModes({ modes: Object.fromEntries(['focus', 'time', 'time_decay', 'semantic_group', 'expand', 'associate', 'external_rerank', 'meta_thinking'].map(name => [name, { ...registration, configurations: name === 'meta_thinking' ? ['default', '调查'] : [] }])) });
describe('bounded original VCP retrieval intentions', () => {
  it('leaves every optional stage off by default and generates only explicitly requested upstream tokens', () => {
    expect(planCompanionMemoryRetrieval(undefined, catalog)).toEqual({ modifierSuffix: '', requestedModes: [] });
    const plan = planCompanionMemoryRetrieval({ time: { ratio: .3 }, timeDecay: { minScore: .01 }, expand: true, associate: true,
      rerank: { provider: 'external', fusionAlpha: .7 }, metaThinking: { chain: '调查', semanticGroup: true } }, catalog);
    expect(plan.modifierSuffix).toBe('::Time0.3::TimeDecay/0.01::Expand::Associate::Rerank+0.7');
    expect(plan.metaMarker).toBe('[[VCP元思考:调查::Group]]');
    expect(plan.requestedModes).toContain('semantic_group');
    expect(planCompanionMemoryRetrieval({ focus: true }, catalog)).toEqual({ modifierSuffix: '::AIMemo+', requestedModes: ['focus'] });
    expect(planCompanionMemoryRetrieval({ focus: false }, catalog)).toEqual({ modifierSuffix: '', requestedModes: [] });
  });
  it('rejects unknown marker syntax, unbounded settings and unregistered meta chains instead of silently changing the request', () => {
    for (const value of [{ modifiers: '::Group' }, { metaThinking: { chain: 'default::Auto' } }, { time: { ratio: 1.1 } },
      { time: { ratio: 1e-7 } }, { timeDecay: { halfLifeDays: 0 } }, { rerank: { provider: 'custom' } }]) expect(companionMemoryRetrievalOptionsSchema.safeParse(value).success).toBe(false);
    expect(() => planCompanionMemoryRetrieval({ metaThinking: { chain: 'unregistered' } }, catalog)).toThrow('未在当前运行配置');
    const missing = projectCompanionMemoryRetrievalModes({ modes: { external_rerank: { ...registration, available: true, configured: false, reason: '未配置原版 RerankUrl、RerankApi、RerankModel。' } } });
    expect(missing.modes.find(mode => mode.id === 'external_rerank')).toMatchObject({ available: false, configured: false });
    expect(() => planCompanionMemoryRetrieval({ rerank: { provider: 'external' } }, missing)).toThrow('RerankUrl');
    expect(() => planCompanionMemoryRetrieval({ rerank: { provider: 'jev' } }, catalog)).toThrow('未注册');
  });
  it('makes mode discovery available through the actual model schema without permitting a forged owner or raw placeholder', () => {
    expect(companionMemoryCapabilitySchema.parse({ action: 'retrieval_modes' })).toEqual({ action: 'retrieval_modes' });
    expect(normalizeCompanionCapabilityCall({ id: 'test', name: 'memory', arguments: '{"action":"retrieval_modes"}' })).toMatchObject({ name: 'memory.retrieval_modes', arguments: '{}' });
    expect(companionMemoryToolArgumentsSchemas['memory.retrieval_modes'].safeParse({ companionId: 'other' }).success).toBe(false);
    expect(companionMemoryToolArgumentsSchemas['memory.search'].safeParse({ query: '昨天', retrievalOptions: { time: { ratio: .2 } } }).success).toBe(true);
    expect(companionMemoryToolArgumentsSchemas['memory.search'].safeParse({ query: '复杂的问题', retrievalOptions: { focus: true } }).success).toBe(true);
    expect(companionMemoryToolArgumentsSchemas['memory.search'].safeParse({ query: '昨天', retrievalOptions: { marker: '[[other日记本]]' } }).success).toBe(false);
  });
});

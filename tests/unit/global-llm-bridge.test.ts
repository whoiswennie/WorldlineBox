import { beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_AI_ANALYSIS_SETTINGS, toWireAiAnalysisSettings } from '../../src/shared/ai-analysis-settings';

const api = vi.hoisted(() => ({ getAiConfig: vi.fn(), setAiConfig: vi.fn(), testAiConnection: vi.fn(), listAiModels: vi.fn() }));
vi.mock('../../src/preload/bridge/library', () => ({ library: api }));
import { llm } from '../../src/preload/bridge/llm';

beforeEach(() => {
  vi.resetAllMocks();
  api.getAiConfig.mockResolvedValue({ ok: true, value: { apiFormat: 'anthropic', model: 'custom', baseUrl: '', hasKey: true,
    enabledFields: { description: false, tags: false, rating: true }, analysisSettings: toWireAiAnalysisSettings(DEFAULT_AI_ANALYSIS_SETTINGS),
    languages: ['ko'], concurrencyLimit: 3, maxAnalysisImageEdgePx: 768, reliabilitySettings: {}, autoAnalyzeEnabled: false, disclaimerAccepted: true } });
  api.setAiConfig.mockResolvedValue({ ok: true });
});

it('changes the global model without requiring a library or resetting asset policy and stored credentials', async () => {
  await llm.setConfig({ apiFormat: 'openai_chat', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' });
  expect(api.setAiConfig).toHaveBeenCalledWith(expect.objectContaining({ apiFormat: 'openai_chat', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com',
    enabledFields: { description: false, tags: false, rating: true }, languages: ['ko'], autoAnalyzeEnabled: false, disclaimerAccepted: true }));
  expect(api.setAiConfig.mock.calls[0]![0]).not.toHaveProperty('apiKey');
  expect(api.setAiConfig.mock.calls[0]![0]).not.toHaveProperty('libraryId');
  expect((await llm.getConfig())).not.toHaveProperty('value.apiKey');
});

it('does not save partial defaults if the existing global configuration cannot be read', async () => {
  const failure = { ok: false, error: { code: 'AI_SETTINGS_INCOMPLETE' } };
  api.getAiConfig.mockResolvedValue(failure);
  expect(await llm.setConfig({ apiFormat: 'openai_chat', model: 'deepseek-flash' })).toEqual(failure);
  expect(api.setAiConfig).not.toHaveBeenCalled();
});

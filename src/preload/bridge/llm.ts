import type { WorldlineBoxLlmApi } from '../../shared/llm';
import { library } from './library';

// Reuse the validated Main routes and encrypted application store. The library
// bridge retains its aliases for existing clients; model ownership is global.
export const llm: WorldlineBoxLlmApi = Object.freeze({
  getConfig: () => library.getAiConfig(),
  async setConfig(input: Parameters<WorldlineBoxLlmApi['setConfig']>[0]) {
    const current = await library.getAiConfig();
    if (!current.ok) return current;
    return library.setAiConfig({
      enabledFields: current.value.enabledFields,
      analysisSettings: current.value.analysisSettings,
      concurrencyLimit: current.value.concurrencyLimit,
      maxAnalysisImageEdgePx: current.value.maxAnalysisImageEdgePx,
      reliabilitySettings: current.value.reliabilitySettings,
      languages: current.value.languages,
      autoAnalyzeEnabled: current.value.autoAnalyzeEnabled,
      disclaimerAccepted: current.value.disclaimerAccepted,
      ...input,
    });
  },
  testConnection: (input: Parameters<WorldlineBoxLlmApi['testConnection']>[0]) => library.testAiConnection(input),
  listModels: (input: Parameters<WorldlineBoxLlmApi['listModels']>[0]) => library.listAiModels(input),
});

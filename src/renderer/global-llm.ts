import type { WorldlineBoxLlmApi } from '../shared/llm';

export function getGlobalLlmApi(): WorldlineBoxLlmApi | undefined {
  return (window as Window & { worldlinebox?: { llm?: WorldlineBoxLlmApi } }).worldlinebox?.llm;
}

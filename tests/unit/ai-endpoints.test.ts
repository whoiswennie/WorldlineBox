import { describe, expect, it, vi } from 'vitest';

import {
  AI_API_FORMATS,
  DEFAULT_AI_API_FORMAT,
  DEFAULT_AI_BASE_URLS,
  DEFAULT_AI_MODELS,
  effectiveAiBaseUrl,
  formatAiLanguagesForPrompt,
  listAiModels,
  migrateLegacyProviderToApiFormat,
  normalizeAiBaseUrl,
  normalizeAiLanguages,
  resolveAnthropicMessagesUrl,
  resolveDashScopeMultimodalGenerationUrl,
  resolveOpenAiChatCompletionsUrl,
  resolveOpenAiModelsUrl,
  resolveOpenAiResponsesUrl,
} from '../../src/shared/ai-endpoints';

describe('AI API format defaults (user decision 2026-09-13)', () => {
  it('defaults to Anthropic Messages', () => {
    expect(DEFAULT_AI_API_FORMAT).toBe('anthropic');
    expect(AI_API_FORMATS).toContain(DEFAULT_AI_API_FORMAT);
  });

  /**
   * Format and model are one pair. A fresh profile that defaulted the wire
   * protocol to Anthropic while keeping the old DashScope model id would fail
   * its first probe with a confusing provider error, so the pairing is asserted
   * for every format rather than only for the default.
   */
  it('pairs every format with a non-empty default model', () => {
    expect(DEFAULT_AI_MODELS[DEFAULT_AI_API_FORMAT]).toBe('claude-sonnet-4-20250514');
    for (const format of AI_API_FORMATS) {
      expect(DEFAULT_AI_MODELS[format]?.trim().length ?? 0).toBeGreaterThan(0);
      expect(DEFAULT_AI_BASE_URLS[format]?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('ai-endpoints URL resolution', () => {
  it('uses official defaults when baseUrl is empty', () => {
    expect(normalizeAiBaseUrl('')).toBeUndefined();
    expect(effectiveAiBaseUrl('openai_chat')).toBe(DEFAULT_AI_BASE_URLS.openai_chat);
    expect(resolveOpenAiChatCompletionsUrl()).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
    expect(resolveOpenAiResponsesUrl()).toBe(
      'https://api.openai.com/v1/responses',
    );
    expect(resolveAnthropicMessagesUrl()).toBe(
      'https://api.anthropic.com/v1/messages',
    );
    expect(resolveDashScopeMultimodalGenerationUrl()).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    );
  });

  it('adds /v1 for host-only OpenAI bases but keeps path prefixes (CC Switch style)', () => {
    expect(resolveOpenAiChatCompletionsUrl('https://relay.example')).toBe(
      'https://relay.example/v1/chat/completions',
    );
    expect(resolveOpenAiChatCompletionsUrl('https://relay.example/v1')).toBe(
      'https://relay.example/v1/chat/completions',
    );
    expect(resolveOpenAiResponsesUrl('https://api.qcode.cc/openai')).toBe(
      'https://api.qcode.cc/openai/responses',
    );
    expect(resolveOpenAiChatCompletionsUrl('https://relay.example/v1/')).toBe(
      'https://relay.example/v1/chat/completions',
    );
  });

  it('collapses duplicated /v1/v1 when joining', () => {
    expect(resolveOpenAiModelsUrl('openai_chat', 'https://relay.example/v1')).toBe(
      'https://relay.example/v1/models',
    );
    expect(resolveAnthropicMessagesUrl('https://proxy.example/api')).toBe(
      'https://proxy.example/api/v1/messages',
    );
    expect(resolveAnthropicMessagesUrl('https://proxy.example/v1')).toBe(
      'https://proxy.example/v1/messages',
    );
  });

  it('converts Model Studio compatible-mode workspace URLs to the native DashScope root', () => {
    expect(resolveDashScopeMultimodalGenerationUrl(
      'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    )).toBe(
      'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    );
  });

  it('maps legacy provider brands to CC Switch apiFormat', () => {
    expect(migrateLegacyProviderToApiFormat('openai')).toBe('openai_chat');
    expect(migrateLegacyProviderToApiFormat('gemini')).toBe('gemini_native');
    expect(migrateLegacyProviderToApiFormat('anthropic')).toBe('anthropic');
    expect(migrateLegacyProviderToApiFormat('openai_responses')).toBe(
      'openai_responses',
    );
  });

  it('normalizes to a single language (first pick) with zh-CN default', () => {
    expect(normalizeAiLanguages('auto')).toEqual(['zh-CN']);
    expect(normalizeAiLanguages('zh-CN')).toEqual(['zh-CN']);
    expect(normalizeAiLanguages(['en', 'zh-CN', 'en'])).toEqual(['en']);
    expect(formatAiLanguagesForPrompt(['zh-CN'])).toContain('Chinese');
    expect(formatAiLanguagesForPrompt(['en'])).toContain('English');
  });
});

describe('listAiModels', () => {
  it('parses OpenAI-compatible model lists for chat format', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const result = await listAiModels({
      apiFormat: 'openai_chat',
      apiKey: 'sk-test',
      baseUrl: 'https://relay.example/v1',
      fetchFn,
    });

    expect(result).toEqual({
      ok: true,
      models: ['gpt-4o', 'gpt-4o-mini'],
    });
    expect(fetchFn).toHaveBeenCalledWith(
      'https://relay.example/v1/models',
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });

  it('provides native DashScope visual-model presets without a brittle model-list request', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const result = await listAiModels({
      apiFormat: 'dashscope_native',
      apiKey: 'sk-test',
      fetchFn,
    });

    expect(result).toEqual({
      ok: true,
      models: ['qwen3-vl-flash', 'qwen3-vl-plus'],
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

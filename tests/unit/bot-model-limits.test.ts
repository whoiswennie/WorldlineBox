import { describe, expect, it } from 'vitest';
import { botModelsMetadataUrl, resolveBotModelLimits } from '../../src/main/companion-bot/model-limits';
import { appBrainRequest, fitsAppBrainRequest } from '../../src/main/companion-bot/app-brain-budget';
import type { BotDshModel } from '../../src/main/companion-bot/dsh-brain';

const deepseek = { model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1' };
describe('model-specific context provenance and output bounds', () => {
  it('uses the documented official DeepSeek window and keeps ordinary output at 4096', () => {
    expect(resolveBotModelLimits(deepseek)).toMatchObject({ window: 1048576, maxTokens: 4096, maxOutputTokens: 393216, source: 'official-default',
      sourceUrl: 'https://api-docs.deepseek.com/api/list-models/', contextEstimate: 'utf8-byte-upper-bound' });
    expect(resolveBotModelLimits({ ...deepseek, model: 'deepseek-v4-pro' }).window).toBe(1048576);
  });
  it('uses the API window for the documented GPT6.1 family, without borrowing the Codex app default', () => {
    for (const model of ['gpt-6.1-sol', 'gpt-6.1', 'gpt-6.1-sol-2026-10-01']) {
      expect(resolveBotModelLimits({ model, baseUrl: 'https://api.openai.com/v1' })).toMatchObject({ window: 1050000, maxOutputTokens: 128000, maxTokens: 4096 });
    }
  });
  it('does not invent a million-token limit for proxies, unknown models, aliases or spoofed hosts', () => {
    for (const input of [{ ...deepseek, baseUrl: 'https://proxy.example/v1' }, { ...deepseek, model: 'deepseek-chat' },
      { ...deepseek, model: 'unverified-model' }, { ...deepseek, baseUrl: 'https://api.deepseek.com.evil.example/v1' },
      { model: 'gpt-6.1-mini-unverified', baseUrl: 'https://api.openai.com/v1' }, { ...deepseek, baseUrl: 'http://api.deepseek.com/v1' }]) {
      expect(resolveBotModelLimits(input)).toMatchObject({ window: 65536, source: 'unknown', maxTokens: 4096 });
    }
  });
  it('prefers a trusted explicit context override and actual same-model output metadata', () => {
    expect(resolveBotModelLimits({ ...deepseek, contextWindow: 262144, maxTokens: 9000 }, { id: deepseek.model, context_window: 128000, max_output_tokens: 8192 }))
      .toMatchObject({ window: 262144, maxTokens: 8192, source: 'explicit', outputClamped: true });
  });
  it('uses matching /models metadata before documented defaults and accepts supported integer aliases', () => {
    for (const key of ['context_window', 'context_length', 'contextWindow', 'max_context_tokens', 'max_context_length']) {
      expect(resolveBotModelLimits(deepseek, { data: [{ id: 'other', [key]: 9000000 }, { id: deepseek.model, [key]: 524288 }] }))
        .toMatchObject({ window: 524288, source: 'metadata', sourceUrl: 'https://api.deepseek.com/v1/models' });
    }
    expect(resolveBotModelLimits({ model: 'custom', baseUrl: 'https://proxy.example/api/v1' }, { id: 'custom', limits: { context_length: 131072, max_completion_tokens: 1024 } }))
      .toMatchObject({ window: 131072, maxTokens: 1024, source: 'metadata' });
  });
  it('never applies a different model record, even when its display name matches', () => {
    expect(resolveBotModelLimits(deepseek, { id: 'other', name: deepseek.model, context_window: 9000000 }).source).toBe('official-default');
    expect(resolveBotModelLimits({ model: 'custom', baseUrl: 'https://proxy.example' }, { data: [{ id: 'other', context_window: 9000000 }] }).source).toBe('unknown');
  });
  it.each(['1048576', 1.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('rejects invalid explicit values and ignores malformed metadata (%s)', value => {
    expect(() => resolveBotModelLimits({ ...deepseek, contextWindow: value as number })).toThrow(/positive safe integer/);
    expect(() => resolveBotModelLimits({ ...deepseek, maxTokens: value as number })).toThrow(/positive safe integer/);
    expect(resolveBotModelLimits(deepseek, { id: deepseek.model, context_window: value }).window).toBe(1048576);
  });
  it('reserves output inside tiny explicit test windows and respects actual provider output maxima', () => {
    expect(resolveBotModelLimits({ model: 'fixture', baseUrl: 'https://fixture.invalid', contextWindow: 4096 }).maxTokens).toBe(1024);
    expect(resolveBotModelLimits({ ...deepseek, maxTokens: 500000 }).maxTokens).toBe(393216);
    expect(resolveBotModelLimits({ ...deepseek, contextWindow: 1024, maxTokens: 4096 }).maxTokens).toBe(768);
  });
  it('normalizes discovery endpoint provenance without leaking endpoint credentials or query data', () => {
    expect(botModelsMetadataUrl('https://user:password@proxy.example/service/v1/chat/completions?key=private#fragment')).toBe('https://proxy.example/service/v1/models');
    expect(botModelsMetadataUrl('https://api.deepseek.com/')).toBe('https://api.deepseek.com/models');
  });
});

it('allows a real million-token model beyond the old 100k character ceiling while retaining explicit stress-test limits', () => {
  const model: BotDshModel = { ...deepseek, apiFormat: 'openai_chat', apiKey: 'fixture-no-billing' };
  const body = appBrainRequest(model, '系统', [{ role: 'user', content: '中文'.repeat(60000) }], [], true);
  expect(body.max_tokens).toBe(4096);
  expect(fitsAppBrainRequest(body, model)).toBe(true);
  expect(fitsAppBrainRequest(body, model, 100000)).toBe(false);
  expect(fitsAppBrainRequest(body, { ...model, contextWindow: 32768 })).toBe(false);
});

it('includes UTF8 input, output reservation and framing headroom in the hard request gate', () => {
  const model: BotDshModel = { model: 'fixture', baseUrl: 'https://fixture.invalid', apiFormat: 'openai_chat', apiKey: 'fixture', contextWindow: 4096, maxTokens: 256 };
  const body = appBrainRequest(model, '', [{ role: 'user', content: '中'.repeat(1500) }], [], true);
  expect(JSON.stringify(body).length).toBeLessThan(4096);
  expect(fitsAppBrainRequest(body, model)).toBe(false);
});

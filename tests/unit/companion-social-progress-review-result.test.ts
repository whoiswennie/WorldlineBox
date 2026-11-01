import { expect, it, vi } from 'vitest';
import { companionSocialProgressReviewResultSchema, reviewCompanionSocialProgress } from '../../src/main/companions/social-progress-review';

const config = { apiFormat: 'openai_chat' as const, model: 'review-result-fixture', apiKey: 'fixture-only', baseUrl: 'https://fixture.invalid' };
const proposed = '我已给伙伴发出了这条消息。';
const violation = { kind: 'social_effect', quote: proposed };
const acceptedJSON = '{"supported":true,"correction":"","violation":null}';
const response = (raw: string) => new Response(JSON.stringify({ choices: [{ message: { content: raw } }] }),
  { headers: { 'Content-Type': 'application/json' } });

it('accepts the original affirmative JSON with an explicit null violation without invoking structured repair', async () => {
  const resolveStructuredRepairConfig = vi.fn(async () => { throw new Error('An accepted verdict must not be sent to another model.'); });
  const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    expect(JSON.parse(request.messages[1].content).proposedText).toBe(proposed);
    return response(acceptedJSON);
  });
  expect(await reviewCompanionSocialProgress(proposed, [], { ...config, resolveStructuredRepairConfig }, undefined,
    { requireReview: true, fetchFn })).toBeUndefined();
  expect(fetchFn).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.anything());
  expect(resolveStructuredRepairConfig).not.toHaveBeenCalled();
});

it('retains the existing affirmative-without-violation contract and permits only an empty correction', () => {
  expect(companionSocialProgressReviewResultSchema.parse({ supported: true, correction: '' })).toEqual({ supported: true, correction: '' });
  expect(companionSocialProgressReviewResultSchema.parse(JSON.parse(acceptedJSON))).toEqual({ supported: true, correction: '', violation: null });
  expect(companionSocialProgressReviewResultSchema.parse({ supported: true, correction: '  ', violation: null }).correction).toBe('');
});

it.each([
  { supported: true, correction: '', violation },
  { supported: true, correction: '这项声明没有回执。', violation: null },
  { supported: false, correction: '这项声明没有回执。', violation: null },
  { supported: false, correction: '这项声明没有回执。' },
  { supported: false, correction: '', violation },
  { supported: false, correction: '  ', violation },
  { supported: false, correction: '需要核验。', violation: { kind: 'unknown_kind', quote: proposed } },
  { supported: false, correction: '需要核验。', violation: { kind: 'social_effect', quote: '' } },
  { supported: 'true', correction: '', violation: null },
])('refuses a contradictory or incomplete result without silently accepting it: %j', value => {
  expect(companionSocialProgressReviewResultSchema.safeParse(value).success).toBe(false);
});

it('preserves unknown-field stripping and does not turn an extra supported lookalike into a verdict', () => {
  expect(companionSocialProgressReviewResultSchema.parse({ supported: true, correction: '', violation: null,
    extra: { supported: false, correction: 'Do not reinterpret this unknown property.' } })).toEqual(JSON.parse(acceptedJSON));
  expect(companionSocialProgressReviewResultSchema.safeParse({ extra: { supported: true }, correction: '', violation: null }).success).toBe(false);
  expect(companionSocialProgressReviewResultSchema.parse({ supported: false, correction: '没有对应的发送回执。',
    violation: { ...violation, extra: true }, extra: { supported: true } })).toEqual({ supported: false,
    correction: '没有对应的发送回执。', violation });
});

it('still rejects a genuine unsupported delivery and requires the exact proposed quote', async () => {
  const fetchFn = vi.fn<typeof fetch>(async () => response(JSON.stringify({ supported: false, correction: '没有对应的发送回执。', violation })));
  expect(await reviewCompanionSocialProgress(proposed, [], config, undefined, { requireReview: true, fetchFn })).toBe('没有对应的发送回执。');
  expect(fetchFn).toHaveBeenCalledOnce();
  await expect(reviewCompanionSocialProgress(proposed, [], config, undefined, { requireReview: true,
    fetchFn: async () => response(JSON.stringify({ supported: false, correction: '没有对应的发送回执。', violation: { ...violation, quote: '不是实际拟稿。' } })) }))
    .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});

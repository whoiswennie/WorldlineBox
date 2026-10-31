import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { activityDecisionJsonSchema, activityDecisionSchema, activityAgentDecisionSchema } from '../../src/shared/companion-activity-task';

// The locked ajv-formats dependency already carries Ajv 8. Use its draft-2020
// validator for Zod's original schema without changing the product dialect.
const require = createRequire(import.meta.url);
const requireAjv8 = createRequire(require.resolve('ajv-formats/package.json'));
const Ajv2020 = requireAjv8('ajv/dist/2020').default as new (options: { strict: boolean; allErrors: boolean; validateFormats: boolean }) => {
  compile(schema: object): (data: unknown) => boolean;
};
const validate = new Ajv2020({ strict: false, allErrors: true, validateFormats: false }).compile(activityDecisionJsonSchema());
const values = {
  action: { action: 'inspect' }, wait: { kind: 'reply', targetCompanionId: 'peer' },
  memory: { operation: 'search', query: '本人经历' }, topic: { action: 'read', topicId: 'topic' },
};

it('matches the actor-only Zod contract for every omitted/null/value combination and status', () => {
  const fields = ['action', 'wait', 'memory', 'topic'] as const;
  for (const status of ['continue', 'complete', 'blocked']) for (let combination = 0; combination < 3 ** fields.length; combination++) {
    const proposal: Record<string, unknown> = { status, summary: '按实际资料决定下一步。' };
    let remaining = combination;
    for (const field of fields) {
      const state = remaining % 3; remaining = Math.floor(remaining / 3);
      if (state) proposal[field] = state === 1 ? null : values[field];
    }
    expect(validate(proposal), JSON.stringify(proposal)).toBe(activityAgentDecisionSchema.safeParse(proposal).success);
  }
});

it('rejects the real topic-read plus reply-wait shape while preserving action plus wait', () => {
  const invalid = { status: 'continue', summary: '先读话题，再等回复。', action: null, memory: null, topic: values.topic, wait: values.wait };
  expect(activityDecisionSchema.safeParse(invalid).success).toBe(false); expect(validate(invalid)).toBe(false);
  const existing = { status: 'continue', summary: '发出本人消息后等真实回复。', action: { action: 'message', recipientIds: ['peer'], text: '请告知实际结果。' }, wait: values.wait };
  expect(activityDecisionSchema.safeParse(existing).success).toBe(true); expect(validate(existing)).toBe(true);
});

it('keeps original field schemas, required fields and strict unknown-field rejection', () => {
  const original = z.toJSONSchema(activityAgentDecisionSchema, { io: 'input' });
  const schema = activityDecisionJsonSchema();
  expect(schema.properties).toEqual(original.properties); expect(schema.required).toEqual(original.required);
  expect(schema.additionalProperties).toBe(false);
  for (const proposal of [
    { status: 'continue', action: null, wait: null, summary: '只有计划', planningState: { summary: '计划', nextSteps: [], constraints: [] } },
    { status: 'complete', action: null, wait: null, summary: '完成', invented: true },
    { status: 'blocked', action: null, wait: null, summary: '受阻', topic: { action: 'read', topicId: 'topic', invented: true } },
  ]) { expect(activityDecisionSchema.safeParse(proposal).success).toBe(false); expect(validate(proposal)).toBe(false); }
});

it('retains legacy decisions for audit while refusing memory or experience proposals from an actor', () => {
  const legacy = { status: 'continue', action: null, wait: null, memory: values.memory, summary: '旧记忆提案' };
  expect(activityDecisionSchema.safeParse(legacy).success).toBe(true);
  expect(activityAgentDecisionSchema.safeParse(legacy).success).toBe(false); expect(validate(legacy)).toBe(false);
  expect(activityDecisionJsonSchema().properties).not.toHaveProperty('memory');
  expect(validate({ status: 'continue', action: { action: 'experience', parameters: { action: 'days' } }, wait: null, summary: '绕过工具回顾经历' })).toBe(false);
});

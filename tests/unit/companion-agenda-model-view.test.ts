import { describe, expect, it } from 'vitest';
import { companionAgendaModelView } from '../../src/main/companions/agenda-model-view';
import type { CompanionAgendaResponse } from '../../src/shared/companion-agenda';
import { boundaryGoal, boundaryGrant, boundaryNow, boundaryOccurrence, boundaryRule, boundaryRun } from './companion-agenda-boundary-fixtures';

function response(): CompanionAgendaResponse {
  return { ok: true, agenda: { companionId: 'alice', rules: [boundaryRule()], occurrences: [boundaryOccurrence()], runs: [boundaryRun()],
    goals: [boundaryGoal()], grants: [boundaryGrant()], hasMore: false, revision: 1, observedAt: boundaryNow } };
}

describe('model calendar message-port view', () => {
  it('redacts scheduled and long-term task source classifications and private owner responses together', () => {
    const taskResponse = { decision: 'accept' as const, message: 'PRIVATE_owner_response', at: boundaryNow, by: 'self' as const };
    const rule = { ...boundaryRule(), taskResponse, presentation: { title: 'PRIVATE_native_activity_title', intent: 'PRIVATE_native_activity_goal' }, classification: { basis: 'source_task' as const, reason: 'PRIVATE_classification_reason', sourceMessageId: 'PRIVATE_message', sourceConversationId: 'PRIVATE_room', sourceAuthorId: 'PRIVATE_author' } };
    const goal = { ...boundaryGoal(), taskResponse };
    const original = { ok: true, agendaRule: rule, agendaGoal: goal, agendaTasks: [{ form: 'scheduled' as const, rule }, { form: 'longterm' as const, goal }] }, before = JSON.stringify(original);
    const result = companionAgendaModelView(original, { conversationId: 'group-room', allowPrivate: false });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    expect(result.agendaTasks).toHaveLength(2); expect(result.agendaTasks![0]!.form).toBe('scheduled');
    expect(companionAgendaModelView(original, { conversationId: 'own-room', allowPrivate: true }).agendaGoal!.taskResponse?.message).toBe('PRIVATE_owner_response');
    expect(companionAgendaModelView(original, { conversationId: 'own-room', allowPrivate: true }).agendaTasks![0]).toMatchObject({ rule: { presentation: rule.presentation } });
    expect(JSON.stringify(original)).toBe(before);
  });
  it('keeps owner-port content complete while hiding execution authority and preserving source records', () => {
    const original = response(), before = JSON.stringify(original);
    const result = companionAgendaModelView(original, { conversationId: 'owner-view', allowPrivate: true });
    expect(result.agenda!.rules[0]!.intent).toBe('PRIVATE_intent'); expect(result.agenda!.goals[0]!.materials).toEqual(boundaryGoal().materials);
    expect(result.agenda!.runs[0]!.result).toBe('PRIVATE_output'); expect(result.agenda!.runs[0]!.leaseToken).toBeUndefined();
    expect(result.agenda!.runs[0]!.leaseUntil).toBeUndefined();
    expect(JSON.stringify(original)).toContain('PRIVATE_checkpoint'); expect(JSON.stringify(original)).toBe(before);
  });
  it.each(['peer-room', 'group-room'])('reveals only timing/status for private commitments in %s', conversationId => {
    const original = response(), before = JSON.stringify(original);
    const result = companionAgendaModelView(original, { conversationId, allowPrivate: false });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_'); expect(JSON.stringify(result)).not.toContain('private.example.com');
    expect(result.agenda!.rules[0]!.trigger).toEqual(original.agenda!.rules[0]!.trigger);
    expect(result.agenda!.occurrences[0]!.scheduledAt).toBe(boundaryNow);
    expect(result.agenda!.runs[0]!.status).toBe('running'); expect(result.agenda!.grants).toEqual([]);
    expect(result.agenda!.runs[0]!.leaseToken).toBeUndefined(); expect(result.agenda!.runs[0]!.leaseUntil).toBeUndefined();
    expect(JSON.stringify(original)).toBe(before);
  });
  it('also protects self-authored learning and arrangements based on another private port', () => {
    const original = response(); original.agenda!.rules[0]!.origin = 'self'; original.agenda!.goals[0]!.origin = 'self';
    expect(JSON.stringify(companionAgendaModelView(original, { conversationId: 'group-room', allowPrivate: false }))).not.toContain('PRIVATE_');
  });
  it('retains content that belongs to the current message port', () => {
    const result = companionAgendaModelView(response(), { conversationId: 'own-room', allowPrivate: false });
    expect(result.agenda!.rules[0]!.intent).toBe('PRIVATE_intent'); expect(result.agenda!.goals[0]!.materials).toEqual(boundaryGoal().materials);
    // A model calendar read is metadata; execution bodies stay outside this port even for its own rule.
    expect(result.agenda!.runs[0]!.result).toBeUndefined();
  });
  it('blocks private detail reads and strips standalone run bodies and internal claims/steps', () => {
    const detail = { ok: true, agendaEvent: { rule: boundaryRule(), occurrences: [boundaryOccurrence()], runs: [boundaryRun()], steps: [] } };
    const denied = companionAgendaModelView(detail, { conversationId: 'group-room', allowPrivate: false });
    expect(denied.ok).toBe(false); expect(denied.agendaEvent).toBeUndefined();
    const rule = boundaryRule(), occurrence = boundaryOccurrence(), run = boundaryRun();
    const result = companionAgendaModelView({ ok: true, agendaRule: rule, agendaGoal: boundaryGoal(), agendaGoals: [boundaryGoal()],
      agendaGrant: boundaryGrant(), agendaGrants: [boundaryGrant()], agendaRun: run, agendaOccurrence: occurrence,
      agendaClaim: { rule, occurrence, run, leaseToken: 'lease' }, agendaClaims: [{ rule, occurrence, run, leaseToken: 'lease' }],
      agendaSteps: [{ id: 'step', runId: run.id, companionId: 'alice', effectKey: 'PRIVATE_effect', title: 'PRIVATE_step', status: 'succeeded', result: 'PRIVATE_result', createdAt: boundaryNow, updatedAt: boundaryNow }] },
    { conversationId: 'peer-room', allowPrivate: false });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_'); expect(result.agendaClaims).toBeUndefined(); expect(result.agendaSteps).toBeUndefined();
  });
  it('does not expose event topics or emitted event keys from a hidden private rule', () => {
    const original = response(); original.agenda!.rules[0]!.trigger = { kind: 'event', topic: 'PRIVATE_event-topic', quietSeconds: 1 };
    original.agenda!.occurrences[0]!.eventKey = 'PRIVATE_event-key';
    expect(JSON.stringify(companionAgendaModelView(original, { conversationId: 'group-room', allowPrivate: false }))).not.toContain('PRIVATE_');
  });
  it('does not leak runs outside the current rule page', () => {
    const original = response(); original.agenda!.rules = [];
    expect(JSON.stringify(companionAgendaModelView(original, { conversationId: 'peer-room', allowPrivate: false }))).not.toContain('PRIVATE_');
  });
  it('does not treat a mutable system wake-up as a public commitment', () => {
    const original = response(); original.agenda!.rules[0]!.origin = 'system';
    expect(JSON.stringify(companionAgendaModelView(original, { conversationId: 'group-room', allowPrivate: false }))).not.toContain('PRIVATE_');
  });
  it.each(['activity', 'chat', 'memory'] as const)('hides a protected system %s event outside its sealed conversation', executor => {
    const original = response(); original.agenda!.rules[0] = { ...boundaryRule(), origin: 'system', protected: true, executor };
    const before = JSON.stringify(original);
    const projected = companionAgendaModelView(original, { conversationId: 'group-room', allowPrivate: false });
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_');
    expect(projected.agenda!.occurrences[0]!.scheduledAt).toBe(boundaryNow);
    expect(projected.agenda!.runs[0]!.status).toBe('running');
    expect(JSON.stringify(original)).toBe(before);
    const detail = companionAgendaModelView({ ok: true, agendaEvent: { rule: original.agenda!.rules[0]!, occurrences: [boundaryOccurrence()], runs: [boundaryRun()], steps: [] } },
      { conversationId: 'group-room', allowPrivate: false });
    expect(detail.ok).toBe(false); expect(detail.agendaEvent).toBeUndefined();
  });
  it('keeps same-port protected base detail semantic and excludes private work bodies', () => {
    const rule = { ...boundaryRule(), origin: 'system' as const, protected: true, title: '整理经历', intent: '整理真实经历', reason: '基础事件', conditions: [] };
    const occurrence = { ...boundaryOccurrence(), reason: '后台已开始', conditionResults: [], eventKey: 'PRIVATE_event-key' };
    const result = companionAgendaModelView({ ok: true, agendaEvent: { rule, occurrences: [occurrence], runs: [boundaryRun()],
      steps: [{ id: 'step', runId: 'run', companionId: 'alice', effectKey: 'PRIVATE_effect', title: 'PRIVATE_step', status: 'succeeded', result: 'PRIVATE_result', createdAt: boundaryNow, updatedAt: boundaryNow }] } },
    { conversationId: 'own-room', allowPrivate: false });
    expect(result.ok).toBe(true); expect(JSON.stringify(result)).not.toContain('PRIVATE_'); expect(result.agendaEvent!.steps).toEqual([]);
  });
});

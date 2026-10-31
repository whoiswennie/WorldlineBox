import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { generateCompanionStructured, generateCompanionText, repairCompanionStructured, type CompanionModelConfig } from '../../src/main/companions/model';
import { companionModelQuota } from '../../src/main/companions/model-quota';
import type { CompanionContextFrame } from '../../src/shared/companion-cognition';

const config: CompanionModelConfig = { apiFormat: 'openai_chat', model: 'private-role-model', apiKey: 'role-secret', ownerId: 'alice' };
const context = { system: 'Only extract actual supplied evidence.', user: JSON.stringify({ purpose: 'vcp_experience_journal',
  messages: [{ id: 'source1', authorId: 'user', content: '三本书，十四天；预约后不能续借。' }], outputSchema: { type: 'object', required: ['notes'] } }) };
const schema = z.strictObject({ notes: z.array(z.string()) });
const response = (content: string) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { headers: { 'Content-Type': 'application/json' } });
const payload = (init?: RequestInit) => JSON.parse(String(init?.body)) as { model: string; messages: Array<{ role: string; content: string }> };
const frame: CompanionContextFrame = { schema: 'worldlinebox.companion-context-v2', companionId: 'alice', purpose: 'vcp_experience_journal',
  profileRevision: 'a'.repeat(64), promptRevision: 'b'.repeat(64), revocationEpoch: 1, invocationId: 'capture:fixed:attempt1', conversationId: 'private_alice',
  identity: '', roleGuidance: '', processorContract: context.system, input: context.user,
  sourceRefs: [{ artifactId: 'source:source1:r1', contentRevision: 1, contentHash: 'c'.repeat(64) }] };

describe('bounded background global-model structural repair', () => {
  it('keeps an existing denial while repairing another field and never flips false into authorization', async () => {
    const original = '{"allowed":false,"spellingWrong":"原有拒绝仍有效"}', fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(original)).mockResolvedValueOnce(response('{"allowed":true,"reason":"原有拒绝仍有效"}'))
      .mockResolvedValueOnce(response('{"allowed":false,"reason":"原有拒绝仍有效"}'));
    const result = await generateCompanionStructured(context, config, undefined, { fetchFn, responseSchema: z.strictObject({ allowed: z.boolean(), reason: z.string() }),
      repairPreserveValues: [{ path: ['allowed'] }, { path: ['optionalMissingField'] }] });
    expect(result).toEqual({ allowed: false, reason: '原有拒绝仍有效' }); expect(fetchFn).toHaveBeenCalledTimes(3);
    const last = JSON.parse(payload(fetchFn.mock.calls[2]?.[1]).messages[1]!.content);
    expect(last.originalOutput).toBe(original); expect(last.validationErrors[0].code).toBe('repair_content_loss');
    expect(last.preserveValues).toEqual([{ path: ['allowed'] }, { path: ['optionalMissingField'] }]);
  });
  it.each(['null', 'defer'] as const)('refuses to erase an original action into %s while adding the missing format field', async next => {
    const action = { action: 'visit', targetCompanionId: 'peer', reason: '原有询问许可' }, original = JSON.stringify({ action });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response(original)).mockImplementation(async () => response(JSON.stringify({ action: next === 'null' ? null : { action: 'defer' }, reason: '为了通过结构检查而删除原行动' })));
    await expect(generateCompanionStructured(context, config, undefined, { fetchFn,
      responseSchema: z.strictObject({ action: z.record(z.string(), z.unknown()).nullable(), reason: z.string() }),
      repairPreserveValues: [{ path: ['action'] }] })).rejects.toMatchObject({ diagnostic: 'structured_repair_exhausted' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
  it('keeps original null and empty results legal but never repairs unreadable material into a null result', async () => {
    const nullable = z.strictObject({ action: z.object({ text: z.string() }).nullable(), reason: z.string() }), keep = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response('{"action":null}')).mockResolvedValueOnce(response('{"action":null,"reason":"当前没有行动"}'));
    expect(await generateCompanionStructured(context, config, undefined, { fetchFn: keep, responseSchema: nullable,
      repairPreserveValues: [{ path: ['action'] }] })).toEqual({ action: null, reason: '当前没有行动' });
    const broken = vi.fn<typeof fetch>().mockResolvedValueOnce(response('{"text":"实际叙述"'))
      .mockImplementation(async () => response('null'));
    await expect(generateCompanionStructured(context, config, undefined, { fetchFn: broken, responseSchema: z.object({ text: z.string() }).nullable(),
      repairPreserveValues: [{ path: ['text'] }] })).rejects.toMatchObject({ diagnostic: 'structured_repair_exhausted' });
    expect(broken).toHaveBeenCalledTimes(3);
  });
  it('never converts an exact source identifier 001 into a numeric identity', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response('{"sourceId":"001"}')).mockImplementation(async () => response('{"sourceId":1}'));
    await expect(generateCompanionStructured(context, config, undefined, { fetchFn, responseSchema: z.object({ sourceId: z.number() }),
      repairPreserveValues: [{ path: ['sourceId'] }] })).rejects.toMatchObject({ diagnostic: 'structured_repair_exhausted' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
  it.each([{ steps: ['先备份', '后修改'] }, { steps: ['核对', '核对'] }])('keeps nested procedure order and multiplicity instead of treating its steps as a set %#', async ({ steps }) => {
    const next = steps[0] === steps[1] ? ['核对'] : ['后修改', '先备份'];
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response(JSON.stringify({ procedure: { steps }, obsoleteField: true })))
      .mockImplementation(async () => response(JSON.stringify({ procedure: { steps: next } })));
    await expect(generateCompanionStructured(context, config, undefined, { fetchFn,
      responseSchema: z.strictObject({ procedure: z.object({ steps: z.array(z.string()) }) }), repairPreserveValues: [{ path: ['procedure'] }] }))
      .rejects.toMatchObject({ diagnostic: 'structured_repair_exhausted' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
  it('rejects a lossy empty repair, keeps the first proposal for the second repair and only persists the conserved result', async () => {
    const notes = [{ content: '三本书，十四天；预约后不能续借。', sourceMessageIds: ['source1'], evidence: [{ sourceMessageId: 'source1', quote: '三本书，十四天；预约后不能续借。' }] }];
    const original = JSON.stringify({ notes, obsoleteTopLevel: [] }), preserved = [{ path: ['notes'], fields: ['content', 'sourceMessageIds', 'evidence'] }];
    const noteSchema = z.strictObject({ notes: z.array(z.strictObject({ content: z.string(), sourceMessageIds: z.array(z.string()), evidence: z.array(z.strictObject({ sourceMessageId: z.string(), quote: z.string() })) })) });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response(original)).mockResolvedValueOnce(response('{"notes":[]}')).mockResolvedValueOnce(response(JSON.stringify({ notes })));
    const committed: unknown[] = [];
    expect(await generateCompanionStructured(context, config, undefined, { fetchFn, responseSchema: noteSchema,
      repairPreserveCollections: preserved, onRepairResult: async receipt => { committed.push(receipt); } })).toEqual({ notes });
    expect(fetchFn).toHaveBeenCalledTimes(3); expect(committed).toHaveLength(1); expect(committed[0]).toMatchObject({ attempt: 2 });
    const second = JSON.parse(payload(fetchFn.mock.calls[2]?.[1]).messages[1]!.content);
    expect(second.originalOutput).toBe(original); expect(second.invalidOutput).toBe('{"notes":[]}'); expect(second.validationErrors[0].code).toBe('repair_content_loss');
  });
  it.each(['empty', 'changed_text', 'changed_evidence'] as const)('parks the repair path instead of accepting %s as a format correction', async change => {
    const note = { content: 'Original valuable event.', evidence: ['EXACT ORIGINAL QUOTE'] };
    const repaired = change === 'empty' ? [] : [{ ...note, ...(change === 'changed_text' ? { content: 'Nothing happened.' } : { evidence: ['invented safe quote'] }) }];
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => response(JSON.stringify({ notes: repaired })))
      .mockResolvedValueOnce(response(JSON.stringify({ notes: [note], unwanted: 1 })));
    const saved = vi.fn(async () => undefined);
    await expect(generateCompanionStructured(context, config, undefined, { fetchFn,
      responseSchema: z.strictObject({ notes: z.array(z.strictObject({ content: z.string(), evidence: z.array(z.string()) })) }),
      repairPreserveCollections: [{ path: ['notes'], fields: ['content', 'evidence'] }], onRepairResult: saved }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE', diagnostic: 'structured_repair_exhausted' });
    expect(fetchFn).toHaveBeenCalledTimes(3); expect(saved).not.toHaveBeenCalled();
  });
  it('cannot convert unreadable original JSON into a successful empty event batch, but keeps an explicitly original empty batch legal', async () => {
    const options = { responseSchema: schema, repairPreserveCollections: [{ path: ['notes'], fields: [] }] };
    const broken = vi.fn<typeof fetch>().mockImplementation(async () => response('{"notes":[]}'))
      .mockResolvedValueOnce(response('{"notes":["valuable event"'));
    await expect(generateCompanionStructured(context, config, undefined, { ...options, fetchFn: broken })).rejects.toMatchObject({ diagnostic: 'structured_repair_exhausted' });
    const empty = vi.fn<typeof fetch>().mockResolvedValueOnce(response('{"notes":[],"oldField":true}')).mockResolvedValue(response('{"notes":[]}'));
    expect(await generateCompanionStructured(context, config, undefined, { ...options, fetchFn: empty })).toEqual({ notes: [] });
  });
  it('sends the exact malformed output and original evidence to the global model, then revalidates without exposing tools or keys in body', async () => {
    const calls: Array<{ body: ReturnType<typeof payload>; auth: string | null }> = [];
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      calls.push({ body: payload(init), auth: new Headers(init?.headers).get('Authorization') });
      return response(calls.length === 1 ? '{"notes":[]}]}' : '{"notes":["三本书，十四天；预约后不能续借。"]}');
    });
    const global = { ...config, model: 'global-repair-model', apiKey: 'global-secret' };
    const result = await generateCompanionStructured(context, { ...config, resolveStructuredRepairConfig: async () => global }, undefined, { fetchFn, responseSchema: schema });
    expect(result).toEqual({ notes: ['三本书，十四天；预约后不能续借。'] });
    expect(calls.map(call => call.body.model)).toEqual(['private-role-model', 'global-repair-model']);
    expect(calls.map(call => call.auth)).toEqual(['Bearer role-secret', 'Bearer global-secret']);
    const repair = JSON.parse(calls[1]!.body.messages[1]!.content);
    expect(repair).toMatchObject({ purpose: 'companion_structured_repair', invalidOutput: '{"notes":[]}]}', originalRequest: context,
      structuredRepair: { originalPurpose: 'vcp_experience_journal', reason: 'syntax', attempt: 1 } });
    expect(calls[1]!.body).not.toHaveProperty('tools');
    expect(JSON.stringify(calls.map(call => call.body))).not.toMatch(/role-secret|global-secret/u);
  });
  it('repairs schema errors and a subsequent syntax error within the same two-child budget', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response('{"notes":4}')).mockResolvedValueOnce(response('{bad')).mockResolvedValueOnce(response('{"notes":[]}'));
    const attempts: number[] = [], receipts: unknown[] = [];
    expect(await generateCompanionStructured(context, config, undefined, { fetchFn, responseSchema: schema,
      onRepairAttempt: async value => { attempts.push(value.attempt); }, onRepairResult: async receipt => { receipts.push(receipt); } })).toEqual({ notes: [] });
    expect(attempts).toEqual([1, 2]); expect(receipts).toHaveLength(1);
    const first = JSON.parse(payload(fetchFn.mock.calls[1]?.[1]).messages[1]!.content), second = JSON.parse(payload(fetchFn.mock.calls[2]?.[1]).messages[1]!.content);
    expect(first.validationErrors[0].path).toEqual(['notes']);
    expect(second.structuredRepair.previousInvocationId).toBe(first.invocation.id);
    expect(second.structuredRepair.rootInvocationId).toBe(first.structuredRepair.rootInvocationId);
  });
  it('never silently extracts a valid prefix and stops after two unsuccessful repairs', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => response('{"notes":[]}]}'));
    await expect(generateCompanionStructured(context, config, undefined, { fetchFn, responseSchema: schema })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    await expect(repairCompanionStructured({ context, raw: '{broken', config, options: { fetchFn, initialRepairAttempts: 2 } })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
  it('does not repair a valid domain refusal, authentication failure, or unknown network outcome', async () => {
    const refusal = vi.fn<typeof fetch>().mockResolvedValue(response('{"allowed":false}'));
    expect(await generateCompanionStructured(context, config, undefined, { fetchFn: refusal, responseSchema: z.strictObject({ allowed: z.boolean() }) })).toEqual({ allowed: false });
    expect(refusal).toHaveBeenCalledTimes(1);
    const auth = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', { status: 401 }));
    await expect(generateCompanionStructured(context, config, undefined, { fetchFn: auth })).rejects.toMatchObject({ code: 'AUTH' }); expect(auth).toHaveBeenCalledTimes(1);
    const network = vi.fn<typeof fetch>().mockResolvedValueOnce(response('{bad')).mockRejectedValue(new Error('wire lost'));
    await expect(generateCompanionStructured(context, config, undefined, { fetchFn: network })).rejects.toMatchObject({ code: 'NETWORK' }); expect(network).toHaveBeenCalledTimes(2);
  });
  it('runs repairs concurrently within the background limit while a fresh foreground operation completes', async () => {
    let repairActive = 0, peak = 0, releaseAll = false;
    const release: Array<() => void> = [];
    const fetchFn: typeof fetch = async (_url, init) => {
      const body = payload(init), input = JSON.parse(body.messages[1]!.content);
      if (input.purpose === 'foreground_probe') return response('still responsive');
      if (input.purpose !== 'companion_structured_repair') return response('{bad');
      repairActive++; peak = Math.max(peak, repairActive);
      if (!releaseAll) await new Promise<void>(resolve => release.push(resolve)); repairActive--; return response('{"notes":[]}');
    };
    const jobs = Array.from({ length: 5 }, (_, i) => generateCompanionStructured(context, { ...config, ownerId: `owner${i}` }, undefined, { fetchFn, responseSchema: schema }));
    try {
      await vi.waitFor(() => { expect(repairActive).toBe(2); expect(companionModelQuota.snapshot().queued).toBeGreaterThanOrEqual(3); });
      expect(await generateCompanionText({ system: '', user: '{"purpose":"foreground_probe"}' }, { ...config, workPriority: 'foreground' }, undefined, { fetchFn })).toBe('still responsive');
      for (let completed = 0; completed < 5;) {
        const batch = release.splice(0); completed += batch.length; batch.forEach(resolve => resolve());
        if (completed < 5) await vi.waitFor(() => expect(release.length).toBeGreaterThan(0));
      }
      await Promise.all(jobs); expect(peak).toBe(2);
    } finally { releaseAll = true; release.splice(0).forEach(resolve => resolve()); await Promise.allSettled(jobs); }
  });
  it('binds child frames to original versions and refuses a changed revocation epoch before another HTTP call', async () => {
    let resolutions = 0;
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response('{bad'));
    await expect(generateCompanionStructured(context, { ...config, resolveAssetContext: async value => ({ ...value,
      frame: { ...frame, revocationEpoch: ++resolutions } }) }, undefined, { fetchFn, responseSchema: schema })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('cancels queued repair and rejects oversized input without truncating it into a new request', async () => {
    const controller = new AbortController(), fetchFn = vi.fn<typeof fetch>(); controller.abort();
    await expect(repairCompanionStructured({ context, raw: '{bad', config, signal: controller.signal, options: { fetchFn } })).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(repairCompanionStructured({ context, raw: '{' + 'x'.repeat(256 * 1024), config, options: { fetchFn } })).rejects.toMatchObject({ code: 'CONTEXT_CAPACITY' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('requires the durable attempt hook before sending and does not retry failed result persistence', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response('{"notes":[]}'));
    await expect(repairCompanionStructured({ context, raw: '{bad', config, options: { fetchFn,
      onRepairAttempt: async () => { throw new Error('attempt storage unavailable'); } } })).rejects.toThrow('attempt storage unavailable');
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(repairCompanionStructured({ context, raw: '{bad', config, options: { fetchFn,
      onRepairResult: async () => { throw new Error('result storage unavailable'); } } })).rejects.toThrow('result storage unavailable');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it('keeps the original source and lease lifecycle checks when repair switches to the global connection', async () => {
    const finishOriginal = vi.fn(async () => undefined), finishGlobal = vi.fn(async () => undefined);
    let originalChecks = 0, globalChecks = 0;
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(response('{bad')).mockResolvedValueOnce(response('{"notes":[]}'));
    const original = { beforeDispatch: async () => { originalChecks++; return finishOriginal; } };
    const global = { beforeDispatch: async () => { globalChecks++; return finishGlobal; } };
    await generateCompanionStructured(context, { ...config, providerLifecycle: original,
      resolveStructuredRepairConfig: async () => ({ ...config, model: 'global', providerLifecycle: global }) }, undefined, { fetchFn, responseSchema: schema });
    expect(originalChecks).toBe(2); expect(globalChecks).toBe(1);
    expect(finishOriginal).toHaveBeenCalledTimes(2); expect(finishGlobal).toHaveBeenCalledTimes(1);
    let checks = 0;
    const guardedFetch = vi.fn<typeof fetch>().mockResolvedValue(response('{bad'));
    await expect(generateCompanionStructured(context, { ...config,
      providerLifecycle: { beforeDispatch: async () => { if (++checks === 2) throw new Error('Source lease withdrawn'); return async () => undefined; } },
      resolveStructuredRepairConfig: async () => ({ ...config, model: 'global' }) }, undefined, { fetchFn: guardedFetch })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });
});

import { expect, it, vi } from 'vitest';
import { observeCompanionReplyPreflight, timeCompanionReplyPreflight } from '../../src/main/companions/reply-preflight-timing';
import type { CompanionModelConfig, CompanionTransportAttemptInput } from '../../src/main/companions/model';

it('preserves host receivers, private attempt state, exact context identity and hook order', async () => {
  const stages: string[] = [], report = vi.fn(), frame = Object.freeze({ host: 'private' });
  const context = { system: 'system', user: 'user' };
  Object.defineProperty(context, 'frame', { enumerable: false, value: frame });
  const finish = vi.fn(async () => { stages.push('finish'); });
  class Attempt {
    #stage = 0;
    async beforeDispatch() { expect(this.#stage++).toBe(0); stages.push('before'); }
    async dispatched() { expect(this.#stage++).toBe(1); stages.push('dispatched'); }
    async complete() { expect(this.#stage++).toBe(2); stages.push('complete'); }
  }
  const attempt = new Attempt(), lifecycle = { async beforeDispatch() { expect(this).toBe(lifecycle); stages.push('lifecycle'); return finish; } };
  const observer = { async prepareAttempt() { expect(this).toBe(observer); stages.push('prepare'); return attempt; } };
  const config: CompanionModelConfig = { apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fixture', providerLifecycle: lifecycle,
    transportObserver: observer, async resolveAssetContext(value) { expect(this).toBe(config); expect(value).toBe(context); stages.push('assets'); return context; },
    trackOperation() { expect(this).toBe(config); }, resolveNativeLifecycle() { expect(this).toBe(config); return lifecycle; },
    async resolveStructuredRepairConfig() { expect(this).toBe(config); return config; } };
  const brand = Symbol('private config field'); Object.defineProperty(config, brand, { value: frame, enumerable: false }); Object.freeze(config);
  const observed = observeCompanionReplyPreflight(config, report);
  expect(observed).not.toBe(config); expect(Reflect.get(observed, brand)).toBe(frame);
  expect(Object.getOwnPropertyDescriptor(observed, brand)?.enumerable).toBe(false);
  const actualContext = await observed.resolveAssetContext!(context, 'reply'); expect(actualContext).toBe(context);
  expect(Object.getOwnPropertyDescriptor(actualContext, 'frame')?.value).toBe(frame);
  const settlement = await observed.providerLifecycle!.beforeDispatch(); expect(settlement).toBe(finish);
  const actual = await observed.transportObserver!.prepareAttempt({} as CompanionTransportAttemptInput);
  expect(stages).toEqual(['assets', 'lifecycle', 'prepare']);
  await actual.beforeDispatch(); await actual.dispatched(); await actual.complete('response', 200); await settlement('response', 1, 200);
  expect(stages).toEqual(['assets', 'lifecycle', 'prepare', 'before', 'dispatched', 'complete', 'finish']);
  observed.trackOperation!(Promise.resolve()); expect(observed.resolveNativeLifecycle!()).toBe(lifecycle);
  expect(await observed.resolveStructuredRepairConfig!()).toBe(config);
  expect(report.mock.calls.map(([name]) => name)).toEqual(['reply.preflight.resolve_assets', 'reply.preflight.provider_admission',
    'reply.preflight.prepare_attempt', 'reply.preflight.attempt_before_dispatch']);
  expect(report.mock.calls.every(([, duration]) => Number.isFinite(duration) && duration >= 0)).toBe(true);
});

it('keeps synchronous failure synchronous and preserves rejection identity when the timing observer throws', async () => {
  const failed = new Error('host denied'), report = vi.fn(() => { throw new Error('diagnostic failed'); });
  expect(() => timeCompanionReplyPreflight('reply.preflight.prepare_attempt', () => { throw failed; }, report)).toThrow(failed);
  await expect(timeCompanionReplyPreflight('reply.preflight.prepare_attempt', () => Promise.reject(failed), report)).rejects.toBe(failed);
  await expect(timeCompanionReplyPreflight('reply.preflight.prepare_attempt', () => 42, report)).resolves.toBe(42);
  expect(report).toHaveBeenCalledTimes(3);
});

it('does not swallow admission failure or invoke paid settlement merely to record it', async () => {
  const failed = new Error('source revoked'), dispatched = vi.fn(async () => undefined), complete = vi.fn(async () => undefined);
  const config: CompanionModelConfig = { apiFormat: 'openai_chat', model: 'fixture', apiKey: 'fixture', transportObserver: {
    prepareAttempt: async () => ({ beforeDispatch: async () => { throw failed; }, dispatched, complete }),
  } };
  const report = vi.fn(), observed = observeCompanionReplyPreflight(config, report);
  const attempt = await observed.transportObserver!.prepareAttempt({} as CompanionTransportAttemptInput);
  await expect(attempt.beforeDispatch()).rejects.toBe(failed);
  expect(dispatched).not.toHaveBeenCalled(); expect(complete).not.toHaveBeenCalled();
  expect(report.mock.calls.map(([operation]) => operation)).toEqual(['reply.preflight.prepare_attempt', 'reply.preflight.attempt_before_dispatch']);
});

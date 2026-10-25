import { expect, it } from 'vitest';
import { BrowserCompanionActivity } from '../../src/main/browser/companion-activity';
import { companionBrowserArgumentsSchema } from '../../src/shared/companion-browser';
import { normalizeCompanionCapabilityCall } from '../../src/shared/companion-capability-tools';

const scope = { companionId: 'alice', companionName: '小爱', conversationId: 'room' };
it('tracks each actual concurrent call and releases it on completion, failure and cancellation', async () => {
  const activity = new BrowserCompanionActivity(() => undefined);
  let release!: () => void;
  const first = activity.run(scope, 'tab1', 'read', undefined, () => new Promise<void>(resolve => { release = resolve; }));
  const second = activity.run({ ...scope, companionId: 'bob' }, 'tab1', 'observe', undefined, () => new Promise(() => undefined));
  const rejected = expect(second).rejects.toThrow('停止');
  await Promise.resolve();
  expect(activity.state().activities.map(item => item.companionId)).toEqual(['alice', 'bob']);
  release(); await first;
  expect(activity.state().activities.map(item => item.companionId)).toEqual(['bob']);
  activity.pause(true, 'tab1'); await rejected;
  expect(activity.state().activities).toEqual([]);
  await expect(activity.run(scope, 'tab1', 'read', undefined, async () => null)).rejects.toThrow('暂停');
  activity.pause(false, 'tab1');
  await expect(activity.run(scope, 'tab1', 'read', undefined, async () => { throw Error('page failed'); })).rejects.toThrow('page failed');
  expect(activity.state().activities).toEqual([]);
});

it('cancels calls on parent abort and global pause, without a durable viewing state', async () => {
  const activity = new BrowserCompanionActivity(() => undefined), controller = new AbortController();
  const pending = activity.run(scope, 'tab1', 'read', controller.signal, () => new Promise(() => undefined));
  controller.abort(Error('cancelled')); await expect(pending).rejects.toThrow('cancelled');
  expect(activity.busy('tab1')).toBe(false);
  activity.pause(true);
  expect(() => activity.assertAllowed()).toThrow('暂停');
  activity.pause(false);
  await expect(activity.run(scope, 'tab2', 'read', undefined, async () => 'actual page')).resolves.toBe('actual page');
  expect(activity.state().activities).toEqual([]);
  expect(new BrowserCompanionActivity(() => undefined).state()).toEqual({ paused: false, pausedTabIds: [], activities: [] });
});

it('binds browser separately from DSH and rejects ambiguous or executable page input', () => {
  const input = { action: 'read', tabId: 'real-tab' };
  const normalized = normalizeCompanionCapabilityCall({ id: 'call1', name: 'browser', arguments: JSON.stringify(input) });
  expect(normalized.name).toBe('browser'); expect(JSON.parse(normalized.arguments)).toMatchObject(input);
  for (const args of [{ action: 'read' }, { action: 'open', url: 'javascript:alert(1)' },
    { action: 'open', url: 'https://user:password@example.com' }, { action: 'evaluate', tabId: 'a', code: 'document.cookie' },
    { action: 'screenshot', tabId: 'a', path: 'C:/arbitrary.png' }]) expect(companionBrowserArgumentsSchema.safeParse(args).success).toBe(false);
});

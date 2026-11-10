import { expect, it } from 'vitest';
import { botContextIsNewer, botNativeContextSchema, type BotNativeContext } from '../../src/shared/companion-native-context';
const contextPath = '../../resources/dsh-bridge/context.js', { foldContextActivity, nativeSessionBusy, nativeActivity } = await import(contextPath);
const init = () => ({ turn: false, commands: {}, compaction: null });
const stamp = '2026-11-10T08:00:00.000Z';
const event = (type: string, seq: number, data = {}) => ({ type, seq, time: stamp, data });
it('observes native manual maintenance despite idle Agent status and retains only lifecycle fields', () => {
  let state = foldContextActivity(init(), event('command/run', 1, { commandId: 'cmd', name: 'compact', args: 'PRIVATE_INPUT' }));
  const ctx = { get: () => ({ snapshot: () => ({ values: { worldlineboxContextActivity: state } }) }) }, agent = { status: 'idle', session: {} };
  expect(nativeSessionBusy(ctx, agent)).toBe(true);
  state = foldContextActivity(state, event('compaction/start', 2, { compactionId: 'compact', turn: null }));
  expect(nativeActivity({ worldlineboxContextActivity: state }, agent)).toMatchObject({ phase: 'compacting', compaction: { origin: 'manual', state: 'running' } });
  expect(JSON.stringify(state)).not.toContain('PRIVATE_INPUT');
  state = foldContextActivity(state, event('compaction/end', 3, { compactionId: 'compact' }));
  expect(nativeSessionBusy(ctx, agent)).toBe(true); // Command persistence has not settled yet.
  state = foldContextActivity(state, event('command/done', 4, { commandId: 'cmd' }));
  expect(nativeSessionBusy(ctx, agent)).toBe(false);
  expect(nativeActivity({ worldlineboxContextActivity: state }, agent)).toMatchObject({ phase: 'idle', compaction: { state: 'succeeded' } });
});
it('recognizes native automatic pressure, failure and the native recovery seed boundary', () => {
  let state = foldContextActivity(init(), event('turn/start', 1));
  state = foldContextActivity(state, event('compaction/start', 2, { compactionId: 'auto', turn: 1 }));
  expect(state.compaction.origin).toBe('automatic');
  expect(nativeActivity({worldlineboxContextActivity:state},undefined).phase).toBe('recovering');
  expect(foldContextActivity(state, event('compaction/end', 3, { compactionId: 'unrelated' }))).toBe(state);
  state = foldContextActivity(state, event('compaction/end', 4, { compactionId: 'auto', error: 'Quota exceeded' }));
  expect(state.compaction).toMatchObject({ state: 'failed', error: 'Quota exceeded' });
  state = foldContextActivity(state, event('compaction/start', 5, { compactionId: 'later', turn: null }));
  state = foldContextActivity(state, event('session/end-seed', 6));
  expect(state).toMatchObject({ turn: false, commands: {}, compaction: { state: 'interrupted' } });
  const numeric=foldContextActivity(init(),{...event('compaction/start',7,{compactionId:'epoch',turn:null}),time:Date.parse(stamp)});
  expect(numeric.compaction.startedAt).toBe(stamp);
});
it('orders same-log-watermark maintenance observations without borrowing another topic', () => {
  const old: BotNativeContext = { source: 'dsh-native-projections', sessionId: 'one', state: 'ready', asOfSeq: 9, sampledAt: stamp, observation: { hostId: 'host', revision: 3 }, activity: { phase: 'compacting' } };
  const next = botNativeContextSchema.parse({ ...old, observation: { hostId: 'host', revision: 4 }, activity: { phase: 'idle' } });
  expect(botContextIsNewer(next, old)).toBe(true); expect(botContextIsNewer(old, next)).toBe(false);
  expect(botContextIsNewer({ ...next, sessionId: 'another' }, old)).toBe(false);
});

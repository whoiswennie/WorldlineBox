import { describe, expect, it, vi } from 'vitest';

import { createLibraryLifecycleRelay } from '../../src/preload/library-lifecycle-relay';
import { parseRendererLifecycleEvent } from '../../src/shared/protocol/responses';

describe('retained asset view lifecycle relay', () => {
  it('replays completed recovery after the view disconnects during recovery', () => {
    const relay = createLibraryLifecycleRelay();
    const original = vi.fn();
    const disconnect = relay.subscribe(original);
    relay.publish({ type: 'worker.recovering' });
    expect(original).toHaveBeenCalledExactlyOnceWith({
      type: 'worker.recovering', recoverySequence: 1,
    });
    disconnect();
    relay.publish({ type: 'worker.recovered', libraryIds: ['library-a'], failedLibraryIds: [] });
    const resumed = vi.fn();
    relay.subscribe(resumed);
    expect(original).toHaveBeenCalledTimes(1);
    expect(resumed).toHaveBeenCalledExactlyOnceWith({
      type: 'worker.recovered', libraryIds: ['library-a'], failedLibraryIds: [], recoverySequence: 2,
    });
  });

  it('replays failure and then delivers a subsequent recovery live', () => {
    const relay = createLibraryLifecycleRelay();
    relay.publish({ type: 'worker.failed' });
    const listener = vi.fn();
    relay.subscribe(listener);
    expect(listener).toHaveBeenCalledExactlyOnceWith({ type: 'worker.failed', recoverySequence: 1 });
    relay.publish({ type: 'worker.recovering' });
    relay.publish({ type: 'worker.recovered', libraryIds: [], failedLibraryIds: ['library-a'] });
    expect(listener.mock.calls.map(([event]) => event.recoverySequence)).toEqual([1, 2, 3]);
  });

  it('does not replay ordinary library transitions or consume their recovery sequence', () => {
    const relay = createLibraryLifecycleRelay();
    const listener = vi.fn();
    relay.publish({ type: 'library.closed', libraryId: 'old-library' });
    relay.subscribe(listener);
    expect(listener).not.toHaveBeenCalled();
    relay.publish({ type: 'library.opening', operation: 'open' });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ type: 'library.opening', operation: 'open' });
    relay.publish({ type: 'worker.recovering' });
    expect(listener).toHaveBeenLastCalledWith({ type: 'worker.recovering', recoverySequence: 1 });
  });

  it('keeps a stable sequence on replay while distinguishing identical later recoveries', () => {
    const relay = createLibraryLifecycleRelay();
    const event = { type: 'worker.recovered' as const, libraryIds: ['library-a'], failedLibraryIds: [] };
    relay.publish(event);
    const listener = vi.fn();
    relay.subscribe(listener)();
    relay.subscribe(listener)();
    expect(listener.mock.calls.map(([event]) => event.recoverySequence)).toEqual([1, 1]);
    relay.publish(event);
    relay.subscribe(listener);
    expect(listener).toHaveBeenLastCalledWith({ ...event, recoverySequence: 2 });
    expect(event).not.toHaveProperty('recoverySequence');
  });

  it('synchronously replays once to a listener added during live worker dispatch', () => {
    const relay = createLibraryLifecycleRelay();
    const added = vi.fn();
    relay.subscribe(() => { relay.subscribe(added); });
    relay.publish({ type: 'worker.recovering' });
    expect(added).toHaveBeenCalledExactlyOnceWith({ type: 'worker.recovering', recoverySequence: 1 });
  });

  it('does not call a subscription removed by an earlier listener during dispatch', () => {
    const relay = createLibraryLifecycleRelay();
    let removeLater: () => void = () => undefined;
    relay.subscribe(() => removeLater());
    const later = vi.fn();
    removeLater = relay.subscribe(later);
    relay.publish({ type: 'worker.recovering' });
    expect(later).not.toHaveBeenCalled();
  });

  it('removes an inaccessible subscription if its synchronous replay throws', () => {
    const relay = createLibraryLifecycleRelay();
    relay.publish({ type: 'worker.recovering' });
    const broken = vi.fn(() => { throw new Error('view gone'); });
    expect(() => relay.subscribe(broken)).toThrow('view gone');
    relay.publish({ type: 'worker.failed' });
    expect(broken).toHaveBeenCalledTimes(1);
  });

  it.each([
    { type: 'worker.recovering' },
    { type: 'worker.failed' },
    { type: 'worker.recovered', libraryIds: [], failedLibraryIds: [] },
  ])('accepts optional positive replay sequences for $type', (event) => {
    expect(parseRendererLifecycleEvent(event)).toEqual(event);
    expect(parseRendererLifecycleEvent({ ...event, recoverySequence: 2 })).toEqual({
      ...event, recoverySequence: 2,
    });
    for (const invalid of [0, -1, 1.5]) {
      expect(() => parseRendererLifecycleEvent({ ...event, recoverySequence: invalid })).toThrow();
    }
  });
});

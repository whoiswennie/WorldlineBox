import type { RendererLifecycleEvent } from '../shared/protocol/responses';

type WorkerLifecycleEvent = Extract<RendererLifecycleEvent, {
  type: 'worker.recovering' | 'worker.recovered' | 'worker.failed';
}>;
type Subscription = { listener: (event: RendererLifecycleEvent) => void };

/**
 * React Activity disconnects the retained Assets view's effects. Keep the last
 * worker state in Preload so resuming that view cannot miss recovery finishing.
 * Ordinary library events are delivered live and are never replayed.
 */
export function createLibraryLifecycleRelay() {
  const subscriptions = new Set<Subscription>();
  let latestWorkerEvent: WorkerLifecycleEvent | undefined;
  let recoverySequence = 0;

  return {
    publish(event: RendererLifecycleEvent): void {
      if (event.type === 'worker.recovering'
        || event.type === 'worker.recovered'
        || event.type === 'worker.failed') {
        latestWorkerEvent = { ...event, recoverySequence: ++recoverySequence };
        event = latestWorkerEvent;
      }
      // Snapshot before dispatch: a listener added by another listener gets
      // the cached worker state once, without joining this in-flight dispatch.
      for (const subscription of [...subscriptions]) {
        if (subscriptions.has(subscription)) subscription.listener(event);
      }
    },

    subscribe(listener: (event: RendererLifecycleEvent) => void): () => void {
      const subscription = { listener };
      subscriptions.add(subscription);
      try {
        if (latestWorkerEvent) listener(latestWorkerEvent);
      } catch (error) {
        subscriptions.delete(subscription);
        throw error;
      }
      return () => { subscriptions.delete(subscription); };
    },
  };
}

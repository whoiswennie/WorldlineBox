import type { CompanionsStore } from '../../src/companions/store';
/** Real owner-authored address delivery. No direct database seeding or omniscient knowledge grant. */
export function shareWorldAddress(store: CompanionsStore, host: { companionId: string; conversationId: string }, recipient: string, advance: (ms: number) => unknown): void {
  store.request({ type: 'world.tool', ...host, arguments: { action: 'share_address', recipientIds: [recipient] } });
  let job = store.request({ type: 'social.job.claim' }).socialJob;
  advance(1600); job ??= store.request({ type: 'social.job.claim' }).socialJob;
  if (job) { advance(1600); store.request({ type: 'social.job.complete', id: job.id, leaseToken: job.leaseToken!, text: null }); }
  advance(6000);
}

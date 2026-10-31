import { companionWorldSnapshotSchema } from './companion-world';
import { companionRuntimeStateSchema } from './companion-state';
import type { CompanionReplyReceivedState } from './companion-reply-observation';

export function parseCompanionReplyObservation(snapshot: CompanionReplyReceivedState, owner: string) {
  const world = companionWorldSnapshotSchema.parse(JSON.parse(snapshot.worldJson));
  const runtimeState = companionRuntimeStateSchema.parse(JSON.parse(snapshot.runtimeStateJson));
  if (runtimeState.companionId !== owner || world.perception && world.perception.companionId !== owner)
    throw new Error('回复状态观察不属于当前伙伴。');
  return { world, runtimeState };
}

/** A physical observation stays at its original instant. Source withdrawal
 * removes quoted and qualitative claims without importing a newer state. */
export function withdrawCompanionReplyObservation(snapshot: CompanionReplyReceivedState, owner: string, revocationEpoch: number) {
  const { world, runtimeState } = parseCompanionReplyObservation(snapshot, owner);
  world.events = world.events.filter(event => !event.sourceMessageId && !event.sourceReads?.length);
  world.visits = [];
  world.knownAddresses = world.knownAddresses?.filter(address => address.source === 'own_home');
  world.actors = world.actors.map(actor => { const { activityLabel: _activityLabel, ...physical } = actor; void _activityLabel;
    return { ...physical, state: { ...physical.state, expression: 'gentle' } }; });
  world.works = world.works.map(work => { const { reason: _reason, ...physical } = work; void _reason; return physical; });
  runtimeState.expression = 'gentle';
  runtimeState.relationshipRecords = [];
  for (const key of ['experience', 'focus', 'reason', 'sourceConversationId', 'sourceMessageIds', 'sourceVersions', 'evidence', 'recentChanges'] as const)
    delete runtimeState[key];
  if (runtimeState.routine?.activity) runtimeState.routine.activity = '收到消息时的活动';
  return { ...snapshot, worldJson: JSON.stringify(world), runtimeStateJson: JSON.stringify(runtimeState), revocationEpoch };
}

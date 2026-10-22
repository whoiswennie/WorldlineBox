import { createHash } from 'node:crypto';
import type { CompanionsStore } from '../../src/companions/store';
import type { CompanionAction } from '../../src/shared/companions';
import type { CompanionLoopCheckpoint } from '../../src/shared/companion-loop';

/** Persistence fixture for lease/state tests; never used as real-model evidence. */
export function companionGoalProofFixture(store: CompanionsStore, input: { id: string; kind: 'work' | 'schedule';
  companionId: string; conversationId: string; sourceMessageId: string; instruction: string; authorizationSourceMessageIds: string[] }) {
  const slot = 'fixture_' + createHash('sha256').update(input.kind + input.id + input.instruction).digest('hex');
  const bubble = store.appendMessage({ conversationId: input.conversationId, authorId: input.companionId,
    replyToId: input.sourceMessageId, content: '机制夹具：独立目标正在处理。', clientId: slot, replyDirective: 'none' });
  const checkpoint: CompanionLoopCheckpoint = { conversationId: input.conversationId, companionId: input.companionId,
    sourceMessageId: input.sourceMessageId, messageId: bubble.id, invocationKey: slot, status: 'running', supplements: [], turns: [],
    context: { system: '机制夹具，不是在线模型验收。', user: JSON.stringify({ invocation: { id: input.id, kind: input.kind,
      companionId: input.companionId, conversationId: input.conversationId, goal: input.instruction,
      authorization: { externalActions: true, sourceMessageIds: input.authorizationSourceMessageIds } } }) } };
  let calls = 0;
  const bind = () => ({ parentMessageId: bubble.id, toolCallId: `${calls++}:fixture_call:0` });
  const finish = (result: string, actions: readonly CompanionAction[]) => {
    checkpoint.turns = actions.map(action => ({ text: '', rawText: '', calls: [{ id: 'fixture_call', name: 'dsh',
      arguments: JSON.stringify({ operation: 'run', tasks: [{ title: action.title, instructions: '机制夹具执行。' }] }) }],
      results: [{ callId: 'fixture_call', content: JSON.stringify({ status: action.status }) }] }));
    checkpoint.turns.push({ text: result, rawText: result, calls: [] }); checkpoint.status = 'done';
    store.request({ type: 'loop.save', checkpoint });
    return { invocationId: input.id, goalSlot: slot, actionIds: actions.map(action => action.id) };
  };
  return { bind, finish, checkpoint };
}

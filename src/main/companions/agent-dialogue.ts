import type { CompanionReplyInput } from './context';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';
import { assembleCompanionInvocation } from './invocation-context';
import { prepareTopicContinuity, type TopicCompactionInput } from './topic-compaction';

/** Every conversation has a real topic. Independent work ports retain only
 * their own explicit records and never inherit the selected chat. */
export async function prepareCompanionAgentDialogue(input: Omit<TopicCompactionInput, 'request'> & {
  request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
}): Promise<CompanionReplyInput> {
  const port = assembleCompanionInvocation(input.frame);
  if (port.invocation.messagePort.kind !== 'conversation') return input.frame;
  if (!port.invocation.topicId) throw new Error('聊天缺少正式话题，不能以无话题窗口运行。请进入主要对话或创建新话题。');
  if (!input.frame.topic) {
    const loaded = await input.request({ type: 'topic.read', conversationId: port.invocation.conversationId,
      topicId: port.invocation.topicId, readerId: port.invocation.companionId });
    if (!loaded.ok || !loaded.topic || !loaded.topicState) throw new Error('当前聊天话题不可读，不能退回其他入口继续推理。');
    input = { ...input, frame: { ...input.frame, topic: loaded.topic, topicState: loaded.topicState } };
  }
  return input.frame.topic!.participantIds.includes(input.frame.companion.id) ? prepareTopicContinuity(input) : input.frame;
}

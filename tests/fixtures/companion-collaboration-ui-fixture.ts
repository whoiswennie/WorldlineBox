import path from 'node:path';
import { BotStore } from '../../src/main/companion-bot/store';
import type { BotTask } from '../../src/main/companion-bot/types';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';

/** Presentation fixtures only. Their retry deadline prevents native execution;
 * actual provider/DSH collaboration is covered by the separate real scenarios. */
export function seedCollaborationUi(profile: string) {
  const store = new BotStore(path.join(profile, 'companion-bot-v2', 'bot.sqlite'));
  try {
    const fish = DEFAULT_BOT_COMPANION_ID, gpt = 'gpt';
    if (!store.getCompanion(fish) || !store.getCompanion(gpt)) throw Error('Built-in task owners are not ready.');
    const direct = store.openDirect(fish), privateGpt = store.openDirect(gpt);
    const group = store.createGroup({ title: '多伙伴协作 · 界面验收', memberIds: [fish, gpt], participationMode: 'mentions' });
    const add = (conversationId: string, companionId: string, id: string, title: string) => {
      const source = store.enqueue({ conversationId, senderId: 'user', recipientIds: [companionId], sourceMessageId: `collaboration-source-${id}`,
        content: `${title}。本地界面验收，只读样例资料，不访问真实桌面和外部网络。` }).events[0]!;
      store.cancelEvent(source.id);
      store.createTask({ id, conversationId, companionId, sourceEventId: source.id, goal: source.content, extra: { title,
        retryAt: Date.now() + 86400000, workerAccess: 'full', nativeAttempted: false, attachmentIds: [],
        progress: { phase: 'queued', detail: '等待空闲执行器。', updatedAt: new Date().toISOString() } } });
      const notice = store.enqueue({ conversationId, senderId: 'task-service', senderName: '任务回执', source: 'task', recipientIds: [companionId],
        sourceMessageId: `collaboration-notice-${id}`, kind: 'task_progress', payload: { taskId: id }, content: `任务 ${id} 状态：queued\nRAW_FIXTURE_TRANSPORT_NOT_CHAT` });
      for (const event of notice.events) store.cancelEvent(event.id);
      return { taskId: id, conversationId, companionId, title, noticeId: notice.message.id };
    };
    return {
      group: { id: group.id, title: group.title, tasks: [
        add(group.id, fish, 'collaboration-ui-finance', '核算样例金额'),
        add(group.id, gpt, 'collaboration-ui-audit', '独立核对统计口径'),
        add(group.id, gpt, 'collaboration-ui-stop', '可停止的资料提取'),
      ] },
      direct: { id: direct.id, title: '大肥鱼', task: add(direct.id, fish, 'collaboration-ui-direct', '私聊资料核对') },
      privateGpt: { id: privateGpt.id, task: add(privateGpt.id, gpt, 'collaboration-ui-private-gpt', '仅私聊可见的 GPT 任务') },
      presentationOnly: true, actualModelCalls: 0, actualNativeWorkerCalls: 0,
    };
  } finally { store.close(); }
}

/** Updates persisted state, never DOM or a renderer API result. The caller
 * emits the production changed event after the transaction has committed. */
export function updateCollaborationUi(profile: string, taskId: string, status: BotTask['status'], phase: string, toolName?: string) {
  const store = new BotStore(path.join(profile, 'companion-bot-v2', 'bot.sqlite'));
  try {
    const task = store.getTask(taskId); if (!task || !taskId.startsWith('collaboration-ui-')) throw Error('Unexpected collaboration fixture task.');
    const stamp = new Date().toISOString(), activity = Array.isArray(task.extra.activity) ? task.extra.activity : [];
    store.updateTask(task.id, { status, summary: status === 'succeeded' ? '样例核对完成：已检查三项筛选条件，原件保持不变。' : task.summary,
      extra: { ...task.extra, retryAt: Date.now() + 86400000, progress: { phase, toolName, updatedAt: stamp },
        activity: [...activity, { id: `${taskId}-${activity.length}`, phase, toolName, createdAt: stamp, updatedAt: stamp }] } });
    return { conversationId: task.conversationId, taskId, status, phase, persisted: true };
  } finally { store.close(); }
}

export function appendCollaborationUiMessage(profile: string, conversationId: string) {
  const store = new BotStore(path.join(profile, 'companion-bot-v2', 'bot.sqlite'));
  try {
    return store.enqueue({ conversationId, senderId: 'user', recipientIds: [], sourceMessageId: `collaboration-later-${Date.now()}`,
      content: '后续消息：协作任务记录应当留在原对话，继续可查看进度和结果。' }).message.id;
  } finally { store.close(); }
}

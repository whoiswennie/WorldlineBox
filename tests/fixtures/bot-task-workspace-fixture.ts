import path from 'node:path';
import { BotStore } from '../../src/main/companion-bot/store';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';

/** Human-authored presentation fixtures written through the actual Main store.
 * Future retryAt prevents these synthetic tasks from invoking DSH or a model. */
export function seedTaskWorkspace(profile: string, conversationId: string) {
  const store = new BotStore(path.join(profile, 'companion-bot-v2', 'bot.sqlite'));
  try {
    const ids: string[] = [], stamp = new Date().toISOString(), retryAt = Date.now() + 86400000;
    for (let i = 0; i < 19; i++) {
      const source = store.enqueue({ conversationId, senderId: 'user', source: 'user', sourceMessageId: `task-ui-source-${i}`, content: `隔离界面测试请求 ${i}；不访问真实桌面。`, recipientIds: [DEFAULT_BOT_COMPANION_ID] }).events[0]!;
      store.cancelEvent(source.id);
      const id = `task-presentation-${String(i).padStart(2, '0')}`; ids.push(id);
      const title = ['整理项目目录', '生成阅读清单', '核对附件格式', '整理最近的笔记', '准备素材索引', '检索项目说明'][i % 6]!;
      const task = store.createTask({ id, conversationId, companionId: DEFAULT_BOT_COMPANION_ID, sourceEventId: source.id,
        goal: `只读查看隔离任务工作区中的文件名称。${'这是测试用完整任务要求与约束，保留在详情中，不应充当聊天气泡和卡片标题。'.repeat(20)}`,
        extra: { title: i === 18 ? '等待停止确认的任务' : `${title} ${i + 1}`, retryAt, nativeAttempted: i === 18, workerAccess: 'scoped', ...(i === 2 ? { retryAttempts: 58, lastRecoveryStage: 'attach', lastRecoveryError: 'Fixture: attaching to the original worker session exceeded its deadline.' } : {}),
          ...(i === 18 ? { cancelRequested: true, cancelRequestedAt: new Date(Date.now() - 45000).toISOString(), cancelRecoveryPaused: true, cancelRecoveryAttempts: 3, retryAttempts: 3, lastRecoveryStage: 'cancel', lastRecoveryError: 'Fixture: the executor has not confirmed the stop outcome. No task was restarted.' } : {}),
          progress: { phase: i < 2 ? 'using-tool' : i === 2 ? 'recovering' : i === 18 ? 'stop-unconfirmed' : 'queued', toolName: i < 2 ? 'shell' : undefined, updatedAt: stamp },
          activity: [{ id: `activity-${i}-0`, phase: 'connecting', createdAt: stamp, updatedAt: stamp }, { id: `activity-${i}-1`, phase: i < 2 ? 'using-tool' : 'queued', toolName: i < 2 ? 'shell' : undefined, createdAt: stamp, updatedAt: stamp }] } });
      store.updateTask(id, { status: i < 2 ? 'running' : i < 13 ? 'queued' : i === 18 ? 'waiting' : 'succeeded', summary: i >= 13 && i < 18 ? `隔离测试执行回执 ${i}。${'原始工具输出留在详情，不重复塞进聊天。'.repeat(30)}` : '', extra: task.extra });
      // Historical presentation timestamps must precede the seeded stop
      // request; otherwise the screenshot would show waiting > task age.
      store.taskTransaction(sql => sql.prepare('UPDATE bot_tasks SET created_at=? WHERE id=?').run(new Date(Date.now() - 120000 + i * 1000).toISOString(), id));
    }
    for (const id of ids.slice(0, 2)) { const task = store.getTask(id)!; store.updateTask(id, { extra: { ...task.extra, retryAt } }); }
    const notice = store.enqueueTaskNotice({ conversationId, senderId: 'task-service', senderName: '任务回执', source: 'task', sourceMessageId: 'task-ui-complete', recipientIds: [DEFAULT_BOT_COMPANION_ID], kind: 'task_done', payload: { taskId: ids[17] }, content: `任务 ${ids[17]} 状态：succeeded\n${'MASSIVE EXECUTOR RECEIPT '.repeat(90)}` });
    if (notice.deferred) throw new Error('Presentation fixture notice unexpectedly deferred.');
    for (const event of store.activeDomainEvents(DEFAULT_BOT_COMPANION_ID, store.getConversation(conversationId)!.securityDomainId)) store.cancelEvent(event.id);
    store.enqueueTaskNotice({ conversationId, senderId: 'task-service', senderName: '任务回执', source: 'task', sourceMessageId: 'task-ui-already-reported', recipientIds: [DEFAULT_BOT_COMPANION_ID], kind: 'task_done', payload: { taskId: ids[16] }, content: `任务 ${ids[16]} 状态：succeeded\nALREADY REPORTED TRANSPORT RECEIPT` });
    const reply = store.claim({ workerId: 'human-authored-task-presentation' });
    if (!reply || reply.event.source !== 'task' || !store.settle({ eventId: reply.event.id, leaseToken: reply.leaseToken, status: 'done', content: '界面测试：我已经把整理结果带回来啦。执行过程和原始回执放在任务里，需要时可以展开查看。' })) throw new Error('Could not settle the human-authored natural response fixture');
    return { ids, tasks: ids.length, scope: conversationId, synthetic: true, settledReplyId: reply.event.replyMessageId };
  } finally { store.close(); }
}

/** Two real built-in owners in one group plus a same-owner private catalog.
 * All source events are cancelled before Main can schedule a model turn. */
export function seedGroupTaskWorkspace(profile: string) {
  const store = new BotStore(path.join(profile, 'companion-bot-v2', 'bot.sqlite'));
  try {
    const owners = [DEFAULT_BOT_COMPANION_ID, 'gpt'];
    const group = store.createGroup({ title: '伙伴任务归属验收', memberIds: owners, participationMode: 'mentions' });
    const privateRoom = store.openDirect('gpt'), retryAt = Date.now() + 86400000;
    const add = (conversationId: string, companionId: string, id: string, done: boolean) => {
      const source = store.enqueue({ conversationId, senderId: 'user', source: 'user', sourceMessageId: id, content: 'Human-authored owner isolation fixture.', recipientIds: [companionId] }).events[0]!;
      store.cancelEvent(source.id);
      store.createTask({ id, conversationId, companionId, sourceEventId: source.id, goal: `仅验证本群任务归属和分页：${id}`, extra: { title: `资料核对 ${id}`, retryAt } });
      if (done) store.updateTask(id, { status: 'succeeded', summary: `隔离界面回执 ${id}` });
    };
    for (let index = 0; index < 8; index++) for (const [ownerIndex, companionId] of owners.entries()) add(group.id, companionId, `group-owner-${ownerIndex}-${index}`, index >= 5);
    for (let index = 0; index < 6; index++) add(privateRoom.id, 'gpt', `private-owner-${index}`, index >= 5);
    return { conversationId: group.id, title: group.title, owners, privateConversationId: privateRoom.id, privateTaskId: 'private-owner-0', countPerOwner: 8, queuedPerOwner: 5, privateCount: 6, synthetic: true, paidRequests: 0 };
  } finally { store.close(); }
}

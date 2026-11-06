import path from 'node:path';
import { BotStore } from '../../src/main/companion-bot/store';
import { BotCompanionRuntime } from '../../src/main/companion-bot/companion-runtime';
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
        extra: { title: i === 18 ? '已停止的隔夜任务' : `${title} ${i + 1}`, retryAt, nativeAttempted: false, workerAccess: 'scoped', ...(i === 2 ? { retryAttempts: 58, lastRecoveryStage: 'attach', lastRecoveryError: 'Fixture: attaching to the original worker session exceeded its deadline.' } : {}),
          progress: { phase: i < 2 ? 'using-tool' : i === 2 ? 'recovering' : 'queued', toolName: i < 2 ? 'shell' : undefined, updatedAt: stamp },
          activity: [{ id: `activity-${i}-0`, phase: 'connecting', createdAt: stamp, updatedAt: stamp }, { id: `activity-${i}-1`, phase: i < 2 ? 'using-tool' : 'queued', toolName: i < 2 ? 'shell' : undefined, createdAt: stamp, updatedAt: stamp }] } });
      store.updateTask(id, { status: i < 2 ? 'running' : i < 13 ? 'queued' : 'succeeded', summary: i >= 13 && i < 18 ? `隔离测试执行回执 ${i}。${'原始工具输出留在详情，不重复塞进聊天。'.repeat(30)}` : '', extra: task.extra });
      // Historical presentation timestamps must precede the seeded stop
      // request; otherwise the screenshot would show waiting > task age.
      store.taskTransaction(sql => sql.prepare('UPDATE bot_tasks SET created_at=? WHERE id=?').run(new Date(Date.now() - 120000 + i * 1000).toISOString(), id));
    }
    // Simulate a task stopped 18 hours ago after exactly 90 seconds of work.
    // Fixture SQL supplies historical state; real Main IPC and both visible
    // clocks must honor the persisted stop rather than count overnight time.
    const stoppedAt = new Date(Date.now() - 18 * 3600000).toISOString();
    const stoppedStartedAt = new Date(Date.parse(stoppedAt) - 90000).toISOString();
    const overnight = store.getTask(ids[18]!)!;
    store.taskTransaction(sql => sql.prepare("UPDATE bot_tasks SET status='cancelled',created_at=?,updated_at=?,extra_json=? WHERE id=?")
      .run(stoppedStartedAt, stoppedAt, JSON.stringify({ ...overnight.extra, cancelRequested: true, humanStopped: true, cancelRequestedAt: stoppedAt,
        elapsedMs: 90000, timerStartedAt: undefined, presenceStartedAt: stoppedStartedAt,
        executorControl: { kind: 'cancel', requestedAt: stoppedAt, state: 'acknowledged', attempts: 0, retryAt: 0 },
        progress: { phase: 'cancelled', detail: '已停止。', updatedAt: stoppedAt } }), ids[18]!));
    for (const id of ids.slice(0, 2)) { const task = store.getTask(id)!; store.updateTask(id, { extra: { ...task.extra, retryAt } }); }
    const notice = store.enqueueTaskNotice({ conversationId, senderId: 'task-service', senderName: '任务回执', source: 'task', sourceMessageId: 'task-ui-complete', recipientIds: [DEFAULT_BOT_COMPANION_ID], kind: 'task_done', payload: { taskId: ids[17] }, content: `任务 ${ids[17]} 状态：succeeded\n${'MASSIVE EXECUTOR RECEIPT '.repeat(90)}` });
    if (notice.deferred) throw new Error('Presentation fixture notice unexpectedly deferred.');
    for (const event of store.activeDomainEvents(DEFAULT_BOT_COMPANION_ID, store.getConversation(conversationId)!.securityDomainId)) store.cancelEvent(event.id);
    store.enqueueTaskNotice({ conversationId, senderId: 'task-service', senderName: '任务回执', source: 'task', sourceMessageId: 'task-ui-already-reported', recipientIds: [DEFAULT_BOT_COMPANION_ID], kind: 'task_done', payload: { taskId: ids[16] }, content: `任务 ${ids[16]} 状态：succeeded\nALREADY REPORTED TRANSPORT RECEIPT` });
    const reply = store.claim({ workerId: 'human-authored-task-presentation' });
    if (!reply || reply.event.source !== 'task' || !store.settle({ eventId: reply.event.id, leaseToken: reply.leaseToken, status: 'done', content: '界面测试：我已经把整理结果带回来啦。执行过程和原始回执放在任务里，需要时可以展开查看。' })) throw new Error('Could not settle the human-authored natural response fixture');
    const runtime = new BotCompanionRuntime(store), followed = store.getTask(ids[0]!)!;
    // activeDomainEvents deliberately excludes never-admitted queued events.
    // Retire the remaining human-authored notice before claiming our guidance.
    const pendingNotices = store.taskTransaction(sql => sql.prepare("SELECT id FROM bot_inbox WHERE conversation_id=? AND companion_id=? AND source='task' AND status='queued'").all(conversationId, DEFAULT_BOT_COMPANION_ID)) as Array<{ id: string }>;
    for (const pending of pendingNotices) store.cancelEvent(pending.id);
    const guidance = store.enqueue({ conversationId, senderId: 'user', recipientIds: [DEFAULT_BOT_COMPANION_ID], sourceMessageId: 'ui-guidance-receipt',
      content: '请同时提供一份 HTML，保留原有文件。', payload: { taskFollowup: { taskId: followed.id } } });
    const followupClaim = store.claim({ workerId: 'human-authored-followup-receipt' });
    if (!followupClaim || followupClaim.event.id !== guidance.events[0]?.id) throw Error(`Unexpected guidance claim: ${followupClaim?.event.sourceMessageId ?? 'none'}; expected ${guidance.events[0]?.sourceMessageId ?? 'none'}`);
    runtime.boundFollowup(followupClaim.event); runtime.deliveredFollowup(followupClaim.event, followed.id);
    store.settle({ eventId: followupClaim.event.id, leaseToken: followupClaim.leaseToken, status: 'done', content: '' });
    const link = store.enqueue({ conversationId, senderId: DEFAULT_BOT_COMPANION_ID, source: 'companion', recipientIds: [], sourceMessageId: 'ui-link-presentation',
      content: '链接放在这里，需要时直接打开。\n\nhttps://www.bilibili.com/video/BV1YgHq62EN6\n\n也可以打开[视频页面](https://www.bilibili.com/video/BV1YgHq62EN6)继续查看。' });
    return { ids, tasks: ids.length, scope: conversationId, synthetic: true, settledReplyId: reply.event.replyMessageId, followupMessageId: guidance.message.id, linkMessageId: link.message.id };
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

/** Completed task notices and their natural replies are written through the
 * production store. They must both remain in private and group chat history.
 * Newer ended tasks fill the bounded catalog without starting native work. */
export function seedTaskActivityHistory(profile: string, directConversationId: string) {
  const store = new BotStore(path.join(profile, 'companion-bot-v2', 'bot.sqlite'));
  try {
    const group = store.createGroup({ title: '任务记录保留验收群', memberIds: [DEFAULT_BOT_COMPANION_ID, 'gpt'], participationMode: 'mentions' });
    const create = (conversationId: string, companionId: string, id: string, title: string, status: 'succeeded' | 'failed' = 'succeeded') => {
      const source = store.enqueue({ conversationId, senderId: 'user', source: 'user', sourceMessageId: `activity-source-${id}`,
        content: '隔离界面验收：核对测试资料，完成后保留任务记录。', recipientIds: [companionId] }).events[0]!;
      store.cancelEvent(source.id);
      store.createTask({ id, conversationId, companionId, sourceEventId: source.id, goal: '只读核对隔离界面测试资料；不调用真实模型或执行器。', extra: { title } });
      store.updateTask(id, { status, summary: `HUMAN_AUTHORED_RAW_EXECUTOR_RESULT_${id}` });
      return { taskId: id, companionId, conversationId, title };
    };
    const direct = create(directConversationId, DEFAULT_BOT_COMPANION_ID, 'activity-private-old', '整理项目资料与引用来源，并核对所有交付文件的名称、格式、目录和阅读说明');
    // Put this historical record outside the latest 100 task cards. Its notice
    // still carries trusted title/owner/state metadata and an exact task ID.
    store.taskTransaction(sql => sql.prepare('UPDATE bot_tasks SET created_at=?,updated_at=? WHERE id=?').run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', direct.taskId));
    for (let index = 0; index < 101; index++) create(directConversationId, DEFAULT_BOT_COMPANION_ID, `activity-catalog-${index}`, `历史目录记录 ${index}`);
    const groupTasks = [
      create(group.id, DEFAULT_BOT_COMPANION_ID, 'activity-group-fish', '核对上海天气资料'),
      create(group.id, 'gpt', 'activity-group-gpt', '核对北京天气资料', 'failed'),
    ];
    const completeNotice = (task: typeof direct, text: string) => {
      const sourceMessageId = `activity-complete-${task.taskId}`;
      const notice = store.enqueueTaskNotice({ conversationId: task.conversationId, senderId: 'task-service', senderName: '任务回执',
        source: 'task', sourceMessageId, recipientIds: [task.companionId], kind: 'task_done', payload: { taskId: task.taskId },
        content: `HUMAN_AUTHORED_RAW_EXECUTOR_RESULT_${task.taskId}` });
      if (notice.deferred) throw Error('Activity history fixture was unexpectedly deferred.');
      const claim = store.claim({ workerId: 'human-authored-task-history' });
      if (!claim || claim.event.sourceMessageId !== sourceMessageId || !store.settle({ eventId: claim.event.id, leaseToken: claim.leaseToken, status: 'done', content: text })) throw Error('Could not settle the activity history reply.');
      return { ...task, noticeId: claim.event.sourceMessageRecordId, replyId: claim.event.replyMessageId, replyText: text };
    };
    return {
      direct: completeNotice(direct, '资料已经整理完成。这个任务的记录和详情会保留在对话里。'),
      group: { conversationId: group.id, title: group.title, tasks: groupTasks.map((task, index) => completeNotice(task, index === 0 ? '上海的测试资料已经核对完成，任务记录在这里。' : '北京的测试资料未能完成核对，失败原因已记在任务中。')) },
      synthetic: true, paidRequests: 0,
    };
  } finally { store.close(); }
}

/** An ordinary subsequent message with no recipients: persistence and UI event
 * refresh are exercised without a background model turn or executor call. */
export function appendTaskActivityConversationMessage(profile: string, conversationId: string) {
  const store = new BotStore(path.join(profile, 'companion-bot-v2', 'bot.sqlite'));
  try {
    return store.enqueue({ conversationId, senderId: 'user', source: 'user', recipientIds: [], sourceMessageId: `activity-later-${conversationId}`,
      content: '后续消息：这些任务记录应当继续留在对话里。' }).message.id;
  } finally { store.close(); }
}

import path from 'node:path';
import { BotStore } from '../../src/main/companion-bot/store';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';

/** Human-authored display messages only: no router event, model or executor. */
export function seedCallOverlay(profile: string, conversationId: string) {
  const store = new BotStore(path.join(profile, 'companion-bot-v2', 'bot.sqlite'));
  try {
    const user = store.enqueue({ conversationId, sourceMessageId: 'overlay-user', source: 'user', senderId: 'user', recipientIds: [], content: '陪我聊一会儿吧。' });
    const companion = store.enqueue({ conversationId, sourceMessageId: 'overlay-companion', source: 'companion', senderId: DEFAULT_BOT_COMPANION_ID, recipientIds: [], content: '我在这里。慢慢说，今天想聊点什么？' });
    return { messageIds: [user.message.id, companion.message.id], events: user.events.length + companion.events.length };
  } finally { store.close(); }
}

export function appendCallOverlayReply(profile: string, conversationId: string, key = 'overlay-controlled-speech-failure', content = '这条回复用于验收收起输入框时的朗读失败提示。') {
  const store = new BotStore(path.join(profile, 'companion-bot-v2', 'bot.sqlite'));
  try {
    const result = store.enqueue({ conversationId, sourceMessageId: key, source: 'companion', senderId: DEFAULT_BOT_COMPANION_ID, recipientIds: [], content });
    return { messageId: result.message.id, events: result.events.length };
  } finally { store.close(); }
}

/** Model-free lifecycle fixture: use the same message identity from generation through final text. */
export function updateCallOverlayReply(profile: string, conversationId: string, key: string, content: string, status: 'running' | 'sent') {
  const store = new BotStore(path.join(profile, 'companion-bot-v2', 'bot.sqlite'));
  try {
    const result = store.enqueue({ conversationId, sourceMessageId: key, source: 'companion', senderId: DEFAULT_BOT_COMPANION_ID, recipientIds: [], content: '正在回应' });
    store.taskTransaction(sql => sql.prepare('UPDATE bot_messages SET content=?,status=? WHERE id=?').run(content, status, result.message.id));
    return { messageId: result.message.id, events: result.events.length };
  } finally { store.close(); }
}

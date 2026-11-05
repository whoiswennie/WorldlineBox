import path from 'node:path';
import { BotStore } from '../../src/main/companion-bot/store';
import type { BotMediaRef } from '../../src/shared/companion-bot-media';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';

export function seedChatResources(profile: string, conversationId: string, url: string, attachments: BotMediaRef[]) {
  const store = new BotStore(path.join(profile, 'companion-bot-v2', 'bot.sqlite'));
  try {
    const send = (sourceMessageId: string, content: string, media?: BotMediaRef[]) => store.enqueue({ conversationId, sourceMessageId,
      senderId: DEFAULT_BOT_COMPANION_ID, source: 'companion', recipientIds: [], content, attachments: media });
    const card = send('resources-link-card', `资料放在这里。\n\n[项目资料预览](${url})`);
    const inline = send('resources-inline-link', `也可以打开[相关说明](${url}?source=inline)继续查看。`);
    const shared = store.enqueue({ conversationId, sourceMessageId: 'resources-user-document', senderId: 'user', recipientIds: [], content: '请查看这份说明。', attachments });
    const file = store.enqueue({ conversationId, sourceMessageId: 'resources-document', senderId: DEFAULT_BOT_COMPANION_ID, source: 'companion', recipientIds: [],
      content: '这份说明可以直接预览，也可以保存。', attachments, sourceIds: [shared.message.id] });
    return { card: card.message.id, inline: inline.message.id, file: file.message.id, events: card.events.length + inline.events.length + file.events.length };
  } finally { store.close(); }
}

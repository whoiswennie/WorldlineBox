import { lstatSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BotStore } from '../../src/main/companion-bot/store';
import type { BotMediaRef } from '../../src/shared/companion-bot-media';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';
export { seedPeerWorkspace } from './bot-peer-workspace-fixture';

/** Real imported attachments, human-authored message, explicitly no AI recipients. */
export function seedThemeAttachments(profile: string, conversationId: string, attachments: BotMediaRef[]) {
  const owned = path.resolve(profile);
  if (path.dirname(owned) !== path.resolve(os.tmpdir()) || !path.basename(owned).startsWith('wlb-peer-workspace-themes-')
    || lstatSync(owned).isSymbolicLink() || path.resolve(realpathSync(owned)) !== owned) throw Error('Theme attachments require their owned profile.');
  const store = new BotStore(path.join(owned, 'companion-bot-v2', 'bot.sqlite'));
  try {
    const result = store.enqueue({ conversationId, senderId: 'user', source: 'user', recipientIds: [], sourceMessageId: 'human-theme-reference-files',
      content: '这是群里的参考资料，需要时展开查看就好。', attachments });
    const userSingle = store.enqueue({ conversationId, senderId: 'user', source: 'user', recipientIds: [], sourceMessageId: 'human-theme-single-file',
      content: '这份说明也单独放在这里。', attachments: attachments.slice(0, 1) });
    const partnerSingle = store.enqueue({ conversationId, senderId: DEFAULT_BOT_COMPANION_ID, source: 'companion', recipientIds: [], sourceMessageId: 'human-theme-partner-file',
      content: '同一份群共享说明，需要时可以展开查看。\n\nhttps://www.bilibili.com/video/BV1YgHq62EN6\n\n或打开[视频页面](https://www.bilibili.com/video/BV1YgHq62EN6)继续查看。', attachments: attachments.slice(0, 1), sourceIds: [userSingle.message.id] });
    if (result.events.length + userSingle.events.length + partnerSingle.events.length) throw Error('Theme fixtures must not start AI work.');
    return { messageId: result.message.id, userSingleId: userSingle.message.id, partnerSingleId: partnerSingle.message.id,
      attachments: result.message.attachments?.length, pendingEvents: 0 };
  } finally { store.close(); }
}

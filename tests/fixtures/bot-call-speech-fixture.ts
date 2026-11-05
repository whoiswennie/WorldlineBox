import path from 'node:path';
import { BotStore } from '../../src/main/companion-bot/store';
import { DEFAULT_BOT_COMPANION_ID } from '../../src/shared/builtin-bot-companions';

/** Human-authored final replies; no model, executor or new agent event is involved. */
export function seedCallSpeech(profile: string, conversationId: string, key: string, content: string) {
  const store = new BotStore(path.join(profile, 'companion-bot-v2', 'bot.sqlite'));
  try {
    const result = store.enqueue({ conversationId, sourceMessageId: `call-speech-${key}`, source: 'companion',
      senderId: DEFAULT_BOT_COMPANION_ID, recipientIds: [], content });
    return { id: result.message.id, status: result.message.status, senderId: result.message.senderId, events: result.events.length };
  } finally { store.close(); }
}

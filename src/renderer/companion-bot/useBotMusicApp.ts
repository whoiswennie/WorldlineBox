import { useState } from 'react';
import type { BotRequest, BotResponse, BotSnapshot } from '../../shared/companion-bot';

export function useBotMusicApp(conversationId: string, runtime: BotSnapshot['chatRuntime'], request: (input: BotRequest) => Promise<BotResponse>, refresh: () => Promise<unknown>) {
  const [drafts, setDrafts] = useState<Record<string, true>>({});
  const topicId = runtime?.topic?.id;
  const attached = topicId ? !!runtime?.apps?.includes('music') : !!drafts[conversationId];
  const clearDraft = () => setDrafts(current => {
    if (!current[conversationId]) return current;
    const next = { ...current }; delete next[conversationId]; return next;
  });
  return {
    attached,
    pending: !topicId && !!drafts[conversationId],
    clearDraft,
    async connect() {
      const result = await request({ type: 'app.connect', conversationId, topicId, appId: 'music' });
      if (!result.ok) throw Error(result.error ?? '音乐应用连接失败。');
      if (topicId) await refresh();
      else setDrafts(current => ({ ...current, [conversationId]: true }));
    },
    async detach() {
      if (!topicId) { clearDraft(); return; }
      const result = await request({ type: 'app.detach', conversationId, topicId, appId: 'music' });
      if (!result.ok) throw Error(result.error ?? '音乐应用断开失败。');
      await refresh();
    },
  };
}

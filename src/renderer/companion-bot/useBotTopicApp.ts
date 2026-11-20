import { useState } from 'react';
import type { BilibiliLoginState } from '../../shared/bilibili';
import type { BotRequest, BotResponse, BotSnapshot } from '../../shared/companion-bot';

export function useBotTopicApp(appId: 'music' | 'video', conversationId: string, runtime: BotSnapshot['chatRuntime'], request: (input: BotRequest) => Promise<BotResponse>, refresh: () => Promise<unknown>) {
  const [prompt, setPrompt] = useState<{ room: string; login: Exclude<BilibiliLoginState,'signed-in'> }>();
  const topicId = runtime?.topic?.id;
  return {
    attached: !!runtime?.apps?.includes(appId),
    loginPrompt: prompt?.room === conversationId ? prompt.login : undefined,
    dismissLogin: () => setPrompt(undefined),
    async connect() {
      const result = await request({ type: 'app.connect', conversationId, topicId, appId });
      if (!result.ok) throw Error(result.error ?? '应用连接失败。');
      if (result.app?.id === 'video' && result.app.login !== 'signed-in') setPrompt({room:conversationId,login:result.app.login});
      await refresh();
    },
    async detach() {
      const result = await request({ type: 'app.detach', conversationId, topicId, appId });
      if (!result.ok) throw Error(result.error ?? '应用断开失败。');
      await refresh();
    },
  };
}

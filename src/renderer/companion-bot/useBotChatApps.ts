import { useRef, useState } from 'react';
import type { BilibiliLoginState } from '../../shared/bilibili';
import type { BrowserPageContext } from '../../shared/browser-page-context';
import type { BotAppId } from '../../shared/companion-apps';
import type { BotRequest, BotResponse, BotSnapshot } from '../../shared/companion-bot';

const emptyApps: BotAppId[] = [];

export function useBotChatApps(conversationId: string, runtime: BotSnapshot['chatRuntime'],
  request: (input: BotRequest) => Promise<BotResponse>, refresh: () => Promise<unknown>, locale: 'zh-CN' | 'en') {
  const [prompt, setPrompt] = useState<{ room: string; login: Exclude<BilibiliLoginState,'signed-in'> }>();
  const [attachingBrowser, setAttachingBrowser] = useState(false);
  const browserAttachmentPending = useRef(false);
  const topicId = runtime?.topic?.id;
  const update = async (input: Extract<BotRequest, { type: 'app.connect' | 'app.browser' | 'app.detach' }>) => {
    const result = await request(input);
    if (!result.ok) throw Error(result.error ?? (locale === 'zh-CN' ? '应用操作失败。' : 'Could not update the app.'));
    if (result.app?.id === 'video' && result.app.login !== 'signed-in') setPrompt({ room: conversationId, login: result.app.login });
    await refresh();
  };
  return {
    apps: runtime?.apps ?? emptyApps,
    browserContext: runtime?.browserContext,
    attachingBrowser,
    browserAttachmentPending,
    onBrowserActivityChange(active: boolean) {
      browserAttachmentPending.current = active;
      setAttachingBrowser(active);
    },
    loginPrompt: prompt?.room === conversationId ? prompt.login : undefined,
    dismissLogin: () => setPrompt(undefined),
    connect: (appId: Exclude<BotAppId, 'browser'>) => update({ type: 'app.connect', conversationId, topicId, appId }),
    attachBrowser: (context: BrowserPageContext) => update({ type: 'app.browser', conversationId, topicId, referenceId: context.referenceId }),
    detach: (appId: BotAppId) => update({ type: 'app.detach', conversationId, topicId, appId }),
  };
}

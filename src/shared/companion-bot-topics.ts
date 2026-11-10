import type { BrowserPageContext } from './browser-page-context';
import type { BotAppId } from './companion-apps';
import type {BotNativeContext} from './companion-native-context';
export interface BotNativeTopic {
  id: string; conversationId: string; title: string; createdAt: string; updatedAt: string;
  pinned?:boolean; favorite?:boolean; renamePending?:boolean;
}
export type BotTopicListMode='recent'|'all'|'favorites';
export interface BotQueuedInput {
  messageId: string; content: string; companionNames: string[]; attachmentNames: string[];
  state: 'queued' | 'guiding' | 'attention'; error?: string;
}
export interface BotChatRuntime {
  browserContext?: BrowserPageContext;
  apps?: BotAppId[];
  contexts?:Record<string,BotNativeContext>;
  topic?: BotNativeTopic;
  running: Array<{ messageId: string; companionId: string; companionName: string; topicId?: string }>;
  queued: BotQueuedInput[];
  hiddenMessageIds: string[];
}

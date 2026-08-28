import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'

const SELECT_VIEW_EVENT = 'worldline:conversation-select-view'

/** Request to select one auxiliary view for a conversation. */
export interface ConversationViewSelection {
  sessionId: SessionId
  viewId: string
}

/** Event name kept private to the conversation shell implementation. */
export const conversationViewSelectionEvent = SELECT_VIEW_EVENT

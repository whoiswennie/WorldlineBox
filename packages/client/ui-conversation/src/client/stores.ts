/**
 * Per-session chat store shared by conversation and details registrations.
 * The plugin creates its handle at apply time so identity follows the fiber.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { CallId, ChatStoreState, SelectionTarget } from './contract/views.ts'
import type { TurnProcessGeneration } from './contract/turn-process.ts'

/** Declared action shape used to give the exported factory a stable return type. */
type ChatActions = {
  select: (draft: ChatStoreState, target: SelectionTarget | null) => void
  setDraft: (draft: ChatStoreState, text: string) => void
  setView: (draft: ChatStoreState, view: string) => void
  setInspect: (draft: ChatStoreState, target: { callId: CallId } | null) => void
  setTurnProcessOpen: (
    draft: ChatStoreState,
    turn: number,
    generation: TurnProcessGeneration,
    open: boolean,
  ) => void
}

/**
 * Declares the per-session chat state and write surface.
 * @returns the store handle.
 */
export function createChatStore(): EngineStoreHandle<ChatStoreState, ChatActions> {
  return defineStore({
    // Anchored to the contract shape: consumers read the store through
    // PropsStore<ChatStore>'s SnapshotSelectorHook<ChatStoreState>, so init
    // and the contract cannot drift.
    init: (): ChatStoreState => ({
      selection: null, draft: '', view: null, inspect: null, turnProcesses: [],
    }),
    persist: 'worldline.conversation.chat',
    actions: {
      select: (d, target: SelectionTarget | null) => { d.selection = target },
      setDraft: (d, text: string) => { d.draft = text },
      setView: (d, view: string) => { d.view = view },
      setInspect: (d, target: { callId: CallId } | null) => { d.inspect = target },
      setTurnProcessOpen: (d, turn, generation, open) => {
        const entries = d.turnProcesses
        const index = entries.findIndex(entry => entry.turn === turn)
        if (!open) {
          if (index >= 0) entries.splice(index, 1)
          return
        }
        const next = { turn, generation }
        if (index < 0) entries.push(next)
        else entries[index] = next
      },
    },
  })
}

/**
 * Stored turn process entry.
 * @param state - state value.
 * @param turn - turn value.
 * @returns The matching stored process generation, when one exists.
 */
export function storedTurnProcessEntry(
  state: Readonly<ChatStoreState>,
  turn: number,
): ChatStoreState['turnProcesses'][number] | undefined {
  return state.turnProcesses.find(entry => entry.turn === turn)
}

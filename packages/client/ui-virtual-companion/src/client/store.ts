import { useSyncExternalStore } from 'react'
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  VirtualCompanion,
  VirtualCompanionDraft,
  VirtualCompanionSnapshot,
} from '../contracts.ts'

/**
 * Contract for directory state.
 */
export interface DirectoryState extends VirtualCompanionSnapshot {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly error?: string
}

interface ApiEnvelope {
  ok?: boolean
  value?: VirtualCompanionSnapshot
  error?: string
}

/**
 * Contract for companion experience state.
 */
export interface CompanionExperienceState {
  /** Reveal coordinator reasoning, context injections, and Tool calls in the transcript. */
  showProcess: boolean
}

type CompanionExperienceActions = {
  setShowProcess: (draft: CompanionExperienceState, visible: boolean) => void
}

/**
 *  Create the per-session, persisted presentation preference shared by companion chat seats.
 * @returns The resulting value.
 */
export function createCompanionExperienceStore(): EngineStoreHandle<
  CompanionExperienceState,
  CompanionExperienceActions
> {
  return defineStore({
    init: (): CompanionExperienceState => ({ showProcess: false }),
    persist: 'worldline.virtual-companion.experience.v1',
    actions: {
      setShowProcess: (draft, visible: boolean) => { draft.showProcess = visible },
    },
  })
}

const EMPTY: DirectoryState = { phase: 'idle', companions: [], rooms: {} }
let state = EMPTY
let loadPromise: Promise<void> | undefined
let roomMutation = Promise.resolve()
const listeners = new Set<() => void>()

function publish(next: DirectoryState): void {
  state = next
  for (const listener of listeners) listener()
}

async function request(path = '', body?: Record<string, unknown>): Promise<VirtualCompanionSnapshot> {
  const response = await fetch(`/api/virtual-companions${path}`, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const envelope = await response.json().catch(() => ({})) as ApiEnvelope
  if (!response.ok || envelope.ok !== true || envelope.value === undefined) {
    throw new Error(envelope.error ?? `虚拟伙伴请求失败（${String(response.status)}）`)
  }
  return envelope.value
}

function ready(snapshot: VirtualCompanionSnapshot): void {
  publish({ phase: 'ready', companions: snapshot.companions, rooms: snapshot.rooms })
}

async function mutate(path: string, body: Record<string, unknown>): Promise<void> {
  try {
    ready(await request(path, body))
  } catch (error) {
    publish({ ...state, phase: 'error', error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

/** Shared browser-side observable and mutation facade. */
export const companionStore = {
  getSnapshot: (): DirectoryState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  load(force = false): Promise<void> {
    if (!force && (state.phase === 'ready' || state.phase === 'loading')) return loadPromise ?? Promise.resolve()
    const { error: _error, ...current } = state
    publish({ ...current, phase: 'loading' })
    loadPromise = request().then(ready, (error: unknown) => {
      publish({ ...state, phase: 'error', error: error instanceof Error ? error.message : String(error) })
    }).finally(() => { loadPromise = undefined })
    return loadPromise
  },
  create(companion: VirtualCompanionDraft): Promise<void> {
    return mutate('/create', { companion })
  },
  update(id: string, companion: VirtualCompanionDraft): Promise<void> {
    return mutate('/update', { id, companion })
  },
  remove(id: string): Promise<void> {
    return mutate('/delete', { id })
  },
  restore(id: string): Promise<void> {
    return mutate('/restore', { id })
  },
  setRoom(sessionId: string, participantIds: readonly string[]): Promise<void> {
    return mutate('/room', { sessionId, participantIds })
  },
  async addParticipant(sessionId: string, companionId: string): Promise<void> {
    const pending = roomMutation.then(async () => {
      await this.load()
      const current = state.rooms[sessionId]?.participantIds ?? []
      if (current.includes(companionId)) return
      await this.setRoom(sessionId, [...current, companionId])
    })
    roomMutation = pending.then(() => undefined, () => undefined)
    await pending
  },
  async removeParticipant(sessionId: string, companionId: string): Promise<void> {
    const pending = roomMutation.then(async () => {
      await this.load()
      const current = state.rooms[sessionId]?.participantIds ?? []
      await this.setRoom(sessionId, current.filter(id => id !== companionId))
    })
    roomMutation = pending.then(() => undefined, () => undefined)
    await pending
  },
  companion(id: string): VirtualCompanion | undefined {
    return state.companions.find(item => item.id === id)
  },
}

/**
 *  Subscribe a component to the shared companion snapshot.
 * @returns The resulting value.
 */
export function useCompanionStore(): DirectoryState {
  return useSyncExternalStore(
    listener => companionStore.subscribe(listener),
    () => companionStore.getSnapshot(),
    () => companionStore.getSnapshot(),
  )
}

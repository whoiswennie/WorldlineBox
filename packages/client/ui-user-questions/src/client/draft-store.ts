/** Session-scoped transient draft state for the generic question composer. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** One in-progress answer, including an explicit skip. */
export interface QuestionDraftAnswer {
  selected: string[]
  custom: string
  skipped: boolean
}

/** Navigation and answer drafts for one pending request. */
export interface QuestionDraftProgress {
  index: number
  drafts: QuestionDraftAnswer[]
}

interface QuestionDraftState {
  requestKey?: string
  progress: QuestionDraftProgress
}

type QuestionDraftActions = {
  replace: (draft: QuestionDraftState, requestKey: string, progress: QuestionDraftProgress) => void
  clear: (draft: QuestionDraftState, requestKey: string) => void
}

const emptyProgress = (): QuestionDraftProgress => ({ index: 0, drafts: [] })

/**
* Declare the question composer's transient Session store.
* @returns a non-persisted store handle whose instance is owned by the Slot registry.
*/
export function createQuestionDraftStore(): EngineStoreHandle<QuestionDraftState, QuestionDraftActions> {
  return defineStore({
    init: (): QuestionDraftState => ({ progress: emptyProgress() }),
    actions: {
      replace: (draft, requestKey, progress) => {
        draft.requestKey = requestKey
        draft.progress = progress
      },
      clear: (draft, requestKey) => {
        if (draft.requestKey !== requestKey) return
        delete draft.requestKey
        draft.progress = emptyProgress()
      },
    },
  })
}

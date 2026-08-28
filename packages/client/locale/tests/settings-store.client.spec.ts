import { describe, expect, it } from 'vitest'
import { createLanguageRowStore } from '../src/client/settings-store.ts'

const options = [{ id: 'zh', label: '中文' }, { id: 'en', label: 'English' }]

describe('createLanguageRowStore', () => {
  it('mirrors only newer locale snapshots', () => {
    const store = createLanguageRowStore().create()
    expect(store.getSnapshot()).toEqual({ active: '', options: [], revision: -1 })
    store.actions.sync('en', options, 2)
    store.actions.sync('zh', options, 1)
    expect(store.getSnapshot()).toEqual({ active: 'en', options, revision: 2 })
  })
})

import { describe, expect, it } from 'vitest'
import { scrubRequestHeaders, stabilizeFixtureMessageIds } from './snapshot-support.ts'

describe('web snapshot support', () => {
  it('scrubs request payloads without changing unrelated JSONL rows', () => {
    const header = JSON.stringify({
      type: 'request/header',
      data: { header: { system: 'volatile', tools: [{ name: 'bash' }], config: { model: 'test' } } },
    })
    const other = JSON.stringify({ type: 'turn/end', data: { turn: 1 } })
    expect(scrubRequestHeaders(`${header}\n${other}`)).toBe([
      JSON.stringify({
        type: 'request/header',
        data: { header: { system: '{{system}}', tools: '{{tools}}', config: { model: 'test' } } },
      }),
      other,
    ].join('\n'))
  })

  it('reuses the committed id only for the same unambiguous message', () => {
    const freshId = '11111111-1111-4111-8111-111111111111'
    const committedId = '22222222-2222-4222-8222-222222222222'
    const message = (id: string) => JSON.stringify({
      type: 'assistant/message',
      data: {
        message: {
          id,
          role: 'assistant',
          content: [{ type: 'text', text: 'stable' }],
          source: { provider: 'replay', model: 'test' },
        },
      },
    })
    expect(stabilizeFixtureMessageIds([message(freshId)], [message(committedId)]))
      .toEqual([message(committedId)])
  })
})

import { describe, expect, it } from 'vitest'
import { inject } from '../src/index.ts'

describe('desktop browser host activation', () => {
  it('publishes electronViewHost before late agent and tool services are ready', () => {
    expect(inject).toEqual(['webServer'])
  })
})

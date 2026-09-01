// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CanonObjectView } from '../src/client/CanonObjectView.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

describe('Canon object view', () => {
  it('projects one Markdown character source into a specialist dossier', () => {
    render(<CanonObjectView
      path="characters/alice.md"
      documentId="document:alice01"
      revision="revision:alice01"
      tags={['主角', '调查员']}
      t={key => zh[key]}
      content={`# Alice

一名追踪失落世界线的调查员。

<!-- worldline-facets {"status":"canon","goal":"找到原点"} -->

## 身份

Alice 来自 [[place:harbor01]]。

## 目标与行为

她会优先保护 @entity:partner01。
`}
    />)

    expect(screen.getByRole('heading', { name: 'Alice' })).toBeTruthy()
    expect(screen.getAllByText('角色')).toHaveLength(2)
    expect(screen.getByText('认知')).toBeTruthy()
    expect(screen.getByText('找到原点')).toBeTruthy()
    expect(screen.getByText('place:harbor01')).toBeTruthy()
    expect(screen.getByText('entity:partner01')).toBeTruthy()
    expect(screen.getByText('此视图只投影当前 Markdown，不创建第二份对象数据。')).toBeTruthy()
  })
})

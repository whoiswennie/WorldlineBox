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
      mediaSources={['data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>']}
      mediaAlt="Alice 主视觉"
      t={key => zh[key]}
      content={`# Alice

一名追踪失落世界线的调查员。

## 身份

Alice 来自 [[place:harbor01]]。

## 目标与行为

- 目标：找到原点

她会优先保护 @entity:partner01。
`}
    />)

    expect(screen.getByRole('heading', { name: 'Alice' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Alice 主视觉' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Alice' }).closest('header')?.children).toHaveLength(3)
    expect(screen.getAllByText('角色')).toHaveLength(2)
    expect(screen.getByText('认知')).toBeTruthy()
    expect(screen.getByText(/目标：找到原点/u)).toBeTruthy()
    expect(screen.getByText('place:harbor01')).toBeTruthy()
    expect(screen.getByText('entity:partner01')).toBeTruthy()
    expect(screen.getByText('此视图只投影当前 Markdown，不创建第二份对象数据。')).toBeTruthy()
  })

  it('renders one visual slot for a non-character archive without media', () => {
    render(<CanonObjectView
      path="assets/notes.md"
      explicitKind="asset"
      documentId="document:notes01"
      revision="revision:notes01"
      tags={['资料']}
      mediaAlt="随身笔记主视觉"
      t={key => zh[key]}
      content={`# 随身笔记

角色的私有检索资料。
`}
    />)

    const image = screen.getByRole('img', { name: '随身笔记主视觉' })
    const hero = screen.getByRole('heading', { name: '随身笔记' }).closest('header')
    expect(image).toBeTruthy()
    expect(hero?.querySelectorAll('img')).toHaveLength(1)
    expect(hero?.children).toHaveLength(3)
  })
})

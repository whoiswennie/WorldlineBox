import { describe, expect, it } from 'vitest'
import type { DocumentView } from '@deepseek-ai/dsh-worldline-project/types'
import {
  NATIVE_CANON_KINDS,
  NATIVE_CANON_SECTIONS,
  dossierDraft,
  dossierMarkdown,
  dossierPath,
  emptyDossierDraft,
  locationDraft,
  plotDraft,
  plotMarkdown,
} from '../src/client/nativeOc.ts'

describe('native OC Markdown projection', () => {
  it('covers the complete OC framework without overlapping category ownership', () => {
    expect(NATIVE_CANON_KINDS).toHaveLength(12)
    expect(NATIVE_CANON_SECTIONS.flatMap(section => section.kinds)).toEqual(
      NATIVE_CANON_KINDS.map(item => item.kind),
    )
    expect(new Set(NATIVE_CANON_KINDS.map(item => item.directory)).size).toBe(12)
  })

  it('creates and reopens a generic dossier in its framework-owned directory', () => {
    const draft = {
      ...emptyDossierDraft('organization'),
      name: '雾港议会',
      summary: '负责雾港航线与灯塔秩序的自治组织。',
      body: '## 权力结构\n\n由七席轮值议员共同决策。',
    }
    const content = dossierMarkdown(draft)
    expect(dossierPath(draft, 1)).toBe('organizations/雾港议会.md')
    expect(content).toContain('# 雾港议会')
    expect(content).toContain('## 权力结构')
    expect(dossierDraft({
      id: 'document:council', projectId: 'project:test', path: 'organizations/council.md',
      revision: 'sha256:test', objectKind: 'organization', tags: [], content,
    } as unknown as DocumentView, 'organization')).toMatchObject(draft)
  })

  it('accepts human-readable Agent-authored location fields', () => {
    const draft = locationDraft({
      id: 'doc:test',
      projectId: 'project:test',
      path: 'maps/places/campus.md',
      revision: 'sha256:test',
      objectKind: 'place',
      tags: [],
      content: `# 星穹学园

互动小说的主舞台。

- 地点 ID：\`map-node:campus01\`
- 地点类型：世界（World）
- 上级地点：—（地图根节点）
- 地图坐标：(320, 180)
- 容纳人数：约 1200 人
- 相邻地点：
  - \`map-node:classroom01|15\`
  - \`map-node:rooftop01|10\`
- 场景背景：\`assets/files/locations/campus/background.png\`
- 场景画廊：
  - \`assets/files/locations/campus/rain.png\`
`,
    } as unknown as DocumentView)

    expect(draft).toMatchObject({
      id: 'map-node:campus01',
      kind: 'world',
      parentId: '',
      x: 320,
      y: 180,
      capacity: '1200',
      connections: 'map-node:classroom01|15\nmap-node:rooftop01|10',
      background: 'assets/files/locations/campus/background.png',
      gallery: 'assets/files/locations/campus/rain.png',
    })
  })

  it('round-trips every repeated hard-time intervention', () => {
    const content = `# 暴雨门控

## 剧情推进

- 顺序：1
- 激活时刻（游戏秒）：0
- 截止时刻（游戏秒）：3600
- 时间干预：1200|广播|全城广播响起
- 时间干预：2400|封路|外廊强制关闭
- 进入条件：风暴正在接近
- 完成证据：角色确认封路事实
`
    const document = {
      id: 'doc:plot', projectId: 'project:test', path: 'scenarios/plot-points/01.md',
      revision: 'sha256:test', objectKind: 'scenario', tags: [], content,
    } as unknown as DocumentView

    const draft = plotDraft(document)
    expect(draft.interventions).toBe('1200|广播|全城广播响起\n2400|封路|外廊强制关闭')
    expect(plotMarkdown(draft)).toContain(
      '- 时间干预：1200|广播|全城广播响起\n- 时间干预：2400|封路|外廊强制关闭',
    )
  })
})

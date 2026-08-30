import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
const binScript = fileURLToPath(new URL('./fixtures/worldline-badge/snapshot.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/worldline-badge/cordis.yml', import.meta.url))
const defaultConfigPath = fileURLToPath(new URL('./fixtures/worldline-badge/default.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const badgeAssetsPath = fileURLToPath(new URL('../../../packages/skill/skill-badge/assets/', import.meta.url))

function normalizeBadgeAssetsPath(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(badgeAssetsPath, '{{badgeAssetsPath}}')
  if (Array.isArray(value)) return value.map(normalizeBadgeAssetsPath)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      normalizeBadgeAssetsPath(item),
    ]))
  }
  return value
}

function catalogText(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const items: unknown[] = value
  return items.map((item) => {
    if (item === null || typeof item !== 'object') return ''
    const text = (item as Record<string, unknown>)['text']
    return typeof text === 'string' ? text : ''
  }).join('\n')
}

describe('worldline badge assembled snapshot', () => {
  it('advertises and loads the opt-in bundled skill through the shipped app', async () => {
    const disabled = await runLoaderSmoke({
      label: 'disabled worldline badge skill snapshot',
      tempDirPrefix: 'headless-snapshot-worldline-badge-disabled-',
      binScript,
      libBinScript: binScript,
      configPath: defaultConfigPath,
      tsconfigPath,
    })
    const enabled = await runLoaderSmoke({
      label: 'worldline badge skill snapshot',
      tempDirPrefix: 'headless-snapshot-worldline-badge-',
      binScript,
      libBinScript: binScript,
      configPath,
      tsconfigPath,
    })
    const disabledSnapshot = JSON.parse(disabled.stdout) as {
      catalog?: unknown
      result?: unknown
      summary?: unknown
    }
    const enabledSnapshot = normalizeBadgeAssetsPath(JSON.parse(enabled.stdout)) as {
      catalog?: unknown
      result?: unknown
      summary?: unknown
    }

    expect(disabled.stderr).toBe('')
    expect(enabled.stderr).toBe('')
    const disabledCatalog = catalogText(disabledSnapshot.catalog)
    expect(disabledCatalog).not.toContain('worldline-badge')
    expect(disabledSnapshot.result).toEqual({
      content: [{
        text: 'Error: skill "worldline-badge" is unknown or no longer available',
        type: 'text',
      }],
      error: { message: 'skill "worldline-badge" is unknown or no longer available' },
      isError: true,
    })
    expect(disabledSnapshot.summary).toBeNull()
    const enabledCatalog = catalogText(enabledSnapshot.catalog)
    expect(enabledCatalog).toContain('`worldline-badge`')
    expect({ result: enabledSnapshot.result, summary: enabledSnapshot.summary }).toMatchInlineSnapshot(`
      {
        "result": {
          "content": [
            {
              "text": "<skill_content name="worldline-badge">
      <skill_resources>
      Base directory for this skill: {{badgeAssetsPath}}
      Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
      </skill_resources>

      <skill_instructions>
      # Worldline Badge

      Add the project-provided “powered by Worldline” badge without recreating or restyling it.

      ## Assets

      - Local PNG: [\`worldline-badge.png\`](worldline-badge.png), deterministically rendered from [\`worldline-badge.svg\`](worldline-badge.svg) at 726×120; display at 121×20
      - Shields.io image URL: \`https://img.shields.io/badge/powered_by-Worldline-6557ff?style=flat-square\`
      - Project URL: \`https://github.com/whoiswennie/WorldlineBox\`

      ## Markdown

      Use this linked badge in Markdown:

      \`\`\`markdown
      [![](https://img.shields.io/badge/powered_by-Worldline-6557ff?style=flat-square)](https://github.com/whoiswennie/WorldlineBox)
      \`\`\`

      If attribution should not be linked, use:

      \`\`\`markdown
      ![](https://img.shields.io/badge/powered_by-Worldline-6557ff?style=flat-square)
      \`\`\`

      ## Usage rules

      - For GitHub or GitLab Markdown, use the Shields.io URL and link it to the project URL unless the user asks for an unlinked image.
      - For Feishu and other systems that import remote images unreliably, upload \`worldline-badge.png\` from this skill directory instead of generating another badge.
      - Preserve the badge's 121×20 dimensions and aspect ratio.
      - Place the badge at the end of the attributed document or section unless the user specifies another position.
      - Do not substitute another color, logo, label, or project URL.

      </skill_instructions>
      </skill_content>",
              "type": "text",
            },
          ],
          "isError": false,
          "value": {
            "content": "# Worldline Badge

      Add the project-provided “powered by Worldline” badge without recreating or restyling it.

      ## Assets

      - Local PNG: [\`worldline-badge.png\`](worldline-badge.png), deterministically rendered from [\`worldline-badge.svg\`](worldline-badge.svg) at 726×120; display at 121×20
      - Shields.io image URL: \`https://img.shields.io/badge/powered_by-Worldline-6557ff?style=flat-square\`
      - Project URL: \`https://github.com/whoiswennie/WorldlineBox\`

      ## Markdown

      Use this linked badge in Markdown:

      \`\`\`markdown
      [![](https://img.shields.io/badge/powered_by-Worldline-6557ff?style=flat-square)](https://github.com/whoiswennie/WorldlineBox)
      \`\`\`

      If attribution should not be linked, use:

      \`\`\`markdown
      ![](https://img.shields.io/badge/powered_by-Worldline-6557ff?style=flat-square)
      \`\`\`

      ## Usage rules

      - For GitHub or GitLab Markdown, use the Shields.io URL and link it to the project URL unless the user asks for an unlinked image.
      - For Feishu and other systems that import remote images unreliably, upload \`worldline-badge.png\` from this skill directory instead of generating another badge.
      - Preserve the badge's 121×20 dimensions and aspect ratio.
      - Place the badge at the end of the attributed document or section unless the user specifies another position.
      - Do not substitute another color, logo, label, or project URL.
      ",
            "name": "worldline-badge",
            "provider": "worldline-badge",
            "resourceBase": {
              "kind": "directory",
              "path": "{{badgeAssetsPath}}",
            },
          },
        },
        "summary": {
          "description": "Add the project-provided “powered by Worldline” badge to documents, pull requests, merge requests, and other attributed content. Use whenever creating a pull request or merge request. Also use when the user asks for a Worldline badge, powered-by-Worldline attribution, or a reusable badge asset or snippet.",
          "invocation": {
            "modelInvocable": true,
            "userInvocable": true,
          },
          "name": "worldline-badge",
          "provider": "worldline-badge",
          "resourceBase": {
            "kind": "directory",
            "path": "{{badgeAssetsPath}}",
          },
          "source": "bundled",
        },
      }
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS * 2)
})

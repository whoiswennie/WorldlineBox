/**
 * REAL-composition tier: boot the examples-owned tool-pwsh Loader fixture as
 * a subprocess through the deployment app/boot path, then execute real
 * foreground and background PowerShell commands through the tool registry.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'

const hasPwsh = spawnSync(
  resolvePwshPath(),
  ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'],
  { encoding: 'utf8' },
).status === 0

const driver = fileURLToPath(new URL(
  '../../../../examples/acp-agent/tests/fixtures/shell/tool-pwsh/driver.ts',
  import.meta.url,
))
const configPath = fileURLToPath(new URL(
  '../../../../examples/acp-agent/tests/fixtures/shell/tool-pwsh/cordis.yml',
  import.meta.url,
))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

interface PwshLoaderReport {
  schemaHasRunInBackground: boolean
  promptHasMarkerSection: boolean
  foregroundText: string
  backgroundText: string
}

describe.skipIf(!hasPwsh)('tool-pwsh through a real Loader composition', () => {
  it('registers the pwsh surface and renders real foreground and background results', async () => {
    let report: PwshLoaderReport | undefined
    const { stderr } = await runLoaderSmoke({
      label: 'tool-pwsh loader smoke',
      tempDirPrefix: 'worldline-tool-pwsh-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      inspect: async (cwd) => {
        report = JSON.parse(
          await readFile(join(cwd, 'pwsh-loader-report.json'), 'utf8'),
        ) as PwshLoaderReport
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(report).toBeDefined()
    expect(report).toMatchObject({
      schemaHasRunInBackground: true,
      promptHasMarkerSection: true,
    })
    expect(report?.foregroundText).toBe('loader-ok\n')
    expect(report?.backgroundText).toContain('loader-bg-ok')
    expect(report?.backgroundText).toContain('[status: completed, exit code: 0]')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})

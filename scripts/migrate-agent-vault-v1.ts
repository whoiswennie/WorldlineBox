/** Auditable one-shot CLI for the legacy companion-to-Agent-Vault migration. */
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import LocalAgentVaultService from '../packages/agent-vault/agent-vault-local/src/index.ts'
import { migrateLegacyCompanions } from '../packages/client/ui-virtual-companion/src/agent-vault-migration.ts'
import type { VirtualCompanion } from '../packages/client/ui-virtual-companion/src/contracts.ts'

function argument(name: string): string {
  const index = process.argv.indexOf(name); const value = index < 0 ? undefined : process.argv[index + 1]
  if (value === undefined || value.trim() === '') throw new Error(`Missing ${name}`)
  return resolve(value)
}

const legacyRoot = argument('--legacy-root')
const worldlineHome = argument('--worldline-home')
const backupRoot = argument('--backup-root')
const directory = JSON.parse(await readFile(resolve(legacyRoot, 'directory.json'), 'utf8')) as {
  companions?: VirtualCompanion[]
}
if (!Array.isArray(directory.companions)) throw new Error('Legacy directory has no companion profiles.')

const vaults = new LocalAgentVaultService(new Context(), { worldlineHome })
try {
  const report = await migrateLegacyCompanions({ legacyRoot, backupRoot,
    profiles: directory.companions, vaults })
  process.stdout.write(`${JSON.stringify(report ?? { status: 'already-complete' }, null, 2)}\n`)
} finally {
  vaults.close()
}

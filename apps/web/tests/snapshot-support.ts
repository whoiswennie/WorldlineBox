// Web E2E-only fixture normalization. The product does not need the complete
// ACP snapshot-suite package, only these two deterministic JSONL transforms.
import { isSurfaceEligibleType } from '@deepseek-ai/dsh-session/surface'

const SYSTEM_TOKEN = '{{system}}'
const TOOLS_TOKEN = '{{tools}}'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Replace bulky request-header payloads while preserving JSONL event shape. */
export function scrubRequestHeaders(rawLog: string): string {
  return rawLog.split('\n').map((line) => {
    if (line.trim().length === 0) return line
    const record = JSON.parse(line) as Record<string, unknown>
    const data = record.data
    if (record.type !== 'request/header' || !isRecord(data) || !isRecord(data.header)) return line
    let touched = false
    if ('system' in data.header) {
      data.header.system = SYSTEM_TOKEN
      touched = true
    }
    if ('tools' in data.header) {
      data.header.tools = TOOLS_TOKEN
      touched = true
    }
    return touched ? JSON.stringify(record) : line
  }).join('\n')
}

function completeMessage(value: unknown): Record<string, unknown> | undefined {
  if (
    !isRecord(value)
    || typeof value.id !== 'string'
    || !UUID_RE.test(value.id)
    || typeof value.role !== 'string'
    || !Array.isArray(value.content)
    || !isRecord(value.source)
  ) return undefined
  return value
}

function surfaceEventMessage(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const type = record.type
  if (typeof type !== 'string' || !isSurfaceEligibleType(type) || !isRecord(record.data)) return undefined
  switch (type) {
    case 'user/message': return completeMessage(record.data)
    case 'assistant/message':
    case 'tool/result': return completeMessage(record.data.message)
    default: throw new Error(`snapshot-support: unsupported surface event type "${type}"`)
  }
}

function recordMessages(record: Record<string, unknown>): Record<string, unknown>[] {
  const surfaceMessage = surfaceEventMessage(record)
  if (surfaceMessage !== undefined) return [surfaceMessage]
  if (record.type !== 'agent/inbox/spliced' || !isRecord(record.data) || !Array.isArray(record.data.inserted)) {
    return []
  }
  return record.data.inserted.flatMap((value) => {
    const message = completeMessage(value)
    return message === undefined ? [] : [message]
  })
}

function parseJsonlRecords(text: string): Record<string, unknown>[] {
  return text.split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function uniqueMessageIds(logs: readonly string[]): Map<string, string> {
  const fingerprintsById = new Map<string, Set<string>>()
  const idsByFingerprint = new Map<string, Set<string>>()
  for (const log of logs) {
    for (const record of parseJsonlRecords(log)) {
      for (const message of recordMessages(record)) {
        const { id, ...withoutId } = message
        const messageId = id as string
        const fingerprint = canonicalJson(withoutId)
        const fingerprints = fingerprintsById.get(messageId)
        if (fingerprints === undefined) fingerprintsById.set(messageId, new Set([fingerprint]))
        else fingerprints.add(fingerprint)
        const ids = idsByFingerprint.get(fingerprint)
        if (ids === undefined) idsByFingerprint.set(fingerprint, new Set([messageId]))
        else ids.add(messageId)
      }
    }
  }
  const unique = new Map<string, string>()
  for (const [id, fingerprints] of fingerprintsById) {
    if (fingerprints.size !== 1) continue
    const fingerprint = fingerprints.values().next().value as string
    if (idsByFingerprint.get(fingerprint)?.size === 1) unique.set(fingerprint, id)
  }
  return unique
}

/** Reuse committed IDs only for unchanged, unambiguous durable messages. */
export function stabilizeFixtureMessageIds(
  logs: readonly string[],
  fixtures: readonly string[],
): string[] {
  const freshIds = uniqueMessageIds(logs)
  const existingIds = uniqueMessageIds(fixtures)
  const replacements = new Map<string, string>()
  for (const [fingerprint, fresh] of freshIds) {
    const existing = existingIds.get(fingerprint)
    if (existing !== undefined && fresh !== existing) replacements.set(fresh, existing)
  }
  return logs.map(log => log.split('\n').map((line) => {
    if (line.trim().length === 0) return line
    const record = JSON.parse(line) as Record<string, unknown>
    let changed = false
    for (const message of recordMessages(record)) {
      const replacement = replacements.get(message.id as string)
      if (replacement === undefined) continue
      message.id = replacement
      changed = true
    }
    return changed ? JSON.stringify(record) : line
  }).join('\n'))
}

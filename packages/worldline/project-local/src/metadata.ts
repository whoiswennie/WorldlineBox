import { dirname, resolve } from 'node:path'
import type { CanonObjectKind, DocumentId } from '@deepseek-ai/dsh-worldline-standard'
import { allocateWorldlineId } from '@deepseek-ai/dsh-worldline-standard'
import { durableWrite, exists, normalizeRelative, readTextBounded } from './storage.ts'

export interface DocumentMetadata {
  readonly id: DocumentId
  readonly objectKind?: CanonObjectKind
  readonly tags: readonly string[]
}

interface MetadataDocument { readonly documents: Record<string, DocumentMetadata> }

export class ProjectMetadata {
  private document: MetadataDocument = { documents: {} }
  private dirty = false

  constructor(private readonly projectPath: string) {}

  private get path(): string { return resolve(this.projectPath, '.worldline', 'index.json') }

  async load(): Promise<void> {
    if (!(await exists(this.path))) return
    const parsed = JSON.parse(await readTextBounded(this.path)) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)
      || !('documents' in parsed) || typeof parsed.documents !== 'object'
      || parsed.documents === null || Array.isArray(parsed.documents)) {
      throw new Error('project metadata does not match the current Worldline schema')
    }
    this.document = { documents: parsed.documents as Record<string, DocumentMetadata> }
  }

  get(path: string): DocumentMetadata | undefined { return this.document.documents[normalizeRelative(path)] }

  ensure(path: string, patch?: Partial<Omit<DocumentMetadata, 'id'>> & { id?: DocumentId }): DocumentMetadata {
    const normalized = normalizeRelative(path)
    const current = this.document.documents[normalized]
    const objectKind = patch?.objectKind ?? current?.objectKind
    const next: DocumentMetadata = {
      id: patch?.id ?? current?.id ?? allocateWorldlineId<'document'>('doc'),
      ...(objectKind === undefined ? {} : { objectKind }),
      tags: patch?.tags ?? current?.tags ?? [],
    }
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      this.document.documents[normalized] = next
      this.dirty = true
    }
    return next
  }

  move(source: string, destination: string): void {
    const from = normalizeRelative(source)
    const to = normalizeRelative(destination)
    const next: Record<string, DocumentMetadata> = {}
    for (const [path, metadata] of Object.entries(this.document.documents)) {
      if (path === from || path.startsWith(`${from}/`)) next[`${to}${path.slice(from.length)}`] = metadata
      else next[path] = metadata
    }
    this.document = { documents: next }
    this.dirty = true
  }

  remove(path: string): void {
    const normalized = normalizeRelative(path)
    const documents: Record<string, DocumentMetadata> = {}
    for (const [key, value] of Object.entries(this.document.documents)) {
      if (key !== normalized && !key.startsWith(`${normalized}/`)) documents[key] = value
    }
    this.document = { documents }
    this.dirty = true
  }

  clone(source: string, destination: string): void {
    const from = normalizeRelative(source)
    const to = normalizeRelative(destination)
    for (const [path, metadata] of Object.entries({ ...this.document.documents })) {
      if (path === from || path.startsWith(`${from}/`)) {
        this.document.documents[`${to}${path.slice(from.length)}`] = {
          ...metadata,
          id: allocateWorldlineId<'document'>('doc'),
        }
      }
    }
    this.dirty = true
  }

  async save(): Promise<void> {
    if (!this.dirty) return
    await durableWrite(this.path, `${JSON.stringify(this.document, null, 2)}\n`)
    this.dirty = false
  }

  historyPath(id: DocumentId, revision: string): string {
    const idPath = id.replace(/[^a-zA-Z0-9._-]/g, '_')
    const revisionPath = revision.replace(/[^a-zA-Z0-9._-]/g, '_')
    return resolve(dirname(this.path), 'history', idPath, `${revisionPath}.snapshot`)
  }
}

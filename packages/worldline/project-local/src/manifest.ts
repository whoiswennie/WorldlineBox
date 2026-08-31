import { parse, stringify } from 'smol-toml'
import type { ProjectManifest, ProjectTemplate } from '@deepseek-ai/dsh-worldline-standard'
import { PROJECT_MANIFEST, WWS_VERSION, worldlineId } from '@deepseek-ai/dsh-worldline-standard'
import { WorldlineProjectError } from '@deepseek-ai/dsh-worldline-project'
import { durableWrite, readTextBounded } from './storage.ts'

const TEMPLATES = new Set<ProjectTemplate>([
  'blank',
  'world-encyclopedia',
  'character-story',
  'social-simulation',
  'civilization-sandbox',
  'playable-scenario',
])

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorldlineProjectError('project-invalid', `worldline.toml requires ${field}`)
  }
  return value
}

function dateString(value: unknown, field: string): string {
  if (value instanceof Date) return value.toISOString()
  const text = requiredString(value, field)
  if (!Number.isFinite(Date.parse(text))) {
    throw new WorldlineProjectError('project-invalid', `worldline.toml ${field} is not an ISO date`)
  }
  return text
}

export async function readManifest(projectPath: string): Promise<ProjectManifest> {
  let raw: Record<string, unknown>
  try {
    raw = parse(await readTextBounded(`${projectPath}/${PROJECT_MANIFEST}`))
  } catch (error) {
    if (error instanceof WorldlineProjectError) throw error
    throw new WorldlineProjectError('project-invalid', `cannot parse worldline.toml: ${String(error)}`)
  }
  const template = requiredString(raw.template, 'template') as ProjectTemplate
  if (!TEMPLATES.has(template)) {
    throw new WorldlineProjectError('project-invalid', `unknown project template: ${template}`)
  }
  const format = requiredString(raw.format, 'format')
  if (format !== WWS_VERSION) {
    throw new WorldlineProjectError('project-invalid', `unsupported WWS format: ${format}`)
  }
  const dependencies = Array.isArray(raw.dependencies)
    ? raw.dependencies.map((entry) => {
      const value = entry as Record<string, unknown>
      return {
        id: requiredString(value.id, 'dependencies.id'),
        version: requiredString(value.version, 'dependencies.version'),
        required: value.required !== false,
      }
    })
    : []
  return {
    format: WWS_VERSION,
    id: worldlineId<'project'>(requiredString(raw.id, 'id')),
    name: requiredString(raw.name, 'name'),
    description: typeof raw.description === 'string' ? raw.description : '',
    createdAt: dateString(raw.createdAt, 'createdAt'),
    updatedAt: dateString(raw.updatedAt, 'updatedAt'),
    defaultWorldId: worldlineId<'world'>(requiredString(raw.defaultWorldId, 'defaultWorldId')),
    defaultWorldlineId: worldlineId<'worldline'>(
      requiredString(raw.defaultWorldlineId, 'defaultWorldlineId'),
    ),
    ...(typeof raw.cover === 'string' ? { cover: raw.cover } : {}),
    ...(typeof raw.author === 'string' ? { author: raw.author } : {}),
    ...(typeof raw.license === 'string' ? { license: raw.license } : {}),
    template,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((value): value is string => typeof value === 'string') : [],
    dependencies,
  }
}

export async function writeManifest(projectPath: string, manifest: ProjectManifest): Promise<void> {
  const document: Record<string, unknown> = {
    format: manifest.format,
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    defaultWorldId: manifest.defaultWorldId,
    defaultWorldlineId: manifest.defaultWorldlineId,
    template: manifest.template,
    tags: [...manifest.tags],
    dependencies: manifest.dependencies.map(value => ({ ...value })),
  }
  if (manifest.cover !== undefined) document.cover = manifest.cover
  if (manifest.author !== undefined) document.author = manifest.author
  if (manifest.license !== undefined) document.license = manifest.license
  await durableWrite(`${projectPath}/${PROJECT_MANIFEST}`, stringify(document))
}

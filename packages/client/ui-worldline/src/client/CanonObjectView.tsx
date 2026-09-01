import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { inferCanonObjectKind } from '@deepseek-ai/dsh-worldline-standard/canon-kind'
import type { CanonObjectKind } from '@deepseek-ai/dsh-worldline-standard/types'
import type { WorldlineLocaleKey } from './locales.ts'
import css from './CanonObjectView.module.css'

interface CanonObjectViewProps {
  readonly path: string
  readonly content: string
  readonly explicitKind?: CanonObjectKind | undefined
  readonly documentId: string
  readonly revision: string | number
  readonly tags: readonly string[]
  readonly t: (key: WorldlineLocaleKey) => string
}

interface ParsedSection {
  readonly title: string
  readonly body: string
}

const KIND_LABELS: Record<CanonObjectKind, WorldlineLocaleKey> = {
  charter: 'kindCharter',
  character: 'kindCharacter',
  place: 'kindPlace',
  organization: 'kindOrganization',
  species: 'kindSpecies',
  item: 'kindItem',
  concept: 'kindConcept',
  rule: 'kindRule',
  relation: 'kindRelation',
  fact: 'kindFact',
  'timeline-event': 'kindTimeline',
  scenario: 'kindScenario',
  asset: 'kindAsset',
  custom: 'kindCustom',
}

const KIND_ICONS: Record<CanonObjectKind, string> = {
  charter: '✦', character: '◉', place: '⌖', organization: '⌘', species: '❈', item: '◇',
  concept: '∞', rule: '⚖', relation: '↭', fact: '●', 'timeline-event': '◷', scenario: '▶',
  asset: '▧', custom: '✣',
}

const MODEL_PROJECTIONS: Record<CanonObjectKind, readonly string[]> = {
  charter: ['Purpose', 'Scope', 'Expectation Profile', 'Invariant'],
  character: ['Entity', 'Facet', 'Belief', 'Goal', 'Policy', 'Action'],
  place: ['Entity', 'Space', 'Environment', 'Process', 'Invariant'],
  organization: ['Entity', 'Relationship', 'Practice', 'Resource', 'Policy'],
  species: ['Entity', 'Facet', 'Lifecycle', 'Environment', 'Capability'],
  item: ['Entity', 'Resource', 'Ownership', 'Action', 'Lifecycle'],
  concept: ['Ontology', 'Facet', 'Fact', 'Relationship', 'Provenance'],
  rule: ['State', 'Action', 'Process', 'System', 'Invariant'],
  relation: ['Relationship', 'Fact', 'Scope', 'Evidence', 'Event'],
  fact: ['Fact', 'Scope', 'Epistemic State', 'Provenance'],
  'timeline-event': ['Time', 'Event', 'Causality', 'State Delta', 'Provenance'],
  scenario: ['Scenario', 'Goal', 'Director', 'Control', 'Termination'],
  asset: ['Asset', 'Projection', 'Media Cue', 'License', 'Binding'],
  custom: ['Entity', 'Facet', 'Fact', 'Relationship', 'Provenance'],
}

function parseDocument(content: string): { readonly title: string; readonly summary: string; readonly sections: readonly ParsedSection[] } {
  const title = /^#\s+(.+)$/mu.exec(content)?.[1]?.trim() ?? 'Untitled'
  const sectionMatches = [...content.matchAll(/^##\s+(.+)$/gmu)]
  const firstSection = sectionMatches[0]?.index ?? content.length
  const preface = content.slice(0, firstSection)
    .replace(/^#\s+.*$/mu, '')
    .replace(/<!--\s*worldline-facets[\s\S]*?-->/gu, '')
    .trim()
  const sections = sectionMatches.map((match, index) => {
    const start = match.index + match[0].length
    const end = sectionMatches[index + 1]?.index ?? content.length
    return { title: match[0].slice(3).trim(), body: content.slice(start, end).trim() }
  }).filter(section => section.body !== '')
  return { title, summary: preface, sections }
}

function parseFacets(content: string): Readonly<Record<string, unknown>> {
  const source = /<!--\s*worldline-facets\s+([\s\S]*?)-->/u.exec(content)?.[1]
  if (source === undefined) return {}
  try {
    const parsed = JSON.parse(source) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Readonly<Record<string, unknown>>
      : {}
  } catch { return {} }
}

function referencesOf(content: string): readonly string[] {
  const values = [...content.matchAll(/\[\[([^\]]+)\]\]|@([a-z][a-z0-9-]*:[a-zA-Z0-9._-]+)/gu)]
    .map(match => match[0].startsWith('[[') ? match[0].slice(2, -2).trim() : match[0].slice(1).trim())
    .filter(value => value !== '')
  return [...new Set(values)].slice(0, 24)
}

function facetText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

export function CanonObjectView(props: CanonObjectViewProps) {
  const parsed = parseDocument(props.content)
  const resolution = inferCanonObjectKind(props.path, props.explicitKind)
  const facets = Object.entries(parseFacets(props.content)).slice(0, 12)
  const references = referencesOf(props.content)
  return <article className={css.objectView} data-kind={resolution.kind} data-worldline-hero>
    <header className={css.hero} data-worldline-depth="1">
      <div className={css.sigil} aria-hidden="true"><span>{KIND_ICONS[resolution.kind]}</span></div>
      <div className={css.identity}>
        <div><span>{props.t(KIND_LABELS[resolution.kind])}</span><i>CANON OBJECT</i></div>
        <h1>{parsed.title}</h1>
        <p>{parsed.summary || props.t('canonNoSummary')}</p>
        <div className={css.chips}>{props.tags.map(tag => <span key={tag}>#{tag}</span>)}<span>{props.path}</span></div>
      </div>
      <dl className={css.metrics}>
        <div><dt>{props.t('canonSections')}</dt><dd>{parsed.sections.length}</dd></div>
        <div><dt>{props.t('canonReferences')}</dt><dd>{references.length}</dd></div>
        <div><dt>{props.t('canonStatus')}</dt><dd>{facetText(parseFacets(props.content)['status'] ?? 'canon')}</dd></div>
      </dl>
    </header>

    <section className={css.modelRail} aria-label={props.t('canonRuntime')} data-worldline-stagger>
      <div><small>{props.t('canonRuntime')}</small><strong>{props.t('canonRuntimeHint')}</strong></div>
      {MODEL_PROJECTIONS[resolution.kind].map(model => <span key={model}>{model}</span>)}
    </section>

    <div className={css.contentGrid}>
      <section className={css.sections} data-worldline-stagger>
        {parsed.sections.length === 0 && <div className={css.emptySection}><span>✧</span><strong>{props.t('canonNoSections')}</strong><p>{props.t('canonNoSectionsHint')}</p></div>}
        {parsed.sections.map((section, index) => <section className={css.sectionCard} key={`${section.title}:${String(index)}`}>
          <header><span>{String(index + 1).padStart(2, '0')}</span><h2>{section.title}</h2></header>
          <MarkdownText text={section.body} />
        </section>)}
      </section>

      <aside className={css.context} data-worldline-reveal>
        <section><header><span>◈</span><h2>{props.t('canonIdentity')}</h2></header><dl><dt>ID</dt><dd>{props.documentId}</dd><dt>{props.t('kind')}</dt><dd>{resolution.customKind ?? props.t(KIND_LABELS[resolution.kind])}</dd><dt>{props.t('revision')}</dt><dd>{String(props.revision).slice(0, 12)}</dd></dl></section>
        <section><header><span>⌁</span><h2>{props.t('canonFacets')}</h2></header>{facets.length === 0 ? <p>{props.t('canonNoFacets')}</p> : <dl>{facets.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{facetText(value)}</dd></div>)}</dl>}</section>
        <section><header><span>↗</span><h2>{props.t('canonReferences')}</h2></header>{references.length === 0 ? <p>{props.t('canonNoReferences')}</p> : <div className={css.references}>{references.map(reference => <span key={reference}>{reference}</span>)}</div>}</section>
        <section className={css.source}><header><span>◎</span><h2>{props.t('canonSource')}</h2></header><p>{props.t('canonSourceHint')}</p><code>{props.path}</code></section>
      </aside>
    </div>
  </article>
}

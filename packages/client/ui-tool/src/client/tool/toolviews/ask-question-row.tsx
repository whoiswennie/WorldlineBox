// ask_user_question toolview: question-flavored summary row replacing the
// generic "Tool call" card, registered into the keyed
// 'tool.call.toolview' hole like todo-row. The row composes ToolRow
// (chrome, running sweep, whole-row expand) and swaps in the interaction
// outcome — `waiting` while pending, answered-count once settled, `cancelled`
// when the user dismissed the whole set — because the questions themselves
// render in the composer takeover.

import { IconQuestionOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import type { AskQuestionCardModel } from '../models/ask-question-card-model.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

interface AnswerEntry {
  id: string
  selected: string[]
  custom?: string
}

interface QuestionEntry {
  id: string
  question: string
}

interface AnsweredQuestion extends QuestionEntry {
  answers: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function answerEntries(text: string): AnswerEntry[] | null {
  const parsed = parseJson(text)
  if (!isRecord(parsed) || !Array.isArray(parsed.answers) || !parsed.answers.every(isRecord)) return null
  const entries: AnswerEntry[] = []
  for (const answer of parsed.answers) {
    if (typeof answer.id !== 'string'
      || !Array.isArray(answer.selected)
      || !answer.selected.every(item => typeof item === 'string')
      || (answer.custom !== undefined && typeof answer.custom !== 'string')) return null
    entries.push({
      id: answer.id,
      selected: answer.selected,
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
    })
  }
  return entries
}

function questionEntries(argsRaw: string): QuestionEntry[] | null {
  const parsed = parseJson(argsRaw)
  if (!isRecord(parsed) || !Array.isArray(parsed.questions) || parsed.questions.length === 0) return null
  const entries: QuestionEntry[] = []
  const ids = new Set<string>()
  for (const question of parsed.questions) {
    if (!isRecord(question)
      || typeof question.id !== 'string'
      || typeof question.question !== 'string'
      || ids.has(question.id)) return null
    ids.add(question.id)
    entries.push({ id: question.id, question: question.question })
  }
  return entries
}

function pairAnswers(argsRaw: string, answers: AnswerEntry[]): AnsweredQuestion[] | null {
  const questions = questionEntries(argsRaw)
  if (questions === null || questions.length !== answers.length) return null
  const byId = new Map<string, AnswerEntry>()
  for (const answer of answers) {
    if (byId.has(answer.id)) return null
    byId.set(answer.id, answer)
  }
  const paired: AnsweredQuestion[] = []
  for (const question of questions) {
    const answer = byId.get(question.id)
    if (answer === undefined) return null
    paired.push({
      ...question,
      answers: [
        ...answer.selected,
        ...(answer.custom === undefined || answer.custom === '' ? [] : [answer.custom]),
      ],
    })
  }
  return paired
}

/** Best-effort answered-count summary when strict transcript pairing is unsafe. */
function answeredSummary(text: string, t: AskQuestionRowProps['t']): string | null {
  const parsed = parseJson(text)
  if (!isRecord(parsed) || !Array.isArray(parsed.answers) || !parsed.answers.every(isRecord)) return null
  const answers = parsed.answers
  const answered = answers.filter(a =>
    (Array.isArray(a.selected) && a.selected.length > 0)
    || (typeof a.custom === 'string' && a.custom !== '')).length
  return t('ask.answered', { answered, total: answers.length })
}

/** Full row props: the toolview runtime share plus the standard locale seat. */
type AskQuestionRowProps = ToolCallViewProps & PropsLocale<'conversation'>

/** One-line question-interaction row (the whole row toggles the call's
 *  Input/Output sections, ToolRow's unified expand). */
export function AskQuestionRow({ toolName, block, inspect, t }: AskQuestionRowProps) {
  const model = toolRowModel(toolName, block)
  // Composer verdicts settle the call as specific UserQuestionErrors
  // (apiproxy ask_user_question handler): 'ASK_CANCELLED' is the user's own
  // dismissal of the set, 'ASK_ABORTED' is a turn interrupt landing while the
  // question was pending. Both name their verdict instead of the generic
  // failed shape, and the abort keeps the shared stopped (amber) semantics of
  // any other interrupted tool call.
  const code = 'kind' in block ? block.error?.code : undefined
  const argsRaw = ('kind' in block ? block.call?.argsRaw : block.argsRaw) ?? ''
  let summary = model.summary
  let state = model.state
  let transcript: AskQuestionCardModel | null = null
  if (code === 'ASK_CANCELLED') {
    summary = t('ask.cancelled')
    state = 'ok'
    const questions = questionEntries(argsRaw)
    if (questions !== null) {
      transcript = { kind: 'unanswered', questions, verdict: t('ask.cancelledDetail') }
    }
  } else if (code === 'ASK_ABORTED') {
    summary = t('ask.interrupted')
    state = 'stopped'
    const questions = questionEntries(argsRaw)
    if (questions !== null) {
      transcript = { kind: 'unanswered', questions, verdict: t('ask.interruptedDetail') }
    }
  } else if (model.state === 'running') {
    summary = t('ask.waiting')
  } else if ('kind' in block && model.state === 'ok') {
    const text = block.content.filter(b => b.type === 'text').map(b => b.text).join('')
    const answers = answerEntries(text)
    summary = answeredSummary(text, t) ?? model.summary
    if (answers !== null) {
      const questions = pairAnswers(argsRaw, answers)
      if (questions !== null) {
        transcript = { kind: 'answered', questions, skippedLabel: t('ask.skipped') }
      }
    }
  }
  return (
    <ToolRow
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={<IconQuestionOutline14 />}
      title={t('ask.rowTitle')}
      summary={summary}
      body={transcript === null ? model.body : null}
      output={transcript === null ? model.output : null}
      askQuestion={transcript}
      state={state}
      inspect={inspect}
    />
  )
}

/**
 * The ask-question row as a plain registrant plugin following the chat
 * toolview declaration across independent activation and reload lifetimes.
 */
export const askQuestionToolview = {
  name: 'ask-question-toolview',
  inject: ['slots'],
  /**
   * Register the ask-question row into the Tool-owned keyed view slot.
   * @param ctx - registrant context (disposal rides ctx.effect inside slots.register).
   */
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview', key: 'ask_user_question', locale: NS,
    }, AskQuestionRow))
  },
}

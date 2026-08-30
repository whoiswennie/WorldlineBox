/**
 * Model-facing `browser_control` adapter over the conversation-owned native browser seam.
 * @module @deepseek-ai/dsh-tool-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import { FIRST_PARTY_SECTION_ORDER } from '@deepseek-ai/dsh-system-prompt'
import { BROWSER_ACTIONS, type BrowserAction, type BrowserCommand } from '@deepseek-ai/dsh-browser'
import type {} from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'tool-browser'
export const inject = ['tools', 'systemPrompt']
/**
 * Default browser tool timeout ms.
 */
export const DEFAULT_BROWSER_TOOL_TIMEOUT_MS = 65_000
/**
 * Default browser max output chars.
 */
export const DEFAULT_BROWSER_MAX_OUTPUT_CHARS = 200_000

/** Browser-control execution and output bounds. */
export interface Config {
  /** Cooperative timeout enforced outside individual CDP calls. */
  timeoutMs?: number
  /** Complete model-facing text cap for successful and failed calls. */
  maxOutputChars?: number
}

/**
 * Config.
 * @returns The resulting value.
 */
export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(DEFAULT_BROWSER_TOOL_TIMEOUT_MS),
  maxOutputChars: z.number().default(DEFAULT_BROWSER_MAX_OUTPUT_CHARS),
})

interface BrowserToolArgs {
  action: BrowserAction
  tab_id?: string
  url?: string
  timeout_ms?: number
  selector?: string
  text?: string
  value?: string
  key?: string
  x?: number
  y?: number
  width?: number
  height?: number
  max_text_length?: number
  max_elements?: number
  max_entries?: number
  save_path?: string
  expression?: string
  method?: string
  params?: Record<string, JsonValue>
  open?: boolean
}

/**
 * Browser tools installed outside Worldline can otherwise operate a second,
 * invisible Electron view while the conversation Browser pane keeps showing
 * this package's session-owned runtime. Hide only inherited legacy browser
 * commands from this Agent; scoped first-party registration remains visible
 * and unrelated tools/plugins are untouched.
 */
function restrictCompetingBrowserTools(ctx: Context): void {
  const scope = scopeOf(ctx)
  if (scope === undefined) return
  let signature = ''
  let lift: (() => void) | undefined
  let reconciling = false
  const reconcile = (): void => {
    if (reconciling) return
    // Read the unrestricted global plane so our own active restriction does
    // not hide the names it must continue denying.
    const deny = ctx.tools.schemas()
      .map(tool => tool.name)
      .filter(name => name !== 'browser_control' && name.startsWith('browser_'))
      .sort()
    const nextSignature = deny.join('\0')
    if (nextSignature === signature) return
    reconciling = true
    try {
      lift?.()
      lift = deny.length === 0 ? undefined : ctx.tools.restrict({ deny })
      signature = nextSignature
    } finally {
      reconciling = false
    }
  }
  reconcile()
  ctx.on('tools/change', reconcile)
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`tool-browser: ${name} must be a positive integer`)
}

function commandFromArgs(args: BrowserToolArgs): BrowserCommand {
  return {
    action: args.action,
    ...(args.tab_id === undefined ? {} : { tabId: args.tab_id }),
    ...(args.url === undefined ? {} : { url: args.url }),
    ...(args.timeout_ms === undefined ? {} : { timeoutMs: args.timeout_ms }),
    ...(args.selector === undefined ? {} : { selector: args.selector }),
    ...(args.text === undefined ? {} : { text: args.text }),
    ...(args.value === undefined ? {} : { value: args.value }),
    ...(args.key === undefined ? {} : { key: args.key }),
    ...(args.x === undefined ? {} : { x: args.x }),
    ...(args.y === undefined ? {} : { y: args.y }),
    ...(args.width === undefined ? {} : { width: args.width }),
    ...(args.height === undefined ? {} : { height: args.height }),
    ...(args.max_text_length === undefined ? {} : { maxTextLength: args.max_text_length }),
    ...(args.max_elements === undefined ? {} : { maxElements: args.max_elements }),
    ...(args.max_entries === undefined ? {} : { maxEntries: args.max_entries }),
    ...(args.save_path === undefined ? {} : { savePath: args.save_path }),
    ...(args.expression === undefined ? {} : { expression: args.expression }),
    ...(args.method === undefined ? {} : { method: args.method }),
    ...(args.params === undefined ? {} : { params: args.params }),
    ...(args.open === undefined ? {} : { open: args.open }),
  }
}

function boundedText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const notice = '\n\n[Browser result truncated by Worldline output policy.]'
  return `${text.slice(0, Math.max(0, maxChars - notice.length))}${notice}`.slice(0, maxChars)
}

function boundBlocks(blocks: readonly ContentBlock[], maxChars: number): ContentBlock[] {
  let remaining = maxChars
  return blocks.flatMap((block): ContentBlock[] => {
    if (block.type !== 'text' || remaining <= 0) return remaining > 0 ? [block] : []
    const text = boundedText(block.text, remaining)
    remaining -= text.length
    return [{ ...block, text }]
  })
}

/** Register the browser tool only when the desktop browser host is present. */
export function apply(ctx: Context, config: Config): void {
  const timeoutMs = config.timeoutMs ?? DEFAULT_BROWSER_TOOL_TIMEOUT_MS
  const maxOutputChars = config.maxOutputChars ?? DEFAULT_BROWSER_MAX_OUTPUT_CHARS
  positiveInteger('timeoutMs', timeoutMs)
  positiveInteger('maxOutputChars', maxOutputChars)
  const controller = ctx.get('browserController')
  if (controller === undefined) return

  restrictCompetingBrowserTools(ctx)

  ctx.systemPrompt.section({
    name: 'tool:browser-control',
    order: FIRST_PARTY_SECTION_ORDER.TOOL_BROWSER,
    text: 'Use browser_control exclusively for interactive browser work. It is the only browser runtime connected to the Worldline Browser pane the user can see; do not use alternate browser_* tools from other bundles. Open or focus tabs, inspect a snapshot before acting, click/fill/type/select, wait for navigation, inspect console/network diagnostics, and save screenshots inside the Session workspace. Prefer snapshot and targeted actions over evaluate or raw cdp; use evaluate/cdp only when the higher-level actions cannot complete the task.',
  })

  ctx.tools.register(defineTool({
    name: 'browser_control',
    description: 'Control Worldline\'s built-in, conversation-owned browser through high-level actions or Chrome DevTools Protocol.',
    parameters: {
      action: { type: 'string', required: true, enum: [...BROWSER_ACTIONS], description: 'Browser operation to perform.' },
      tab_id: { type: 'string', description: 'Target tab id. Omit to use the active tab where supported.' },
      url: { type: 'string', description: 'HTTP(S) URL for open or navigate. A missing scheme is treated as HTTPS.' },
      timeout_ms: { type: 'number', description: 'Action timeout in milliseconds, capped at 60000.' },
      selector: { type: 'string', description: 'CSS selector for element actions.' },
      text: { type: 'string', description: 'Visible text target, or text to type when value is omitted.' },
      value: { type: 'string', description: 'Value for fill, type, or select.' },
      key: { type: 'string', description: 'Key or shortcut for press, for example Enter or Ctrl+L.' },
      x: { type: 'number', description: 'Viewport x coordinate for click or screenshot clipping.' },
      y: { type: 'number', description: 'Viewport y coordinate for click or screenshot clipping.' },
      width: { type: 'number', description: 'Screenshot clip width.' },
      height: { type: 'number', description: 'Screenshot clip height.' },
      max_text_length: { type: 'number', description: 'Maximum page text characters returned by snapshot or text.' },
      max_elements: { type: 'number', description: 'Maximum interactive elements returned by snapshot.' },
      max_entries: { type: 'number', description: 'Maximum console or network entries returned.' },
      save_path: { type: 'string', description: 'Screenshot path relative to the Session workspace.' },
      expression: { type: 'string', description: 'JavaScript expression or async body for evaluate.' },
      method: { type: 'string', description: 'Chrome DevTools Protocol method for cdp.' },
      params: { type: 'object', additionalProperties: true, description: 'JSON parameters for cdp.' },
      open: { type: 'boolean', description: 'Explicit DevTools open state; omit to toggle.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: boundedText(JSON.stringify(value, null, 2), maxOutputChars) }],
    },
    timeoutMs,
    async execute(args: BrowserToolArgs, exec) {
      if (exec.agent === undefined) throw new Error('browser_control requires a calling Agent')
      const result = await controller.execute(exec.agent.id, commandFromArgs(args), {
        ...(exec.agent.session.header.cwd === undefined ? {} : { workspaceRoot: exec.agent.session.header.cwd }),
        signal: exec.signal,
      })
      return JSON.parse(JSON.stringify(result)) as JsonValue
    },
    finalizeContent: (_exec, result) => boundBlocks(result.content, maxOutputChars),
    presentCall: (args: BrowserToolArgs) => ({
      card: 'generic',
      title: `Browser ${args.action}${args.tab_id === undefined ? '' : ` · ${args.tab_id}`}`,
    }),
  }))
}

import { COMPANION_BROWSER_CAPABILITY_TOOL } from '../../shared/companion-browser';
import type { CompanionLoopCall, CompanionLoopTurn } from '../../shared/companion-loop';
import type { ToolVisualInput } from '../../shared/companion-file-tool';
import type { CompanionStructuredAgentCapabilities } from './structured-agent';

export type CompanionBrowserExtension = (scope: { companionId: string; conversationId: string }, base: CompanionStructuredAgentCapabilities) => CompanionStructuredAgentCapabilities;
export function withCompanionBrowser(base: CompanionStructuredAgentCapabilities,
  execute: (call: CompanionLoopCall, signal?: AbortSignal) => Promise<unknown>,
  images: (turns: readonly CompanionLoopTurn[]) => Promise<ToolVisualInput[]>): CompanionStructuredAgentCapabilities {
  return { ...base, replaySafe: false, tools: [...base.tools, COMPANION_BROWSER_CAPABILITY_TOOL], toolImages: images,
    execute: (call, signal) => call.name === 'browser' ? execute(call, signal) : base.execute(call, signal) };
}

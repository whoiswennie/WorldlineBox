import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ProjectSummary } from '@deepseek-ai/dsh-worldline-project/types'
import type { RunId } from '@deepseek-ai/dsh-worldline-standard/types'
import { BIND_PATH } from '../contract.ts'

/** The only author composition used by Studio-launched Worldline conversations. */
export const WORLDLINE_AUTHOR_PRESET = 'worldline-author'

/** Minimal boundary required to publish one project-bound author conversation. */
export interface AuthorConversationLaunchPort {
  registerWorkspace(input: { readonly path: string }): Promise<WorkspaceView>
  createSession(options: {
    readonly workspaceId: WorkspaceId
    readonly agentPreset: string
  }): Promise<SessionId>
  deleteSession(sessionId: SessionId): Promise<void>
  openSession(sessionId: SessionId): void
  showConversation(): void
  bind(request: {
    readonly sessionId: SessionId
    readonly projectId: ProjectSummary['manifest']['id']
    readonly runId?: RunId
  }): Promise<Response>
}

/**
 * Atomically create the dedicated author composition, bind it before the first turn, then open it.
 * Any failed bind removes the unpublished blank Session instead of exposing a generic conversation.
 * @param port - Session, layout, and binding operations supplied by the composed client.
 * @param project - Worldline project whose directory and identity own the conversation.
 * @param runId - Optional logical run to expose alongside the project authoring context.
 */
export async function launchWorldlineAuthorConversation(
  port: AuthorConversationLaunchPort,
  project: ProjectSummary,
  runId?: RunId,
): Promise<void> {
  const workspace = await port.registerWorkspace({ path: project.path })
  const sessionId = await port.createSession({
    workspaceId: workspace.workspaceId,
    agentPreset: WORLDLINE_AUTHOR_PRESET,
  })
  try {
    const response = await port.bind({
      sessionId,
      projectId: project.manifest.id,
      ...(runId === undefined ? {} : { runId }),
    })
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(result.error ?? `conversation binding failed: HTTP ${String(response.status)}`)
    }
  } catch (error) {
    await port.deleteSession(sessionId).catch(() => undefined)
    throw error
  }
  port.openSession(sessionId)
  port.showConversation()
}

/**
 * Send a Worldline conversation binding through the same-origin Host endpoint.
 * @param request - Session and Worldline identity to bind before the first turn.
 * @returns The unconsumed Host response so launch policy can reject non-success statuses.
 */
export function bindWorldlineConversation(
  request: Parameters<AuthorConversationLaunchPort['bind']>[0],
): Promise<Response> {
  return fetch(BIND_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(request),
  })
}

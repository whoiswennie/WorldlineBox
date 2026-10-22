import type { CompanionLoopTurn } from '../../shared/companion-loop';

/** Keep a past state call's receipt, while current host state owns all numbers. */
export function companionStateToolTurns(turns: readonly CompanionLoopTurn[]): readonly CompanionLoopTurn[] {
  return turns.map(turn => ({ ...turn, ...(turn.results ? { results: turn.results.map(result => {
    if (!turn.calls.some(call => call.id === result.callId && call.name === 'state')) return result;
    try {
      const data = JSON.parse(result.content) as { ok?: boolean; error?: string; runtimeState?: { companionId?: string; revision?: number; updatedAt?: string } };
      if (!data.runtimeState) return result;
      return { ...result, content: JSON.stringify({ ok: data.ok === true, ...(data.error ? { error: data.error } : {}),
        stateObservation: { status: 'historical', asOf: data.runtimeState.updatedAt, revision: data.runtimeState.revision },
        notice: '这是当时状态工具的执行凭证；当前情绪、属性、关注和语气仅以本轮宿主 runtimeState 为准。' }) };
    } catch { return { ...result, content: JSON.stringify({ ok: false, error: '旧状态凭证无法核验，请重新读取当前状态。' }) }; }
  }) } : {}) }));
}

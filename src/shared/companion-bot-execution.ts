import type { BotExecutionStep } from './companion-bot';

/** Aggregate transport fragments, preserving native attempt/session boundaries.
 * Legacy reasoning events have delta text and no stream identity. */
function fold(steps: BotExecutionStep[], incoming: BotExecutionStep): BotExecutionStep[] {
  const step = { ...incoming };
  if (step.type === 'child_text_stream') step.type = 'child_text';
  let index = -1;
  if (step.type === 'reasoning' || step.type === 'child_text') {
    index = step.streamId ? steps.findLastIndex(item => item.type === step.type && item.streamId === step.streamId && item.nativeSessionId === step.nativeSessionId)
      : steps.length - 1;
    if (index >= 0) {
      const previous = steps[index]!;
      if (previous.type !== step.type || previous.nativeSessionId !== step.nativeSessionId || previous.nativeTurn !== step.nativeTurn || previous.nativeStep !== step.nativeStep) index = -1;
      else step.text = step.type === 'child_text' || step.textMode === 'snapshot' ? step.text : (previous.text ?? '') + (step.text ?? '');
    }
  } else if (step.type === 'tool_result') {
    index = steps.findLastIndex(item => item.type === 'tool_call' && item.nativeSessionId === step.nativeSessionId
      && (step.callId ? item.callId === step.callId : !item.output));
    if (index >= 0) {
      const previous = steps[index]!;
      steps[index] = { ...previous, sequence: step.sequence, output: step.text, summary: step.summary, status: step.status ?? 'completed', updatedAt: step.updatedAt ?? step.at };
      return steps;
    }
  }
  if (index >= 0) steps[index] = { ...steps[index]!, ...step, id: steps[index]!.id, at: steps[index]!.at };
  else steps.push(step);
  return steps;
}

export function appendBotExecutionStep(previous: readonly BotExecutionStep[], update: BotExecutionStep): BotExecutionStep[] {
  // The bridge sequence is monotone for the entire observed task, including
  // children. A reconnect must not append already observed deltas a second time.
  if (update.sequence !== undefined && previous.some(item => item.streamGeneration === update.streamGeneration && item.sequence !== undefined && item.sequence >= update.sequence!)) return [...previous];
  return fold([...previous], update).slice(-1000);
}

export interface BotExecutionRound { id: string; step?: number; turn?: number; sessionId?: string; steps: BotExecutionStep[] }
export function botExecutionRounds(input: readonly BotExecutionStep[]): BotExecutionRound[] {
  const normalized = input.reduce<BotExecutionStep[]>((steps, item) => fold(steps, item), []);
  const rounds: BotExecutionRound[] = [], current = new Map<string, BotExecutionRound>();
  for (const item of normalized) {
    const session = item.nativeSessionId ?? '', legacyStep = item.nativeStep === undefined && item.type === 'status' ? /开始第\s*(\d+)\s*步处理/u.exec(item.summary ?? '') : null;
    if (item.stage === 'turn_start') current.delete(session);
    const number = item.nativeStep ?? (legacyStep ? Number(legacyStep[1]) : undefined);
    const boundary = item.stage === 'step_start' || !!legacyStep;
    let round = number !== undefined ? rounds.find(group => group.sessionId === session && group.turn === item.nativeTurn && group.step === number) : current.get(session);
    if (legacyStep) round = undefined;
    if (boundary || number !== undefined) {
      if (!round) { round = { id: item.id, sessionId: session, turn: item.nativeTurn, step: number, steps: [] }; rounds.push(round); }
      current.set(session, round);
    }
    // Loop markers describe the container; they are not extra user-facing phases.
    if (boundary || ['turn_start','step_end','turn_end'].includes(item.stage ?? '')
      || item.type === 'status' && /^(开始处理任务|本轮处理结束|第\s*\d+\s*步处理结束)$/u.test(item.summary ?? '')) continue;
    if (!round) { round = { id: item.id, sessionId: session, steps: [] }; rounds.push(round); current.set(session, round); }
    round.steps.push(item);
  }
  return rounds.filter(round => round.steps.length);
}

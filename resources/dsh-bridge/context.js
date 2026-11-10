/** Lightweight native event fold. It observes DSH maintenance; it never owns
 * compaction, token estimation, commands or model execution. */
export const activityKey = 'worldlineboxContextActivity';
export function foldContextActivity(state, event) {
  const data = event.data, at = typeof event.time === 'number' ? new Date(event.time).toISOString() : event.time;
  if (event.type === 'turn/start') return { ...state, turn: true };
  if (event.type === 'turn/end') return { ...state, turn: false };
  if (event.type === 'command/run') return { ...state, commands: { ...state.commands, [data.commandId]: data.name } };
  if (event.type === 'command/done') { const commands = { ...state.commands }; delete commands[data.commandId]; return { ...state, commands }; }
  if (event.type === 'compaction/start') return { ...state, compaction: { id: data.compactionId, state: 'running',
    origin: data.turn === null ? 'manual' : 'automatic', startedAt: at, sequence: event.seq } };
  if (event.type === 'compaction/end' && state.compaction?.id === data.compactionId) return { ...state, compaction: { ...state.compaction,
    state: data.error ? 'failed' : 'succeeded', finishedAt: at, sequence: event.seq, ...(data.error ? { error: String(data.error).slice(0, 2000) } : {}) } };
  if (event.type === 'session/end-seed') return { turn: false, commands: {}, compaction: state.compaction?.state === 'running'
    ? { ...state.compaction, state: 'interrupted', finishedAt: at, sequence: event.seq } : state.compaction };
  return state;
}
export async function registerContextActivity(ctx) {
  const registry = ctx.get?.('sessionProjections'); if (!registry?.register) return;
  const { z } = await import('zod');
  const schema = z.object({ turn: z.boolean(), commands: z.record(z.string(), z.string()), compaction: z.object({
    id: z.string(), state: z.enum(['running', 'succeeded', 'failed', 'interrupted']), origin: z.enum(['manual', 'automatic']),
    startedAt: z.string(), finishedAt: z.string().optional(), sequence: z.number().int(), error: z.string().optional(),
  }).nullable() });
  return registry.register({ key: activityKey, stateVersion: 1, stateSchema: schema,
    init: () => ({ turn: false, commands: {}, compaction: null }), apply: foldContextActivity,
    wire: { viewSchema: schema, view: state => state, summary: false } });
}
export function nativeActivity(values, agent) {
  const state = values?.[activityKey]; if (!state) return;
  const commands = Object.values(state.commands), compacting = state.compaction?.state === 'running';
  const phase = !agent && (compacting || commands.length || state.turn) ? 'recovering'
    : compacting ? 'compacting' : commands.length ? 'maintenance' : agent?.status === 'running' || state.turn ? 'running' : 'idle';
  return { phase, ...(commands.length ? { command: commands.at(-1) } : {}), ...(state.compaction ? { compaction: state.compaction } : {}) };
}
export function nativeSessionBusy(ctx, agent) {
  const registry = ctx.get('sessionProjections');
  const state = registry?.snapshot(agent.session, [activityKey]).values?.[activityKey];
  return agent.status !== 'idle' || !!state && (state.compaction?.state === 'running' || Object.keys(state.commands).length > 0);
}

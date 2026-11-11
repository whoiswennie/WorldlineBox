import path from 'node:path';
import { createHash } from 'node:crypto';

/** The same cold-safe, incremental summary API that feeds the native DSH UI.
 * Only trusted, already-bound lane identities are exposed, never other rooms. */
export async function nativeTopicStates(ctx, input, signal) {
  if (!Array.isArray(input.bindings) || input.bindings.length > 200) throw Error('Invalid native topic bindings.');
  for (const item of input.bindings) if (!item || typeof item.laneId !== 'string' || !item.laneId || item.laneId.length > 300
    || item.sessionId !== 'wlb-bot-' + createHash('sha256').update(item.laneId).digest('hex')
    || typeof item.cwd !== 'string' || !path.isAbsolute(item.cwd)) throw Error('Invalid native topic identity.');
  const catalog = await ctx.sessionController.list({}, signal);
  if (!Array.isArray(catalog?.items)) throw Error('Native session catalogue is unavailable.');
  const sessions = new Map(catalog.items.map(row => [String(row.sessionId), row]));
  return input.bindings.map(item => {
    const row = sessions.get(item.sessionId);
    const exists = !!row && !row.blank && typeof row.cwd === 'string' && path.resolve(row.cwd) === path.resolve(item.cwd);
    const title = row?.projections?.values?.title;
    return { laneId: item.laneId, sessionId: item.sessionId, exists,
      ...(exists && typeof title === 'string' && title.trim() ? { title } : {}),
      ...(exists && Number.isFinite(row.updatedAt) ? { updatedAt: new Date(row.updatedAt).toISOString() } : {}) };
  });
}

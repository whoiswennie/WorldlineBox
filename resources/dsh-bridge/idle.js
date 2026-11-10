import { nativeSessionBusy } from './context.js';
/** Read-only native quiescence probe. An unknown registry or projection never
 * authorizes process reclamation; caller leases must fence new admissions. */
export async function inspectNativeIdle(ctx, state) {
  const unknown = new Set(), result = { idle: false, known: false, activeTurns: 0, backgroundJobs: 0,
    pendingQuestions: state.pendingWorkerQuestions?.size ?? 0, pendingInbox: 0, settling: 0, activeSubagents: 0 };
  const jobs = ctx.get('jobs'), subagents = ctx.get('subagents'), projections = ctx.get('sessionProjections');
  if (!jobs || typeof jobs.list !== 'function') unknown.add('jobs-registry');
  if (!subagents || typeof subagents.listDescendants !== 'function') unknown.add('subagent-registry');
  if (!projections || typeof projections.snapshot !== 'function') unknown.add('session-projections');
  if (!ctx.agents || typeof ctx.agents.list !== 'function') unknown.add('agent-registry');
  let agents = [];
  try { agents = ctx.agents.list(); if (!Array.isArray(agents)) throw Error('Unknown registry'); }
  catch { unknown.add('agent-registry'); agents = []; }
  const owners = new Set(agents.map(agent => String(agent.session.id))), childIds = new Set();
  for (const agent of agents) {
    if (!['idle', 'running'].includes(agent.status)) unknown.add('agent-status');
    if (agent.status === 'running') result.activeTurns++;
    else try { if (nativeSessionBusy(ctx, agent)) result.activeTurns++; } catch { unknown.add('agent-maintenance'); }
    if (!Array.isArray(agent.inbox?.nextTurn) || !Array.isArray(agent.inbox?.nextStep)) unknown.add('agent-inbox');
    else result.pendingInbox += agent.inbox.nextTurn.length + agent.inbox.nextStep.length;
    try {
      if (ctx.get('userQuestions')) {
        const questions = projections.snapshot(agent.session, new Set(['userQuestions'])).values.userQuestions;
        if (!Array.isArray(questions?.active)) throw Error('Missing question projection');
        result.pendingQuestions += questions.active.length;
      }
    } catch { unknown.add('question-projection'); }
    try {
      const descendants = await subagents.listDescendants(agent.session.id, AbortSignal.timeout(3000));
      if (!Array.isArray(descendants)) throw Error('Missing child catalog');
      for (const child of descendants) {
        if (child.kind !== 'child' || !['running', 'inactive'].includes(child.activity)) { unknown.add('child-catalog'); continue; }
        owners.add(String(child.id)); if (child.activity === 'running') childIds.add(String(child.id));
      }
    } catch { unknown.add('child-catalog'); }
  }
  result.activeSubagents = childIds.size;
  try {
    const entries = [...(jobs?.list() ?? []), ...[...owners].flatMap(owner => jobs.list(owner))], live = new Set();
    for (const job of entries) {
      if (!['running', 'stopping', 'completed', 'failed', 'killed'].includes(job.status)) unknown.add('job-status');
      else if (['running', 'stopping'].includes(job.status)) live.add(job.id);
    }
    result.backgroundJobs = live.size;
  } catch { unknown.add('jobs-registry'); }
  const records = [...state.sessions.values()];
  result.settling = records.filter(record => record.waiting || record.admissions || record.botMutationActive
    || record.effectCalls?.size || record.effectCommits?.size || record.effectCommitFailures?.size).length
    + state.botOpenings.size + state.botCancelChecks.size + (state.pluginMutations ?? 0);
  // Registries can change while a child catalog read awaits. Recheck the live
  // snapshot before certifying the cut; no caller should stop on a stale cut.
  const current = ctx.agents?.list?.();
  if (!Array.isArray(current) || current.length !== agents.length || current.some(agent => !agents.includes(agent))) unknown.add('agent-registry-changed');
  else if (current.some(agent => agent.status !== 'idle' || agent.inbox?.nextTurn?.length || agent.inbox?.nextStep?.length)) result.activeTurns = Math.max(1, result.activeTurns);
  result.known = unknown.size === 0;
  result.idle = result.known && !state.closing && !result.activeTurns && !result.backgroundJobs && !result.pendingQuestions
    && !result.pendingInbox && !result.settling && !result.activeSubagents;
  return { ...result, ...(unknown.size ? { unknownReasons: [...unknown] } : {}) };
}

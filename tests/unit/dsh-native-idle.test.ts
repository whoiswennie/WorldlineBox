import { expect, it } from 'vitest';
const idleModule = '../../resources/dsh-bridge/idle.js';
const { inspectNativeIdle } = await import(idleModule);

function fixture() {
  const agent = { status: 'idle', session: { id: 'root' }, inbox: { nextTurn: [] as unknown[], nextStep: [] as unknown[] } };
  const jobs: Array<{ id: string; status: string }> = [], children: Array<{ kind: string; id: string; activity: string }> = [], questions: unknown[] = [];
  const services: Record<string, unknown> = { jobs: { list: () => jobs }, subagents: { listDescendants: async () => children },
    userQuestions: {}, sessionProjections: { snapshot: () => ({ values: { userQuestions: { active: questions } } }) } };
  const ctx = { agents: { list: () => [agent] }, get: (name: string) => services[name] };
  const state = { sessions: new Map(), botOpenings: new Map(), botCancelChecks: new Map(), pendingWorkerQuestions: new Set(), pluginMutations: 0, closing: false };
  return { agent, jobs, children, questions, services, ctx, state };
}
it('certifies only a fully idle native snapshot and never consumes native work', async () => {
  const f = fixture(); expect(await inspectNativeIdle(f.ctx, f.state)).toMatchObject({ idle: true, known: true, activeTurns: 0 });
  f.jobs.push({ id: 'job', status: 'running' }); expect(await inspectNativeIdle(f.ctx, f.state)).toMatchObject({ idle: false, backgroundJobs: 1 });
  f.jobs.length = 0; f.agent.inbox.nextTurn.push({}); expect(await inspectNativeIdle(f.ctx, f.state)).toMatchObject({ idle: false, pendingInbox: 1 });
  expect(f.agent.inbox.nextTurn).toHaveLength(1); f.agent.inbox.nextTurn.length = 0;
  f.questions.push({}); expect(await inspectNativeIdle(f.ctx, f.state)).toMatchObject({ idle: false, pendingQuestions: 1 });
  f.questions.length = 0; f.state.pendingWorkerQuestions.add('question'); expect(await inspectNativeIdle(f.ctx, f.state)).toMatchObject({ idle: false, pendingQuestions: 1 });
  f.state.pendingWorkerQuestions.clear(); f.children.push({ kind: 'child', id: 'child', activity: 'running' });
  expect(await inspectNativeIdle(f.ctx, f.state)).toMatchObject({ idle: false, activeSubagents: 1 });
  f.children.length = 0; f.state.sessions.set('root', { waiting: true }); expect(await inspectNativeIdle(f.ctx, f.state)).toMatchObject({ idle: false, settling: 1 });
});
it('fails closed for unknown services, child diagnostics, or changing live ownership', async () => {
  const f = fixture(); delete f.services.jobs;
  expect(await inspectNativeIdle(f.ctx, f.state)).toMatchObject({ idle: false, known: false, unknownReasons: expect.arrayContaining(['jobs-registry']) });
  const next = fixture(); next.children.push({ kind: 'diagnostic', id: 'missing', activity: 'inactive' });
  expect(await inspectNativeIdle(next.ctx, next.state)).toMatchObject({ idle: false, known: false });
  const changed = fixture(); let reads = 0;
  changed.ctx.agents.list = () => ++reads === 1 ? [changed.agent] : [];
  expect(await inspectNativeIdle(changed.ctx, changed.state)).toMatchObject({ idle: false, known: false, unknownReasons: ['agent-registry-changed'] });
});

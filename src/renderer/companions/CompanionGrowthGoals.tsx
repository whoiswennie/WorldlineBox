import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import { companionGrowthGoalDraftSchema, companionGrowthGoalSchema, type CompanionGrowthGoal } from '../../shared/companion-cognition';
import type { CompanionWorkspaceRequest } from '../../shared/companion-workspace';
import { createCoalescedRefresh } from './coalesced-refresh';

const statuses: Record<CompanionGrowthGoal['status'], string> = {
  proposed: '已提出', practicing: '练习中', reconsidering: '重新考虑', paused: '已暂停', retired: '已结束',
};
type Draft = { statement: string; context: string; practice: string; examples: string; counterexamples: string };
type Editor = { goal?: CompanionGrowthGoal; draft: Draft; feedback: string };
type Transition = { goal: CompanionGrowthGoal; status: 'proposed' | 'paused' | 'retired'; feedback: string };
type Mutation = Extract<CompanionWorkspaceRequest, { type: 'growth.goals.propose' | 'growth.goal.status' }>;
type WithoutScope<T> = T extends unknown ? Omit<T, 'conversationId' | 'operationId'> : never;
type MutationInput = WithoutScope<Mutation>;
const draftFor = (goal?: CompanionGrowthGoal): Draft => ({ statement: goal?.statement ?? '', context: goal?.context ?? '',
  practice: goal?.practice.join('\n') ?? '', examples: goal?.examples.join('\n') ?? '', counterexamples: goal?.counterexamples.join('\n') ?? '' });

/** Source-backed feedback is distinct from agenda plans and published identity.
 * This component is mounted only while its actual dossier page is open. */
export function CompanionGrowthGoals({ companionId, api }: { companionId: string; api?: WorldlineBoxCompanionsApi }) {
  const [snapshot, setSnapshot] = useState<{ owner: string; conversationId?: string; goals: CompanionGrowthGoal[] }>();
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [editor, setEditor] = useState<Editor>(), [transition, setTransition] = useState<Transition>();
  const lifecycle = useRef({ alive: false, lifetime: 0, epoch: 0, serial: 0, owner: companionId, busy: false });
  const operation = useRef<{ input: string; id: string } | undefined>(undefined);
  const load = useCallback(async () => {
    const state = lifecycle.current, epoch = state.epoch, serial = ++state.serial;
    const current = () => state.alive && state.epoch === epoch && state.serial === serial && state.owner === companionId;
    setSnapshot(undefined); setLoading(true); setError('');
    try {
      if (!api?.workspace) throw new Error('当前无法读取培养方向。');
      const observed = await api.request({ type: 'state', readiness: 'navigation' });
      if (!current()) return;
      if (!observed.ok || !observed.state?.companions.some(owner => owner.id === companionId)) throw new Error(observed.error || '当前伙伴尚不可核实。');
      const rooms = observed.state.conversations.filter(room => room.kind === 'private' && !room.peerOnly && room.memberIds.length === 1 && room.memberIds[0] === companionId);
      if (rooms.length > 1) throw new Error('当前私聊范围不唯一，未采用不确定的来源。');
      const room = rooms[0];
      if (!room) { setSnapshot({ owner: companionId, goals: [] }); return; }
      const result = await api.workspace({ type: 'growth.goals.read', companionId, conversationId: room.id });
      if (!current()) return;
      if (!result.ok || !result.growthGoals || result.growthGoals.length > 40) throw new Error(result.error || '培养方向来源暂不可核实。');
      const goals = result.growthGoals.map(goal => companionGrowthGoalSchema.parse(goal));
      if (goals.some(goal => goal.companionId !== companionId || goal.conversationId !== room.id)
        || new Set(goals.map(goal => goal.id)).size !== goals.length) throw new Error('培养方向的伙伴或会话归属不一致。');
      setSnapshot({ owner: companionId, conversationId: room.id, goals });
      return true;
    } catch (cause) { if (current()) { setSnapshot(undefined); setEditor(undefined); setTransition(undefined); operation.current = undefined; setError(cause instanceof Error ? cause.message : '培养方向读取失败。'); } }
    finally { if (current()) setLoading(false); }
  }, [api, companionId]);
  useLayoutEffect(() => {
    const state = lifecycle.current; state.alive = true; state.owner = companionId; ++state.lifetime; ++state.epoch; ++state.serial; state.busy = false;
    operation.current = undefined;
    const updates = createCoalescedRefresh(load, undefined, 400); void updates.trigger();
    const unsubscribe = api?.onChanged(change => {
      if (change?.kind === 'progress') return;
      ++state.epoch; ++state.serial; state.busy = false; operation.current = undefined;
      setSnapshot(undefined); setEditor(undefined); setTransition(undefined); setBusy(false); setLoading(true); setError(''); void updates.trigger();
    });
    return () => { state.alive = false; ++state.lifetime; ++state.epoch; ++state.serial; state.busy = false; setSnapshot(undefined); setEditor(undefined); setTransition(undefined); setBusy(false); updates.dispose(); unsubscribe?.(); };
  }, [api, companionId, load]);
  const data = snapshot?.owner === companionId ? snapshot : undefined;
  const mutate = async (command: MutationInput) => {
    const state = lifecycle.current, epoch = state.epoch;
    if (!api?.workspace || state.busy || !state.alive || state.owner !== companionId || !data) return;
    const current = () => state.alive && state.epoch === epoch && state.owner === companionId;
    state.busy = true; setBusy(true); setError('');
    try {
      const conversationId = data.conversationId;
      if (!conversationId) throw new Error('当前培养方向的来源会话尚不可核实。');
      const scoped = { ...command, conversationId }, serialized = JSON.stringify(scoped);
      const operationId = operation.current?.input === serialized ? operation.current.id : crypto.randomUUID();
      operation.current = { input: serialized, id: operationId };
      const result = await api.workspace({ ...scoped, operationId });
      if (!current()) return;
      if (!result.ok || !result.growthGoal) throw new Error(result.error || '培养方向尚未确认保存，请重新核对。');
      const goal = companionGrowthGoalSchema.parse(result.growthGoal);
      if (goal.companionId !== companionId || goal.conversationId !== conversationId
        || command.type === 'growth.goal.status' && (goal.id !== command.goalId || goal.status !== command.status)
        || command.type === 'growth.goals.propose' && command.goalId && goal.id !== command.goalId
        || command.expectedRevision !== undefined && goal.revision <= command.expectedRevision
        || command.type === 'growth.goals.propose' && editor?.goal?.status === 'paused' && goal.status !== 'paused')
        throw new Error('返回的培养方向归属或状态不一致，请重新核对。');
      operation.current = undefined; setEditor(undefined); setTransition(undefined); await load();
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : '培养方向尚未确认保存。'); }
    finally { if (current()) { state.busy = false; setBusy(false); } }
  };
  const submitDefinition = () => {
    if (!editor || !data) return;
    const lines = (value: string) => value.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    const checked = companionGrowthGoalDraftSchema.safeParse({ statement: editor.draft.statement, context: editor.draft.context,
      practice: lines(editor.draft.practice), examples: lines(editor.draft.examples), counterexamples: lines(editor.draft.counterexamples) });
    if (!checked.success) { setError('请填写培养方向与适用情境；每类最多五项，每项不超过300字。'); return; }
    void mutate({ type: 'growth.goals.propose', companionId,
      ...(editor.goal ? { goalId: editor.goal.id, expectedRevision: editor.goal.revision } : {}), feedback: editor.feedback.trim(), goal: checked.data });
  };
  const edit = (goal?: CompanionGrowthGoal) => { setError(''); setTransition(undefined); setEditor({ goal, draft: draftFor(goal), feedback: '' }); operation.current = undefined; };
  const startDefinition = async () => {
    if (data?.conversationId) { edit(); return; }
    const state = lifecycle.current, lifetime = state.lifetime;
    const current = () => state.alive && state.lifetime === lifetime && state.owner === companionId;
    if (!api || !data || state.busy || !current()) return;
    state.busy = true; setBusy(true); setError('');
    try {
      // This explicit user action may create the feedback room. Its ordinary
      // full notification is never suppressed: read the scope fresh before
      // showing a new, empty editor. No draft or write crosses that boundary.
      const opened = await api.request({ type: 'conversation.open', companionId });
      if (!current()) return;
      if (!opened.ok) throw new Error(opened.error || '未能打开本次反馈的私聊。');
      if (await load() && current()) edit();
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : '当前无法提出培养方向。'); }
    finally { if (current()) { state.busy = false; setBusy(false); } }
  };
  const act = (goal: CompanionGrowthGoal, status: Transition['status']) => { setError(''); setEditor(undefined); setTransition({ goal, status, feedback: '' }); operation.current = undefined; };
  const transitionLabel = transition?.status === 'paused' ? '暂停' : transition?.status === 'retired' ? '结束' : '继续提出';
  return <section className="cognition-source-goals" aria-label="来自交流的培养方向" aria-busy={loading}>
    <h4>来自交流的培养方向</h4><p>具体反馈是准备尝试的方向，不代表已经形成的性格。当前任务保留开始时的快照，新任务采用届时仍有效的方向。</p>
    <div className="cognition-growth-toolbar"><button type="button" className="companion-secondary-button" disabled={!data || busy} onClick={() => void startDefinition()}>{data && !data.conversationId ? '打开私聊提出方向' : '提出培养方向'}</button><button type="button" className="companion-secondary-button" disabled={loading || busy} onClick={() => void load()}>重新核对方向</button></div>
    {error && <p role="alert">{error}</p>}
    {!data ? <p className="cognition-empty">{loading ? '正在核对培养方向与真实来源…' : '培养方向尚未核实，暂不展示旧内容。'}</p> : <>
      {!data.goals.length && <p className="cognition-empty">当前私聊尚无有来源的培养方向。</p>}
      <ol className="cognition-goals">{data.goals.map(goal => <li key={goal.id} data-growth-goal={goal.id} data-status={goal.status}>
        <header className="cognition-goal-card-heading"><strong>{goal.statement}</strong><span>{statuses[goal.status]}</span></header>
        <p className="cognition-goal-context">{goal.context}</p><details><summary>定义、练习与来源</summary>
          {!!goal.practice.length && <><p>练习方式</p><ul>{goal.practice.map((text, index) => <li key={index}>{text}</li>)}</ul></>}
          {!!goal.examples.length && <><p>表达示例</p><ul>{goal.examples.map((text, index) => <li key={index}>{text}</li>)}</ul></>}
          {!!goal.counterexamples.length && <><p>需要避免</p><ul>{goal.counterexamples.map((text, index) => <li key={index}>{text}</li>)}</ul></>}
          <p>定义修订 {goal.revision}</p>{goal.sources.map(source => <p key={source.messageId}><code>{source.messageId}</code> · 来源修订 {source.revision} · <code>{source.contentHash}</code></p>)}
        </details>
        {goal.status === 'retired' ? <p className="cognition-caption">已经结束，保留原定义与来源。</p> : <div className="cognition-goal-actions">
          <button type="button" disabled={busy} onClick={() => edit(goal)}>调整方向</button>
          <button type="button" disabled={busy} onClick={() => act(goal, goal.status === 'paused' ? 'proposed' : 'paused')}>{goal.status === 'paused' ? '继续提出' : '暂停练习'}</button>
          <button type="button" disabled={busy} onClick={() => act(goal, 'retired')}>结束方向</button>
        </div>}
      </li>)}</ol>{data.goals.length === 40 && <p className="cognition-caption">本次显示当前私聊最近的40项培养方向。</p>}
    </>}
    {editor && <form className="cognition-goal-form" aria-label="培养方向反馈" onSubmit={event => { event.preventDefault(); if (!busy && editor.feedback.trim()) submitDefinition(); }}>
      <h4>{editor.goal ? '调整培养方向' : '提出培养方向'}</h4>
      <p>{editor.goal?.status === 'paused' ? '调整定义不会自动恢复练习。只有明确选择“继续提出”后，才重新参与未来培养。' : '保存的是这次真实反馈与未来练习方向，不会直接编辑人格正文。'}</p>
      {([['statement', '培养方向', 800], ['context', '适用情境', 600], ['practice', '练习方式（每行一项）', 1504], ['examples', '表达示例（每行一项）', 1504], ['counterexamples', '需要避免（每行一项）', 1504]] as const).map(([field, label, max]) => <label key={field}>{label}<textarea required={field === 'statement' || field === 'context'} disabled={busy} maxLength={max} value={editor.draft[field]} onChange={event => setEditor({ ...editor, draft: { ...editor.draft, [field]: event.target.value } })} /></label>)}
      <label>本次反馈<textarea required disabled={busy} maxLength={2000} value={editor.feedback} onChange={event => setEditor({ ...editor, feedback: event.target.value })} /></label>
      <div className="cognition-goal-form-actions"><button type="submit" disabled={!data || busy || !editor.feedback.trim()}>{busy ? '正在保存…' : editor.goal ? '保存方向调整' : '提交培养方向'}</button><button type="button" disabled={busy} onClick={() => { setEditor(undefined); operation.current = undefined; }}>取消本次调整</button></div>
    </form>}
    {transition && <form className="cognition-goal-status-form" aria-label="培养方向状态反馈" onSubmit={event => { event.preventDefault(); if (data && !busy && transition.feedback.trim()) void mutate({ type: 'growth.goal.status', companionId,
      goalId: transition.goal.id, expectedRevision: transition.goal.revision, status: transition.status, feedback: transition.feedback.trim() }); }}>
      <h4>{transitionLabel}这个方向</h4><p>{transition.status === 'retired' ? '结束后保留原定义和来源，不能改写或恢复这个方向。' : transition.status === 'paused' ? '暂停未来练习，不会请求人格整合，也不会改写当前任务的快照。' : '把这个方向重新提出供未来练习，不宣称已经形成性格。'}</p>
      <label>本次状态反馈<textarea required disabled={busy} maxLength={2000} value={transition.feedback} onChange={event => setTransition({ ...transition, feedback: event.target.value })} /></label>
      <div><button type="submit" disabled={!data || busy || !transition.feedback.trim()}>{busy ? '正在保存…' : `确认${transitionLabel}`}</button><button type="button" disabled={busy} onClick={() => { setTransition(undefined); operation.current = undefined; }}>暂不调整状态</button></div>
    </form>}
  </section>;
}

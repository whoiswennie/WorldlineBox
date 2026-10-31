import { useCallback, useEffect, useRef, useState } from 'react';
import type { Companion, WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionRuntimeState } from '../../shared/companion-state';
import { createCoalescedRefresh } from './coalesced-refresh';

const relationshipKinds = { agreement: '共同约定', shared_experience: '共同经历', commitment: '承诺', fulfilment: '履行', disagreement: '分歧', repair: '修复', boundary: '相处边界', expectation: '当前期待' };
export function CompanionExperienceView({ runtime }: { runtime: CompanionRuntimeState }) {
  const experience = runtime.experience, [now, setNow] = useState(Date.now);
  useEffect(() => {
    const expiry = Date.parse(experience?.validUntil ?? ''); let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { const current = Date.now(); setNow(current); if (Number.isFinite(expiry) && expiry > current) timer = setTimeout(refresh, Math.min(2_147_483_647, expiry - current + 1)); };
    refresh();
    return () => clearTimeout(timer);
  }, [experience?.validUntil]);
  const expired = !!experience?.validUntil && Date.parse(experience.validUntil) <= now;
  return <section className="cognition-current-experience" aria-label="本人当前体验">
    {runtime.routine?.activity && <p>当前活动：{runtime.routine.activity}</p>}
    {!experience ? <p className="cognition-empty">尚无有来源的本人体验表达。当前感受保留未知，不根据精力、交流次数或表情推断。</p> : expired ? <p className="cognition-empty">上次体验记录已过有效时间，当前感受等待重新核对。</p> : <>
      <dl className="cognition-fields"><div><dt>当前情境</dt><dd>{experience.situation}</dd></div><div><dt>本人表达</dt><dd>{experience.statement || '没有明确表达感受。'}</dd></div>{experience.focus && <div><dt>此刻关注</dt><dd>{experience.focus}</dd></div>}{experience.uncertainty && <div><dt>仍不确定的地方</dt><dd>{experience.uncertainty}</dd></div>}{experience.responsePreference && <div><dt>当前希望怎样回应</dt><dd>{experience.responsePreference}</dd></div>}<div><dt>重新评估的条件</dt><dd>{experience.reassessWhen.join('\n')}</dd></div></dl>
      <details className="cognition-source"><summary>这段体验的来源与版本</summary><p>这是伙伴对当时处境的表达。发生于 {experience.occurredAt}，记录于 {experience.recordedAt}，修订 {experience.revision}。</p>{experience.sourceVersions.map(source => <p key={source.messageId}><code>{source.messageId}</code> · 来源修订 {source.revision} · <code>{source.checksum}</code></p>)}</details>
    </>}
  </section>;
}
export function CompanionRelationshipExperienceView({ runtime, companions = [] }: { runtime: CompanionRuntimeState; companions?: Companion[] }) {
  return <section aria-label="具体关系经历"><h4>具体关系经历与约定</h4>{!runtime.relationshipRecords.length ? <p className="cognition-empty">当前范围没有可展示的关系事件。关系设定不证明已发生共同经历，也不换算成亲近分数。</p> : <ol className="cognition-goals">{runtime.relationshipRecords.map(record => <li key={record.id}><strong>{record.topic}</strong><span>{relationshipKinds[record.kind]} · {record.targetId === 'user' ? '与你' : companions.find(companion => companion.id === record.targetId)?.name ?? record.targetId}</span><p>{record.context}</p><p>{record.statement}</p>{record.currentExpectation && <p>当前期待：{record.currentExpectation}</p>}<p>重新评估条件：{record.reassessWhen.join('；')}</p><details><summary>关系事件的来源与版本</summary><p>{record.occurredAt} · 修订 {record.revision}</p>{record.sourceVersions.map(source => <p key={source.messageId}><code>{source.messageId}</code> · 来源修订 {source.revision} · <code>{source.checksum}</code></p>)}</details></li>)}</ol>}</section>;
}
type Props = { companionId: string; api?: WorldlineBoxCompanionsApi; relationships?: boolean };
export function CompanionCurrentCircumstances(props: Props) { return <CurrentCircumstancesBody key={props.companionId} {...props} />; }
function CurrentCircumstancesBody({ companionId, api, relationships = false }: Props) {
  const [runtime, setRuntime] = useState<CompanionRuntimeState>(), [companions, setCompanions] = useState<Companion[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const lifecycle = useRef({ alive: false, sequence: 0 });
  const load = useCallback(async () => {
    const state = lifecycle.current, epoch = ++state.sequence; setLoading(true); setError('');
    try {
      const snapshot = await api?.request({ type: 'state' });
      if (!state.alive || epoch !== state.sequence) return;
      const conversation = snapshot?.state?.conversations.find(room => room.kind === 'private' && room.memberIds.includes(companionId) && !room.id.startsWith('world_'));
      if (!snapshot?.ok || !conversation) throw new Error(snapshot?.error || '尚无可核实的私聊范围，当前处境与关系事件保留未知。');
      const result = await api?.request({ type: 'state.get', companionId, conversationId: conversation.id });
      if (!state.alive || epoch !== state.sequence) return;
      if (!result?.ok || result.runtimeState?.companionId !== companionId) throw new Error(result?.error || '当前处境尚未核实。');
      setRuntime(result.runtimeState); setCompanions(snapshot.state!.companions);
    } catch (cause) { if (state.alive && epoch === state.sequence) { setRuntime(undefined); setError(cause instanceof Error ? cause.message : '处境读取失败。'); } }
    finally { if (state.alive && epoch === state.sequence) setLoading(false); }
  }, [api, companionId]);
  useEffect(() => { const state = lifecycle.current; state.alive = true; const updates = createCoalescedRefresh(load, undefined, 250); void updates.trigger(); const unsubscribe = api?.onChanged(() => { setRuntime(undefined); void updates.trigger(); }); return () => { state.alive = false; ++state.sequence; updates.dispose(); unsubscribe?.(); }; }, [api, load]);
  return <div>{loading && <p role="status">正在核对当前处境与来源…</p>}{error && <p role="status">{error}</p>}{runtime && (relationships ? <CompanionRelationshipExperienceView runtime={runtime} companions={companions} /> : <CompanionExperienceView runtime={runtime} />)}</div>;
}

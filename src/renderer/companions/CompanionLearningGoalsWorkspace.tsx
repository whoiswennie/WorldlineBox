import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Companion, CompanionsRequest, CompanionsResponse, WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionLearningGrant } from '../../shared/companion-learning';
import type { CompanionLearningGoal, CompanionLearningGoalRound, CompanionLearningGoalWorkspaceCommand } from '../../shared/companion-learning-goals';
import { Avatar } from './CompanionVisuals';
import { Icon } from '../Icons';
import { createCoalescedRefresh } from './coalesced-refresh';
import { CompanionLearningSources } from './CompanionLearningSources';
import { CompanionLearningGoalEditor, learningMaterialLabel } from './CompanionLearningGoalEditor';
import { CompanionLearningRound, learningDate, learningPhaseLabels } from './CompanionLearningRound';
import './companion-learning-goals.css';

type Props = { owner: Companion; api?: WorldlineBoxCompanionsApi; request(input: CompanionsRequest): Promise<CompanionsResponse | undefined>; onClose(): void; onOpenNote?(id: string): void };
type Page<T> = { items: T[]; hasMore: boolean; nextCursor?: number };
const states = { active: '持续学习中', paused: '已暂停', stopped: '已结束安排' };
function short(value: string, max = 140) { return value.length <= max ? value : value.slice(0, max) + '…'; }
function intervalLabel(value: number) { return value < 60 ? `${value} 分钟` : value < 1440 ? `${value / 60} 小时` : `${value / 1440} 天`; }
function LearningGoalDescription({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return <><h3>{short(text, 160)}</h3>{text.length > 160 && <details className="learning-goal-full-text" onToggle={event => setOpen(event.currentTarget.open)}><summary>完整学习目标</summary>{open && <p>{text}</p>}</details>}</>;
}

/** Owner-keyed, bounded pages of durable goals and their actual learning receipts. */
export function CompanionLearningGoalsWorkspace(props: Props) { return <LearningGoalsBody key={props.owner.id} {...props} />; }
function LearningGoalsBody({ owner, api, request, onClose, onOpenNote }: Props) {
  const [goals, setGoals] = useState<Page<CompanionLearningGoal>>(), [grants, setGrants] = useState<CompanionLearningGrant[]>([]);
  const [rounds, setRounds] = useState<Page<CompanionLearningGoalRound>>(), [selectedId, setSelectedId] = useState<string>(), [roundId, setRoundId] = useState<string>();
  const [goalCursors, setGoalCursors] = useState<number[]>([]), [roundCursors, setRoundCursors] = useState<number[]>([]);
  const [editor, setEditor] = useState<'new' | 'edit'>(), [sourcesOpen, setSourcesOpen] = useState(false), [stopConfirm, setStopConfirm] = useState(false);
  const [editingGoal, setEditingGoal] = useState<CompanionLearningGoal>();
  const [error, setError] = useState(''), [actionError, setActionError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const alive = useRef(false), serial = useRef(0), lock = useRef(false), scope = useRef('');
  const roundSnapshot = useRef<{ key: string; page: Page<CompanionLearningGoalRound> } | undefined>(undefined);
  const cursor = goalCursors.at(-1) ?? 0, roundCursor = roundCursors.at(-1) ?? 0;
  const currentKey = JSON.stringify([owner.id, cursor, selectedId, roundCursor]);
  useLayoutEffect(() => { scope.current = currentKey; }, [currentKey]);
  const stopReading = useCallback(() => { alive.current = false; ++serial.current; }, []);
  const goal = goals?.items.find(item => item.id === selectedId && item.companionId === owner.id);
  const selectedRound = rounds?.items.find(item => item.id === roundId) ?? rounds?.items[0];
  const refresh = useCallback(async () => {
    if (lock.current || sourcesOpen) return;
    const epoch = ++serial.current; setLoading(true);
    try {
      if (!api?.workspace) throw new Error('学习安排接口暂不可用，请重新打开伙伴页面。');
      const [goalResult, sourceResult] = await Promise.all([
        api.workspace({ type: 'memory.learning.goals.list', companionId: owner.id, cursor, limit: 20 }),
        api.workspace({ type: 'memory.learning.status', companionId: owner.id }),
      ]);
      if (!alive.current || epoch !== serial.current || scope.current !== currentKey) return;
      if (!goalResult.ok || !goalResult.learningGoals) throw new Error(goalResult.error || '学习目标暂时无法读取。');
      if (goalResult.learningGoals.items.some(item => item.companionId !== owner.id)) throw new Error('学习目标的伙伴归属未能核实。');
      if (!sourceResult.ok || !sourceResult.learning || sourceResult.learning.grants.some(item => item.companionId !== owner.id)) throw new Error(sourceResult.error || '材料授权暂时无法核实。');
      const selected = goalResult.learningGoals.items.find(item => item.id === selectedId);
      const snapshot = selected ? JSON.stringify([selected.id, roundCursor, selected.revision, selected.totalRounds, selected.lastRound?.updatedAt, selected.phase, sourceResult.learning.grants.map(item => [item.id, item.revision, item.enabled])]) : '';
      // World ticks update the overview, but unchanged historical receipt bodies are not downloaded again.
      const roundResult = selected && snapshot !== roundSnapshot.current?.key ? await api.workspace({ type: 'memory.learning.goals.rounds', companionId: owner.id, id: selected.id, cursor: roundCursor, limit: 10 }) : undefined;
      if (!alive.current || epoch !== serial.current || scope.current !== currentKey) return;
      if (roundResult && (!roundResult.ok || !roundResult.learningRounds || roundResult.learningRounds.items.some(item => item.companionId !== owner.id || item.goalId !== selectedId))) throw new Error(roundResult.error || '学习轮次的归属未能核实。');
      setGoals(goalResult.learningGoals); setGrants(sourceResult.learning.grants);
      if (!selectedId || !goalResult.learningGoals.items.some(item => item.id === selectedId)) { setSelectedId(goalResult.learningGoals.items[0]?.id); setRounds(undefined); setRoundId(undefined); setRoundCursors([]); }
      else if (roundResult?.learningRounds) { setRounds(roundResult.learningRounds); roundSnapshot.current = { key: snapshot, page: roundResult.learningRounds }; }
      else if (selected && roundSnapshot.current?.key === snapshot) setRounds(roundSnapshot.current.page);
      setError('');
    } catch (cause) {
      if (alive.current && epoch === serial.current && scope.current === currentKey) { setGoals(undefined); setRounds(undefined); roundSnapshot.current = undefined; setGrants([]); setError(cause instanceof Error ? cause.message : '学习安排暂时无法读取。'); }
    } finally { if (alive.current && epoch === serial.current && scope.current === currentKey) setLoading(false); }
  }, [api, cursor, currentKey, owner.id, roundCursor, selectedId, sourcesOpen]);
  useEffect(() => {
    alive.current = true; const reads = createCoalescedRefresh(refresh, undefined, 1500); void reads.trigger();
    const unsubscribe = api?.onChanged(() => reads.trigger());
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void reads.trigger(); }, 15000);
    return () => { stopReading(); reads.dispose(); unsubscribe?.(); clearInterval(timer); };
  }, [api, refresh, stopReading]);
  const command = async (input: CompanionLearningGoalWorkspaceCommand): Promise<boolean> => {
    if (lock.current || !api?.workspace) return false;
    lock.current = true; ++serial.current; setBusy(true); setError(''); setActionError(''); setNotice('');
    try {
      const result = await api.workspace(input);
      if (!result.ok || !result.learningGoal || result.learningGoal.companionId !== owner.id || ('id' in input && result.learningGoal.id !== input.id)) throw new Error(result.error || '学习安排未能保存。');
      if (!alive.current) return false;
      const saved = result.learningGoal;
      if (input.type === 'memory.learning.goals.create') setGoalCursors([]);
      setGoals(current => current ? { ...current, items: current.items.some(item => item.id === saved.id) ? current.items.map(item => item.id === saved.id ? saved : item) : [saved, ...current.items].slice(0, 20) } : { items: [saved], hasMore: false });
      if (selectedId !== saved.id) { setSelectedId(saved.id); setRounds(undefined); setRoundCursors([]); setRoundId(undefined); }
      setNotice(input.type === 'memory.learning.goals.run' ? '已安排下一轮，按学习时段与伙伴状态等待执行。' : input.type === 'memory.learning.goals.create' ? '学习目标已保存。后续每轮的真实记录会留在这里。' : saved.state === 'paused' ? '学习已暂停，恢复后继续。' : saved.state === 'stopped' ? '已结束这个目标的后续学习安排。' : '学习安排已更新。');
      return true;
    } catch (cause) { if (alive.current) setActionError(cause instanceof Error ? cause.message : '学习安排未能保存。'); return false; }
    finally { lock.current = false; if (alive.current) { setBusy(false); void refresh(); } }
  };
  const selectGoal = (id: string) => { if (editor || id === selectedId) return; setSelectedId(id); setRounds(undefined); setRoundId(undefined); setRoundCursors([]); setStopConfirm(false); setNotice(''); };
  const save = async (draft: Extract<CompanionLearningGoalWorkspaceCommand, { type: 'memory.learning.goals.create' }>) => {
    const saved = await command(editor === 'edit' && editingGoal ? { type: 'memory.learning.goals.update', companionId: owner.id, id: editingGoal.id, expectedRevision: editingGoal.revision, text: draft.text, materials: draft.materials, allowWeb: draft.allowWeb, schedule: draft.schedule } : draft);
    if (saved && alive.current) setEditor(undefined); return saved;
  };
  return <section className="companion-learning-goals" aria-label="伙伴学习与成长">
    <div className="learning-goals-preserved" hidden={sourcesOpen}>
      <header className="learning-goals-header"><div><button type="button" aria-label="返回记忆库" onClick={onClose}><Icon name="chevron-left" size={18} /></button><Avatar companion={owner} /><span><small>{owner.name} · 把好奇变成自己的理解</small><h2>学习与成长</h2></span></div><button type="button" onClick={() => setSourcesOpen(true)}><Icon name="folder" size={15} />材料授权</button></header>
      <div className="learning-goals-layout"><aside className="learning-goals-sidebar"><div className="learning-goals-sidebar-heading"><span>持续学习目标</span><button type="button" aria-label="新建学习目标" disabled={busy || !!editor} onClick={() => { setEditor('new'); setNotice(''); setError(''); }}><Icon name="plus" size={16} /></button></div>
        <ol aria-label="学习目标列表">{goals?.items.map(item => <li key={item.id}><button type="button" aria-current={item.id === selectedId ? 'true' : undefined} disabled={!!editor} onClick={() => selectGoal(item.id)}><span className="learning-goal-list-state"><span className={'learning-goal-orb is-' + item.state} />{item.state === 'active' ? learningPhaseLabels[item.phase] : states[item.state]}</span><strong>{short(item.text, 100)}</strong><small>{item.totalRounds} 轮记录 · {learningDate(item.updatedAt)}</small></button></li>)}</ol>
        {!goals?.items.length && <p className="learning-goals-sidebar-empty">{loading ? '正在读取学习安排…' : '留一个值得慢慢探索的方向。'}</p>}
        <nav className="learning-goal-pagination" aria-label="学习目标分页"><button type="button" aria-label="上一页目标" disabled={!goalCursors.length || loading || !!editor} onClick={() => { setGoals(undefined); setSelectedId(undefined); setRounds(undefined); setGoalCursors(current => current.slice(0, -1)); }}><Icon name="chevron-left" size={14} /></button><span>{goalCursors.length + 1} 页</span><button type="button" aria-label="下一页目标" disabled={!goals?.hasMore || goals.nextCursor === undefined || loading || !!editor} onClick={() => { if (goals?.nextCursor !== undefined) { setGoals(undefined); setSelectedId(undefined); setRounds(undefined); setGoalCursors(current => [...current, goals.nextCursor!]); } }}><Icon name="chevron-right" size={14} /></button></nav>
        <p className="learning-goals-sidebar-note"><Icon name="shield" size={14} />只展示 {owner.name} 的学习安排与记录</p>
      </aside><main className="learning-goals-content">
        {(actionError || error) && <p className="learning-goal-error learning-goal-banner" role="alert">{actionError || error}<button type="button" disabled={loading} onClick={() => { setActionError(''); void refresh(); }}>重新读取</button></p>}
        {notice && <p className="learning-goal-notice" role="status"><Icon name="check" size={14} />{notice}</p>}
        {editor ? <CompanionLearningGoalEditor key={editor + ':' + (editor === 'edit' ? editingGoal?.id : owner.id)} owner={owner} goal={editor === 'edit' ? editingGoal : undefined} grants={grants} request={request} busy={busy} onSave={save} onCancel={() => setEditor(undefined)} onSources={() => setSourcesOpen(true)} /> : goal ? <>
          <section className="learning-goal-overview"><div className="learning-goal-overview-meta"><span className={'learning-goal-state is-' + goal.state}><span className={'learning-goal-orb is-' + goal.state} />{states[goal.state]}</span><time dateTime={goal.createdAt}>始于 {learningDate(goal.createdAt)}</time></div><LearningGoalDescription key={goal.id} text={goal.text} /><div className="learning-goal-current"><span className="learning-goal-current-icon"><Icon name={goal.phase === 'reading' ? 'file-text' : goal.phase === 'testing' ? 'check' : 'sparkles'} size={19} /></span><div><strong>{goal.state === 'active' ? learningPhaseLabels[goal.phase] : states[goal.state]}</strong><p>{goal.waitReason || (goal.state === 'paused' ? '恢复后，继续按原目标和学习时段推进。' : goal.state === 'stopped' ? '已保留学习记录，后续不再安排新的一轮。' : '按当前学习节奏推进；每轮结果会写入下面的记录。')}</p>{goal.state === 'active' && <time dateTime={goal.nextAt}>下次可学习 {learningDate(goal.nextAt, goal.schedule.timeZone)} · {goal.schedule.timeZone}</time>}</div></div>
            <div className="learning-goal-overview-actions"><button type="button" disabled={busy || goal.state !== 'active' || !['idle', 'waiting'].includes(goal.phase)} onClick={() => void command({ type: 'memory.learning.goals.run', companionId: owner.id, id: goal.id, expectedRevision: goal.revision })}><Icon name="play" size={14} />安排下一轮</button>{goal.state !== 'stopped' && <button type="button" disabled={busy} onClick={() => void command({ type: 'memory.learning.goals.update', companionId: owner.id, id: goal.id, expectedRevision: goal.revision, state: goal.state === 'paused' ? 'active' : 'paused' })}><Icon name={goal.state === 'paused' ? 'play' : 'pause'} size={14} />{goal.state === 'paused' ? '恢复学习' : '暂停学习'}</button>}<button type="button" disabled={busy} onClick={() => { setEditingGoal(goal); setEditor('edit'); setNotice(''); setError(''); }}><Icon name="edit" size={14} />调整目标</button><details className="learning-goal-settings"><summary><Icon name="clock" size={14} />学习节奏与材料</summary><p>每轮间隔 {intervalLabel(goal.schedule.intervalMinutes)} · {goal.schedule.windows.length ? `${goal.schedule.windows.length} 个学习时段` : '未限定学习时段'} · {goal.schedule.timeZone}</p><p>间隔与时段使用现实时间；需伙伴已激活，睡眠与用餐时等待，工作和聊天可独立并行。</p>{goal.schedule.windows.map((window, index) => <p key={index}>{Math.floor(window.startMinute / 60).toString().padStart(2, '0')}:{(window.startMinute % 60).toString().padStart(2, '0')}–{Math.floor(window.endMinute / 60).toString().padStart(2, '0')}:{(window.endMinute % 60).toString().padStart(2, '0')}{window.endMinute < window.startMinute ? '（次日）' : ''} · {(window.days ?? [0, 1, 2, 3, 4, 5, 6]).map(day => ['日', '一', '二', '三', '四', '五', '六'][day]).join('、')}</p>)}<ul>{goal.materials.map((material, index) => <li key={index}>{learningMaterialLabel(material, grants)}</li>)}</ul>{!goal.materials.length && <p>未指定固定材料。</p>}<p>{goal.allowWeb ? '允许查找公开网页' : '不自行扩展网页来源'}</p>{goal.state !== 'stopped' && <button type="button" disabled={busy} onClick={() => setStopConfirm(true)}>结束这个学习目标</button>}</details></div>
            {stopConfirm && <div className="learning-goal-stop-confirm"><p>结束后不再安排新一轮，已有学习记录会保留。当前尚未提交的结果将停止。</p><div><button type="button" disabled={busy} onClick={() => setStopConfirm(false)}>继续保留</button><button type="button" disabled={busy} onClick={() => void command({ type: 'memory.learning.goals.update', companionId: owner.id, id: goal.id, expectedRevision: goal.revision, state: 'stopped' }).then(saved => { if (saved) setStopConfirm(false); })}>确认结束学习</button></div></div>}
          </section>
          <section className="learning-goal-rounds"><div className="learning-goals-section-heading"><div><span className="learning-goal-kicker">每一轮，都有真实的来处</span><h3>学习记录 <small>{goal.totalRounds} 轮</small></h3></div><button type="button" disabled={loading} aria-label="刷新学习记录" onClick={() => void refresh()}><Icon name="refresh" size={15} /></button></div>
            {!!rounds?.items.length && <div className="learning-goal-round-browser"><nav aria-label="选择学习轮次">{rounds.items.map(round => <button type="button" key={round.id} aria-current={selectedRound?.id === round.id ? 'true' : undefined} onClick={() => setRoundId(round.id)}><span>第 {round.ordinal} 轮<time dateTime={round.startedAt}>{learningDate(round.startedAt)}</time></span><strong>{short(round.plan?.focus || round.summary || learningPhaseLabels[round.phase], 100)}</strong><small>{round.status === 'running' ? learningPhaseLabels[round.phase] : round.status === 'completed' ? `${round.reads.length} 份阅读 · ${round.memoryIds.length} 项记忆` : round.status === 'failed' ? '需要处理' : round.status === 'deferred' ? '已延后' : '本轮已停止'}</small></button>)}</nav>{selectedRound && <CompanionLearningRound key={selectedRound.id} round={selectedRound} onOpenNote={onOpenNote} />}</div>}
            {!rounds?.items.length && <div className="learning-goal-empty-round"><Icon name="file-text" size={24} /><h4>{loading ? '正在读取学习记录…' : '还没有提交的学习记录'}</h4><p>真正开始一轮后，这里会记录计划、原文、理解与自测。尚未发生的步骤不会显示成完成。</p></div>}
            <nav className="learning-goal-pagination" aria-label="学习记录分页"><button type="button" disabled={!roundCursors.length || loading} onClick={() => { setRounds(undefined); setRoundId(undefined); setRoundCursors(current => current.slice(0, -1)); }}>上一页记录</button><span>第 {roundCursors.length + 1} 页 · 每页最多 10 轮</span><button type="button" disabled={!rounds?.hasMore || rounds.nextCursor === undefined || loading} onClick={() => { if (rounds?.nextCursor !== undefined) { setRounds(undefined); setRoundId(undefined); setRoundCursors(current => [...current, rounds.nextCursor!]); } }}>下一页记录</button></nav>
          </section>
        </> : !error && !loading && <div className="learning-goals-welcome"><span className="learning-goals-welcome-icon"><Icon name="sparkles" size={28} /></span><span className="learning-goal-kicker">和 {owner.name} 一起，慢慢长大</span><h3>从一个长久的好奇开始</h3><p>写下想探索的方向，留一些可读的材料。伙伴会在自己的空闲里持续学习，留下原文依据、真实的理解，以及还没弄明白的问题。</p><button type="button" className="learning-goal-primary" onClick={() => setEditor('new')}><Icon name="plus" size={15} />写下第一个学习目标</button><small>只打开页面不会触发学习或模型调用。</small></div>}
      </main></div>
    </div>
    {sourcesOpen && <CompanionLearningSources owner={owner} api={api} embedded onClose={() => { setSourcesOpen(false); void refresh(); }} />}
  </section>;
}

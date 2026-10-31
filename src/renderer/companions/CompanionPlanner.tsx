import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { Companion, CompanionAction, WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionRuntimeState } from '../../shared/companion-state';
import { Avatar } from './CompanionVisuals';
import { Icon } from '../Icons';
import { CompanionAgendaSummary } from './CompanionAgenda';
import './companion-planner-current.css';
import type { ScheduleRequest } from './companion-schedules';
import { useCompanionRoutine } from './companion-routines';
import { createCoalescedRefresh } from './coalesced-refresh';
import { CompanionStateChanges } from './CompanionStateChanges';
import { CompanionCharacterDevelopment } from './CompanionCharacterDevelopment';
import { CompanionExperienceView } from './CompanionCurrentCircumstances';


export function CompanionPlanner({ companion, members, conversationId,  request, api, onOwnerChange, onClose, onProfile, onMemory, onSchedules, onWorld, onObserve, onManageGroup, onLocateStateSource, onStateMemory, active = true }: {
  readonly companion: Companion; readonly members: Companion[]; readonly conversationId: string; readonly conversationKind?: 'private' | 'group'; readonly actions: CompanionAction[];
  readonly request: ScheduleRequest; readonly api?: WorldlineBoxCompanionsApi; readonly onOwnerChange: (id: string) => void;
  readonly onClose: () => void; readonly onProfile: () => void; readonly onMemory: () => void; readonly onSchedules: (eventId?: string) => void;
  readonly onWorld?: () => void;
  readonly onObserve?: () => void; readonly onManageGroup?: () => void;
  readonly onLocateStateSource?: (conversationId: string, messageId: string) => void;
  readonly onStateMemory?: (noteId: string) => void;
  readonly active?: boolean;
}) {
  const { routine } = useCompanionRoutine(companion.id, conversationId, request, api, active);
  const stateScope = companion.id + '/' + conversationId;
  const [runtimeSnapshot, setRuntime] = useState<{ scope: string; state: CompanionRuntimeState; checkedAt: string }>();
  const [stateError, setStateError] = useState<{ scope: string; message: string }>();
  const runtime = active && runtimeSnapshot?.scope === stateScope && runtimeSnapshot.state.companionId === companion.id ? runtimeSnapshot.state : undefined;
  const stateIssue = active && stateError?.scope === stateScope ? stateError.message : undefined;
  const [stateDetails, setStateDetails] = useState(false);
  const epoch = useRef(0), currentScope = useRef(stateScope);
  useLayoutEffect(() => { currentScope.current = stateScope; }, [stateScope]);
  const invalidateStateRead = useCallback(() => { ++epoch.current; }, []);
  const loadState = useCallback(async () => {
    if (!active) return; const current = ++epoch.current;
    try {
      const result = await request({ type: 'state.get', companionId: companion.id, conversationId });
      if (current !== epoch.current || currentScope.current !== stateScope) return;
      if (!result?.ok || result.runtimeState?.companionId !== companion.id) throw new Error(result?.error || '当前伙伴状态暂时无法核实。');
      setRuntime({ scope: stateScope, state: result.runtimeState, checkedAt: new Date().toISOString() }); setStateError(undefined);
    } catch (cause) {
      if (current !== epoch.current || currentScope.current !== stateScope) return;
      setRuntime(undefined); setStateError({ scope: stateScope, message: cause instanceof Error ? cause.message : '当前伙伴状态暂时无法核实。' });
    }
  }, [active, request, companion.id, conversationId, stateScope]);
  useLayoutEffect(() => {
    if (!active) return; const reads = createCoalescedRefresh(loadState, undefined, 200); void reads.trigger();
    const unsubscribe = api?.onChanged(() => reads.trigger());
    return () => { invalidateStateRead(); setRuntime(undefined); setStateError(undefined); reads.dispose(); unsubscribe?.(); };
  }, [active, api, loadState, invalidateStateRead]);
  const focus = runtime?.focus;
  return <><aside className="companions-relationship-panel companions-planner" aria-label="伙伴手帐">
    <header><div><span>伙伴手帐</span><h3>{companion.name}的日常</h3></div><button className="companion-icon-button" aria-label="收起我们之间" onClick={onClose}>×</button></header>
    <div className="companions-planner-identity"><Avatar companion={companion} /><div><strong>{companion.name}</strong>{members.length > 1 ? <select aria-label="当前伙伴" value={companion.id} onChange={event => onOwnerChange(event.target.value)}>{members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select> : <span>{companion.active === false ? '伙伴生活已暂停' : '查看处境与经历'}</span>}</div><button className="companion-icon-button" aria-label="查看伙伴资料" onClick={onProfile}><Icon name="users" /></button></div>
    <div className="companions-planner-state">
      <button className="companions-planner-state-chips" aria-label="查看当前伙伴状态详情" aria-expanded={stateDetails} onClick={() => setStateDetails(value => !value)}>{runtime ? <span>{runtime.reason ? '近期处境与关注' : '处境尚无明确记录'}</span> : <span>{stateIssue ? '当前状态暂不可用' : '正在了解当前状态…'}</span>}<Icon name="chevron" /></button>
      <p className="companions-planner-focus"><i />{stateIssue ? '状态同步中断，等待重新核对' : routine?.runtime.phase === 'resting' ? routine.runtime.activity ?? '正在休息' : focus ? '正在关注 · ' + focus : runtime ? '暂无已记录的关注' : '正在读取当前关注'}</p>
      {routine && <button className="companions-planner-routine-current" onClick={() => onSchedules()}><Icon name="clock" /><span>{routine.runtime.activity ?? (routine.runtime.phase === 'sleeping' ? '正在睡觉' : routine.runtime.phase === 'awake' ? '清醒的日常' : '正在休息')}</span><small>{companion.active === false ? '激活后可交流' : '可以交流'}</small></button>}
      {stateDetails && <div className="companions-planner-state-detail" role="dialog" aria-label="伙伴当前状态"><header><strong>当前状态</strong><button aria-label="关闭当前状态详情" onClick={() => setStateDetails(false)}>×</button></header>{runtime?.reason ? <p>{runtime.reason}</p> : <p>{stateIssue ? '当前状态尚未核实，旧状态与来源已隐藏。' : '状态会随实际交流、共同经历和执行任务更新。'}</p>}{stateIssue && <p className="companions-state-sync-error" role="status">{stateIssue}<button type="button" onClick={() => void loadState()}>重新核对</button></p>}{runtime && <CompanionExperienceView runtime={runtime} />}{runtime && <CompanionStateChanges key={stateScope} changes={runtime.recentChanges} onLocateSource={onLocateStateSource} onOpenMemory={onStateMemory} />}{runtime && <CompanionCharacterDevelopment active={active} companionId={companion.id} conversationId={conversationId} request={request} api={api} onOpenMemory={onStateMemory} />}<p>这里展示已记录的处境、关注和来源。没有明确记录时保留未知，不用心理分数或交流次数推断感受与关系。</p><button onClick={onProfile}>查看完整角色设定</button>{runtime && runtimeSnapshot?.scope === stateScope && <small className="companions-state-sync">状态核对 <time dateTime={runtimeSnapshot.checkedAt}>{new Date(runtimeSnapshot.checkedAt).toLocaleTimeString('zh-CN', { hour12: false })}</time></small>}</div>}
    </div>
    {onWorld && <button className="companions-world-entry" aria-label="看看伙伴的小屋" onClick={onWorld}><Icon name="globe" /><span><strong>去她的小屋看看</strong><small>窗外的天气，和她此刻的生活</small></span><Icon name="chevron" /></button>}
    <CompanionAgendaSummary companionId={companion.id} request={request} api={api} active={active} onOpen={onSchedules} />
    <div className="companions-planner-links"><button onClick={onMemory} aria-label="管理共同记忆"><Icon name="archive" /><span>共同记忆<small>查看来处与相处的细节</small></span><Icon name="chevron" /></button><button onClick={() => onSchedules()} aria-label="查看伙伴日程"><Icon name="activity" /><span>日程<small>查看这件事如何发生与完成</small></span><Icon name="chevron" /></button>{onObserve && <button onClick={onObserve} aria-label="查看此伙伴的交互"><Icon name="users" /><span>伙伴往来<small>查看真实交往与关系</small></span><Icon name="chevron" /></button>}{onManageGroup && <button onClick={onManageGroup} aria-label="管理群聊"><Icon name="users" /><span>群聊成员<small>查看与管理这段群聊</small></span><Icon name="chevron" /></button>}</div>
  </aside></>;
}

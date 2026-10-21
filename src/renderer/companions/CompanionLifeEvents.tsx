import { useCallback, useEffect, useRef, useState } from 'react';
import { companionLifeRuleDraftSchema, companionLifeRhythm, type CompanionLifeOccurrence, type CompanionLifeRule } from '../../shared/companion-life-event';
import type { Companion, WorldlineBoxCompanionsApi } from '../../shared/companions';
import { companionTimestamp } from '../../shared/companion-time';
import { Icon } from '../Icons';
import type { ScheduleRequest } from './companion-schedules';
import './companion-work-orders.css';

const ACTIONS: Record<CompanionLifeRule['action'], string> = { message: '联系与问候', visit: '拜访朋友', rest: '放松休息', study: '读书学习', leisure: '兴趣时光', park_walk: '公园散步' };
const OCCURRENCES: Record<CompanionLifeOccurrence['status'], string> = { observing: '等待自然发生', pending: '等待合适时机', running: '正在安排', active: '实际进行中', done: '已完成', silent: '这次选择安静', expired: '本次已结束', cancelled: '本次已中断', failed: '未能完成' };
type Draft = { title: string; enabled: boolean; start: string; end: string; percent: number; action: CompanionLifeRule['action']; targetId: string; durationMinutes: number;
  checkIntervalMinutes: number; actionCooldownMinutes: number; silenceCooldownMinutes: number; failureCooldownMinutes: number };
const time = (minute: number) => String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
function minutes(value: string, end = false): number { if (end && value === '24:00') return 1440; const match = /^(\d{2}):(\d{2})$/.exec(value); return match && +match[1]! < 24 && +match[2]! < 60 ? +match[1]! * 60 + +match[2]! : NaN; }
const empty = (): Draft => ({ title: '', enabled: true, start: '14:00', end: '18:00', percent: 35, action: 'message', targetId: '', durationMinutes: 30, ...companionLifeRhythm({}) });
function ruleDraft(rule: CompanionLifeRule): Draft { return { title: rule.title, enabled: rule.enabled, start: time(rule.startMinute), end: time(rule.endMinute), percent: rule.probability * 100, action: rule.action, targetId: rule.targetId ?? '', durationMinutes: rule.durationMinutes ?? 30, ...companionLifeRhythm(rule) }; }

export function CompanionLifeEvents({ companion, companions, request, api }: { readonly companion: Companion; readonly companions: Companion[]; readonly request: ScheduleRequest; readonly api?: WorldlineBoxCompanionsApi }) {
  const [rules, setRules] = useState<CompanionLifeRule[]>([]), [occurrences, setOccurrences] = useState<CompanionLifeOccurrence[]>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [editor, setEditor] = useState<{ rule?: CompanionLifeRule; draft: Draft }>(), [removing, setRemoving] = useState<string>();
  const epoch = useRef(0);
  const clientId = useRef(crypto.randomUUID()), submitted = useRef('');
  const refresh = useCallback(async () => {
    const current = ++epoch.current;
    try {
      const response = await request({ type: 'life-rule.list', companionId: companion.id });
      if (current !== epoch.current) return;
      if (!response?.lifeRules) { setError(response?.error || '日常事件暂时无法读取，请刷新重试。'); return; }
      setRules(response.lifeRules); setOccurrences(response.lifeOccurrences ?? []);
    } catch (cause) { if (current === epoch.current) setError(cause instanceof Error ? cause.message : '日常事件无法读取。'); }
    finally { if (current === epoch.current) setLoading(false); }
  }, [companion.id, request]);
  useEffect(() => { const counter = epoch; void Promise.resolve().then(refresh); return () => { counter.current++; }; }, [refresh]);
  useEffect(() => { let timer: ReturnType<typeof setTimeout> | undefined; const unsubscribe = api?.onChanged(() => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 200); }); return () => { unsubscribe?.(); clearTimeout(timer); }; }, [api, refresh]);
  function begin(rule?: CompanionLifeRule) { setEditor({ rule, draft: rule ? ruleDraft(rule) : empty() }); setError(''); clientId.current = crypto.randomUUID(); submitted.current = ''; }
  const target = (id?: string) => id === 'user' ? '你' : id ? companions.find(item => item.id === id)?.name ?? '指定的伙伴' : '由伙伴自然选择朋友';
  async function save() {
    if (!editor) return;
    const draft = editor.draft;
    const parsed = companionLifeRuleDraftSchema.safeParse({ title: draft.title, enabled: draft.enabled, startMinute: minutes(draft.start), endMinute: minutes(draft.end, true), probability: draft.percent / 100, action: draft.action, ...companionLifeRhythm(draft), ...(draft.action === 'park_walk' ? { durationMinutes: draft.durationMinutes } : {}), ...(['message', 'visit'].includes(draft.action) && draft.targetId ? { targetId: draft.targetId } : {}) });
    if (!parsed.success) { setError('请检查标题、时间窗口和机会百分比；散步时长为10至120世界分钟，结束时间可写24:00，起止时间不能相同。'); return; }
    const signature = JSON.stringify(parsed.data);
    if (submitted.current && submitted.current !== signature) clientId.current = crypto.randomUUID();
    submitted.current = signature;
    setBusy(true); setError('');
    try {
      const response = editor.rule ? await request({ type: 'life-rule.update', companionId: companion.id, id: editor.rule.id, expectedRevision: editor.rule.revision, rule: parsed.data }) : await request({ type: 'life-rule.create', companionId: companion.id, rule: parsed.data, clientId: clientId.current });
      if (!response?.ok) { setError(response?.error || '日常事件未保存，请刷新确认后重试。'); return; }
      setEditor(undefined); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '日常事件未保存。'); }
    finally { setBusy(false); }
  }
  async function change(rule: CompanionLifeRule, remove = false) {
    setBusy(true); setError('');
    const { title, enabled, startMinute, endMinute, probability, action, targetId, durationMinutes } = rule;
    try {
      const response = remove ? await request({ type: 'life-rule.remove', companionId: companion.id, id: rule.id, expectedRevision: rule.revision }) : await request({ type: 'life-rule.update', companionId: companion.id, id: rule.id, expectedRevision: rule.revision, rule: { title, enabled: !enabled, startMinute, endMinute, probability, action, ...companionLifeRhythm(rule), ...(action === 'park_walk' && durationMinutes !== undefined ? { durationMinutes } : {}), ...(targetId ? { targetId } : {}) } });
      if (!response?.ok) { setError(response?.error || '日常事件已经变化，请刷新后重试。'); return; }
      setRemoving(undefined); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作未完成。'); }
    finally { setBusy(false); }
  }
  return <div className="companions-life-workspace"><div className="companions-life-list"><div className="companions-life-intro"><span className="companions-work-eyebrow">给生活留一点偶然</span><h3>日常事件</h3><p>在合适的时间，伙伴会根据心情、精力、关系和所在环境，自然地联系朋友、去公园散步，或做一点喜欢的事。</p><button className="companion-primary-button" onClick={() => { begin(); }}><Icon name="plus" />添加日常事件</button></div>
    {!companion.proactive && <p className="companions-life-paused"><Icon name="info" />伙伴的主动联系已关闭。日常事件会保留，开启伙伴资料中的主动联系后才会触发。</p>}
    {error && <p className="companions-memory-error" role="alert">{error}<button onClick={() => { setError(''); void refresh(); }}>刷新事件</button></p>}
    {loading && <p className="companions-subtle">正在读取日常事件…</p>}
    {!loading && !rules.length && <p className="companions-work-empty">还没有日常事件，可以为她留下一段自由的生活时间。</p>}
    {rules.map(rule => <article className="companions-life-rule" key={rule.id} data-life-rule={rule.id}><div className="companions-life-rule-top"><span className="companions-life-action"><Icon name={rule.action === 'message' ? 'message-circle' : rule.action === 'visit' ? 'users' : rule.action === 'study' ? 'file' : 'clock'} />{ACTIONS[rule.action]}</span><span className={'companions-life-enabled' + (rule.enabled ? ' is-enabled' : '')}>{rule.enabled ? '已启用' : '已停用'}</span></div><h4>{rule.title}</h4><div className="companions-life-window"><time>{time(rule.startMinute)}—{rule.endMinute < 1440 && rule.endMinute <= rule.startMinute ? '次日 ' : ''}{time(rule.endMinute)}</time><span>基础机会 <strong>{Math.round(rule.probability * 10000) / 100}%</strong></span></div>{['message', 'visit'].includes(rule.action) && <p>{target(rule.targetId)}</p>}{rule.action === 'park_walk' && <p>散步 {rule.durationMinutes ?? 30} 世界分钟 · 抵达公园后计时</p>}<div className="companions-life-rule-actions"><button disabled={busy} onClick={() => { begin(rule); }}>编辑事件</button><button disabled={busy} onClick={() => void change(rule)}>{rule.enabled ? '停用事件' : '启用事件'}</button><button disabled={busy} onClick={() => setRemoving(rule.id)}>移除事件</button></div>{removing === rule.id && <div className="companions-work-confirm"><p>移除后不再产生新的日常事件，已经发生的经历保留。</p><button onClick={() => setRemoving(undefined)}>保留事件</button><button disabled={busy} onClick={() => void change(rule, true)}>确认移除事件</button></div>}</article>)}
    {!!occurrences.length && <details className="companions-life-history"><summary>最近的生活记录</summary>{occurrences.slice(0, 12).map(occurrence => <div key={occurrence.id}><strong>{occurrence.rule.title}</strong><small>{companionTimestamp(occurrence.windowStart)} · {OCCURRENCES[occurrence.status]}</small>{occurrence.result && <p>{occurrence.result}</p>}{occurrence.reason && <p>{occurrence.reason}</p>}</div>)}</details>}
  </div><aside className="companions-life-editor">{editor ? <form onSubmit={event => { event.preventDefault(); void save(); }}><div className="companions-schedule-editor-heading"><h3>{editor.rule ? '调整这份小期待' : '添一点生活的可能'}</h3><button type="button" aria-label="关闭日常事件编辑" onClick={() => setEditor(undefined)}>×</button></div><label>事件名称<input aria-label="日常事件名称" maxLength={120} required value={editor.draft.title} onChange={event => setEditor({ ...editor, draft: { ...editor.draft, title: event.target.value } })} placeholder="例如：午后找朋友聊聊" /></label><div className="companions-schedule-field-row"><label>开始时间<input aria-label="日常事件开始时间" type="time" required value={editor.draft.start} onChange={event => setEditor({ ...editor, draft: { ...editor.draft, start: event.target.value } })} /></label><label>结束时间<input aria-label="日常事件结束时间" inputMode="numeric" pattern="[0-2][0-9]:[0-5][0-9]" required value={editor.draft.end} onChange={event => setEditor({ ...editor, draft: { ...editor.draft, end: event.target.value } })} /></label></div><small>按世界中的本地时间。结束早于开始时跨夜；24:00表示当天结束。</small><label>每轮评估的基础机会<div className="companions-life-probability"><input aria-label="日常事件机会滑杆" type="range" min={0} max={100} step={1} value={editor.draft.percent} onChange={event => setEditor({ ...editor, draft: { ...editor.draft, percent: Number(event.target.value) } })} /><span><input aria-label="日常事件机会百分比" type="number" required min={0} max={100} step="any" value={editor.draft.percent} onChange={event => setEditor({ ...editor, draft: { ...editor.draft, percent: Number(event.target.value) } })} />%</span></div></label><label>想做什么<select aria-label="日常事件动作" value={editor.draft.action} onChange={event => { const action = event.target.value as Draft['action']; setEditor({ ...editor, draft: { ...editor.draft, action, targetId: action === 'visit' && editor.draft.targetId === 'user' ? '' : editor.draft.targetId } }); }}>{Object.entries(ACTIONS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>{editor.draft.action === 'park_walk' && <label>散步时长<input aria-label="散步时长分钟" type="number" required min={10} max={120} step={1} value={editor.draft.durationMinutes} onChange={event => setEditor({ ...editor, draft: { ...editor.draft, durationMinutes: Number(event.target.value) } })} /><small>世界分钟，抵达公园后计时。工作、吃饭或睡觉中断时不计为散步。</small></label>}{['message', 'visit'].includes(editor.draft.action) && <label>交流对象<select aria-label="日常事件对象" value={editor.draft.targetId} onChange={event => setEditor({ ...editor, draft: { ...editor.draft, targetId: event.target.value } })}><option value="">由伙伴自然选择朋友</option>{editor.draft.action === 'message' && <option value="user">我</option>}{companions.filter(item => item.id !== companion.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}<div className="companions-schedule-field-row"><label>评估间隔<input aria-label="日常事件评估间隔分钟" type="number" min={1} max={120} required value={editor.draft.checkIntervalMinutes} onChange={event => setEditor({ ...editor, draft: { ...editor.draft, checkIntervalMinutes: Number(event.target.value) } })} /></label><label>行动后休息<input aria-label="日常事件行动冷却分钟" type="number" min={5} max={1440} required value={editor.draft.actionCooldownMinutes} onChange={event => setEditor({ ...editor, draft: { ...editor.draft, actionCooldownMinutes: Number(event.target.value) } })} /></label></div><div className="companions-schedule-field-row"><label>安静后再考虑<input aria-label="日常事件沉默冷却分钟" type="number" min={1} max={1440} required value={editor.draft.silenceCooldownMinutes} onChange={event => setEditor({ ...editor, draft: { ...editor.draft, silenceCooldownMinutes: Number(event.target.value) } })} /></label><label>失败后再考虑<input aria-label="日常事件失败冷却分钟" type="number" min={1} max={1440} required value={editor.draft.failureCooldownMinutes} onChange={event => setEditor({ ...editor, draft: { ...editor.draft, failureCooldownMinutes: Number(event.target.value) } })} /></label></div><small>均为世界分钟。没有想说的新内容时可以选择安静，同一时段稍后仍有机会。</small><label className="companions-checkbox"><input aria-label="启用日常事件" type="checkbox" checked={editor.draft.enabled} onChange={event => setEditor({ ...editor, draft: { ...editor.draft, enabled: event.target.checked } })} />启用这项日常事件</label><div className="companions-life-explanation"><Icon name="info" /><p>机会按评估节奏计算，会随精力、心情、关系与环境调整。完成、安静或失败后分别休息，再考虑下一次；不会要求每轮必须发言。睡觉、吃饭或工作时不主动联系，离线机会不补发。默认只联系伙伴，主动找你需要单独设置；拜访仍需许可。</p></div><footer><button className="companion-secondary-button" type="button" disabled={busy} onClick={() => setEditor(undefined)}>暂不保存</button><button className="companion-primary-button" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存日常事件'}</button></footer></form> : <div className="companions-life-editor-idle"><Icon name="message-circle" /><h3>不用把每一分钟排满</h3><p>固定提醒负责守时，日常事件让生活保持一点自由。选择左侧事件，调整她的闲暇时光。</p></div>}</aside></div>;
}

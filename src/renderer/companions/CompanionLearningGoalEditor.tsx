import { useState } from 'react';
import type { Companion, CompanionsRequest, CompanionsResponse } from '../../shared/companions';
import type { CompanionLearningGrant } from '../../shared/companion-learning';
import type { CompanionLearningGoal, CompanionLearningGoalMaterial, CompanionLearningGoalWorkspaceCommand } from '../../shared/companion-learning-goals';
import { Icon } from '../Icons';

type GoalDraft = Extract<CompanionLearningGoalWorkspaceCommand, { type: 'memory.learning.goals.create' }>;
type Window = CompanionLearningGoal['schedule']['windows'][number];
const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
function minuteLabel(minute: number) { return `${Math.floor(minute / 60).toString().padStart(2, '0')}:${(minute % 60).toString().padStart(2, '0')}`; }
function minuteValue(value: string) { const [hour = 0, minute = 0] = value.split(':').map(Number); return Number.isFinite(hour + minute) ? hour * 60 + minute : 0; }
export function learningMaterialLabel(material: CompanionLearningGoalMaterial, grants: CompanionLearningGrant[]) {
  if (material.kind === 'file') return material.name || '已选择的本地文件';
  if (material.kind === 'web') return material.url;
  const grant = grants.find(value => value.id === material.grantId);
  return (grant ? grant.libraryName + (grant.folderName ? ` / ${grant.folderName}` : '') : '已授权的资料来源') + (material.kind === 'asset' ? ' · 指定资产' : '');
}

export function CompanionLearningGoalEditor({ owner, goal, grants, request, busy, onSave, onCancel, onSources }: {
  owner: Companion; goal?: CompanionLearningGoal; grants: CompanionLearningGrant[]; busy: boolean;
  request: (input: CompanionsRequest) => Promise<CompanionsResponse | undefined>;
  onSave(draft: GoalDraft): Promise<boolean>; onCancel(): void; onSources(): void;
}) {
  const [text, setText] = useState(goal?.text ?? ''), [materials, setMaterials] = useState<CompanionLearningGoalMaterial[]>(goal?.materials ?? []);
  const [intervalMinutes, setIntervalMinutes] = useState(goal?.schedule.intervalMinutes ?? 60);
  const [windows, setWindows] = useState<Window[]>(goal?.schedule.windows.map(window => ({ ...window, days: window.days ?? [0, 1, 2, 3, 4, 5, 6] })) ?? []);
  const [timeZone, setTimeZone] = useState(goal?.schedule.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
  const [allowWeb, setAllowWeb] = useState(goal?.allowWeb ?? false), [url, setUrl] = useState('');
  const [error, setError] = useState(''), [picking, setPicking] = useState(false);
  const disabled = busy || picking;
  const updateWindow = (index: number, patch: Partial<Window>) => setWindows(current => current.map((item, position) => position === index ? { ...item, ...patch } : item));
  const addWeb = () => {
    try {
      const parsed = new URL(url.trim());
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('请填写公开的 HTTP 或 HTTPS 网页地址。');
      if (materials.length >= 20) throw new Error('一个目标最多关联 20 项材料。');
      if (!materials.some(item => item.kind === 'web' && item.url === parsed.href)) setMaterials(current => [...current, { kind: 'web', url: parsed.href }]);
      setUrl(''); setError('');
    } catch (cause) { setError(cause instanceof Error && cause.message.startsWith('请') ? cause.message : '请填写完整、有效的公开网页地址。'); }
  };
  const pickFiles = async () => {
    setPicking(true); setError('');
    try {
      const result = await request({ type: 'attachment.pick' });
      if (!result?.ok) throw new Error(result?.error || '文件未能添加。');
      const additions = (result.attachments ?? []).map(item => ({ kind: 'file' as const, attachmentId: item.id, name: item.name }));
      const added = additions.filter(item => !materials.some(value => value.kind === 'file' && value.attachmentId === item.attachmentId));
      if (materials.length + added.length > 20) throw new Error('一个目标最多关联 20 项材料，请减少选择后再添加。');
      setMaterials(current => [...current, ...added]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '文件未能添加。'); }
    finally { setPicking(false); }
  };
  return <form className="learning-goal-editor" aria-label={goal ? '调整学习目标' : '新建学习目标'} onSubmit={event => {
    event.preventDefault(); setError('');
    if (!text.trim()) { setError('先写下想让伙伴持续探索的目标。'); return; }
    try { new Intl.DateTimeFormat('zh-CN', { timeZone }); } catch { setError('请使用有效的时区，例如 Asia/Shanghai。'); return; }
    if (windows.some(window => !window.days?.length)) { setError('每个学习时段至少选择一天。'); return; }
    if (url.trim()) { setError('网页地址尚未加入材料，请先点击“加入网页”或清空地址。'); return; }
    void onSave({ type: 'memory.learning.goals.create', companionId: owner.id, text: text.trim(), materials, allowWeb, schedule: { intervalMinutes, windows, timeZone } });
  }}>
    <header><span className="learning-goal-kicker">{owner.name} 的成长方向</span><h3>{goal ? '调整学习目标' : '想让伙伴慢慢学会什么？'}</h3><p>用自然语言描述方向、期望和边界。伙伴会分轮规划、阅读、整理与自测，保留每一步的出处。</p></header>
    <label className="learning-goal-field">持续学习目标<textarea aria-label="持续学习目标" maxLength={12000} rows={5} placeholder="例如：持续学习海洋生态，先理解近岸潮汐与生物的关系。每轮聚焦一个小问题，用材料支持结论；说不清楚的地方留到下一轮。" value={text} disabled={disabled} onChange={event => setText(event.target.value)} /></label>
    <fieldset><legend>参考材料 <small>可选</small></legend><p>选中的材料只用于这个目标。资产库的阅读范围仍由材料授权管理。</p>
      {!!grants.filter(item => item.enabled).length && <div className="learning-goal-grants">{grants.filter(item => item.enabled).map(grant => <label key={grant.id}><input type="checkbox" disabled={disabled} checked={materials.some(item => item.kind === 'library' && item.grantId === grant.id)} onChange={event => setMaterials(current => event.target.checked ? current.length < 20 ? [...current, { kind: 'library', grantId: grant.id }] : current : current.filter(item => item.kind !== 'library' || item.grantId !== grant.id))} /><span>{grant.libraryName}<small>{grant.folderName || '已授权文本范围'}</small></span></label>)}</div>}
      <div className="learning-goal-material-actions"><button type="button" disabled={disabled} onClick={() => void pickFiles()}><Icon name="file-text" size={14} />{picking ? '正在选择…' : '选择本地文件'}</button><button type="button" disabled={disabled} onClick={onSources}><Icon name="folder" size={14} />管理资产库授权</button></div>
      <div className="learning-goal-web"><input aria-label="学习网页地址" type="url" placeholder="粘贴公开网页地址" value={url} maxLength={4096} disabled={disabled || materials.length >= 20} onChange={event => setUrl(event.target.value)} /><button type="button" disabled={disabled || !url.trim()} onClick={addWeb}>加入网页</button></div>
      {!!materials.length && <ul className="learning-goal-materials">{materials.map((material, index) => <li key={JSON.stringify(material)}><Icon name={material.kind === 'web' ? 'external-link' : material.kind === 'file' ? 'file-text' : 'folder'} size={13} /><span>{learningMaterialLabel(material, grants)}</span><button type="button" aria-label={`移除材料 ${learningMaterialLabel(material, grants)}`} disabled={disabled} onClick={() => setMaterials(current => current.filter((_, position) => position !== index))}><Icon name="close" size={13} /></button></li>)}</ul>}
      <label className="learning-goal-check"><input type="checkbox" checked={allowWeb} disabled={disabled} onChange={event => setAllowWeb(event.target.checked)} /><span>允许伙伴为这个目标查找公开网页<small>未开启时，不会自行扩展网页来源；你指定的网页仍作为明确材料。</small></span></label>
      {!materials.length && !allowWeb && <p className="learning-goal-material-hint">尚未指定材料。保存目标后会等待你添加材料，或允许伙伴查找公开网页。</p>}
    </fieldset>
    <fieldset><legend>学习节奏</legend><div className="learning-goal-cadence"><label>每轮间隔（现实时间）<select aria-label="学习目标间隔" value={intervalMinutes} disabled={disabled} onChange={event => setIntervalMinutes(Number(event.target.value))}>{[5, 15, 30, 60, 180, 360, 720, 1440, 10080].map(value => <option key={value} value={value}>{value < 60 ? `${value} 分钟` : value < 1440 ? `${value / 60} 小时` : `${value / 1440} 天`}</option>)}{![5, 15, 30, 60, 180, 360, 720, 1440, 10080].includes(intervalMinutes) && <option value={intervalMinutes}>{intervalMinutes} 分钟</option>}</select></label><label>时区<input aria-label="学习目标时区" value={timeZone} maxLength={100} disabled={disabled} onChange={event => setTimeZone(event.target.value)} /></label></div>
      <p>到达间隔后，在允许的时段检查激活、睡眠与用餐状态；睡眠、用餐、未激活或暂停时会等待。工作与聊天可独立并行，实际资源条件和等待原因显示在目标中。</p>
      {!windows.length && <p className="learning-goal-window-hint">未限定时段 · 按伙伴作息检查学习条件</p>}
      {windows.map((window, index) => <div className="learning-goal-window" key={index}><div><label>开始<input type="time" aria-label={`学习时段 ${index + 1} 开始`} value={minuteLabel(window.startMinute)} disabled={disabled} onChange={event => updateWindow(index, { startMinute: minuteValue(event.target.value) })} /></label><span>至</span><label>结束<input type="time" aria-label={`学习时段 ${index + 1} 结束`} value={minuteLabel(window.endMinute)} disabled={disabled} onChange={event => updateWindow(index, { endMinute: minuteValue(event.target.value) })} /></label><button type="button" disabled={disabled} aria-label={`移除学习时段 ${index + 1}`} onClick={() => setWindows(current => current.filter((_, position) => position !== index))}><Icon name="close" size={13} /></button></div><div className="learning-goal-weekdays" role="group" aria-label={`学习时段 ${index + 1} 星期`}>{dayNames.map((name, day) => <button type="button" key={day} disabled={disabled} aria-pressed={(window.days ?? []).includes(day)} aria-label={`时段 ${index + 1} 星期${name}`} onClick={() => updateWindow(index, { days: (window.days ?? []).includes(day) ? window.days!.filter(value => value !== day) : [...(window.days ?? []), day].sort() })}>{name}</button>)}</div>{window.endMinute < window.startMinute && <small>跨至次日</small>}</div>)}
      <button type="button" disabled={disabled || windows.length >= 14} onClick={() => setWindows(current => [...current, { startMinute: 540, endMinute: 1260, days: [0, 1, 2, 3, 4, 5, 6] }])}><Icon name="plus" size={13} />添加学习时段</button>
    </fieldset>
    {error && <p className="learning-goal-error" role="alert">{error}</p>}
    <footer><button type="button" disabled={disabled} onClick={onCancel}>取消</button><button className="learning-goal-primary" type="submit" disabled={disabled || !text.trim()}>{busy ? '正在保存…' : goal ? '保存调整' : '创建持续学习目标'}</button></footer>
  </form>;
}

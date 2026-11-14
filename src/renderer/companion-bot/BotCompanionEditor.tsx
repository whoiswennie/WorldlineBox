import { useRef, useState, type FormEvent } from 'react';
import type { BotCompanion, BotParticipationMode, BotResponse, WorldlineBoxBotApi } from '../../shared/companion-bot';
import { BOT_WORKER_CONCURRENCY_DEFAULT, BOT_WORKER_CONCURRENCY_MIN, BOT_WORKER_CONCURRENCY_MAX } from '../../shared/companion-bot';
import type { WorldlineBoxDshLauncherApi } from '../../shared/dsh-launcher';
import { builtinBotCompanion, DEFAULT_BOT_COMPANION_ID } from '../../shared/builtin-bot-companions';
import { BotAvatar, botAssetUrl } from './BotAvatar';
import { BotTextField } from './BotTextField';
import { BotPersonaTemplates } from './BotPersonaTemplates';
import { BotCompanionAppearance } from './BotCompanionAppearance';
import { BotCompanionPerformance } from './BotCompanionPerformance';
import { BotIcon } from './BotIcon';
import { BotCompanionDataClear } from './BotCompanionDataClear';
import { BotCompanionSchedules } from './BotCompanionSchedules';
import './bot-editor.css';

const words = {
  'zh-CN': { edit: '角色卡', add: '新伙伴', group: '新群聊', world: '世界频道', name: '名字', persona: '人格与相处方式', title: '聊天名称', members: '参与伙伴',
    mode: '群聊回应', automatic: '智能参与', all: '全体讨论', mentions: '仅点名回应', hint: '@姓名 点名，@所有人 邀请全体', reference: '形象设定',
    identity: '两种形象，同一位大肥鱼。聊天与记忆始终相连。', templates: '人格模板', basics: '基本资料', close: '关闭', templateHint: '为同一位伙伴保留不同的相处方式，聊天与记忆始终相连。', cancel: '取消', save: '保存', create: '创建', error: '操作失败，请稍后重试。' },
  en: { edit: 'Character card', add: 'New companion', group: 'New group', world: 'World channel', name: 'Name', persona: 'Personality and relationship', title: 'Chat name', members: 'Participants',
    mode: 'Group replies', automatic: 'Smart participation', all: 'Everyone', mentions: 'Mentions only', hint: '@Name to address someone · @all for everyone', reference: 'Character reference',
    identity: 'Two appearances, one companion. Your conversation and memories stay together.', templates: 'Persona templates', basics: 'Profile', close: 'Close', templateHint: 'Different ways to be together, with the same conversation and memories.', cancel: 'Cancel', save: 'Save', create: 'Create', error: 'The operation failed. Try again.' },
};
export type BotCompanionSettingsSection = 'templates' | 'basics' | 'appearance' | 'performance' | 'execution' | 'schedule';
export interface BotCompanionEditorDraft { name: string; persona?: string; members: string[]; groupMode: BotParticipationMode; workerConcurrency?: number }

/** Drafts belong to this keyed editor, never to the live 400-message workspace. */
export function BotCompanionEditor({ kind, companion, companions, locale, api, initialSection = 'templates', suspended = false, onMeet, onPersonaChanged, onSave, onCancel }: {
  kind: 'companion' | 'group' | 'world'; companion?: BotCompanion; companions: readonly BotCompanion[]; locale: keyof typeof words;
  api?: WorldlineBoxBotApi; onPersonaChanged?(): void; onSave(draft: BotCompanionEditorDraft): Promise<BotResponse>; onCancel(): void;
  launcherApi?: WorldlineBoxDshLauncherApi; initialSection?: BotCompanionSettingsSection; suspended?: boolean; onMeet?(): void; onRuntimeChanged?(): void; onOpenLauncher?(): void;
}) {
  const t = words[locale], [name, setName] = useState(companion?.name ?? ''), [persona, setPersona] = useState(companion?.persona ?? '');
  const [members, setMembers] = useState<string[]>([]), [groupMode, setGroupMode] = useState<BotParticipationMode>('automatic');
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), pending = useRef(false), composing = useRef(false);
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState<BotCompanionSettingsSection>(initialSection === 'templates' || initialSection === 'execution' ? 'basics' : initialSection === 'performance' ? 'appearance' : initialSection);
  const initialConcurrency = companion?.workerConcurrency ?? BOT_WORKER_CONCURRENCY_DEFAULT;
  const [workerConcurrency, setWorkerConcurrency] = useState(String(initialConcurrency));
  const concurrency = Number(workerConcurrency), validConcurrency = workerConcurrency.trim() !== '' && Number.isInteger(concurrency) && concurrency >= BOT_WORKER_CONCURRENCY_MIN && concurrency <= BOT_WORKER_CONCURRENCY_MAX;
  const managesPersonas = kind === 'companion' && !!companion && !!api;
  const title = kind === 'companion' ? companion ? t.edit : t.add : kind === 'world' ? t.world : t.group;
  const builtin = companion && builtinBotCompanion(companion.id);
  const references = builtin?.referenceImages ?? (builtin?.referenceImage ? [{ label: t.reference, url: builtin.referenceImage }] : []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current || composing.current || !name.trim() || kind === 'companion' && !validConcurrency || (kind !== 'companion' && !members.length)) return;
    pending.current = true; setSaving(true); setError(''); setSaved(false);
    try { const result = await onSave({ name, ...(managesPersonas ? {} : { persona }), members, groupMode, ...(kind === 'companion' && concurrency !== initialConcurrency ? { workerConcurrency: concurrency } : {}) }); if (!result.ok) setError(result.error || t.error); else setSaved(true); }
    catch { setError(t.error); }
    finally { pending.current = false; setSaving(false); }
  };
  if (managesPersonas) return <div className="bot-modal-backdrop" hidden={suspended}><div className="bot-modal bot-companion-editor has-personas" role="dialog" aria-modal="true" aria-label={`${title} · ${companion.name}`}>
    <header className="bot-editor-header"><BotAvatar companion={companion} /><div><h2>{title} · {companion.name}</h2></div><button type="button" className="bot-editor-close" onClick={onCancel} aria-label={t.close}>×</button></header>
    <nav className="bot-editor-tabs" aria-label={title}>{([
      ['basics', locale === 'zh-CN' ? '资料与人格' : 'Profile and persona', 'profile'],
      ['appearance', locale === 'zh-CN' ? '形象与表演' : 'Appearance and performance', 'image'],
      ['schedule', locale === 'zh-CN' ? '日程' : 'Schedule', 'tasks'],
    ] as const).map(([section, label, icon]) => <button type="button" key={section} className={tab === section ? 'is-active' : ''} aria-label={label} aria-pressed={tab === section} onClick={() => setTab(section)}><BotIcon name={icon} />{label}</button>)}</nav>
    <div className="bot-editor-tabpanel bot-editor-profile" hidden={tab !== 'basics'}>
      <details className="bot-editor-personas" open={initialSection === 'templates' || undefined}><summary>{t.templates}</summary><BotPersonaTemplates api={api} companionId={companion.id} locale={locale} onChanged={onPersonaChanged} /></details>
    <form className="bot-editor-basics" onSubmit={event => void submit(event)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}>
      <header className="bot-settings-section-heading"><h3>{t.basics}</h3></header>
      <label>{t.name}<input name="name" value={name} maxLength={80} onChange={event => { setName(event.target.value); setSaved(false); }} disabled={saving} required /></label>
      {!!references.length && <details className="bot-character-reference"><summary>{t.reference}</summary>{references.map(reference => <figure key={reference.url}><figcaption>{reference.label}</figcaption><img alt={`${companion.name} · ${reference.label}`} src={botAssetUrl(reference.url)} loading="lazy" /></figure>)}</details>}
      <details className="bot-editor-advanced" open={initialSection === 'execution' || undefined}><summary>{locale === 'zh-CN' ? '任务执行' : 'Task execution'}</summary>
      <div className="bot-settings-card"><h4>{locale === 'zh-CN' ? 'Worker 并发' : 'Worker concurrency'}</h4><label className="bot-settings-field">{locale === 'zh-CN' ? '同时执行的任务数' : 'Concurrent tasks'}<input name="workerConcurrency" type="number" min={BOT_WORKER_CONCURRENCY_MIN} max={BOT_WORKER_CONCURRENCY_MAX} step="1" value={workerConcurrency} disabled={saving} aria-invalid={!validConcurrency} aria-describedby="bot-concurrency-hint" onChange={event => { setWorkerConcurrency(event.target.value); setSaved(false); }} /></label><p id="bot-concurrency-hint">{locale === 'zh-CN' ? `默认 ${BOT_WORKER_CONCURRENCY_DEFAULT} 项，可设置 ${BOT_WORKER_CONCURRENCY_MIN}–${BOT_WORKER_CONCURRENCY_MAX} 项。保存后用于后续任务调度，正在执行的任务会继续。` : `Default ${BOT_WORKER_CONCURRENCY_DEFAULT}; choose ${BOT_WORKER_CONCURRENCY_MIN}–${BOT_WORKER_CONCURRENCY_MAX}. Applies to subsequent scheduling after saving; running tasks continue.`}</p>{!validConcurrency && <p className="bot-error" role="alert">{locale === 'zh-CN' ? '请输入有效范围内的整数。' : 'Enter an integer within the allowed range.'}</p>}</div>
      </details>
      <BotCompanionDataClear api={api} companionId={companion.id} name={companion.name} locale={locale} onChanged={onPersonaChanged} />
      {error && <p className="bot-error" role="alert">{error}</p>}
      {saved && <p className="bot-settings-saved" role="status">{locale === 'zh-CN' ? '资料与任务设置已保存。' : 'Profile and task settings saved.'}</p>}
      <footer><button type="submit" className="bot-editor-primary" disabled={saving || !name.trim() || !validConcurrency}>{saving ? locale === 'zh-CN' ? '正在保存…' : 'Saving…' : t.save}</button></footer>
    </form>
    </div>
    {tab === 'appearance' && <div className="bot-editor-tabpanel bot-editor-meeting"><BotCompanionAppearance companion={companion} locale={locale} active={!suspended} onMeet={onMeet} /><BotCompanionPerformance api={api} companionId={companion.id} locale={locale} /></div>}
    {tab === 'schedule' && <div className="bot-editor-tabpanel"><BotCompanionSchedules api={api} companionId={companion.id} locale={locale} /></div>}
  </div></div>;
  return <div className="bot-modal-backdrop"><form className="bot-modal bot-companion-editor" onSubmit={event => void submit(event)} role="dialog" aria-modal="true" aria-label={title}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}>
    <h2>{title}</h2>
    {companion && builtin && <div className="bot-profile-preview"><BotAvatar companion={companion} large /><div><strong>{companion.name}</strong><p>{builtin.summary}</p>{companion.id === DEFAULT_BOT_COMPANION_ID && <small>{t.identity}</small>}</div></div>}
    <label>{kind === 'companion' ? t.name : t.title}<input autoFocus name="name" value={name} maxLength={80} onChange={event => setName(event.target.value)} disabled={saving} required /></label>
    {kind === 'companion' ? <BotTextField label={t.persona} name="persona" value={persona} onChange={event => setPersona(event.target.value)} maxLength={24000} minRows={10} showCount disabled={saving} />
      : <fieldset disabled={saving}><legend>{t.members}</legend>{companions.map(item => <label key={item.id}><input type="checkbox" checked={members.includes(item.id)} onChange={event => setMembers(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} />{item.name}</label>)}</fieldset>}
    {kind === 'group' && <label>{t.mode}<select value={groupMode} disabled={saving} onChange={event => setGroupMode(event.target.value as BotParticipationMode)}>
      <option value="automatic">{t.automatic}</option><option value="all">{t.all}</option><option value="mentions">{t.mentions}</option>
    </select><small>{t.hint}</small></label>}
    {!!references.length && <details className="bot-character-reference"><summary>{t.reference}</summary>{references.map(reference => <figure key={reference.url}><figcaption>{reference.label}</figcaption><img alt={`${companion?.name} · ${reference.label}`} src={botAssetUrl(reference.url)} /></figure>)}</details>}
    {error && <p className="bot-error" role="alert">{error}</p>}
    <footer><button type="button" onClick={onCancel}>{t.cancel}</button><button type="submit" className="bot-editor-primary" disabled={saving || !name.trim() || (kind !== 'companion' && !members.length)}>{companion ? t.save : t.create}</button></footer>
  </form></div>;
}

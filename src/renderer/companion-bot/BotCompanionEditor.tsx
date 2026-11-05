import { useRef, useState, type FormEvent } from 'react';
import type { BotCompanion, BotParticipationMode, BotResponse, WorldlineBoxBotApi } from '../../shared/companion-bot';
import { builtinBotCompanion, DEFAULT_BOT_COMPANION_ID } from '../../shared/builtin-bot-companions';
import { BotAvatar, botAssetUrl } from './BotAvatar';
import { BotTextField } from './BotTextField';
import { BotPersonaTemplates } from './BotPersonaTemplates';
import './bot-editor.css';

const words = {
  'zh-CN': { edit: '编辑伙伴', add: '新伙伴', group: '新群聊', world: '世界频道', name: '名字', persona: '人格与相处方式', title: '聊天名称', members: '参与伙伴',
    mode: '群聊回应', automatic: '智能参与', all: '全体讨论', mentions: '仅点名回应', hint: '@姓名 点名，@所有人 邀请全体', reference: '形象设定',
    identity: '两种形象，同一位大肥鱼。聊天与记忆始终相连。', templates: '人格模板', basics: '基本资料', close: '关闭', templateHint: '为同一位伙伴保留不同的相处方式，聊天与记忆始终相连。', cancel: '取消', save: '保存', create: '创建', error: '操作失败，请稍后重试。' },
  en: { edit: 'Edit companion', add: 'New companion', group: 'New group', world: 'World channel', name: 'Name', persona: 'Personality and relationship', title: 'Chat name', members: 'Participants',
    mode: 'Group replies', automatic: 'Smart participation', all: 'Everyone', mentions: 'Mentions only', hint: '@Name to address someone · @all for everyone', reference: 'Character reference',
    identity: 'Two appearances, one companion. Your conversation and memories stay together.', templates: 'Persona templates', basics: 'Profile', close: 'Close', templateHint: 'Different ways to be together, with the same conversation and memories.', cancel: 'Cancel', save: 'Save', create: 'Create', error: 'The operation failed. Try again.' },
};
export interface BotCompanionEditorDraft { name: string; persona?: string; members: string[]; groupMode: BotParticipationMode }

/** Drafts belong to this keyed editor, never to the live 400-message workspace. */
export function BotCompanionEditor({ kind, companion, companions, locale, api, onPersonaChanged, onSave, onCancel }: {
  kind: 'companion' | 'group' | 'world'; companion?: BotCompanion; companions: readonly BotCompanion[]; locale: keyof typeof words;
  api?: WorldlineBoxBotApi; onPersonaChanged?(): void; onSave(draft: BotCompanionEditorDraft): Promise<BotResponse>; onCancel(): void;
}) {
  const t = words[locale], [name, setName] = useState(companion?.name ?? ''), [persona, setPersona] = useState(companion?.persona ?? '');
  const [members, setMembers] = useState<string[]>([]), [groupMode, setGroupMode] = useState<BotParticipationMode>('automatic');
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), pending = useRef(false), composing = useRef(false);
  const [tab, setTab] = useState<'templates' | 'basics'>('templates');
  const managesPersonas = kind === 'companion' && !!companion && !!api;
  const title = kind === 'companion' ? companion ? t.edit : t.add : kind === 'world' ? t.world : t.group;
  const builtin = companion && builtinBotCompanion(companion.id);
  const references = builtin?.referenceImages ?? (builtin?.referenceImage ? [{ label: t.reference, url: builtin.referenceImage }] : []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current || composing.current || !name.trim() || (kind !== 'companion' && !members.length)) return;
    pending.current = true; setSaving(true); setError('');
    try { const result = await onSave({ name, ...(managesPersonas ? {} : { persona }), members, groupMode }); if (!result.ok) setError(result.error || t.error); }
    catch { setError(t.error); }
    finally { pending.current = false; setSaving(false); }
  };
  if (managesPersonas) return <div className="bot-modal-backdrop"><div className="bot-modal bot-companion-editor has-personas" role="dialog" aria-modal="true" aria-label={`${title} · ${companion.name}`}>
    <header className="bot-editor-header"><BotAvatar companion={companion} /><div><h2>{title} · {companion.name}</h2><p>{t.templateHint}</p></div><button type="button" className="bot-editor-close" onClick={onCancel} aria-label={t.close}>×</button></header>
    <nav className="bot-editor-tabs" aria-label={title}><button type="button" className={tab === 'templates' ? 'is-active' : ''} aria-pressed={tab === 'templates'} onClick={() => setTab('templates')}>{t.templates}</button><button type="button" className={tab === 'basics' ? 'is-active' : ''} aria-pressed={tab === 'basics'} onClick={() => setTab('basics')}>{t.basics}</button></nav>
    <div className="bot-editor-tabpanel" hidden={tab !== 'templates'}><BotPersonaTemplates api={api} companionId={companion.id} locale={locale} onChanged={onPersonaChanged} /></div>
    <form className="bot-editor-basics" hidden={tab !== 'basics'} onSubmit={event => void submit(event)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}>
      {builtin && <div className="bot-profile-preview"><BotAvatar companion={companion} large /><div><strong>{companion.name}</strong><p>{builtin.summary}</p>{companion.id === DEFAULT_BOT_COMPANION_ID && <small>{t.identity}</small>}</div></div>}
      <label>{t.name}<input name="name" value={name} maxLength={80} onChange={event => setName(event.target.value)} disabled={saving} required /></label>
      {!!references.length && <details className="bot-character-reference"><summary>{t.reference}</summary>{references.map(reference => <figure key={reference.url}><figcaption>{reference.label}</figcaption><img alt={`${companion.name} · ${reference.label}`} src={botAssetUrl(reference.url)} loading="lazy" /></figure>)}</details>}
      {error && <p className="bot-error" role="alert">{error}</p>}
      <footer><button type="button" onClick={onCancel}>{t.close}</button><button type="submit" className="bot-editor-primary" disabled={saving || !name.trim()}>{t.save}</button></footer>
    </form>
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

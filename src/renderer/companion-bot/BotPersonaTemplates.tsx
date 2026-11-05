import { useEffect, useRef, useState } from 'react';
import type { BotResponse, WorldlineBoxBotApi } from '../../shared/companion-bot';
import { BotIcon } from './BotIcon';
import { BotTextField } from './BotTextField';
import './bot-persona-templates.css';

type PersonaList = NonNullable<BotResponse['personas']>;
type Persona = NonNullable<BotResponse['persona']>;
type Draft = { name: string; prompt: string };
const NEW_TEMPLATE = '__new__';
const copy = {
  'zh-CN': {
    title: '人格模板', add: '新建模板', search: '搜索人格模板', builtin: '内置', custom: '自建', active: '使用中', default: '默认', modified: '已修改',
    loading: '正在读取人格模板…', loadingPrompt: '正在读取完整设定…', empty: '没有匹配的模板', name: '模板名称', prompt: '人格与相处方式',
    draft: '未保存的草稿', saved: '已保存', activateHint: '点击左侧模板即可切换，下一条新消息生效。',
    currentHint: '正在使用已保存版本；编辑区的修改需要保存后才会生效。', otherHint: '此模板尚未启用；保存只更新模板，也可以单独启用。', newHint: '为新模板命名并写下设定，保存后即可启用。',
    continuity: '切换人格保留聊天与记忆；正在进行的回复和任务不会被改写。',
    save: '保存并启用', saveChanges: '保存修改', edit: '编辑', activate: '启用此模板', saving: '正在保存…', applying: '正在切换…', restored: '已恢复并启用原始设定。', applied: '已切换，下一条新消息生效。',
    savedHint: '已保存并启用，下一条新消息生效。', savedInactive: '已保存，当前使用的人格未改变。', appliedSaved: '已启用模板的已保存版本；编辑区草稿尚未保存。', delete: '删除模板', confirmDelete: '确认删除', cancel: '保留模板',
    deleteHint: '自建模板删除后无法恢复；内置模板可从“恢复全部内置模板”找回。删除正在使用的模板会切回默认人格。',
    restore: '恢复原始设定', restoreAll: '恢复全部内置模板', restoreAllHint: '恢复整套内置设定并启用默认人格；保留自建模板。',
    confirmRestore: '确认恢复', cancelRestore: '取消恢复', error: '操作失败，请稍后重试。', retry: '重新读取',
    chars: '字', limit: '模板', close: '关闭', newName: '新的人格', countHint: '最多 64 份模板',
  },
  en: {
    title: 'Persona templates', add: 'New template', search: 'Search persona templates', builtin: 'Built-in', custom: 'Custom', active: 'Active', default: 'Default', modified: 'Modified',
    loading: 'Loading persona templates…', loadingPrompt: 'Loading the full persona…', empty: 'No matching templates', name: 'Template name', prompt: 'Personality and relationship',
    draft: 'Unsaved draft', saved: 'Saved', activateHint: 'Select a template to apply it to the next new message.',
    currentHint: 'The saved version is active. Save editor changes before they can take effect.', otherHint: 'This template is inactive. Saving changes does not activate it.', newHint: 'Name this template and add its persona, then save to activate it.',
    continuity: 'Switching preserves chat and memory. Replies and tasks already in progress keep their original settings.',
    save: 'Save and activate', saveChanges: 'Save changes', edit: 'Edit', activate: 'Activate template', saving: 'Saving…', applying: 'Switching…', restored: 'Original persona restored and activated.', applied: 'Switched. Applies to the next new message.',
    savedHint: 'Saved and activated for the next new message.', savedInactive: 'Saved. The active persona has not changed.', appliedSaved: 'The saved version is active. The draft in the editor is still unsaved.', delete: 'Delete template', confirmDelete: 'Confirm deletion', cancel: 'Keep template',
    deleteHint: 'Deleted custom templates cannot be recovered. Built-ins can be restored from the library. Deleting the active template restores the default persona.',
    restore: 'Restore original persona', restoreAll: 'Restore all built-ins', restoreAllHint: 'Restore all built-ins and activate the default persona. Keep custom templates.',
    confirmRestore: 'Restore templates', cancelRestore: 'Cancel', error: 'The operation failed. Try again.', retry: 'Reload',
    chars: 'characters', limit: 'templates', close: 'Close', newName: 'New persona', countHint: 'Up to 64 templates',
  },
};

/** Only the selected prompt is loaded. Text drafts stay here, away from the
 * live transcript; changing a character does not re-render its messages. */
export function BotPersonaTemplates({ api, companionId, locale, onChanged }: {
  api: WorldlineBoxBotApi; companionId: string; locale: keyof typeof copy; onChanged?(): void;
}) {
  const t = copy[locale];
  const [list, setList] = useState<PersonaList>(), [selected, setSelected] = useState(''), [detail, setDetail] = useState<Persona>();
  const [drafts, setDrafts] = useState<Record<string, Draft>>({}), [query, setQuery] = useState('');
  const [busy, setBusy] = useState<'loading' | 'activating' | 'saving' | 'deleting' | 'restoring' | null>('loading');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [confirm, setConfirm] = useState<'delete' | 'restore-all' | null>(null);
  const alive = useRef(false), pending = useRef(false), generation = useRef(0), composing = useRef(false);
  const selectedItem = list?.items.find(item => item.id === selected);
  const draft = drafts[selected] ?? (detail?.id === selected ? { name: detail.name, prompt: detail.prompt } : undefined);
  const dirty = selected === NEW_TEMPLATE || !!draft && !!detail && (draft.name !== detail.name || draft.prompt !== detail.prompt);
  const canSave = !!draft?.name.trim() && !!draft.prompt.trim() && !busy && dirty;
  const updateDraft = (field: keyof Draft, value: string) => {
    if (!draft) return;
    setDrafts(current => ({ ...current, [selected]: { ...draft, [field]: value } })); setNotice(''); setConfirm(null);
  };
  const accept = (result: BotResponse, id?: string) => {
    if (!result.ok) throw new Error(result.error || t.error);
    if (result.personas) setList(result.personas);
    if (result.persona) { setDetail(result.persona); setSelected(result.persona.id); }
    else if (id) setSelected(id);
  };
  const load = async () => {
    if (pending.current) return;
    pending.current = true; const token = ++generation.current; setBusy('loading'); setError('');
    try {
      const result = await api.request({ type: 'companion.personas.list', companionId });
      if (!alive.current || token !== generation.current) return;
      if (!result.ok || !result.personas) throw new Error(result.error || t.error);
      setList(result.personas); setSelected(result.personas.activeId);
      const full = await api.request({ type: 'companion.personas.get', companionId, id: result.personas.activeId });
      if (!alive.current || token !== generation.current) return;
      accept(full);
    } catch (reason) { if (alive.current && token === generation.current) setError(reason instanceof Error ? reason.message : t.error); }
    finally { if (alive.current && token === generation.current) { pending.current = false; setBusy(null); } }
  };
  useEffect(() => {
    alive.current = true;
    // Subscribe after mount; the initial loading state is already rendered.
    void Promise.resolve().then(() => { if (alive.current) return load(); });
    const lifecycle = generation;
    return () => { alive.current = false; ++lifecycle.current; pending.current = false; };
    // The parent keys the editor by companion. Drafts never follow another owner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, companionId]);

  const perform = async (kind: NonNullable<typeof busy>, request: Parameters<WorldlineBoxBotApi['request']>[0], success: string, clearDraft?: string) => {
    if (pending.current || kind === 'saving' && composing.current) return;
    pending.current = true; const token = ++generation.current; setBusy(kind); setError(''); setNotice(''); setConfirm(null);
    try {
      const result = await api.request(request);
      if (!alive.current || token !== generation.current) return;
      accept(result);
      if (clearDraft) setDrafts(current => {
        const next = { ...current };
        if (clearDraft === '*builtin*') for (const item of [...list?.items ?? [], ...result.personas?.items ?? []]) { if (item.builtin || item.isDefault) delete next[item.id]; }
        else delete next[clearDraft];
        return next;
      });
      if (request.type !== 'companion.personas.get') onChanged?.();
      if (!result.persona && result.personas) {
        const full = await api.request({ type: 'companion.personas.get', companionId, id: result.personas.activeId });
        if (!alive.current || token !== generation.current) return;
        accept(full);
      }
      setNotice(success);
    } catch (reason) { if (alive.current && token === generation.current) setError(reason instanceof Error ? reason.message : t.error); }
    finally { if (alive.current && token === generation.current) { pending.current = false; setBusy(null); } }
  };
  const select = (id: string) => {
    if (id === list?.activeId && id === selected || pending.current) return;
    void perform('activating', { type: 'companion.personas.activate', companionId, id }, drafts[id] ? t.appliedSaved : t.applied);
  };
  const add = () => {
    if (pending.current || !list || list.items.length >= list.limit) return;
    setSelected(NEW_TEMPLATE); setDetail(undefined); setConfirm(null); setError(''); setNotice('');
    setDrafts(current => current[NEW_TEMPLATE] ? current : { ...current, [NEW_TEMPLATE]: { name: t.newName, prompt: '' } });
  };
  const items = list?.items.filter(item => item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
  return <section className="bot-personas" aria-label={t.title} aria-busy={!!busy} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}>
    <aside className="bot-personas__sidebar">
      <div className="bot-personas__list-heading"><strong>{t.title}</strong><span>{list ? `${list.items.length} / ${list.limit}` : '—'}</span>
        <button type="button" className="bot-personas__add" aria-label={t.add} title={t.add} onClick={add} disabled={!!busy || !list || list.items.length >= list.limit}><BotIcon name="plus" /></button></div>
      <label className="bot-personas__search"><BotIcon name="search" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t.search} aria-label={t.search} /></label>
      <div className="bot-personas__list" aria-label={t.title}>
        {selected === NEW_TEMPLATE && <button type="button" className="bot-personas__item is-selected" aria-current="true"><span className="bot-personas__mark"><BotIcon name="plus" /></span><span><strong>{draft?.name || t.newName}</strong><small>{t.draft}</small></span></button>}
        {items.map(item => <div key={item.id} className={`bot-personas__row${item.id === selected ? ' is-selected' : ''}`}>
          <button type="button" className="bot-personas__item" aria-current={item.id === selected ? 'true' : undefined}
            aria-label={`${item.name}${item.id === list?.activeId ? ` · ${t.active}` : ''}`} onClick={() => select(item.id)} disabled={!!busy}>
            <span className="bot-personas__mark"><BotIcon name={item.builtin ? 'profile' : 'file'} /></span><span><strong>{item.name}</strong>
              <small>{item.builtin ? t.builtin : t.custom}{item.isDefault ? ` · ${t.default}` : ''}{item.modified ? ` · ${t.modified}` : ''} · {new Intl.NumberFormat(locale).format(item.charCount)} {t.chars}</small></span>
            {item.id === list?.activeId && <span className="bot-personas__active" title={t.active} aria-hidden="true">✓</span>}
          </button><button type="button" className="bot-personas__edit" aria-label={`${t.edit} ${item.name}`} title={`${t.edit} ${item.name}`} disabled={!!busy}
            onClick={() => void perform('loading', { type: 'companion.personas.get', companionId, id: item.id }, '')}><BotIcon name="settings" /></button>
        </div>)}
        {!items.length && busy !== 'loading' && <p className="bot-personas__empty">{t.empty}</p>}
        {busy === 'loading' && !list && <p className="bot-personas__empty" role="status">{t.loading}</p>}
      </div>
      <div className="bot-personas__library-footer"><p>{t.activateHint}</p><button type="button" onClick={() => { setConfirm('restore-all'); setNotice(''); }} disabled={!!busy || !list}><BotIcon name="history" />{t.restoreAll}</button></div>
    </aside>
    <div className="bot-personas__editor">
      <header className="bot-personas__editor-heading"><div><span className="bot-personas__eyebrow">{selectedItem?.builtin ? t.builtin : t.custom}</span><h3>{draft?.name || t.title}</h3></div>
        <span className={`bot-personas__state${dirty ? ' is-draft' : ''}`}>{busy === 'activating' ? t.applying : dirty ? t.draft : t.saved}</span></header>
      <div className="bot-personas__feedback" aria-live="polite">
        {error ? <div className="bot-personas__error" role="alert"><span>{error}</span>{!detail && <button type="button" onClick={() => void load()} disabled={!!busy}>{t.retry}</button>}</div>
          : confirm === 'delete' ? <div className="bot-personas__confirmation"><p>{t.deleteHint}</p><button type="button" className="is-danger" onClick={() => void perform('deleting', { type: 'companion.personas.delete', companionId, id: selected }, t.applied, selected)}>{t.confirmDelete}</button><button type="button" onClick={() => setConfirm(null)}>{t.cancel}</button></div>
            : confirm === 'restore-all' ? <div className="bot-personas__confirmation"><p>{t.restoreAllHint}</p><button type="button" className="bot-editor-primary" onClick={() => void perform('restoring', { type: 'companion.personas.restore', companionId }, t.restored, '*builtin*')}>{t.confirmRestore}</button><button type="button" onClick={() => setConfirm(null)}>{t.cancelRestore}</button></div>
              : <p className={notice ? 'is-success' : ''} role="status">{notice || (selected === NEW_TEMPLATE ? t.newHint : selected === list?.activeId ? t.currentHint : t.otherHint)}</p>}
      </div>
      {draft ? <div className="bot-personas__fields">
        <label className="bot-personas__name">{t.name}<input name="templateName" value={draft.name} onChange={event => updateDraft('name', event.target.value)} maxLength={80} disabled={!!busy} /></label>
        <BotTextField label={t.prompt} name="persona" value={draft.prompt} onChange={event => updateDraft('prompt', event.target.value)} maxLength={24000} minRows={12} showCount disabled={!!busy} />
      </div> : <div className="bot-personas__placeholder" role="status"><BotIcon name="profile" /><p>{t.loadingPrompt}</p></div>}
      <div className="bot-personas__editor-footer"><p>{t.continuity}</p><div>
        {(selectedItem?.builtin || selectedItem?.isDefault) && <button type="button" onClick={() => void perform('restoring', { type: 'companion.personas.restore', companionId, id: selected }, t.restored, selected)} disabled={!!busy || !selectedItem.modified && !dirty}><BotIcon name="history" />{t.restore}</button>}
        {selectedItem && !selectedItem.isDefault && <button type="button" className="is-danger" onClick={() => { setConfirm('delete'); setNotice(''); }} disabled={!!busy}><BotIcon name="file" />{t.delete}</button>}
        {selectedItem && selected !== list?.activeId && <button type="button" onClick={() => select(selected)} disabled={!!busy}>{t.activate}</button>}
        <button type="button" className="bot-editor-primary" onClick={() => draft && void perform('saving', { type: 'companion.personas.save', companionId, ...(selected !== NEW_TEMPLATE ? { id: selected } : {}), name: draft.name, prompt: draft.prompt, activate: selected === NEW_TEMPLATE }, selected === NEW_TEMPLATE || selected === list?.activeId ? t.savedHint : t.savedInactive, selected)} disabled={!canSave}>{busy === 'saving' ? t.saving : selected === NEW_TEMPLATE ? t.save : t.saveChanges}</button>
      </div></div>
    </div>
  </section>;
}

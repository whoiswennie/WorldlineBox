import { useRef, useState, type ReactNode } from 'react';
import type { Companion, CompanionAttachment, CompanionConversation, CompanionDraft, CompanionMessage, CompanionsRequest, CompanionsResponse } from '../../shared/companions';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { Avatar, companionAppearance } from './CompanionVisuals';
import { PublicAppearanceSheet } from './PublicAppearanceSheet';
import { AvatarCropDialog } from './AvatarCropDialog';
import { companionGroupTitle } from '../../shared/companion-titles';
import { builtinCompanionProfile, BUILTIN_COMPANION_PROFILES } from '../../shared/companion-catalogue';

export type CompanionRequest = (input: CompanionsRequest) => Promise<CompanionsResponse | undefined>;
export type CompanionDialog =
  | { kind: 'chat' }
  | { kind: 'companion'; companion?: Companion }
  | { kind: 'group'; conversation?: CompanionConversation }
  | { kind: 'action'; message: CompanionMessage; conversation: CompanionConversation }
  | { kind: 'delete'; companion: Companion }
  | { kind: 'delete-conversation'; conversation: CompanionConversation; mode: 'hide' | 'dissolve' };

function Modal({ title, children, onClose, busy, catalogue = false }: { title: string; children: ReactNode; onClose: () => void; busy: boolean; catalogue?: boolean }) {
  useDialogFocusTrap(true, title);
  return <div className="companions-modal-backdrop" onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); } }}>
    <section className={`companions-modal${catalogue ? ' is-catalogue' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><button type="button" className="companion-icon-button" aria-label="关闭弹窗" onClick={onClose} disabled={busy}>×</button></header>
      {children}
    </section>
  </div>;
}

export function CompanionDialogs({ dialog, companions, request, onClose, onOpen, onCreated, builtins, requestError }: {
  dialog: CompanionDialog; companions: Companion[]; request: CompanionRequest; onClose: () => void;
  onOpen: (companionId: string) => void; onCreated: (conversation: CompanionConversation) => void;
  builtins: readonly (CompanionDraft & { id: string })[];
  requestError?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cropSource, setCropSource] = useState<CompanionAttachment>();
  const avatarTrigger = useRef<HTMLButtonElement>(null);
  const [dissolving, setDissolving] = useState(false);
  const [tab, setTab] = useState<'builtin' | 'custom'>(dialog.kind === 'companion' && dialog.companion ? 'custom' : 'builtin');
  const [catalogueQuery, setCatalogueQuery] = useState('');
  const [catalogueCategory, setCatalogueCategory] = useState('全部');
  const initial = dialog.kind === 'companion' ? dialog.companion : undefined;
  const [draft, setDraft] = useState<CompanionDraft>(() => ({ name: initial?.name ?? '', description: initial?.description ?? '', persona: initial?.persona ?? '', model: '', avatar: initial?.avatar ?? 'custom', proactive: initial?.proactive ?? true, ...(initial?.avatarAttachmentId ? { avatarAttachmentId: initial.avatarAttachmentId } : {}), ...(initial?.appearanceAttachmentId ? { appearanceAttachmentId: initial.appearanceAttachmentId } : {}) }));
  const [connectionMode, setConnectionMode] = useState<'global' | 'independent'>(initial?.llm ? 'independent' : 'global');
  const [connection, setConnection] = useState<NonNullable<CompanionDraft['llm']>>(() => ({ apiFormat: initial?.llm?.apiFormat ?? 'openai_chat', baseUrl: initial?.llm?.baseUrl ?? '', model: initial?.llm?.model ?? '' }));
  const [apiKey, setApiKey] = useState('');
  const group = dialog.kind === 'group' ? dialog.conversation : undefined;
  const [title, setTitle] = useState(group?.title ?? '');
  const [members, setMembers] = useState<string[]>(group?.memberIds ?? []);
  const [actionOwner, setActionOwner] = useState(dialog.kind === 'action' ? dialog.conversation.memberIds[0] ?? '' : '');
  const [actionPrompt, setActionPrompt] = useState(dialog.kind === 'action' ? dialog.message.content : '');
  const [actionTitle, setActionTitle] = useState(dialog.kind === 'action' ? dialog.message.content.slice(0, 50) || '处理这条消息的附件' : '');
  async function submit(input: CompanionsRequest) {
    setBusy(true); setError('');
    const response = await request(input);
    setBusy(false);
    if (!response) { setError('request'); return; }
    if (response.conversation) onCreated(response.conversation);
    onClose();
  }
  async function chooseAvatar() {
    setError(''); setBusy(true);
    try {
      const response = await request({ type: 'attachment.pick', kind: 'image', purpose: 'avatar' });
      if (!response?.ok) { setError(response?.error || '头像未能选取，请重试。'); return; }
      const image = response.attachments?.[0]; if (!image) return;
      if (!image.mime.startsWith('image/')) { setError('请选择图片文件作为头像。'); return; }
      setCropSource(image);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '头像未能选取，请重试。'); }
    finally { setBusy(false); }
  }
  async function chooseAppearance() {
    setError(''); setBusy(true);
    try { const response = await request({ type: 'attachment.pick', kind: 'image', purpose: 'appearance' });
      if (!response) { setError('request'); return; }
      const image = response.attachments?.[0]; if (!image) return;
      if (!image.mime.startsWith('image/')) { setError('请选择图片文件作为三视图。'); return; }
      setDraft(current => ({ ...current, appearanceAttachmentId: image.id }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : '图片未能选取，请重试。'); }
    finally { setBusy(false); }
  }
  const modalTitle = dialog.kind === 'chat' ? '发起聊天' : dialog.kind === 'companion' ? (initial ? '编辑伙伴资料' : '添加联系人') : dialog.kind === 'group' ? (group ? '管理群聊' : '创建群聊') : dialog.kind === 'action' ? '交给伙伴处理' : dialog.kind === 'delete-conversation' ? (dialog.mode === 'dissolve' ? '解散群聊' : '删除聊天') : '移除联系人';
  const visibleBuiltins = builtins.filter(item => {
    const profile = builtinCompanionProfile(item.id);
    return (catalogueCategory === '全部' || profile?.category === catalogueCategory)
      && `${item.name} ${item.description} ${profile?.introduction ?? ''} ${item.id}`.toLowerCase().includes(catalogueQuery.trim().toLowerCase());
  });
  return <Modal title={modalTitle} onClose={onClose} busy={busy} catalogue={dialog.kind === 'companion' && !initial && tab === 'builtin'}>
    {dialog.kind === 'chat' && <div className="companions-form"><p className="companions-subtle">选一位联系人开始私聊，或勾选多位伙伴创建群聊。</p><input aria-label="选择聊天联系人" placeholder="搜索联系人…" value={catalogueQuery} onChange={event => setCatalogueQuery(event.target.value)} /><div className="companions-start-chat-list">{companions.filter(role => `${role.name} ${role.description}`.toLowerCase().includes(catalogueQuery.toLowerCase())).map(role => <div key={role.id}><input type="checkbox" aria-label={`选择 ${role.name}`} checked={members.includes(role.id)} onChange={event => setMembers(event.target.checked ? [...members, role.id] : members.filter(id => id !== role.id))} /><button disabled={busy} onClick={() => { onOpen(role.id); onClose(); }}><Avatar companion={role} /><span><strong>{role.name}</strong><small>{role.description}</small></span></button></div>)}</div><footer><button className="companion-secondary-button" onClick={onClose}>取消</button><button className="companion-primary-button" disabled={busy || !members.length} onClick={() => members.length === 1 ? (onOpen(members[0]!), onClose()) : void submit({ type: 'conversation.create-group', title: '', memberIds: members })}>{members.length > 1 ? `创建群聊（${members.length + 1}人）` : '开始聊天'}</button></footer></div>}
    {dialog.kind === 'companion' && <>
      {!initial && <div className="companions-dialog-tabs" role="tablist" aria-label="角色来源"><button role="tab" aria-selected={tab === 'builtin'} onClick={() => setTab('builtin')}>内置角色</button><button role="tab" aria-selected={tab === 'custom'} onClick={() => setTab('custom')}>自定义角色</button></div>}
      {tab === 'builtin' && !initial ? <div className="companions-builtin-picker">
        <div className="companions-catalogue-intro"><p>认识一位新的伙伴</p><span>各自的性格，各自的记忆。以后随时都能接着聊。</span></div>
        <input className="companions-catalogue-search" aria-label="搜索内置角色" placeholder="搜索名字、性格或兴趣…" value={catalogueQuery} onChange={event => setCatalogueQuery(event.target.value)} />
        <div className="companions-catalogue-categories" role="group" aria-label="角色分类">{['全部', 'AI 拟人', '原创角色', '社区伙伴'].map(category => <button key={category} type="button" aria-pressed={catalogueCategory === category} onClick={() => setCatalogueCategory(category)}>{category}</button>)}<span>{visibleBuiltins.length} 位伙伴</span></div>
        <div className="companions-catalogue-grid">{visibleBuiltins.map(item => {
          const existing = companions.find(companion => companion.id === item.id && companion.builtin);
          const profile = builtinCompanionProfile(item.id)!;
          return <article className="companions-builtin-card" key={item.id} data-builtin-template={profile.templateId}><div className="companions-builtin-card-identity"><Avatar companion={item} large /><div><h3>{item.name}</h3><span>{profile.category}</span></div></div><p>{profile.introduction}</p><footer><span>{existing ? '已在联系人中' : item.description}</span>
            <button className={existing ? 'companion-secondary-button' : 'companion-primary-button'} disabled={busy} onClick={() => {
              if (existing) { onOpen(existing.id); onClose(); }
              else void submit({ type: 'companion.add-builtin', templateId: profile.templateId });
            }}>{existing ? '已添加 · 打开' : '添加'}</button>
            </footer>
          </article>;
        })}</div>
        {!visibleBuiltins.length && <p className="companions-catalogue-empty">没有找到符合条件的伙伴，试试其他名字或分类。</p>}
        <p className="companions-subtle">默认使用全局 LLM 服务，名字和人设不绑定模型。添加后可在资料中单独配置连接。</p>
      </div> : <form className="companions-form" onSubmit={event => {
        event.preventDefault();
        const companion: CompanionDraft = { ...draft, model: '', ...(connectionMode === 'independent' ? { llm: connection } : {}) };
        const credential = apiKey.trim() && connectionMode === 'independent' ? { apiKey: apiKey.trim() } : {};
        void submit(initial ? { type: 'companion.update', id: initial.id, expectedRevision: initial.revision, companion, ...credential } : { type: 'companion.create', companion, ...credential });
      }}>
        <label>名字<input data-dialog-initial-focus="true" required maxLength={60} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="她希望你如何称呼她？" /></label>
        <div className="companions-avatar-editor"><Avatar companion={draft} large /><div><button ref={avatarTrigger} type="button" className="companion-secondary-button" disabled={busy} onClick={() => void chooseAvatar()}>选择本地头像</button><button type="button" className="companions-avatar-reset" disabled={busy} onClick={() => setDraft({ ...draft, avatar: 'custom', avatarAttachmentId: undefined })}>恢复名字头像</button><p className="companions-subtle">选择一张图片，作为她在聊天中的头像。</p></div></div>
        <PublicAppearanceSheet attachmentId={draft.appearanceAttachmentId} fallbackSource={companionAppearance({ ...draft, id: initial?.id, builtin: initial?.builtin })} name={draft.name || '伙伴'} description="一张正面、侧面、背面的标准设定板，作为这位伙伴的公开形象资料。上传的图片优先于内置形象。" disabled={busy} onChoose={() => void chooseAppearance()} onRemove={() => setDraft(current => ({ ...current, appearanceAttachmentId: undefined }))} />
        <label>个性签名<input maxLength={500} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} placeholder="显示在联系人资料中的一句话" /></label>
        <label>人设<textarea required rows={5} maxLength={12000} value={draft.persona} onChange={event => setDraft({ ...draft, persona: event.target.value })} placeholder="身份、性格、表达习惯、喜欢什么，以及你们如何相处……" /></label>
        <label>形象<select value={draft.avatar} onChange={event => setDraft({ ...draft, avatar: event.target.value as CompanionDraft['avatar'], avatarAttachmentId: undefined })}><option value="custom">{draft.avatarAttachmentId ? '本地头像' : '名字头像'}</option>{BUILTIN_COMPANION_PROFILES.map(profile => <option key={profile.id} value={profile.templateId}>{profile.name}</option>)}</select></label>
        <label>LLM 服务<select aria-label="伙伴 LLM 服务" value={connectionMode} onChange={event => setConnectionMode(event.target.value as 'global' | 'independent')}><option value="global">使用全局 LLM 服务（默认）</option><option value="independent">为此伙伴单独配置</option></select></label>
        {connectionMode === 'global' ? <p className="companions-subtle">共用设置中的全局 LLM 服务，继承连接方式、地址、密钥和模型。角色名字、人设与记忆独立保存。</p> : <fieldset className="companions-independent-connection"><legend>此伙伴的独立连接</legend>
          <label>连接方式<select aria-label="连接方式" value={connection.apiFormat} onChange={event => setConnection({ ...connection, apiFormat: event.target.value as NonNullable<CompanionDraft['llm']>['apiFormat'] })}><option value="openai_chat">OpenAI Chat Completions</option><option value="openai_responses">OpenAI Responses</option><option value="anthropic">Anthropic Messages</option><option value="gemini_native">Gemini 原生 API</option><option value="dashscope_native">DashScope 原生 API</option></select></label>
          <label>API URL<input aria-label="API URL" maxLength={4096} value={connection.baseUrl} onChange={event => setConnection({ ...connection, baseUrl: event.target.value })} placeholder="服务的 API 地址" /></label>
          <label>API Key<input aria-label="API Key" type="password" autoComplete="new-password" maxLength={4096} value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={initial?.llm?.hasKey ? '已保存，留空保留' : '输入此服务的 API Key'} /></label>
          <label>模型<input aria-label="模型" required maxLength={160} value={connection.model} onChange={event => setConnection({ ...connection, model: event.target.value })} placeholder="该服务支持的模型名" /></label>
          <p className="companions-subtle">独立配置只用于这位伙伴。已保存的密钥不会回显。</p>
        </fieldset>}
        <label className="companions-checkbox"><input type="checkbox" checked={draft.proactive} onChange={event => setDraft({ ...draft, proactive: event.target.checked })} />允许空闲时主动联系我和其他伙伴</label>
        <footer><button type="button" className="companion-secondary-button" onClick={onClose} disabled={busy}>取消</button><button className="companion-primary-button" disabled={busy}>{busy ? '保存中…' : initial ? '保存资料' : '添加伙伴'}</button></footer>
      </form>}
    </>}
    {dialog.kind === 'group' && <form className="companions-form" onSubmit={event => { event.preventDefault(); void submit(group ? { type: 'conversation.update', id: group.id, title, memberIds: members } : { type: 'conversation.create-group', title, memberIds: members }); }}>
      <label>群聊名称<input data-dialog-initial-focus="true" maxLength={100} value={title} onChange={event => setTitle(event.target.value)} placeholder={companionGroupTitle(members.map(id => companions.find(item => item.id === id)?.name ?? '伙伴'))} /></label>
      <p className="companions-subtle">留空会按成员名字显示。也可以给这个群取一个名字。</p>
      <fieldset><legend>群成员 · 你会自动加入</legend><div className="companions-member-picker">{companions.map(item => <label className="companions-checkbox" key={item.id}><input type="checkbox" checked={members.includes(item.id)} onChange={event => setMembers(event.target.checked ? [...members, item.id] : members.filter(id => id !== item.id))} /><Avatar companion={item} /><span>{item.name}</span></label>)}</div></fieldset>
      {!companions.length && <p>先添加一个伙伴，就可以一起群聊了。</p>}
      {group && <div className="companions-group-danger">{dissolving ? <><p>确定解散“{group.title}”吗？该群正在运行和排队的回复会停止。聊天记录留在本地，同一批成员以后可以重新建群。</p><button type="button" className="companion-danger-button" disabled={busy} onClick={() => void submit({ type: 'conversation.delete', id: group.id, mode: 'dissolve' })}>确认解散群聊</button><button type="button" className="companion-secondary-button" onClick={() => setDissolving(false)}>保留群聊</button></> : <button type="button" className="companion-text-danger" onClick={() => setDissolving(true)}>解散群聊</button>}</div>}
      <footer><button type="button" className="companion-secondary-button" onClick={onClose} disabled={busy}>取消</button><button className="companion-primary-button" disabled={busy || !members.length}>{busy ? '保存中…' : group ? '保存群聊' : '创建群聊'}</button></footer>
    </form>}
    {dialog.kind === 'action' && <form className="companions-form" onSubmit={event => { event.preventDefault(); void submit({ type: 'action.run', conversationId: dialog.conversation.id, companionId: actionOwner, sourceMessageId: dialog.message.id, title: actionTitle, prompt: actionPrompt }); }}>
      <blockquote className="companions-dialog-quote">{dialog.message.content || dialog.message.attachments.map(item => item.name).join('、')}</blockquote>
      <label>交给谁<select value={actionOwner} onChange={event => setActionOwner(event.target.value)}>{companions.filter(item => dialog.conversation.memberIds.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>事情名称<input data-dialog-initial-focus="true" required maxLength={120} value={actionTitle} onChange={event => setActionTitle(event.target.value)} /></label>
      <label>希望她怎么做<textarea required maxLength={16000} rows={5} value={actionPrompt} onChange={event => setActionPrompt(event.target.value)} placeholder="明确目标、需要的资料和完成标准" /></label>
      <p className="companions-subtle">她会使用自己的能力处理这件事。你们可以继续聊天，结果会回到这里。</p>
      <footer><button type="button" className="companion-secondary-button" onClick={onClose} disabled={busy}>取消</button><button className="companion-primary-button" disabled={busy || !actionOwner}>{busy ? '提交中…' : '开始处理'}</button></footer>
    </form>}
    {dialog.kind === 'delete' && <div className="companions-form"><p>确定将“{dialog.companion.name}”从联系人移除吗？已有聊天记录保留。</p><footer><button className="companion-secondary-button" disabled={busy} onClick={onClose}>保留联系人</button><button className="companion-danger-button" disabled={busy || dialog.companion.builtin} onClick={() => void submit({ type: 'companion.delete', id: dialog.companion.id })}>移除联系人</button></footer></div>}
    {dialog.kind === 'delete-conversation' && <div className="companions-form"><p>{dialog.mode === 'dissolve' ? `确定解散“${dialog.conversation.title}”吗？该群正在运行和排队的回复会停止。` : `从消息列表删除“${dialog.conversation.title}”吗？聊天记录会保留，重新发起聊天时可以找回。`}</p><footer><button className="companion-secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="companion-danger-button" disabled={busy} onClick={() => void submit({ type: 'conversation.delete', id: dialog.conversation.id, mode: dialog.mode })}>{dialog.mode === 'dissolve' ? '确认解散群聊' : '删除聊天'}</button></footer></div>}
    {cropSource && <AvatarCropDialog attachment={cropSource} name={draft.name || '伙伴'} request={request} returnFocusRef={avatarTrigger} onCancel={() => setCropSource(undefined)} onConfirm={image => { setDraft(current => ({ ...current, avatar: 'custom', avatarAttachmentId: image.id })); setCropSource(undefined); }} />}
    {error && <p className="companions-modal-error" role="alert">{error === 'request' ? requestError || '操作未完成，请查看错误信息后重试。' : error}</p>}
  </Modal>;
}

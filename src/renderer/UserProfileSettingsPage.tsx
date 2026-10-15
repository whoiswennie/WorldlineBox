import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { CompanionAttachment, WorldlineBoxCompanionsApi } from '../shared/companions';
import type { PlayerProfile, PlayerProfileDraft } from '../shared/companion-profile';
import { Avatar } from './companions/CompanionVisuals';
import { PublicAppearanceSheet } from './companions/PublicAppearanceSheet';
import { AvatarCropDialog } from './companions/AvatarCropDialog';
import { SettingsCard } from './ui/patterns';
import { useT } from './i18n';
import './user-profile-settings.css';

function profileDraft(profile: PlayerProfile): PlayerProfileDraft {
  return { name: profile.name, description: profile.description, ...(profile.avatarAttachmentId ? { avatarAttachmentId: profile.avatarAttachmentId } : {}), ...(profile.appearanceAttachmentId ? { appearanceAttachmentId: profile.appearanceAttachmentId } : {}) };
}
export function UserProfileSettingsPage({ api = (window as unknown as { worldlinebox?: { companions?: WorldlineBoxCompanionsApi } }).worldlinebox?.companions }: { api?: WorldlineBoxCompanionsApi }) {
  const t = useT(), [profile, setProfile] = useState<PlayerProfile>(), [draft, setDraft] = useState<PlayerProfileDraft>({ name: '', description: '' });
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false), [changedElsewhere, setChangedElsewhere] = useState(false);
  const [cropSource, setCropSource] = useState<CompanionAttachment>();
  const avatarTrigger = useRef<HTMLButtonElement>(null);
  const alive = useRef(true), editing = useRef(false), epoch = useRef(0), currentProfile = useRef<PlayerProfile | undefined>(undefined);
  const accept = useCallback((value: PlayerProfile) => { currentProfile.current = value; setProfile(value); setDraft(profileDraft(value)); editing.current = false; setDirty(false); setChangedElsewhere(false); }, []);
  const load = useCallback(async () => {
    const current = ++epoch.current; setLoading(true); setError('');
    try { if (!api) throw new Error(t('settings.profileUnavailable')); const result = await api.request({ type: 'player.profile.get' }); if (alive.current && current === epoch.current) { if (!result.ok || !result.playerProfile) throw new Error(result.error || t('settings.profileReadFailed')); accept(result.playerProfile); } }
    catch (cause) { if (alive.current && current === epoch.current) setError(cause instanceof Error ? cause.message : t('settings.profileReadFailed')); }
    finally { if (alive.current && current === epoch.current) setLoading(false); }
  }, [api, accept, t]);
  useEffect(() => { const requestEpoch = epoch; alive.current = true; void Promise.resolve().then(() => { if (alive.current) void load(); }); const unsubscribe = api?.onChanged(() => {
    void api.request({ type: 'player.profile.get' }).then(result => { if (!alive.current || !result.ok || !result.playerProfile || result.playerProfile.revision === currentProfile.current?.revision) return; if (editing.current) setChangedElsewhere(true); else accept(result.playerProfile); }).catch(() => undefined);
  }); return () => { alive.current = false; requestEpoch.current++; unsubscribe?.(); }; }, [api, load, accept]);
  function change(patch: Partial<PlayerProfileDraft>) { editing.current = true; setDirty(true); setSaved(false); setDraft(current => ({ ...current, ...patch })); }
  async function choose(purpose: 'avatar' | 'appearance') {
    if (!api || busy) return; setBusy(true); setError('');
    try { const result = await api.request({ type: 'attachment.pick', kind: 'image', purpose }); if (!alive.current) return; if (!result.ok) throw new Error(result.error || t('settings.profilePickFailed'));
      const image = result.attachments?.[0]; if (!image) return; if (!image.mime.startsWith('image/')) throw new Error(t('settings.profileImageOnly'));
      if (purpose === 'avatar') setCropSource(image); else change({ appearanceAttachmentId: image.id });
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : t('settings.profilePickFailed')); }
    finally { if (alive.current) setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!api || !profile || busy) return; setBusy(true); setError('');
    try { const result = await api.request({ type: 'player.profile.update', expectedRevision: profile.revision, profile: { ...draft, name: draft.name.trim() } }); if (!alive.current) return; if (!result.ok || !result.playerProfile) throw new Error(result.error || t('settings.profileSaveFailed')); accept(result.playerProfile); setSaved(true); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : t('settings.profileSaveFailed')); }
    finally { if (alive.current) setBusy(false); }
  }
  return <><form className="player-profile-settings" aria-label={t('settings.categoryProfile')} onSubmit={event => void save(event)}>
    <p className="player-profile-intro">{t('settings.profileIntro')}</p>
    {loading && !profile ? <p role="status">{t('settings.profileLoading')}</p> : <>
      <SettingsCard><div className="player-profile-identity"><Avatar companion={{ name: draft.name || '我', avatar: 'custom', avatarAttachmentId: draft.avatarAttachmentId }} large showPresence={false} /><div><strong>{t('settings.profileAvatar')}</strong><p>{t('settings.profileAvatarHint')}</p><div><button ref={avatarTrigger} type="button" className="companion-secondary-button" disabled={busy || !profile} onClick={() => void choose('avatar')}>{t('settings.profileChooseAvatar')}</button>{draft.avatarAttachmentId && <button type="button" className="player-profile-remove" disabled={busy} onClick={() => change({ avatarAttachmentId: undefined })}>{t('settings.profileRemoveAvatar')}</button>}</div></div></div>
        <div className="player-profile-fields"><label>{t('settings.profileName')}<input autoComplete="nickname" name="profile-name" required maxLength={60} value={draft.name} disabled={busy || !profile} onChange={event => change({ name: event.target.value })} /></label><label>{t('settings.profileDescription')}<textarea name="profile-description" rows={4} maxLength={4000} value={draft.description} disabled={busy || !profile} placeholder={t('settings.profileDescriptionPlaceholder')} onChange={event => change({ description: event.target.value })} /></label><small>{t('settings.profilePublicHint')}</small></div>
      </SettingsCard>
      <SettingsCard><PublicAppearanceSheet attachmentId={draft.appearanceAttachmentId} name={draft.name || '我'} title={t('settings.profileSheet')} description={t('settings.profileSheetHint')} chooseLabel={t(draft.appearanceAttachmentId ? 'settings.profileReplaceSheet' : 'settings.profileChooseSheet')} removeLabel={t('settings.profileRemoveSheet')} emptyLabel={t('settings.profileEmptySheet')} previewLabel={t('settings.profilePreviewSheet')} closeLabel={t('settings.profileCloseSheet')} unavailableLabel={t('settings.profileImageUnavailable')} disabled={busy || !profile} onChoose={() => void choose('appearance')} onRemove={() => change({ appearanceAttachmentId: undefined })} /></SettingsCard>
    </>}
    {error && <p className="player-profile-error" role="alert">{error}<button type="button" disabled={busy} onClick={() => void load()}>{t('settings.profileReload')}</button></p>}
    {changedElsewhere && <p className="player-profile-notice">{t('settings.profileChangedElsewhere')}</p>}
    <footer><span role="status">{saved ? t('settings.profileSaved') : dirty ? t('settings.profileUnsaved') : ''}</span><button className="companion-primary-button" disabled={busy || loading || !profile || !dirty || !draft.name.trim()}>{t(busy ? 'settings.profileSaving' : 'settings.profileSave')}</button></footer>
  </form>{cropSource && api && <AvatarCropDialog attachment={cropSource} name={draft.name || '我'} request={input => api.request(input)} returnFocusRef={avatarTrigger} onCancel={() => setCropSource(undefined)} onConfirm={image => { change({ avatarAttachmentId: image.id }); setCropSource(undefined); }} />}</>;
}

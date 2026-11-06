import { useEffect, useState } from 'react';
import type { BotCompanion } from '../../shared/companion-bot';
import { DEFAULT_BOT_COMPANION_ID } from '../../shared/builtin-bot-companions';
import { BotAvatar } from './BotAvatar';
import { BotIcon } from './BotIcon';
import { readBotCallPreferences, saveBotCallPreferences, type BotCallPreferences } from './call-preferences';

export function BotCompanionAppearance({ companion, locale, active = true, onMeet }: { companion: BotCompanion; locale: 'zh-CN' | 'en'; active?: boolean; onMeet?(): void }) {
  const zh = locale === 'zh-CN', [preferences, setPreferences] = useState(() => readBotCallPreferences(companion.id)), [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    // The meeting can change these same preferences while this pane is hidden.
    let live = true;
    void Promise.resolve().then(() => { if (live) setPreferences(readBotCallPreferences(companion.id)); });
    return () => { live = false; };
  }, [active, companion.id]);
  const update = (value: Partial<BotCallPreferences>) => {
    if (!saveBotCallPreferences(companion.id, value)) { setError(zh ? '本设备存储暂不可用，请重试。' : 'Local storage is unavailable. Try again.'); return; }
    setPreferences(current => ({ ...current, ...value })); setError('');
  };
  return <section className="bot-settings-scroll bot-settings-appearance">
    <header className="bot-settings-section-heading"><h3>{zh ? '形象与声音' : 'Appearance & voice'}</h3><p>{zh ? '会面偏好按伙伴保存在本设备，调整后立即生效。' : 'Meeting preferences are saved on this device for this companion and apply immediately.'}</p></header>
    <div className="bot-settings-profile-card"><BotAvatar companion={companion} large /><div><strong>{companion.name}</strong><p>{companion.id === DEFAULT_BOT_COMPANION_ID ? zh ? 'Live2D 动态形象' : 'Live2D character' : zh ? '静态头像形象' : 'Portrait character'}</p></div>{onMeet && <button type="button" onClick={onMeet}><BotIcon name="phone" />{zh ? '进入会面' : 'Open meeting'}</button>}</div>
    <div className="bot-settings-card"><h4>{zh ? '场景' : 'Scene'}</h4><label className="bot-settings-field">{zh ? '默认背景场景' : 'Default background'}<select value={preferences.scene.startsWith('data:') ? 'custom' : preferences.scene} onChange={event => update({ scene: event.target.value })}>
      <option value="evening">{zh ? '暮色书房' : 'Evening studio'}</option><option value="plain">{zh ? '静谧留白' : 'Quiet space'}</option>{preferences.scene.startsWith('data:') && <option value="custom" disabled>{zh ? '会面中选择的图片' : 'Image selected in a meeting'}</option>}
    </select></label><p>{zh ? '自选背景图片、取景、表情与姿态可在会面的“场景与互动”中调整。' : 'Choose a background image, framing, expressions and poses from Scene & interactions during a meeting.'}</p></div>
    <div className="bot-settings-card"><h4>{zh ? '形象互动' : 'Character interaction'}</h4>{[
      ['gazeEnabled', zh ? '视线跟随鼠标' : 'Follow pointer', zh ? '让动态形象的目光跟随屏幕上的鼠标位置。' : 'Let the character follow the pointer across the screen.'],
      ['idleEnabled', zh ? '自然待机动作' : 'Idle motion', zh ? '启用动态形象的自然待机表现。' : 'Enable the character’s idle animation.'],
    ].map(([field, label, hint]) => <label className="bot-settings-toggle" key={field}><span><strong>{label}</strong><small>{hint}</small></span><input type="checkbox" aria-label={label} checked={preferences[field as 'gazeEnabled' | 'idleEnabled']} onChange={event => update({ [field!]: event.target.checked })} /></label>)}<p>{zh ? '动态互动适用于配有 Live2D 模型的伙伴。' : 'Dynamic interaction applies to companions with a Live2D model.'}</p></div>
    <div className="bot-settings-card"><h4>{zh ? '声音' : 'Voice'}</h4><label className="bot-settings-toggle"><span><strong>{zh ? '自动朗读伙伴回复' : 'Read new replies aloud'}</strong><small>{zh ? '接通会面后，按顺序朗读这位伙伴的新回复。' : 'Read this companion’s new replies in order during a meeting.'}</small></span><input type="checkbox" aria-label={zh ? '自动朗读伙伴回复' : 'Read new replies aloud'} checked={preferences.readAloud} onChange={event => update({ readAloud: event.target.checked })} /></label></div>
    {error && <p role="alert" className="bot-error">{error}</p>}
  </section>;
}

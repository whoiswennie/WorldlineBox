import { useRef, useState } from 'react';
import type { BotCompanion } from '../../shared/companion-bot';
import type { DshLauncherState, WorldlineBoxDshLauncherApi } from '../../shared/dsh-launcher';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { BotAvatar } from './BotAvatar';
import { BotIcon } from './BotIcon';
import { hasCompanionDshBinding } from './useBotDshBindings';
import './bot-dsh-binding.css';

type Companion = Pick<BotCompanion, 'id' | 'name'>;
export interface BotDshBindingDialogProps {
  api: WorldlineBoxDshLauncherApi; state: DshLauncherState; companions: readonly Companion[]; locale: 'zh-CN' | 'en';
  onState(state: DshLauncherState): void; onClose(): void; onOpenLauncher?(): void;
}

/** Confirmation is the only allocation path. Merely opening this dialog is read-only. */
export function BotDshBindingDialog(props: BotDshBindingDialogProps) {
  const missing = props.companions.filter(value => !hasCompanionDshBinding(props.state, value.id));
  const current = missing[0];
  if (!current) return null;
  return <BindingForm key={current.id} {...props} companion={current} missing={missing.length} />;
}

function BindingForm({ api, state, companions, companion, missing, locale, onState, onClose, onOpenLauncher }: BotDshBindingDialogProps & { companion: Companion; missing: number }) {
  const zh = locale === 'zh-CN', [mode, setMode] = useState<'create' | 'existing'>('create');
  const name = `${companion.name} 的能力环境`.slice(0, 100);
  const [runtimeId, setRuntimeId] = useState(''), [instanceId, setInstanceId] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), pending = useRef(false);
  useDialogFocusTrap(true, companion.id);
  const existingOwner = state.instances.find(value => value.companionId === companion.id);
  const available = state.instances.filter(value => !value.companionId && value.status === 'stopped' && state.runtimes.some(runtime => runtime.id === value.runtimeId));
  const valid = !existingOwner && state.supported && (mode === 'create' ? !!name.trim() && state.runtimes.some(value => value.id === runtimeId) : available.some(value => value.id === instanceId));
  const confirm = async () => {
    if (!valid || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const response = await api.request(mode === 'create'
        ? { type: 'companion.environment.create', companionId: companion.id, name: companion.name, runtimeId }
        : { type: 'companion.environment.bind', companionId: companion.id, name: companion.name, instanceId });
      if (!response.ok) { setError(response.error); return; }
      let next = response.state;
      if (!next) { const latest = await api.request({ type: 'state' }); if (latest.ok) next = latest.state; }
      if (!next || !hasCompanionDshBinding(next, companion.id)) { setError(zh ? '绑定尚未确认，请刷新实例状态后重试。' : 'Binding is not confirmed. Refresh the instance state and try again.'); return; }
      onState(next);
    } catch (cause) { setError(String(cause)); }
    finally { pending.current = false; setBusy(false); }
  };
  const goToLauncher = () => { if (!busy) { onClose(); onOpenLauncher?.(); } };
  return <div className="bot-binding-backdrop" onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); } }}>
    <section className="bot-binding-dialog" role="dialog" aria-modal="true" aria-labelledby={`binding-title-${companion.id}`} data-companion-binding={companion.id}>
      <aside className="bot-binding-character"><span className="bot-binding-eyebrow">WORLDLINE / CONNECTION</span><BotAvatar companion={companion as BotCompanion} large /><strong>{companion.name}</strong><p>{zh ? '独立的能力环境，属于这一位伙伴。' : 'An independent environment for this companion.'}</p><span className="bot-binding-seal"><BotIcon name="sparkles" />{zh ? '专属执行环境' : 'PRIVATE ENVIRONMENT'}</span></aside>
      <div className="bot-binding-main"><header><div><span className="bot-binding-eyebrow">{zh ? '建立连接' : 'ESTABLISH CONNECTION'}</span><h2 id={`binding-title-${companion.id}`}>{zh ? '为伙伴绑定 DSH' : 'Connect a private DSH'}</h2></div><button type="button" aria-label={zh ? '暂不绑定' : 'Close binding dialog'} disabled={busy} onClick={onClose}>×</button></header>
        <p className="bot-binding-intro">{zh ? `与${companion.name}对话前，需要为其绑定独立实例。由你选择 DSH 版本并确认，插件与技能将在该实例中独立保存。` : `Before chatting with ${companion.name}, choose and confirm an independent DSH instance. Its plugins and skills remain separate.`}</p>
        {companions.length > 1 && <div className="bot-binding-members" aria-label={zh ? '群聊实例准备进度' : 'Group binding progress'}>{companions.map(value => <span key={value.id} data-ready={hasCompanionDshBinding(state, value.id)} data-current={value.id === companion.id}><i>{hasCompanionDshBinding(state, value.id) ? '✓' : '○'}</i>{value.name}</span>)}<small>{zh ? `还需绑定 ${missing} 位伙伴` : `${missing} companions remaining`}</small></div>}
        <div className="bot-binding-body">{existingOwner ? <div className="bot-binding-empty"><BotIcon name="tasks" /><h3>{zh ? '已绑定实例的运行版本不可用' : 'The bound runtime is unavailable'}</h3><p>{zh ? `请在启动器修复「${existingOwner.name}」的运行版本。已有插件和资料会保留。` : `Repair the runtime for “${existingOwner.name}” in the launcher. Its plugins and data are retained.`}</p></div> : <>
          <div className="bot-binding-modes" role="tablist" aria-label={zh ? '绑定方式' : 'Binding method'}><button type="button" role="tab" aria-selected={mode === 'create'} disabled={busy} onClick={() => setMode('create')}><BotIcon name="plus" />{zh ? '新建专属实例' : 'Create private instance'}</button><button type="button" role="tab" aria-selected={mode === 'existing'} disabled={busy} onClick={() => setMode('existing')}><BotIcon name="tasks" />{zh ? '绑定已有实例' : 'Use existing instance'}</button></div>
          {mode === 'create' ? state.runtimes.length ? <div className="bot-binding-fields"><label>{zh ? '实例名称' : 'Instance name'}<input value={name} readOnly aria-readonly="true" /></label><label>{zh ? 'DSH 运行版本' : 'DSH runtime version'}<select aria-label={zh ? '选择 DSH 版本' : 'Choose DSH version'} value={runtimeId} disabled={busy} onChange={event => setRuntimeId(event.target.value)}><option value="">{zh ? '请选择已安装的版本' : 'Choose an installed version'}</option>{state.runtimes.map(value => <option key={value.id} value={value.id}>DSH {value.version}</option>)}</select></label><p className="bot-binding-note">{zh ? '确认后创建并绑定，执行任务时按需启动。以后升级此实例会保留插件、技能与配置。' : 'Confirmation creates and binds the instance. Tasks start it on demand; upgrades retain its plugins, skills and settings.'}</p></div> : <div className="bot-binding-empty"><BotIcon name="tasks" /><h3>{zh ? '先安装一个 DSH 版本' : 'Install a DSH version first'}</h3><p>{zh ? '前往启动器下载官方版本，再回来选择并确认绑定。' : 'Download an official version in the launcher, then return to choose and confirm it.'}</p></div>
          : <div className="bot-binding-fields"><label>{zh ? '可绑定实例' : 'Available instance'}<select aria-label={zh ? '选择已有实例' : 'Choose existing instance'} value={instanceId} disabled={busy} onChange={event => setInstanceId(event.target.value)}><option value="">{zh ? '请选择未绑定的已停止实例' : 'Choose an unbound, stopped instance'}</option>{available.map(value => <option key={value.id} value={value.id}>{value.name} · DSH {state.runtimes.find(runtime => runtime.id === value.runtimeId)?.version ?? '—'}</option>)}</select></label><p className="bot-binding-note">{zh ? '绑定后，此实例将专属于该伙伴，保留原有插件和配置。其他伙伴不能共用；运行中的实例请先在启动器停止。' : 'Binding gives this companion exclusive use, retaining existing plugins and settings. Stop running instances in the launcher before binding.'}</p>{!available.length && <p role="status">{zh ? '暂无可绑定实例。可以新建，或在启动器准备一个未绑定实例。' : 'No available instances. Create one here or prepare an unbound instance in the launcher.'}</p>}</div>}
        </>}{!state.supported && <p role="alert">{zh ? '当前系统不支持此 DSH 运行环境。' : 'This system does not support this DSH runtime.'}</p>}{error && <p className="bot-binding-error" role="alert">{error}</p>}</div>
        <footer><button type="button" disabled={busy || !onOpenLauncher} onClick={goToLauncher}>{zh ? '前往启动器' : 'Open launcher'}<BotIcon name="external" /></button><div><button type="button" disabled={busy} onClick={onClose}>{zh ? '稍后设置' : 'Later'}</button><button type="button" className="bot-binding-confirm" disabled={busy || !valid} onClick={() => void confirm()}>{busy ? zh ? '正在绑定…' : 'Connecting…' : mode === 'create' ? zh ? '确认创建并绑定' : 'Create and bind' : zh ? '确认绑定' : 'Confirm binding'}</button></div></footer>
      </div>
    </section>
  </div>;
}

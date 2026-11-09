import { useRef, useState } from 'react';
import type { BotCompanion } from '../../shared/companion-bot';
import type { DshLauncherState, WorldlineBoxDshLauncherApi } from '../../shared/dsh-launcher';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { BotAvatar } from './BotAvatar';
import { BotIcon } from './BotIcon';
import { hasSharedDshBinding, sharedDshInstance } from './useBotDshBindings';
import './bot-dsh-binding.css';

type Companion = Pick<BotCompanion, 'id' | 'name'>;
export interface BotDshBindingDialogProps {
  api: WorldlineBoxDshLauncherApi; state: DshLauncherState; companions: readonly Companion[]; locale: 'zh-CN' | 'en';
  onState(state: DshLauncherState): void; onClose(): void; onOpenLauncher?(): void;
}

/** One deliberate setup serves every character. Opening this dialog never allocates an instance. */
export function BotDshBindingDialog(props: BotDshBindingDialogProps) {
  if (hasSharedDshBinding(props.state) || !props.companions.length) return null;
  return <BindingForm {...props} companion={props.companions[0]!} />;
}

function BindingForm({ api, state, companion, locale, onState, onClose, onOpenLauncher }: BotDshBindingDialogProps & { companion: Companion }) {
  const zh = locale === 'zh-CN';
  const available = state.instances.filter(value => state.runtimes.some(runtime => runtime.id === value.runtimeId));
  const [mode, setMode] = useState<'create' | 'existing'>(available.length ? 'existing' : 'create');
  const name = '共享 DSH';
  const [runtimeId, setRuntimeId] = useState(''), [instanceId, setInstanceId] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), pending = useRef(false);
  useDialogFocusTrap(true, 'shared-dsh-setup');
  const selected = sharedDshInstance(state);
  const needsRepair = !!selected && !state.runtimes.some(runtime => runtime.id === selected.runtimeId);
  const valid = state.supported && (mode === 'create' ? state.runtimes.some(value => value.id === runtimeId) : available.some(value => value.id === instanceId));
  const confirm = async () => {
    if (!valid || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const response = await api.request(mode === 'create'
        ? { type: 'companion.environment.create', companionId: companion.id, name, runtimeId }
        : { type: 'companion.environment.bind', companionId: companion.id, name, instanceId });
      if (!response.ok) { setError(response.error); return; }
      let next = response.state;
      if (!next) { const latest = await api.request({ type: 'state' }); if (latest.ok) next = latest.state; }
      if (!next || !hasSharedDshBinding(next)) { setError(zh ? '共享执行环境尚未确认，请刷新实例状态后重试。' : 'The shared executor is not confirmed. Refresh the instance state and retry.'); return; }
      onState(next);
    } catch (cause) { setError(String(cause)); }
    finally { pending.current = false; setBusy(false); }
  };
  const goToLauncher = () => { if (!busy) { onClose(); onOpenLauncher?.(); } };
  return <div className="bot-binding-backdrop" onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); } }}>
    <section className="bot-binding-dialog" role="dialog" aria-modal="true" aria-labelledby="shared-dsh-title" data-shared-dsh-setup>
      <aside className="bot-binding-character"><span className="bot-binding-eyebrow">WORLDLINE / CONNECTION</span><BotAvatar companion={companion as BotCompanion} large /><strong>{zh ? '连接所有伙伴' : 'Connect every companion'}</strong><p>{zh ? '一次配置，共同使用。聊天与记忆仍属于各自的角色。' : 'One setup for everyone. Each character keeps its own chats and memories.'}</p><span className="bot-binding-seal"><BotIcon name="sparkles" />{zh ? '共享执行环境' : 'SHARED ENVIRONMENT'}</span></aside>
      <div className="bot-binding-main"><header><div><span className="bot-binding-eyebrow">{zh ? '只需设置一次' : 'ONE-TIME SETUP'}</span><h2 id="shared-dsh-title">{zh ? '连接共享 DSH' : 'Connect shared DSH'}</h2></div><button type="button" aria-label={zh ? '关闭 DSH 配置' : 'Close DSH setup'} disabled={busy} onClick={onClose}>×</button></header>
        <p className="bot-binding-intro">{zh ? '所有伙伴通过同一个 DSH 执行任务，账号登录、API、插件和技能只需配置一次。你可以选用已有实例，也可以新建一个共享实例。' : 'All companions execute tasks through one DSH. Configure accounts, API, plugins and skills once. Use an existing instance or create a shared one.'}</p>
        <div className="bot-binding-body">
          {needsRepair && <p className="bot-binding-error" role="status">{zh ? `「${selected.name}」的运行版本不可用。可在启动器修复，或在这里改选其他实例；原有资料会保留。` : `The runtime for “${selected.name}” is unavailable. Repair it in the launcher or select another instance. Its data is retained.`}</p>}
          <div className="bot-binding-modes" role="tablist" aria-label={zh ? '连接方式' : 'Connection method'}><button type="button" role="tab" aria-selected={mode === 'create'} disabled={busy} onClick={() => setMode('create')}><BotIcon name="plus" />{zh ? '新建共享实例' : 'Create shared instance'}</button><button type="button" role="tab" aria-selected={mode === 'existing'} disabled={busy} onClick={() => setMode('existing')}><BotIcon name="tasks" />{zh ? '使用已有实例' : 'Use existing instance'}</button></div>
          {mode === 'create' ? state.runtimes.length ? <div className="bot-binding-fields"><label>{zh ? '实例名称' : 'Instance name'}<input value={name} readOnly aria-readonly="true" /></label><label>{zh ? 'DSH 运行版本' : 'DSH runtime version'}<select aria-label={zh ? '选择 DSH 版本' : 'Choose DSH version'} value={runtimeId} disabled={busy} onChange={event => setRuntimeId(event.target.value)}><option value="">{zh ? '请选择已安装的版本' : 'Choose an installed version'}</option>{state.runtimes.map(value => <option key={value.id} value={value.id}>DSH {value.version}</option>)}</select></label><p className="bot-binding-note">{zh ? '确认后设为所有伙伴的共享执行环境，任务需要时启动。后续在 DSH 工作台统一配置账号、模型和插件。' : 'Confirmation selects this executor for all companions. It starts when needed. Manage accounts, models and plugins in its DSH workbench.'}</p></div> : <div className="bot-binding-empty"><BotIcon name="tasks" /><h3>{zh ? '先安装一个 DSH 版本' : 'Install a DSH version first'}</h3><p>{zh ? '前往启动器下载官方版本，再回来完成这一次共享配置。' : 'Download an official version in the launcher, then complete this one-time setup.'}</p></div>
          : <div className="bot-binding-fields"><label>{zh ? '共享执行实例' : 'Shared execution instance'}<select aria-label={zh ? '选择已有实例' : 'Choose existing instance'} value={instanceId} disabled={busy} onChange={event => setInstanceId(event.target.value)}><option value="">{zh ? '请选择已有实例' : 'Choose an existing instance'}</option>{available.map(value => <option key={value.id} value={value.id}>{value.name} · DSH {state.runtimes.find(runtime => runtime.id === value.runtimeId)?.version ?? '—'}</option>)}</select></label><p className="bot-binding-note">{zh ? '保留所选实例的登录、API、插件和技能，所有伙伴共同使用。原有其他实例及资料保留；伙伴在各自工作区中为每条消息创建独立会话。' : 'Reuse its accounts, API, plugins and skills for all companions. Other instances and their data remain; each companion creates a fresh session for every message in its own workspace.'}</p>{!available.length && <p role="status">{zh ? '暂无可用实例。可以选择已安装的版本新建，或在启动器修复已有实例。' : 'No usable instances. Create one from an installed runtime or repair an existing one in the launcher.'}</p>}</div>}
          {!state.supported && <p role="alert">{zh ? '当前系统不支持此 DSH 运行环境。' : 'This system does not support this DSH runtime.'}</p>}{error && <p className="bot-binding-error" role="alert">{error}</p>}
        </div>
        <footer><button type="button" disabled={busy || !onOpenLauncher} onClick={goToLauncher}>{zh ? '前往启动器' : 'Open launcher'}<BotIcon name="external" /></button><div><button type="button" disabled={busy} onClick={onClose}>{zh ? '稍后设置' : 'Later'}</button><button type="button" className="bot-binding-confirm" disabled={busy || !valid} onClick={() => void confirm()}>{busy ? zh ? '正在连接…' : 'Connecting…' : mode === 'create' ? zh ? '创建并共享' : 'Create and share' : zh ? '确认使用' : 'Use this instance'}</button></div></footer>
      </div>
    </section>
  </div>;
}

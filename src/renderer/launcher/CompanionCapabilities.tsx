import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { BotCompanion, WorldlineBoxBotApi } from '../../shared/companion-bot';
import type { DshCompanionEnvironment, DshLauncherRequest, DshLauncherResponse, DshLauncherState, WorldlineBoxDshLauncherApi } from '../../shared/dsh-launcher';
import { useLocale } from '../i18n';
import { Button, DialogShell, Select, TextField } from '../ui';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { InstancePluginControls } from './InstancePluginControls';
import { InstanceSkillControls } from './InstanceSkillControls';
import { LauncherMarketplace } from './LauncherMarketplace';
import { CompanionNativeCapabilities } from './CompanionNativeCapabilities';
import './launcher.css';
import './companion-capabilities.css';

type Companion = Pick<BotCompanion, 'id' | 'name' | 'enabled'>;
type CapabilityTab = 'callable' | 'installed' | 'plugins' | 'skills' | 'environment';

export function CompanionCapabilitiesDialog({ api, botApi, companion, onClose, onRuntimeChanged }: { api: WorldlineBoxDshLauncherApi; botApi?: WorldlineBoxBotApi; companion: Companion; onClose(): void; onRuntimeChanged?(): void }) {
  const { locale } = useLocale(), zh = locale === 'zh-CN', id = useId();
  useDialogFocusTrap(true, id);
  return <div className="companion-capabilities-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <DialogShell dialogId={`companion-capabilities-${id}`} className="companion-capabilities-dialog" contentClassName="companion-capabilities-content" title={zh ? `${companion.name}的能力` : `${companion.name} · Capabilities`}
      description={zh ? '配置这位伙伴使用的原生插件与技能。' : 'Manage this companion’s native plugins and skills.'} onRequestClose={onClose}
      headerActions={<Button aria-label={zh ? '关闭能力管理' : 'Close capabilities'} iconName="close" variant="quiet" size="sm" onClick={onClose} />}>
      <CompanionCapabilities key={companion.id} api={api} botApi={botApi} companion={companion} onRuntimeChanged={onRuntimeChanged} />
    </DialogShell>
  </div>;
}

export function CompanionCapabilitiesPage({ api, botApi }: { api: WorldlineBoxDshLauncherApi; botApi?: WorldlineBoxBotApi }) {
  const { locale } = useLocale(), zh = locale === 'zh-CN';
  const [companions, setCompanions] = useState<Companion[]>([]), [selected, setSelected] = useState(''), [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!botApi) return;
    let live = true;
    void botApi.request({ type: 'state' }).then(result => {
      if (!live) return;
      if (!result.ok) setError(result.error ?? (zh ? '伙伴列表暂时不可用。' : 'The companion list is unavailable.'));
      else { setCompanions(result.snapshot?.companions ?? []); setError(''); }
    }).catch(error => { if (live) setError(String(error)); });
    return () => { live = false; };
  }, [botApi, revision, zh]);
  useEffect(() => {
    if (!botApi) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = botApi.onEvent(event => {
      if (event.type !== 'changed' || timer) return;
      timer = setTimeout(() => { timer = undefined; setRevision(value => value + 1); }, 100);
    });
    return () => { clearTimeout(timer); unsubscribe(); };
  }, [botApi]);
  const companion = companions.find(person => person.id === selected) ?? companions[0];
  return <div className="launcher-page companion-capabilities-page">
    <div className="launcher-page-heading"><div><h1>{zh ? '伙伴能力' : 'Companion capabilities'}</h1><p>{zh ? '普通伙伴共用执行器；独立装备插件时自动准备专属环境，复用已安装的 DSH。' : 'Companions share the executor until you equip a private environment, using the installed DSH runtime.'}</p></div></div>
    {!!companions.length && <Select label={zh ? '选择伙伴' : 'Companion'} value={companion?.id ?? ''} onValueChange={setSelected} options={companions.map(person => ({ value: person.id, label: person.name }))} />}
    {error && <p role="alert" className="companion-capability-error">{error}<Button size="sm" variant="quiet" onClick={() => setRevision(value => value + 1)}>{zh ? '重试' : 'Retry'}</Button></p>}
    {companion ? <CompanionCapabilities key={companion.id} api={api} botApi={botApi} companion={companion} onRuntimeChanged={() => setRevision(value => value + 1)} /> : !error && <p className="launcher-help">{botApi ? zh ? '正在读取伙伴…' : 'Loading companions…' : zh ? '请先到伙伴界面创建一位伙伴。' : 'Create a companion first.'}</p>}
  </div>;
}

export function CompanionCapabilities({ api, botApi, companion, onRuntimeChanged }: { api: WorldlineBoxDshLauncherApi; botApi?: WorldlineBoxBotApi; companion: Companion; onRuntimeChanged?(): void }) {
  const { locale } = useLocale(), zh = locale === 'zh-CN';
  const [state, setState] = useState<DshLauncherState>(), [environment, setEnvironment] = useState<DshCompanionEnvironment>();
  const [tab, setTab] = useState<CapabilityTab>('callable'), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [pluginSpec, setPluginSpec] = useState(''), [runtimeId, setRuntimeId] = useState(''), [refreshVersion, setRefreshVersion] = useState(0);
  const [connectionIntent, setConnectionIntent] = useState<{ instanceId: string; keepAlive: boolean }>();
  const [runtimeOverride, setRuntimeOverride] = useState<{ source: boolean; value: boolean }>();
  const runtimeEnabled = runtimeOverride?.source === (companion.enabled !== false) ? runtimeOverride.value : companion.enabled !== false;
  const mounted = useRef(true), operationIds = useRef(new Set<string>()), seenOperations = useRef(new Set<string>());
  const acceptState = useCallback((next: DshLauncherState) => {
    if (!mounted.current) return;
    setState(next);
    setEnvironment(current => {
      const instance = next.instances.find(instance => instance.id === current?.instance.id);
      return current && instance ? { ...current, instance } : current;
    });
    for (const operation of next.operations) {
      if (!operationIds.current.has(operation.id) || operation.status === 'running' || seenOperations.current.has(operation.id)) continue;
      seenOperations.current.add(operation.id);
      if (operation.status === 'succeeded') setNotice(zh ? '能力配置已更新。' : 'Capabilities updated.');
      else setError(operation.error || (zh ? '能力变更未完成，请重试。' : 'The capability change did not finish. Try again.'));
    }
  }, [zh]);
  const refresh = useCallback(async () => {
    const [snapshot, binding] = await Promise.all([api.request({ type: 'state' }), api.request({ type: 'companion.environment.state', companionId: companion.id, name: companion.name })]);
    if (!mounted.current) return;
    if (snapshot.ok && snapshot.state) acceptState(snapshot.state);
    if (!binding.ok) setError(binding.error);
    else if (binding.companionEnvironment) setEnvironment(binding.companionEnvironment);
  }, [api, companion.id, companion.name, acceptState]);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = api.onChanged(acceptState);
    void Promise.resolve().then(refresh).catch(error => { if (mounted.current) setError(String(error)); });
    return () => { mounted.current = false; unsubscribe(); };
  }, [api, acceptState, refresh, refreshVersion]);
  const run = useCallback(async (input: DshLauncherRequest): Promise<DshLauncherResponse> => {
    const observation = ['instance.plugins', 'skill.list', 'market.search', 'skill.inspect'].includes(input.type);
    if (mounted.current && !observation) { setError(''); setNotice(''); }
    try {
      const result = await api.request(input);
      if (!mounted.current) return result;
      if (!result.ok) setError(result.error);
      else {
        if (result.operationId) operationIds.current.add(result.operationId);
        if (result.state) acceptState(result.state);
        if (result.companionEnvironment) setEnvironment(result.companionEnvironment);
        if (!observation) await refresh();
      }
      return result;
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      if (mounted.current) setError(message);
      return { ok: false, error: message };
    }
  }, [api, acceptState, refresh]);
  const action = async (input: DshLauncherRequest) => {
    if (busy) return;
    setBusy(true);
    try { return await run(input); } finally { if (mounted.current) setBusy(false); }
  };
  const toggleCompanion = async () => {
    if (!botApi || busy) return;
    setBusy(true); setError('');
    try {
      const response = await botApi.request({ type: 'companion.runtime', companionId: companion.id, operation: runtimeEnabled ? 'stop' : 'start' });
      if (!mounted.current) return;
      if (!response.ok) setError(response.error || (zh ? '伙伴状态未更新，请重试。' : 'Could not update the companion. Try again.'));
      else {
        const saved = response.snapshot?.companions.find(person => person.id === companion.id);
        if (saved) setRuntimeOverride({ source: companion.enabled !== false, value: saved.enabled !== false });
        else { const state = await botApi.request({ type: 'state' }); if (state.ok) { const saved = state.snapshot?.companions.find(person => person.id === companion.id); if (saved && mounted.current) setRuntimeOverride({ source: companion.enabled !== false, value: saved.enabled !== false }); } }
        onRuntimeChanged?.(); await refresh();
      }
    } catch (failure) { if (mounted.current) setError(String(failure)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const instance = environment && (state?.instances.find(value => value.id === environment.instance.id) ?? environment.instance);
  const privateEnvironment = environment?.mode === 'private';
  const changing = !!state?.operations.some(operation => operation.instanceId === instance?.id && operation.status === 'running');
  const locked = busy || changing || ['starting', 'stopping'].includes(instance?.status ?? '');
  const version = state?.runtimes.find(runtime => runtime.id === instance?.runtimeId)?.version;
  const args = { companionId: companion.id, name: companion.name };
  const configureConnection = async (keepAlive: boolean) => {
    if (!instance || locked) return;
    setConnectionIntent({ instanceId: instance.id, keepAlive });
    try { await action({ type: 'companion.environment.configure', ...args, keepAlive }); }
    finally { if (mounted.current) setConnectionIntent(undefined); }
  };
  const tabs: Array<[CapabilityTab, string]> = [['callable', zh ? '可调用能力' : 'Callable capabilities'], ['installed', zh ? '原生插件与技能' : 'Native plugins and skills'], ['plugins', zh ? '插件市场' : 'Plugins'], ['skills', zh ? '技能市场' : 'Skills'], ['environment', zh ? '运行环境' : 'Environment']];
  const catalogRevision = `${instance?.id ?? 'unconfigured'}:${instance?.status ?? ''}:${instance?.updatedAt ?? ''}:${instance?.restartRequired === true}:${refreshVersion}:${state?.operations.filter(operation => operation.instanceId === instance?.id && operation.status !== 'running').map(operation => `${operation.id}:${operation.status}`).join('|') ?? ''}`;
  return <section className="companion-capabilities" data-companion-capabilities={companion.id} aria-label={zh ? `${companion.name}的能力配置` : `${companion.name} capabilities`}>
    <div className="companion-capability-summary"><div><strong>{privateEnvironment ? zh ? '独立能力环境' : 'Private capability environment' : zh ? '使用共享能力' : 'Shared capabilities'}</strong>
      <p>{privateEnvironment ? zh ? '插件、技能与登录配置只属于这位伙伴。程序版本与其他环境共用。' : 'Plugins, skills and sign-ins belong to this companion. Runtime files are shared.' : zh ? '当前复用默认 DSH。配置专属插件时会自动准备独立环境，不需要手动创建实例。' : 'Uses the default DSH. Equipping private plugins automatically prepares a separate environment.'}</p>
      {instance && <span>{instance.name}{version ? ` · DSH ${version}` : ''} · {zh ? ({ stopped: '用时启动', running: '已连接', starting: '启动中', stopping: '关闭中', failed: '连接失败' }[instance.status] ?? instance.status) : instance.status}</span>}</div>
      <Button size="sm" variant="quiet" disabled={busy} iconName="refresh" onClick={() => { setError(''); setRefreshVersion(value => value + 1); }}>{zh ? '刷新能力' : 'Refresh'}</Button>
    </div>
    {botApi && <div className="companion-runtime-control"><div><strong>{zh ? runtimeEnabled ? '伙伴已启用' : '伙伴已关闭' : runtimeEnabled ? 'Companion enabled' : 'Companion disabled'}</strong><p>{zh ? '关闭后暂停这位伙伴的任务与聊天；其他伙伴继续工作。连接方式只管理执行器保活。' : 'Disabling pauses this companion’s tasks and chat. Other companions keep working. Connection mode controls executor keepalive separately.'}</p></div><Button variant={runtimeEnabled ? 'quiet' : 'primary'} disabled={busy} onClick={() => void toggleCompanion()}>{zh ? runtimeEnabled ? '关闭伙伴' : '启用伙伴' : runtimeEnabled ? 'Disable companion' : 'Enable companion'}</Button></div>}
    {error && <p className="companion-capability-error" role="alert">{error}</p>}
    {notice && <p className="companion-capability-notice" role="status">{notice}</p>}
    {!runtimeEnabled ? <p className="launcher-help" role="status">{zh ? '这位伙伴已关闭。启用后可读取和配置原生能力。' : 'This companion is disabled. Enable it to load and configure native capabilities.'}</p> : !environment ? <p className="launcher-help" role="status">{error ? zh ? '连接可用后可重试读取能力。' : 'Retry when the executor is available.' : zh ? '正在读取能力配置…' : 'Loading capabilities…'}</p> : !privateEnvironment ?
      <><div className="companion-capability-onboarding"><h2>{zh ? `为${companion.name}装备更多能力` : `Equip ${companion.name}`}</h2><p>{zh ? '安装原生插件、连接外部平台或添加技能，配置会独立保存。已有聊天和任务不会被迁移或重放。' : 'Install native plugins, connect platforms or add skills with private configuration. Existing conversations and tasks stay in their current environment.'}</p>
        <Button variant="primary" disabled={busy} loading={busy} iconName="plus" onClick={() => void action({ type: 'companion.environment.ensure', ...args })}>{zh ? '配置独立能力' : 'Set up private capabilities'}</Button></div><CompanionNativeCapabilities key={catalogRevision} api={api} companion={companion} /></> : instance && state && <>
      <nav className="launcher-tabs companion-capability-tabs" aria-label={zh ? '能力分类' : 'Capability sections'}>{tabs.map(([value, label]) => <button type="button" key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</button>)}</nav>
      {instance.restartRequired && <p className="companion-capability-notice" role="status">{zh ? '原生插件配置已保存，正在等待安全时机重启执行器；已有任务会保留。' : 'Plugin configuration is saved. The executor will restart safely while preserving existing tasks.'}</p>}
      {tab === 'callable' && (['starting', 'stopping'].includes(instance.status) ? <p className="launcher-help" role="status">{zh ? '执行器正在重新连接，连接完成后会读取最新原生能力。' : 'The executor is reconnecting. Native capabilities refresh when it is ready.'}</p> : <CompanionNativeCapabilities key={catalogRevision} api={api} companion={companion} applying={locked} onApplyUpdate={() => void action({ type: 'companion.environment.refresh', ...args })} />)}
      {tab === 'installed' && <><p className="launcher-help">{zh ? '插件也可能只提供界面或后台服务。全局注册的新工具在后续步骤可见；预设内能力变更可能需空闲重连。停用或替换可能影响尚未调用的旧工具，正在执行的插件是否继续由插件自身决定。需要重启时不强制打断任务。' : 'Plugins can provide UI or background services. Globally registered tools become available in later steps; preset changes may require an idle reconnect. Disabling or replacing plugins can affect pending calls. In-flight behavior depends on the plugin. Required restarts do not interrupt active tasks.'}</p><InstancePluginControls state={state} instanceId={instance.id} run={run} disabled={locked} /><InstanceSkillControls state={state} instanceId={instance.id} run={run} disabled={locked} />
        <section className="launcher-card"><h2>{zh ? '从地址安装原生插件' : 'Install a native plugin by address'}</h2><p className="launcher-help">{zh ? '可填写 npm 包名、Git 地址或本地插件路径。安装使用 DSH 原生管理器。' : 'Enter an npm package, Git URL or local plugin path. DSH manages the installation.'}</p><div className="companion-capability-install"><TextField aria-label={zh ? '插件地址' : 'Plugin address'} value={pluginSpec} onChange={event => setPluginSpec(event.target.value)} placeholder="@scope/plugin" maxLength={512} /><Button disabled={locked || !pluginSpec.trim()} iconName="plus" onClick={() => void action({ type: 'instance.plugin', instanceId: instance.id, action: 'add', spec: pluginSpec.trim() })}>{zh ? '安装插件' : 'Install plugin'}</Button></div></section></>}
      {(tab === 'plugins' || tab === 'skills') && <LauncherMarketplace kind={tab === 'plugins' ? 'plugin' : 'skill'} state={state} targetInstanceId={instance.id} run={run} disabled={locked} />}
      {tab === 'environment' && <div className="companion-capability-environment"><section className="launcher-card"><h2>{zh ? '连接方式' : 'Connection mode'}</h2><label className="companion-capability-keepalive"><input type="checkbox" checked={connectionIntent?.instanceId === instance.id ? connectionIntent.keepAlive : instance.keepAlive === true} disabled={locked} onChange={event => void configureConnection(event.target.checked)} /><span><strong>{zh ? '保持连接' : 'Keep connected'}</strong><small>{zh ? 'QQ 等需要持续收件的插件可开启。关闭后用时启动，空闲时退出；配置与历史会保留。' : 'Enable for plugins that receive messages continuously. Otherwise the environment starts on demand and exits when idle, keeping configuration and history.'}</small></span></label><Button disabled={locked} iconName="external-link" onClick={() => void action({ type: 'companion.environment.open', ...args })}>{zh ? '打开原生插件设置与工作台' : 'Open native settings and workbench'}</Button></section>
        <section className="launcher-card"><h2>{zh ? 'DSH 程序版本' : 'DSH runtime'}</h2><p className="launcher-help">{zh ? '升级保留这位伙伴的插件、配置和历史，不会重新安装另一份相同程序。' : 'Upgrades retain plugins, configuration and history, reusing installed runtime files.'}</p><div className="companion-capability-install"><Select label={zh ? '程序版本' : 'Runtime version'} value={runtimeId || instance.runtimeId} onValueChange={setRuntimeId} options={state.runtimes.map(runtime => ({ value: runtime.id, label: `DSH ${runtime.version}` }))} /><Button disabled={locked || !runtimeId || runtimeId === instance.runtimeId} onClick={() => void action({ type: 'companion.environment.upgrade', ...args, runtimeId })}>{zh ? '升级并保留配置' : 'Upgrade and keep configuration'}</Button></div></section>
        <p className="launcher-help">{zh ? '已创建独立环境后会一直保留，以保护插件配置与已有任务；未配置独立能力的伙伴继续使用共享环境。' : 'Private environments are retained to protect plugin configuration and existing tasks. Companions without private capabilities continue sharing the default environment.'}</p></div>}
    </>}
  </section>;
}

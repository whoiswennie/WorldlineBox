import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { BotCompanion, WorldlineBoxBotApi } from '../../shared/companion-bot';
import type { DshLauncherState, WorldlineBoxDshLauncherApi } from '../../shared/dsh-launcher';
import type { DshTaskCapabilities } from '../../shared/dsh-task-spec';
import { useLocale } from '../i18n';
import { Icon } from '../Icons';
import { Button, DialogShell, Select } from '../ui';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import { CompanionNativeCapabilities } from './CompanionNativeCapabilities';
import './companion-capability-archive.css';

type Companion = Pick<BotCompanion, 'id' | 'name' | 'enabled'>;
type Props = { api: WorldlineBoxDshLauncherApi; botApi?: WorldlineBoxBotApi; companion: Companion; onRuntimeChanged?(): void };

export function CompanionCapabilitiesDialog({ onClose, ...props }: Props & { onClose(): void }) {
  const { locale } = useLocale(), zh = locale === 'zh-CN', id = useId(); useDialogFocusTrap(true, id);
  return <div className="companion-capabilities-backdrop" onMouseDown={event => { if (event.currentTarget === event.target) onClose(); }}>
    <DialogShell dialogId={`companion-capabilities-${id}`} className="companion-capabilities-dialog" contentClassName="companion-capabilities-content" title={zh ? `${props.companion.name}的能力档案` : `${props.companion.name} · Capability archive`}
      description={zh ? '查看真实生效的能力；插件与技能在 DSH 中管理。' : 'View effective capabilities. Manage plugins and skills in DSH.'} onRequestClose={onClose}
      headerActions={<Button aria-label={zh ? '关闭能力档案' : 'Close capability archive'} iconName="close" variant="quiet" size="sm" onClick={onClose} />}>
      <CompanionCapabilities key={props.companion.id} {...props} />
    </DialogShell>
  </div>;
}

export function CompanionCapabilitiesPage({ api, botApi }: Pick<Props, 'api' | 'botApi'>) {
  const { locale } = useLocale(), zh = locale === 'zh-CN';
  const [companions, setCompanions] = useState<Companion[]>([]), [selected, setSelected] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    if (!botApi) return;
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => { try { const result = await botApi.request({ type: 'state' }); if (!live) return;
      if (result.ok) { setCompanions(result.snapshot?.companions ?? []); setError(''); } else setError(result.error ?? '');
    } catch (failure) { if (live) setError(String(failure)); } };
    void read(); const unsubscribe = botApi.onEvent(event => { if (event.type === 'changed' && !timer) timer = setTimeout(() => { timer = undefined; void read(); }, 150); });
    return () => { live = false; clearTimeout(timer); unsubscribe(); };
  }, [botApi]);
  const companion = companions.find(person => person.id === selected) ?? companions[0];
  return <div className="launcher-page companion-capabilities-page"><header className="capability-archive-page-heading"><span>COMPANION ARCHIVE</span><h1>{zh ? '角色能力档案' : 'Character capability archives'}</h1><p>{zh ? '查看角色与执行环境的连接，以及执行器实际提供的工具和技能。' : 'Inspect the connected environment and the tools and skills it actually provides.'}</p></header>
    {!!companions.length && <Select label={zh ? '选择伙伴' : 'Companion'} value={companion?.id ?? ''} onValueChange={setSelected} options={companions.map(person => ({ value: person.id, label: person.name }))} />}
    {error && <p role="alert" className="companion-capability-error">{error}</p>}
    {companion ? <CompanionCapabilities key={companion.id} api={api} companion={companion} /> : !error && <p className="capability-archive-empty">{zh ? '暂无角色档案。创建角色后，可在这里查看。' : 'Create a character to view its archive here.'}</p>}
  </div>;
}

/** Observation only: opening this card never allocates or starts an executor. */
export function CompanionCapabilities({ api, companion, onRuntimeChanged }: Props) {
  const { locale } = useLocale(), zh = locale === 'zh-CN';
  const [state, setState] = useState<DshLauncherState>(), [error, setError] = useState(''), [reading, setReading] = useState(true), [opening, setOpening] = useState(false), [revision, setRevision] = useState(0);
  const [summary, setSummary] = useState<{ revision: string; value: DshTaskCapabilities }>(); const ticket = useRef(0);
  const read = useCallback(async () => {
    const current = ++ticket.current; setReading(true); setError('');
    try { const result = await api.request({ type: 'state' }); if (current !== ticket.current) return;
      if (result.ok && result.state) setState(result.state); else setError(result.ok ? zh ? '暂时没有执行环境信息。' : 'No environment information returned.' : result.error);
    } catch (failure) { if (current === ticket.current) setError(String(failure)); }
    finally { if (current === ticket.current) setReading(false); }
  }, [api, zh]);
  useEffect(() => {
    const requests = ticket; void Promise.resolve().then(read); const unsubscribe = api.onChanged(next => { requests.current++; setState(next); setReading(false); });
    return () => { requests.current++; unsubscribe(); };
  }, [api, read]);
  const own = state?.instances.find(instance => instance.companionId === companion.id);
  const instance = own ?? state?.instances.find(instance => instance.isDefault && !instance.companionId);
  const runtime = state?.runtimes.find(runtime => runtime.id === instance?.runtimeId);
  const online = instance?.status === 'running' && companion.enabled !== false;
  const status = companion.enabled === false ? zh ? '角色已关闭' : 'Character disabled' : !instance ? zh ? '尚未连接' : 'Not connected'
    : zh ? ({ running: '已连接', stopped: '未启动', starting: '连接中', stopping: '正在关闭', failed: '连接异常' }[instance.status]) : instance.status;
  const version = `${instance?.id}:${instance?.status}:${instance?.updatedAt}:${instance ? state?.companionCapabilityRevisions?.[instance.id] ?? 0 : 0}:${revision}:${state?.operations.filter(op => op.instanceId === instance?.id && op.status !== 'running').map(op => op.id).join('|')}`;
  const actualSummary = online && summary?.revision === version && summary.value.instanceId === instance?.id ? summary.value : undefined;
  const acceptCapabilities = useCallback((value: DshTaskCapabilities) => setSummary({ revision: version, value }), [version]);
  const open = async () => {
    if (opening) return; setOpening(true); setError('');
    try { const result = await api.request({ type: 'companion.environment.open', companionId: companion.id, name: companion.name });
      if (!result.ok) setError(result.error); else { if (result.state) setState(result.state); onRuntimeChanged?.(); await read(); }
    } catch (failure) { setError(String(failure)); } finally { setOpening(false); }
  };
  return <section className="companion-capabilities capability-archive" data-companion-capabilities={companion.id} aria-label={zh ? `${companion.name}的能力档案` : `${companion.name} capability archive`}>
    <header className="capability-archive-hero"><div className="capability-archive-emblem" aria-hidden="true"><Icon name="sparkles" size={27} /></div><div className="capability-archive-hero-copy"><span className="capability-archive-eyebrow">CAPABILITY ARCHIVE</span><h3>{zh ? '能力档案' : 'Capability archive'}</h3><p>{zh ? '每一份能力，都来自真实连接的执行环境。' : 'Capabilities, grounded in the connected environment.'}</p></div><span className="capability-archive-status" data-online={online || undefined}><i />{status}</span></header>
    <section className="capability-archive-binding" aria-label={zh ? '执行环境绑定' : 'Environment binding'}><div><span className="capability-archive-label">{zh ? '执行环境' : 'EXECUTION ENVIRONMENT'}</span><strong>{own ? zh ? '专属 DSH' : 'Private DSH' : instance ? zh ? '共享 DSH' : 'Shared DSH' : zh ? '等待连接 DSH' : 'Awaiting DSH'}</strong><p>{instance?.name ?? (zh ? '安装 DSH 后，可从工作台准备执行环境。' : 'Install DSH, then open its workbench to prepare the environment.')}{runtime ? ` · v${runtime.version}` : ''}</p></div><div className="capability-archive-actions"><Button size="sm" iconName="refresh" variant="quiet" disabled={reading || opening} onClick={() => { setRevision(value => value + 1); void read(); }}>{zh ? '刷新档案' : 'Refresh archive'}</Button><Button size="sm" iconName="external-link" disabled={opening || state?.supported === false || !state?.runtimes.length || companion.enabled === false} loading={opening} onClick={() => void open()}>{zh ? '前往专属 DSH' : 'Open private DSH'}</Button></div><p className="capability-archive-binding-hint">{zh ? '在 DSH 中管理插件与技能；首次前往会准备并启动角色的专属环境。' : 'Manage plugins and skills in DSH. First access prepares and starts this character’s private environment.'}</p></section>
    <div className="capability-archive-metrics" aria-label={zh ? '实际生效能力' : 'Effective capabilities'}>{[
      ['code', zh ? '原生工具' : 'Native tools', actualSummary ? String(actualSummary.toolsTotal ?? actualSummary.effective?.toolCount ?? actualSummary.tools.length) : '—'],
      ['file-text', zh ? '生效技能' : 'Effective skills', actualSummary ? String(actualSummary.skillsTotal ?? actualSummary.effective?.skillCount ?? actualSummary.skills.length) : '—'],
      ['shield', zh ? '能力来源' : 'Capability source', zh ? own ? '专属环境' : instance ? '共享环境' : '未连接' : own ? 'Private' : instance ? 'Shared' : 'Unbound'],
    ].map(([icon, label, value]) => <div key={label}><Icon name={icon as 'code' | 'file-text' | 'shield'} size={17} /><span>{label}</span><strong>{value}</strong></div>)}</div>
    <p className="capability-archive-native-note"><Icon name="info" size={15} /><span>{zh ? '插件安装、配置与启停均在 DSH 中完成。此处仅记录已注册能力；皮肤、桌宠等插件不会仅因安装而计为新能力。' : 'Install, configure and toggle plugins in DSH. Only registered capabilities appear here; installing a theme or pet does not make it a callable capability.'}</span></p>
    {error && <p className="companion-capability-error" role="alert">{error}</p>}
    {online && instance ? <CompanionNativeCapabilities key={version} api={api} companion={companion} instanceId={instance.id} onCapabilities={acceptCapabilities} />
      : <div className="companion-capability-onboarding capability-archive-empty" role="status"><Icon name={reading ? 'loader' : 'link-off'} size={26} /><strong>{zh ? reading ? '正在读取执行环境' : companion.enabled === false ? '角色已休息' : instance?.status === 'starting' ? '正在连接 DSH' : '尚未读取生效能力' : reading ? 'Reading environment' : 'No live capability snapshot'}</strong><p>{zh ? 'DSH 连接后，这里会显示原生注册的工具、技能及其来源。查看档案不会启动或更改执行环境。' : 'Connect DSH to view native tools, skills and sources. Viewing this archive does not start or modify the environment.'}</p></div>}
  </section>;
}

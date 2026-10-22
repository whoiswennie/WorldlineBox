import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { Companion, WorldlineBoxCompanionsApi } from '../../../shared/companions';
import type { CompanionWorldSettings, CompanionWorldSnapshot } from '../../../shared/companion-world';
import { Icon } from '../../Icons';
import { Avatar } from '../CompanionVisuals';
import { createWorldViewport, type WorldViewportEngine } from './world-engine';
import { readWorldObserverPreferences, saveWorldObserverPreferences } from './world-observer-preferences';
import { WORLD_VISIT_LABELS, WORLD_WEATHER_LABELS, worldActorStatus, worldWorkLabel } from './world-presentation';
import './companion-world.css';
import { StartupScreen } from '../../StartupScreen';
import { companionWeatherSymbol } from '../../../shared/companion-weather';
import { checkWorldGraphicsCapability, getWorldGraphicsCapability, markWorldGraphicsUnavailable, subscribeWorldGraphicsCapability } from '../../device-capabilities/world-graphics-probe';
import { WorldGraphicsGate } from './WorldGraphicsGate';

export function CompanionWorld({ api, companions, initialCompanionId, initialSceneId, observerKey, visibleWindowCount = 1, active = true, totalMemoryBytes, onClose, onOpenWindow }: {
  readonly api?: WorldlineBoxCompanionsApi;
  readonly companions: Pick<Companion, 'id' | 'name' | 'avatar' | 'avatarAttachmentId'>[];
  readonly initialCompanionId?: string; readonly initialSceneId?: string; readonly observerKey?: string; readonly visibleWindowCount?: number; readonly active?: boolean;
  readonly totalMemoryBytes?: number;
  readonly onClose: () => void; readonly onOpenWindow?: (sceneId?: string) => void;
}) {
  const [savedObserver] = useState(() => readWorldObserverPreferences(undefined, observerKey));
  const observerPreferences = useRef(savedObserver);
  const [snapshot, setSnapshot] = useState<CompanionWorldSnapshot>();
  const [sceneId, setSceneId] = useState<string | undefined>(initialSceneId ?? (initialCompanionId ? undefined : savedObserver.sceneId));
  const [followId, setFollowId] = useState<string | undefined>(!initialCompanionId && !initialSceneId && companions.some(companion => companion.id === savedObserver.followId) ? savedObserver.followId : undefined);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [error, setError] = useState('');
  const [renderError, setRenderError] = useState('');
  const graphics = useSyncExternalStore(subscribeWorldGraphicsCapability, getWorldGraphicsCapability, getWorldGraphicsCapability);
  const [checkingGraphics, setCheckingGraphics] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [settings, setSettings] = useState<CompanionWorldSettings>();
  const [saving, setSaving] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const engine = useRef<WorldViewportEngine | undefined>(undefined);
  const drawnScene = useRef<string | undefined>(undefined);
  const loadInFlight = useRef(false), alive = useRef(true);
  const scenes = snapshot?.scenes ?? [];
  const followedActor = followId ? snapshot?.actors.find(actor => actor.companionId === followId) : undefined;
  const requestedId = followId ?? (sceneId?.startsWith('home_') ? sceneId.slice(5) : !sceneId ? initialCompanionId : undefined);
  const dormantResident = snapshot?.residents.find(resident => resident.companionId === requestedId && resident.active === false);
  const currentScene = dormantResident ? undefined : scenes.find(scene => scene.id === (followedActor?.sceneId ?? sceneId)) ?? scenes.find(scene => scene.ownerId === initialCompanionId) ?? scenes.find(scene => scene.kind === 'home') ?? scenes[0];
  const owner = companions.find(companion => companion.id === currentScene?.ownerId);
  const isPark = currentScene?.kind === 'park';
  const canRender = !!snapshot && !dormantResident && graphics?.status === 'available';
  const currentViewId = currentScene?.id;
  const visibleActors = snapshot?.actors.filter(actor => actor.sceneId === currentScene?.id) ?? [];
  const name = useCallback((id: string | undefined) => companions.find(item => item.id === id)?.name ?? '伙伴', [companions]);
  const rememberView = useCallback(() => {
    const view = engine.current?.getView(), id = drawnScene.current;
    if (view && id) observerPreferences.current.views[id] = view;
    saveWorldObserverPreferences(observerPreferences.current, undefined, observerKey);
  }, [observerKey]);
  const checkGraphics = useCallback(() => {
    setCheckingGraphics(true); setRenderError('');
    void Promise.resolve().then(() => {
      if (!alive.current) return;
      checkWorldGraphicsCapability({ totalMemoryBytes }); setCheckingGraphics(false);
    });
  }, [totalMemoryBytes]);
  useEffect(() => {
    const cached = getWorldGraphicsCapability();
    if (active && (!cached || totalMemoryBytes !== undefined && cached.memoryGiB !== totalMemoryBytes / 1024 ** 3)) {
      void Promise.resolve().then(() => { if (alive.current) checkGraphics(); });
    }
  }, [active, checkGraphics, totalMemoryBytes]);
  const changeFollow = useCallback((id: string | undefined) => { observerPreferences.current.followId = id; if (!id && drawnScene.current) setSceneId(drawnScene.current); setFollowId(id); }, []);
  const load = useCallback(async () => {
    if (!api || loadInFlight.current || document.hidden) return;
    loadInFlight.current = true;
    try { const result = await api.request({ type: 'world.snapshot' }); if (!alive.current) return; if (result.ok && result.world) { setSnapshot(result.world); setError(''); } else setError(result.error ?? '暂时没有读到世界状态，请稍后再试。'); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '世界状态暂时未连接。'); }
    finally { loadInFlight.current = false; }
  }, [api]);
  useEffect(() => {
    alive.current = true;
    if (!active) return () => { alive.current = false; };
    void Promise.resolve().then(() => { if (alive.current) void load(); });
    const timer = setInterval(() => void load(), 1000);
    const refreshVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', refreshVisible);
    return () => { alive.current = false; clearInterval(timer); document.removeEventListener('visibilitychange', refreshVisible); };
  }, [load, active]);
  useEffect(() => {
    if (!viewport.current || !canRender) return;
    try { engine.current = createWorldViewport(viewport.current, setRenderError, changeFollow, rememberView,
      () => markWorldGraphicsUnavailable('context_lost', '图形上下文已中断。可在此重新检测后恢复画面，世界生活仍会继续。')); }
    catch { void Promise.resolve().then(() => { if (alive.current) markWorldGraphicsUnavailable('probe_failed', '基础检测通过，但三维场景未能初始化。请关闭其他图形程序后重新检测。'); }); }
    return () => { rememberView(); engine.current?.dispose(); engine.current = undefined; drawnScene.current = undefined; };
  }, [changeFollow, rememberView, canRender]);
  useEffect(() => {
    if (!snapshot || !currentScene || !canRender || !engine.current) return;
    const changed = drawnScene.current !== currentViewId;
    if (changed) rememberView();
    engine.current?.update(snapshot, currentScene, companions);
    if (changed) {
      drawnScene.current = currentViewId;
      const view = observerPreferences.current.views[currentViewId!];
      {
        if (view) engine.current?.restoreView(view, followId);
        else if (followId) engine.current?.focus(followId);
      }
    }
    observerPreferences.current.sceneId = currentViewId;
    observerPreferences.current.followId = followId;
    if (changed) rememberView();
  }, [snapshot, currentScene, companions, followId, rememberView, currentViewId, isPark, canRender]);
  useEffect(() => {
    const timer = setInterval(rememberView, 1000);
    const onVisibility = () => { if (document.hidden) rememberView(); };
    window.addEventListener('beforeunload', rememberView); document.addEventListener('visibilitychange', onVisibility);
    return () => { clearInterval(timer); window.removeEventListener('beforeunload', rememberView); document.removeEventListener('visibilitychange', onVisibility); };
  }, [rememberView]);
  useEffect(() => { engine.current?.setActive(active && !settingsOpen); if (!active) rememberView(); }, [active, settingsOpen, rememberView, canRender]);
  useEffect(() => { engine.current?.setVisibleWindowCount(visibleWindowCount); }, [visibleWindowCount, canRender]);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { if (settingsOpen) setSettingsOpen(false); else onClose(); } }; document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey); }, [onClose, settingsOpen]);
  async function saveSettings(event: FormEvent) {
    event.preventDefault(); if (!settings || !api || saving) return; setSaving(true); setError('');
    try { const { revision, ...patch } = settings; const response = await api.request({ type: 'world.configure', expectedRevision: revision, patch }); if (!alive.current) return; if (!response.ok) { setError(response.error ?? '设置未保存，请重新打开设置后再试。'); return; } if (response.world) setSnapshot(response.world); else await load(); setSettingsOpen(false); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : '设置未保存。'); }
    finally { if (alive.current) setSaving(false); }
  }
  const visits = snapshot?.visits.filter(visit => !owner || visit.guestId === owner.id || visit.hostId === owner.id).slice(-6).reverse() ?? [];
  const events = snapshot?.events.filter(event => !currentScene || event.sceneId === currentScene.id || owner && (event.actorId === owner.id || event.targetId === owner.id)).slice(-8).reverse() ?? [];
  function eventText(text: string) {
    const labels = [...companions.map(companion => [companion.id, companion.name] as const), ...scenes.flatMap(scene => [[scene.id, scene.kind === 'home' ? name(scene.ownerId) + '的小屋' : scene.name] as const, ...scene.objects.map(object => [object.id, object.name] as const)])].sort((a, b) => b[0].length - a[0].length);
    return labels.reduce((value, [id, label]) => value.replaceAll(id, label), text);
  }
  return <div className="companion-world-window">
    <section className={'companion-world' + (inspectorOpen ? '' : ' is-inspector-collapsed')} role="region" aria-label="伙伴世界">
      <header className="companion-world-header">
        <div className="companion-world-environment" aria-label="世界环境">{snapshot ? <>
          <time className="companion-world-time" dateTime={snapshot.clock.virtualNow} aria-label="世界日期与时间"><span>{new Date(snapshot.clock.virtualNow).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', timeZone: snapshot.settings.timeZone })}</span><strong>{new Date(snapshot.clock.virtualNow).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: snapshot.settings.timeZone })}</strong></time>
          <span className="companion-world-weather"><span className="companion-world-sun" aria-hidden="true">{companionWeatherSymbol(snapshot.environment.weather, snapshot.clock.daylight)}</span>{snapshot.environment.weather ? WORLD_WEATHER_LABELS[snapshot.environment.weather] : '未知'}</span>
          <span className="companion-world-temperature"><small>室外</small>{snapshot.environment.outdoorTemperature?.toFixed(1) ?? '—'}°C</span><span className="companion-world-temperature is-indoor"><small>室内</small>{snapshot.environment.indoorTemperature?.toFixed(1) ?? '—'}°C</span>
        </> : <span>正在打开世界…</span>}</div>
        <div className="companion-world-header-actions">{onOpenWindow && <button aria-label="另开一个世界窗口" title="同时观察其他小屋" className="companion-icon-button" onClick={() => onOpenWindow(currentScene?.id)}><Icon name="plus" /></button>}<button aria-label={inspectorOpen ? '收起生活面板' : '显示生活面板'} aria-expanded={inspectorOpen} className="companion-icon-button" onClick={() => setInspectorOpen(value => !value)}><Icon name="panel-right" /></button><button aria-label="世界设置" className="companion-icon-button" disabled={!snapshot} onClick={() => { setSettings(snapshot!.settings); setSettingsOpen(true); }}><Icon name="sliders" /></button><button aria-label="关闭伙伴世界" className="companion-icon-button" onClick={onClose}><Icon name="close" /></button></div>
      </header>
      <div className="companion-world-body"><div className="companion-world-stage">
        {!snapshot && <StartupScreen title="正在连接伙伴世界" detail={error || "读取时间、伙伴位置与场景"} stage="读取世界状态" compact />}
        {dormantResident && <div className="companion-world-dormant" role="status"><Icon name="clock" /><h3>{dormantResident.name}已休眠</h3><p>虚拟世界未加载，也不会进行后台活动。</p><p>聊天和存档已保留，请回到联系人资料手动激活。</p></div>}
        <div className="companion-world-view" hidden={!!dormantResident} ref={viewport} data-world-scene={currentScene?.id} data-world-observation={isPark ? 'park' : 'home'} />
        {snapshot && !dormantResident && (!graphics || graphics.status !== 'available' || checkingGraphics) && <WorldGraphicsGate report={graphics} checking={checkingGraphics || !graphics} onRecheck={checkGraphics} />}
        {snapshot?.backlog && <div className="companion-world-continuing" role="status"><Icon name="loader" />正在接续离线期间的生活…</div>}
        <div className="companion-world-place"><h3>{isPark ? '公共花园' : owner ? owner.name + '的小屋' : currentScene?.name ?? '正在连接世界'}</h3>{isPark && <p className="companion-world-place-detail">树荫下散步，在长椅上歇一会儿</p>}{followId && <button className="companion-world-following" onClick={() => { changeFollow(undefined); engine.current?.reset(); }}>正在跟随 {name(followId)} <Icon name="close" /></button>}</div>
        {(error || renderError) && <div className="companion-world-notice" role="alert">{error || renderError}{error && <button onClick={() => void load()}>重试</button>}</div>}
        <div className="companion-world-camera" aria-label="世界视角控制"><button disabled={!canRender} aria-label="放大世界" onClick={() => engine.current?.zoom(1.2)}><Icon name="plus" /></button><button disabled={!canRender} aria-label="缩小世界" onClick={() => engine.current?.zoom(1 / 1.2)}>−</button>{<><i /><button disabled={!canRender} aria-label="向左旋转世界" onClick={() => engine.current?.rotate(-Math.PI / 8)}><Icon name="rotate-ccw" /></button><button disabled={!canRender} aria-label="向右旋转世界" onClick={() => engine.current?.rotate(Math.PI / 8)}><Icon name="rotate-cw" /></button></>}<i /><button disabled={!canRender} aria-label="重置世界视角" onClick={() => engine.current?.reset()}><Icon name="fit-window" /></button></div>
        <footer className="companion-world-stage-footer"><span>{'拖动旋转 · 右键平移 · 滚轮缩放'}</span><span>{snapshot?.settings.mode === 'realtime' ? '跟随现实时间' : snapshot ? `现实 ${snapshot.settings.dayDurationMinutes} 分钟 · 世界一天` : ''}</span></footer>
      </div><aside className="companion-world-inspector" aria-label="世界中的伙伴" hidden={!inspectorOpen}><div className="companion-world-location"><label htmlFor="companion-world-location">去哪里看看</label><select id="companion-world-location" aria-label="观测地点" value={dormantResident ? 'home_' + dormantResident.companionId : currentViewId ?? ''} onChange={event => { changeFollow(undefined); setSceneId(event.target.value); }}>{scenes.map(scene => <option key={scene.id} value={scene.id}>{scene.kind === 'park' ? scene.name : name(scene.ownerId) + '的小屋'}</option>)}{snapshot?.residents.filter(resident => resident.active === false).map(resident => <option key={resident.companionId} value={'home_' + resident.companionId}>{resident.name} · 休眠</option>)}</select></div>
        <section className="companion-world-residents"><div className="companion-world-section-title"><h3>此刻的生活</h3><span>{visibleActors.length} 位在这里</span></div>{!visibleActors.length && <p className="companion-world-empty">这里暂时很安静。<br />可以选择其他已开放的场景。</p>}{visibleActors.map(actor => { const companion = companions.find(item => item.id === actor.companionId), work = snapshot?.works.find(item => item.companionId === actor.companionId && item.status !== 'ended'), behavior = worldActorStatus(actor, snapshot!, companions); return <article className="companion-world-resident" key={actor.companionId} data-world-actor={actor.companionId} data-world-activity={actor.activity}><div><Avatar companion={companion} showPresence={false} /><span><strong>{companion?.name ?? '伙伴'}</strong><small title={behavior.detail}>{behavior.label}</small></span><button aria-label={'在场景中找到' + name(actor.companionId)} onClick={() => engine.current?.focus(actor.companionId)}><Icon name="eye" /></button></div>{work && <p className="companion-world-work" data-world-work={work.status}><i />{worldWorkLabel(work)}{work.reason && <small>{work.reason}</small>}</p>}<p className="companion-world-resident-state"><span>精力 {Math.round(actor.state.energy)}%</span><span>{({ calm: '平静', bright: '心情明亮', focused: '专注', tired: '有些疲惫', low: '情绪低落' } as const)[actor.state.mood]}</span><span>{actor.state.thermalComfort < .45 ? '温度不太舒适' : '体感舒适'}</span></p><footer><span>位置 {actor.position.x.toFixed(1)}, {actor.position.y.toFixed(1)}</span><span>{({ north: '朝北', east: '朝东', south: '朝南', west: '朝西' } as const)[actor.facing]}</span></footer></article>; })}</section>
        <section className="companion-world-visits"><div className="companion-world-section-title"><h3>来往的小消息</h3><Icon name="users" /></div>{visits.length ? visits.map(visit => <article key={visit.id} data-world-visit={visit.status}><div><strong>{name(visit.guestId)}<span> → </span>{name(visit.hostId)}</strong><small>{WORLD_VISIT_LABELS[visit.status]}</small></div><p>{visit.reason}</p>{visit.response && <p className="companion-world-visit-response">“{visit.response}”</p>}</article>) : <p className="companion-world-empty">敲门、等待回应，再一起坐坐。<br />伙伴会自己决定是否接待拜访。</p>}</section>
        <button className="companion-world-history-toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(value => !value)}><Icon name="clock" />生活里的片刻<Icon name="chevron" /></button>{detailsOpen && <section className="companion-world-events" aria-label="世界生活记录">{events.length ? events.map(event => <article key={event.id}><time>{new Date(event.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: snapshot?.settings.timeZone })}</time><p>{eventText(event.text)}</p></article>) : <p className="companion-world-empty">还没有新的生活片段。</p>}</section>}
        <p className="companion-world-observer"><Icon name="eye" />你正在观察大家的生活。这里的互动不会代替你授权电脑任务。</p>
      </aside></div>
      {settingsOpen && settings && <div className="companion-world-settings-backdrop"><form className="companion-world-settings" onSubmit={event => void saveSettings(event)} aria-label="世界时间设置"><header><h3>世界时间</h3><button type="button" className="companion-icon-button" aria-label="关闭世界设置" onClick={() => setSettingsOpen(false)}>×</button></header><p>默认与电脑日期和时间同步。加速模式改变昼夜、作息和生活片段；走路、坐下和电脑任务仍按现实时间进行。</p><label className="companion-world-mode"><input type="radio" name="world-mode" checked={settings.mode === 'compressed'} onChange={() => setSettings({ ...settings, mode: 'compressed' })} /><span><strong>加速体验一天</strong><small>可选：现实 20 分钟度过世界一天，可调整速度</small></span></label><label className="companion-world-mode"><input type="radio" name="world-mode" checked={settings.mode === 'realtime'} onChange={() => setSettings({ ...settings, mode: 'realtime' })} /><span><strong>与你使用相同的时间</strong><small>默认 · 推荐：跟随电脑的真实日期与时间</small></span></label>{settings.mode === 'compressed' && <label className="companion-world-duration">一天需要多少现实分钟<input aria-label="世界一天的现实分钟" type="number" min={5} max={1440} required value={settings.dayDurationMinutes} onChange={event => setSettings({ ...settings, dayDurationMinutes: Number(event.target.value) })} /></label>}<label className="companion-world-duration">世界所在时区<input aria-label="世界时区" required value={settings.timeZone} onChange={event => setSettings({ ...settings, timeZone: event.target.value })} /></label>{error && <p role="alert">{error}</p>}<footer><button type="button" className="companion-secondary-button" onClick={() => setSettingsOpen(false)}>再想想</button><button type="submit" className="companion-primary-button" disabled={saving}>{saving ? '正在保存…' : '保存世界设置'}</button></footer></form></div>}
    </section>
  </div>;
}

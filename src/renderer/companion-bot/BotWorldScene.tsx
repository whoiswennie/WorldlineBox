import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { WorldlineBoxBotApi } from '../../shared/companion-bot';
import type { BotWorldCommand, BotWorldSnapshot } from '../../shared/companion-bot-world';
import { useLocale } from '../i18n';
import './bot-world.css';
const BotWorld3D = lazy(() => import('./BotWorld3D').then(module => ({ default: module.BotWorld3D })));

const words = {
  'zh-CN': { title: '伙伴世界', loading: '正在观察场景…', refresh: '刷新观察', park: '去公共花园', home: '回自己的小屋',
    objects: '场景物件', choose: '选择一个物件', sit: '坐下', sleep: '睡觉', rest: '休息', work: '工作', eat: '用餐', read: '阅读', stand: '站起来',
    position: '位置', map: '伙伴世界场景位置图', hint: '点击地面移动。伙伴会沿可走路径行进；选择物件后可进行交互。', error: '世界操作失败，请重新观察。',
    idle: '自在地待着', walking: '正在走动', sitting: '坐着', sleeping: '睡觉中', resting: '休息中', working: '在电脑前', eating: '用餐中', reading: '阅读中',
    view2d: '位置图', view3d: '三维场景', loading3d: '正在准备三维场景…', fallback: '三维场景暂不可用，已返回位置图。', hint3d: '拖动旋转，滚轮缩放，双击地面移动。' },
  en: { title: 'Companion world', loading: 'Observing the scene…', refresh: 'Refresh', park: 'Visit the public garden', home: 'Return home',
    objects: 'Scene objects', choose: 'Choose an object', sit: 'Sit', sleep: 'Sleep', rest: 'Rest', work: 'Work', eat: 'Eat', read: 'Read', stand: 'Stand',
    position: 'Position', map: 'Companion world positions', hint: 'Click the floor to walk along a valid path. Select an object to interact with it.', error: 'The world action failed. Observe again.',
    idle: 'Idle', walking: 'Walking', sitting: 'Sitting', sleeping: 'Sleeping', resting: 'Resting', working: 'At the computer', eating: 'Eating', reading: 'Reading',
    view2d: 'Position map', view3d: '3D scene', loading3d: 'Preparing the 3D scene…', fallback: 'The 3D scene is unavailable. Showing the position map.', hint3d: 'Drag to orbit, scroll to zoom and double-click the floor to walk.' },
};
const supported: Record<string, Array<'sit' | 'sleep' | 'rest' | 'work' | 'eat' | 'read'>> = {
  chair: ['sit', 'read'], bench: ['sit', 'rest', 'read'], sofa: ['sit', 'rest', 'read'], bed: ['sleep', 'rest'], computer: ['work'], desk: ['work', 'read'], dining: ['eat'],
};

/** The physical world has its own narrow API; no legacy companion IPC or autonomous controller mounts here. */
export function BotWorldScene({ api, conversationId, companionId, isActive = true }: {
  api: WorldlineBoxBotApi; conversationId: string; companionId: string; isActive?: boolean;
}) {
  const { locale } = useLocale(), t = words[locale];
  const [snapshot, setSnapshot] = useState<BotWorldSnapshot>(), [selectedScene, setSelectedScene] = useState(''), [objectId, setObjectId] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [view, setView] = useState<'2d' | '3d'>('2d');
  const epoch = useRef(0), reading = useRef(false), acting = useRef(false);
  const accept = useCallback((next: BotWorldSnapshot) => setSnapshot(previous => !previous || next.revision > previous.revision
    || next.revision === previous.revision && next.observedAt >= previous.observedAt ? next : previous), []);
  const invalidate = useCallback(() => { ++epoch.current; }, []);
  const refresh = useCallback(async () => {
    if (reading.current) return;
    const token = epoch.current; reading.current = true;
    try {
      const result = await api.request({ type: 'world.observe', conversationId, companionId });
      if (token !== epoch.current) return;
      if (result.ok && result.world) { accept(result.world); setError(''); } else setError(result.error ?? t.error);
    } catch { if (token === epoch.current) setError(t.error); }
    finally { reading.current = false; }
  }, [api, conversationId, companionId, t, accept]);
  useEffect(() => {
    if (!isActive) return;
    let active = true;
    queueMicrotask(() => { if (active) void refresh(); }); const timer = setInterval(() => { void refresh(); }, 1000);
    return () => { active = false; clearInterval(timer); invalidate(); };
  }, [isActive, refresh, invalidate]);
  const act = async (command: BotWorldCommand) => {
    if (acting.current) return;
    const token = epoch.current; acting.current = true; setBusy(true); setError('');
    try {
      const result = await api.request({ type: 'world.act', conversationId, companionId, command, effectId: crypto.randomUUID() });
      if (token !== epoch.current) return;
      if (result.ok && result.world) accept(result.world); else setError(result.error ?? t.error);
    } catch { if (token === epoch.current) setError(t.error); }
    finally { acting.current = false; if (token === epoch.current) setBusy(false); }
  };
  const own = snapshot?.actors.find(actor => actor.companionId === companionId);
  const scene = snapshot?.scenes.find(item => item.id === selectedScene) ?? snapshot?.scenes.find(item => item.id === own?.sceneId);
  const object = scene?.objects.find(item => item.id === objectId);
  return <section className="bot-world" aria-label={t.title}>
    <header><strong>{t.title}</strong><nav><button aria-pressed={view === '2d'} onClick={() => setView('2d')}>{t.view2d}</button><button aria-pressed={view === '3d'} onClick={() => setView('3d')}>{t.view3d}</button><button onClick={() => void refresh()}>{t.refresh}</button></nav></header>
    {error && <p role="alert">{error}</p>}
    {!snapshot || !own || !scene ? <p role="status">{t.loading}</p> : <>
      <div className="bot-world-toolbar"><select aria-label={t.title} value={scene.id} onChange={event => { setSelectedScene(event.target.value); setObjectId(''); }}>
        {snapshot.scenes.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select><button disabled={busy || own.sceneId === 'park'} onClick={() => { setSelectedScene('park'); void act({ operation: 'travel', sceneId: 'park', expectedRevision: snapshot.revision }); }}>{t.park}</button>
      <button disabled={busy || own.sceneId === own.homeSceneId} onClick={() => { setSelectedScene(own.homeSceneId); void act({ operation: 'travel', sceneId: own.homeSceneId, expectedRevision: snapshot.revision }); }}>{t.home}</button></div>
      {view === '3d' ? <Suspense fallback={<p role="status">{t.loading3d}</p>}><BotWorld3D snapshot={snapshot} scene={scene} active={isActive} onMove={(x, y) => {
        if (!busy && own.sceneId === scene.id) void act({ operation: 'move', sceneId: scene.id, x, y, expectedRevision: snapshot.revision });
      }} onFallback={() => { setView('2d'); setError(t.fallback); }} /></Suspense> : <svg className="bot-world-map" role="img" aria-label={t.map} viewBox={`0 0 ${scene.width} ${scene.depth}`} onClick={event => {
        if (busy || own.sceneId !== scene.id) return;
        const bounds = event.currentTarget.getBoundingClientRect(); if (!bounds.width || !bounds.height) return;
        const scale = Math.min(bounds.width / scene.width, bounds.height / scene.depth);
        const offsetX = (bounds.width - scene.width * scale) / 2, offsetY = (bounds.height - scene.depth * scale) / 2;
        const x = Math.floor((event.clientX - bounds.left - offsetX) / scale), y = Math.floor((event.clientY - bounds.top - offsetY) / scale);
        if (x >= 0 && y >= 0 && x < scene.width && y < scene.depth) void act({ operation: 'move', sceneId: scene.id, x, y, expectedRevision: snapshot.revision });
      }}>
        <defs><pattern id={`bot-world-grid-${companionId}`} width="1" height="1" patternUnits="userSpaceOnUse"><path d="M 1 0 L 0 0 0 1" fill="none" stroke="currentColor" strokeWidth=".025" opacity=".14" /></pattern></defs>
        <rect width={scene.width} height={scene.depth} className={scene.kind === 'park' ? 'bot-world-ground is-park' : 'bot-world-ground'} />
        <rect width={scene.width} height={scene.depth} fill={`url(#bot-world-grid-${companionId})`} />
        {scene.objects.map(item => <g key={item.id} className={`bot-world-object ${item.id === objectId ? 'selected' : ''}`} onClick={event => { event.stopPropagation(); setObjectId(item.id); }}>
          <title>{item.name}{item.occupantId ? ` · ${item.occupantId}` : ''}</title><rect x={item.position.x} y={item.position.y} width={item.width} height={item.depth} rx=".15" />
          <text x={item.position.x + item.width / 2} y={item.position.y + item.depth / 2} textAnchor="middle" dominantBaseline="middle" fontSize={scene.kind === 'park' ? '.65' : '.55'}>{item.name}</text>
        </g>)}
        {snapshot.actors.filter(actor => actor.sceneId === scene.id).map(actor => <g className={`bot-world-actor ${actor.companionId === companionId ? 'is-self' : ''}`} key={actor.companionId} data-world-actor={actor.companionId} data-world-x={actor.position.x} data-world-y={actor.position.y} transform={`translate(${actor.position.x + .5} ${actor.position.y + .5})`}>
          <title>{actor.name} · {t[actor.activity]}</title><circle r=".42" /><text y="-.75" textAnchor="middle" fontSize=".7">{actor.name}</text>
        </g>)}
      </svg>}
      <p className="bot-world-position">{own.name} · {t[own.activity]} · {snapshot.scenes.find(item => item.id === own.sceneId)?.name} · {t.position}（{own.position.x.toFixed(1)}, {own.position.y.toFixed(1)}）</p>
      <div className="bot-world-actions"><select aria-label={t.objects} value={objectId} onChange={event => setObjectId(event.target.value)}><option value="">{t.choose}</option>{scene.objects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        {(supported[object?.kind ?? ''] ?? []).map(action => <button key={action} disabled={busy || own.sceneId !== scene.id} onClick={() => void act({ operation: 'interact', objectId, action, expectedRevision: snapshot.revision })}>{t[action]}</button>)}
        <button disabled={busy} onClick={() => void act({ operation: 'interact', action: 'stand', expectedRevision: snapshot.revision })}>{t.stand}</button></div>
      <p className="bot-world-hint">{view === '3d' ? t.hint3d : t.hint}</p>
    </>}
  </section>;
}

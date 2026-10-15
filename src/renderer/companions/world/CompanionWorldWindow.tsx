import { useEffect, useMemo, useState } from 'react';
import type { WorldlineBoxCompanionsApi } from '../../../shared/companions';
import { companionWorldObserverRequestSchema, type CompanionWorldWindowApi, type CompanionWorldWindowContext } from '../../../shared/companion-world-window';
import { CompanionWorld } from './CompanionWorld';
import './companion-world-window.css';

/** A narrow observer renderer. It never mounts the chat/DSH/application shell. */
export function CompanionWorldWindow() {
  const bridge = (window as unknown as { worldlinebox?: { companionWorld?: CompanionWorldWindowApi } }).worldlinebox?.companionWorld;
  const [context, setContext] = useState<CompanionWorldWindowContext>();
  const [error, setError] = useState('');
  const [documentVisible, setDocumentVisible] = useState(!document.hidden);
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const load = async () => {
      try { const response = await bridge.context(); if (!active) return;
        if (response.ok && response.context) { setContext(response.context); setError(''); } else setError(response.error ?? '世界窗口暂时无法初始化。');
      } catch { if (active) setError('世界窗口暂时无法初始化。'); }
    };
    void load(); const changed = bridge.onChanged(() => { void load(); });
    const visibility = bridge.onVisibility(value => setContext(previous => previous ? { ...previous, ...value } : previous));
    const documentVisibility = () => setDocumentVisible(!document.hidden);
    document.addEventListener('visibilitychange', documentVisibility);
    return () => { active = false; changed(); visibility(); document.removeEventListener('visibilitychange', documentVisibility); };
  }, [bridge]);
  const api = useMemo<WorldlineBoxCompanionsApi | undefined>(() => bridge ? {
    request: input => bridge.request(companionWorldObserverRequestSchema.parse(input)),
    onChanged: listener => bridge.onChanged(listener), onReplyStream: () => () => undefined,
  } : undefined, [bridge]);
  return <main className="companion-world-window" data-world-observer-key={context?.observerKey}>
    {error || !bridge ? <p role="alert">{error || '世界窗口桥接不可用。'}</p> : !context ? <p role="status">正在打开伙伴世界…</p> :
      <CompanionWorld api={api} companions={context.companions} initialCompanionId={context.companionId} initialSceneId={context.sceneId} initialView={context.view}
        observerKey={context.observerKey} visibleWindowCount={context.visibleWindowCount} active={context.visible && documentVisible}
        onClose={() => { void bridge.control('close'); }} onOpenWindow={(sceneId, view) => { void bridge.open({ sceneId, view }); }} />}
  </main>;
}

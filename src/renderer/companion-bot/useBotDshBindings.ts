import { useCallback, useEffect, useRef, useState } from 'react';
import type { DshLauncherState, WorldlineBoxDshLauncherApi } from '../../shared/dsh-launcher';

/** The launcher default is the shared executor for every companion. CLI selection is independent. */
export function useBotDshBindings(api?: WorldlineBoxDshLauncherApi) {
  const [state, setState] = useState<DshLauncherState>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const revision = useRef(0), mounted = useRef(true);
  const accept = useCallback((value: DshLauncherState) => {
    ++revision.current; setState(value); setLoading(false); setError('');
  }, []);
  const refresh = useCallback(async () => {
    const current = ++revision.current; setLoading(true); setError('');
    if (!api) { setState(undefined); setLoading(false); return; }
    try {
      const response = await api.request({ type: 'state' });
      if (!mounted.current || current !== revision.current) return;
      if (response.ok && response.state) setState(response.state);
      else { setState(undefined); setError(response.ok ? 'DSH 未返回实例信息。' : response.error); }
    } catch (cause) { if (mounted.current && current === revision.current) { setState(undefined); setError(String(cause)); } }
    finally { if (mounted.current && current === revision.current) setLoading(false); }
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    const requests = revision;
    let live = true;
    const unsubscribe = api?.onChanged(accept);
    void Promise.resolve().then(() => { if (live) void refresh(); });
    return () => { live = false; mounted.current = false; ++requests.current; unsubscribe?.(); };
  }, [api, accept, refresh]);
  return { state, error, loading, accept, refresh };
}

export function sharedDshInstance(state: DshLauncherState | undefined) {
  return state?.instances.find(value => value.isDefault);
}

/** Readiness applies equally to direct chats, groups and calls. */
export function hasSharedDshBinding(state: DshLauncherState | undefined): boolean {
  const instance = sharedDshInstance(state);
  return state?.supported === true && !!instance && state.runtimes.some(value => value.id === instance.runtimeId);
}

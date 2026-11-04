import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BotWorldScene, BotWorldSnapshot } from '../../shared/companion-bot-world';
import { createBotWorldViewport, type BotWorldViewport } from './world-3d';

export function BotWorld3D({ snapshot, scene, active, onMove, onFallback }: {
  snapshot: BotWorldSnapshot; scene: BotWorldScene; active: boolean;
  onMove(x: number, y: number): void; onFallback(message: string): void;
}) {
  const container = useRef<HTMLDivElement>(null), viewport = useRef<BotWorldViewport | undefined>(undefined);
  const callbacks = useRef({ onMove, onFallback }), [failure, setFailure] = useState('');
  useLayoutEffect(() => { callbacks.current = { onMove, onFallback }; }, [onMove, onFallback]);
  const fail = useCallback((message: string) => { setFailure(message); callbacks.current.onFallback(message); }, []);
  useEffect(() => {
    let disposed = false;
    try { if (container.current) viewport.current = createBotWorldViewport(container.current, fail, (x, y) => callbacks.current.onMove(x, y)); }
    catch (error) { queueMicrotask(() => { if (!disposed) fail(error instanceof Error ? error.message : '3D不可用'); }); }
    return () => { disposed = true; viewport.current?.dispose(); viewport.current = undefined; };
  }, [fail]);
  useEffect(() => {
    let active = true;
    try { viewport.current?.update(snapshot, scene); }
    catch (error) { queueMicrotask(() => { if (active) fail(error instanceof Error ? error.message : '3D不可用'); }); }
    return () => { active = false; };
  }, [snapshot, scene, fail]);
  useEffect(() => { viewport.current?.setActive(active); }, [active]);
  return <div className="bot-world-3d" ref={container}>{failure && <p role="alert">{failure}</p>}</div>;
}

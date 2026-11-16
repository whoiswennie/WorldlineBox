import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Live2DRenderer } from '@soullink-emotion/live2d-pixi';
import type { PartialFACSLikeState } from '@soullink-emotion/engine';
import { type BotCallCue, type BotCallModel, type BotCallModelCatalog } from '../../shared/companion-call';
import { botAssetUrl } from './BotAvatar';
import { BOT_CALL_PORTRAIT_SCALE } from './call-presentation';
import type { BotCallPerformance } from './call-performance';
import { trackCallGaze } from './call-gaze';

export interface BotLive2DControls {
  catalog: BotCallModelCatalog;
  expression(name: string): void; motion(index: number): void; reset(): void; scale(value: number): void; present(cue?: BotCallCue, text?: string): void;
  pose(values: PartialFACSLikeState): void; gesture(kind: 'nod' | 'shake' | 'blink'): void; idle(enabled: boolean): void; gaze(enabled: boolean): void;
  position(x: number, y: number): void;
  fullBody(enabled: boolean): void;
  hasBodyShape?: boolean;
  bodyShape?(value: number): void;
  presence?(value: 'idle' | 'waiting' | 'speaking'): void;
  audio?(value: number): void;
}
export function BotLive2DStage({ model, name, desktopPet, onReady, onError }: { model: BotCallModel; name: string; desktopPet: boolean; onReady(controls: BotLive2DControls): void; onError(message: string): void }) {
  const host = useRef<HTMLDivElement>(null), performanceLayer = useRef<BotCallPerformance>(undefined), controls = useRef<BotLive2DControls>(undefined);
  const minimumResolution = useRef(1);
  useLayoutEffect(() => { minimumResolution.current = desktopPet ? 2 : 1; }, [desktopPet]);
  useEffect(() => {
    let cancelled = false, frame = 0, loaded = false, disposed = false, renderer: Live2DRenderer | undefined, resize: ResizeObserver | undefined, gaze: ReturnType<typeof trackCallGaze> | undefined;
    let disposeAvatar: (() => void) | undefined;
    const dispose = () => { if (renderer && !disposed) { disposed = true; renderer.destroy(); } };
    const load = async () => {
      // Pixi's interpreter patch keeps JavaScript eval blocked by the app CSP.
      const [{ Live2DRenderer, createScriptTagCubismLoader }, { createCallAvatar }] = await Promise.all([import('@soullink-emotion/live2d-pixi'), import('./call-avatar'), import('@pixi/unsafe-eval')]);
      if (cancelled || !host.current) return;
      const modelUrl = model.modelUrl ?? botAssetUrl('companion-call/' + model.model);
      const catalog = model.assets;
      const loadCore = createScriptTagCubismLoader(botAssetUrl('companion-call/live2dcubismcore.min.js'));
      renderer = new Live2DRenderer(host.current, { cubismLoader: async () => {
        await loadCore();
        for (let attempt = 0; attempt < 100; attempt++) {
          if (cancelled) throw Error('会面已结束。');
          try { const core = Reflect.get(window, 'Live2DCubismCore') as { Version?: { csmGetVersion(): number } } | undefined; if ((core?.Version?.csmGetVersion() ?? 0) > 0) return; } catch { /* Embedded WASM is still initializing. */ }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw Error('Live2D 运行库初始化超时。');
      } });
      const parameters = await renderer.load(modelUrl, { automaticIdle: false, animations: model.manifest });
      await renderer.prepareNativeAnimations(catalog.expressions.map(item => item.name), catalog.motions);
      loaded = true;
      if (cancelled) { dispose(); return; }
      const avatar = createCallAvatar({ host: host.current!, renderer, parameters, catalog, modelUrl, name, vts: model.vtsParameters });
      performanceLayer.current = avatar.performance;
      disposeAvatar = avatar.dispose;
      gaze = trackCallGaze(host.current!, avatar.performance, undefined, false);
      let viewScale = BOT_CALL_PORTRAIT_SCALE, viewX = 0, viewY = 0, fullBody = false;
      const reportFigure = () => {
        const bounds = renderer!.getFigureBounds();
        const node = host.current;
        if (node && bounds) {
          node.dataset.petFigure = [bounds.x, bounds.y, bounds.width, bounds.height].map(Math.round).join(',');
          const head = avatar.captionHead();
          if (head) node.dataset.petHead = [head.x, head.y, head.width, head.height].map(Math.round).join(',');
        }
      };
      const frameView = (value = viewScale) => {
        viewScale = Math.max(.4, Math.min(3, value));
        const width = host.current?.clientWidth ?? 0, height = host.current?.clientHeight ?? 0;
        renderer!.setViewScale(viewScale);
        renderer!.setViewOffset({ x: width * viewX, y: height * (viewY + (fullBody ? 0 : Math.max(0, viewScale - 1) * .48)) });
        reportFigure();
      };
      frameView(); resize = new ResizeObserver(() => frameView()); resize.observe(host.current!);
      controls.current = { ...avatar.controls,
        scale: value => frameView(value),
        gaze(enabled) { avatar.performance.gaze(enabled); gaze?.enabled(enabled); },
        position(x, y) { viewX = x; viewY = y; frameView(); },
        fullBody(enabled) { fullBody = enabled; renderer!.setFullBody?.(enabled); frameView(); },
      };
      const update = () => {
        if (cancelled) return;
        const ratio = host.current?.ownerDocument.defaultView?.devicePixelRatio;
        if (ratio !== lastRatio || minimumResolution.current !== lastMinimum) {
          lastRatio = ratio; lastMinimum = minimumResolution.current;
          renderer!.syncViewport?.(lastMinimum);
          reportFigure();
        }
        avatar.update(minimumResolution.current > 1 ? host.current?.ownerDocument.defaultView ?? undefined : undefined);
        frame = requestAnimationFrame(update);
      };
      let lastRatio: number | undefined, lastMinimum = 0;
      update(); onReady(controls.current);
    };
    void load().catch(error => { loaded = true; if (!cancelled) onError(error instanceof Error ? error.message : '形象暂时无法载入。'); dispose(); });
    return () => { cancelled = true; cancelAnimationFrame(frame); resize?.disconnect(); gaze?.stop(); disposeAvatar?.(); performanceLayer.current = undefined; controls.current = undefined; if (loaded) dispose(); };
  }, [model, name, onReady, onError]);
  return <div className="bot-call-live2d" ref={host} aria-label={name + ' Live2D'} />;
}

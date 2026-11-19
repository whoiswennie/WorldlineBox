import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Live2DRenderer } from '@soullink-emotion/live2d-pixi';
import type { PartialFACSLikeState } from '@soullink-emotion/engine';
import { type BotCallCue, type BotCallModel, type BotCallModelCatalog } from '../../shared/companion-call';
import { botAssetUrl } from './BotAvatar';
import { BOT_CALL_ZOOM, usesAutomaticBotCallFraming, type BotCallFraming } from './call-preferences';
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
export function BotLive2DStage({ model, name, desktopPet, hidden = false, framing, onReady, onError }: { model: BotCallModel; name: string; desktopPet: boolean; hidden?: boolean; framing: BotCallFraming; onReady(controls: BotLive2DControls): void; onError(message: string): void }) {
  const host = useRef<HTMLDivElement>(null), performanceLayer = useRef<BotCallPerformance>(undefined), controls = useRef<BotLive2DControls>(undefined);
  const minimumResolution = useRef(1);
  const frameRenderer = useRef<Live2DRenderer>(undefined);
  const initialFraming = useRef(framing);
  const visible = useRef(!hidden);
  const updateRendering = useRef<(visible: boolean) => void>(undefined);
  useLayoutEffect(() => {
    minimumResolution.current = desktopPet ? 2 : 1;
    frameRenderer.current?.syncFrameClock();
  }, [desktopPet]);
  useLayoutEffect(() => { initialFraming.current = framing; }, [framing]);
  useLayoutEffect(() => {
    visible.current = !hidden;
    updateRendering.current?.(!hidden);
  }, [hidden]);
  useEffect(() => {
    let cancelled = false, loaded = false, disposed = false, renderer: Live2DRenderer | undefined, resize: ResizeObserver | undefined, gaze: ReturnType<typeof trackCallGaze> | undefined;
    let stopFrame: (() => void) | undefined;
    let disposeAvatar: (() => void) | undefined;
    const dispose = () => { if (renderer && !disposed) { disposed = true; renderer.destroy(); } };
    const load = async () => {
      // Pixi's interpreter patch keeps JavaScript eval blocked by the app CSP.
      const [{ Live2DRenderer, createScriptTagCubismLoader }, { createCallAvatar }] = await Promise.all([import('@soullink-emotion/live2d-pixi'), import('./call-avatar'), import('@pixi/unsafe-eval')]);
      if (cancelled || !host.current) return;
      const modelUrl = model.modelUrl ?? botAssetUrl('companion-call/' + model.model);
      const automaticFraming = usesAutomaticBotCallFraming(model);
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
      frameRenderer.current = renderer;
      renderer.syncViewport(minimumResolution.current);
      let { scale: viewScale, x: viewX, y: viewY, fullBody } = initialFraming.current;
      const viewOffset = () => {
        const width = host.current?.clientWidth ?? 0, height = host.current?.clientHeight ?? 0;
        const portraitOffset = automaticFraming || fullBody ? 0 : Math.max(0, viewScale - 1) * .48;
        return { x: width * viewX, y: height * (viewY + portraitOffset) };
      };
      renderer.setFullBody(fullBody);
      renderer.setViewScale(viewScale);
      renderer.setViewOffset(viewOffset());
      const parameters = await renderer.load(modelUrl, { automaticIdle: false, automaticFraming, animations: model.manifest });
      await renderer.prepareNativeAnimations(catalog.expressions.map(item => item.name), catalog.motions);
      loaded = true;
      if (cancelled) { dispose(); return; }
      const avatar = createCallAvatar({ host: host.current!, renderer, parameters, catalog, modelUrl, name, vts: model.vtsParameters });
      performanceLayer.current = avatar.performance;
      disposeAvatar = avatar.dispose;
      gaze = trackCallGaze(host.current!, avatar.performance, undefined, false);
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
        viewScale = Math.max(BOT_CALL_ZOOM.min, Math.min(BOT_CALL_ZOOM.max, value));
        renderer!.setViewScale(viewScale);
        renderer!.setViewOffset(viewOffset());
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
      };
      let lastRatio: number | undefined, lastMinimum = 0;
      updateRendering.current = show => {
        if (!show) {
          stopFrame?.();
          stopFrame = undefined;
        } else if (!stopFrame) {
          renderer!.syncViewport(minimumResolution.current);
          frameView();
          update();
          stopFrame = renderer!.onFrame(update);
        }
      };
      updateRendering.current(visible.current);
      onReady(controls.current);
    };
    void load().catch(error => { loaded = true; if (!cancelled) onError(error instanceof Error ? error.message : '形象暂时无法载入。'); dispose(); });
    return () => { cancelled = true; stopFrame?.(); resize?.disconnect(); gaze?.stop(); disposeAvatar?.(); performanceLayer.current = undefined; controls.current = undefined; frameRenderer.current = undefined; updateRendering.current = undefined; if (loaded) dispose(); };
  }, [model, name, onReady, onError]);
  return <div className="bot-call-live2d" ref={host} hidden={hidden} aria-label={name + ' Live2D'} />;
}

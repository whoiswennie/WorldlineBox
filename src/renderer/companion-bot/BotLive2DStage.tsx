import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Live2DRenderer } from '@soullink-emotion/live2d-pixi';
import type { PartialFACSLikeState } from '@soullink-emotion/engine';
import { botCallMotionId, type BotCallCue, type BotCallModel, type BotCallModelCatalog } from '../../shared/companion-call';
import { botAssetUrl } from './BotAvatar';
import { BOT_CALL_PORTRAIT_SCALE, botCallProfile } from './call-presentation';
import { BotCallPerformance } from './call-performance';
import { trackCallGaze } from './call-gaze';

export interface BotLive2DControls {
  catalog: BotCallModelCatalog;
  expression(name: string): void; motion(index: number): void; reset(): void; scale(value: number): void; present(cue?: BotCallCue): void;
  pose(values: PartialFACSLikeState): void; gesture(kind: 'nod' | 'shake' | 'blink'): void; idle(enabled: boolean): void; gaze(enabled: boolean): void;
  position(x: number, y: number): void;
  fullBody(enabled: boolean): void;
  presence?(value: 'idle' | 'waiting' | 'speaking'): void;
  audio?(value: number): void;
}
export function BotLive2DStage({ model, name, desktopPet, onReady, onError }: { model: BotCallModel; name: string; desktopPet: boolean; onReady(controls: BotLive2DControls): void; onError(message: string): void }) {
  const host = useRef<HTMLDivElement>(null), performanceLayer = useRef<BotCallPerformance>(undefined), controls = useRef<BotLive2DControls>(undefined);
  const minimumResolution = useRef(1);
  useLayoutEffect(() => { minimumResolution.current = desktopPet ? 2 : 1; }, [desktopPet]);
  useEffect(() => {
    let cancelled = false, frame = 0, loaded = false, disposed = false, renderer: Live2DRenderer | undefined, resize: ResizeObserver | undefined, gaze: ReturnType<typeof trackCallGaze> | undefined;
    const dispose = () => { if (renderer && !disposed) { disposed = true; renderer.destroy(); } };
    const load = async () => {
      // Pixi's interpreter patch keeps JavaScript eval blocked by the app CSP.
      const [{ Live2DRenderer, createScriptTagCubismLoader }, { SoullinkRuntime }] = await Promise.all([import('@soullink-emotion/live2d-pixi'), import('@soullink-emotion/engine'), import('@pixi/unsafe-eval')]);
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
      const startedAt = performance.now(), clock = () => (performance.now() - startedAt) / 1000;
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      const profile = botCallProfile(parameters, modelUrl, name, model.vtsParameters);
      const engine = new SoullinkRuntime({ profile, motionStyle: { seed: crypto.getRandomValues(new Uint32Array(1))[0], spontaneity: reducedMotion ? .25 : 1, microMotionGain: reducedMotion ? .5 : 1.15, idleActionGain: reducedMotion ? .4 : 1.1, gazeStability: .64 } });
      const performanceState = new BotCallPerformance(engine, clock, reducedMotion);
      performanceLayer.current = performanceState;
      performanceState.gaze(false);
      gaze = trackCallGaze(host.current!, performanceState, undefined, false);
      let viewScale = BOT_CALL_PORTRAIT_SCALE, viewX = 0, viewY = 0, fullBody = false;
      const reportFigure = () => {
        const bounds = renderer!.getFigureBounds();
        if (host.current && bounds) host.current.dataset.petFigure = [bounds.x, bounds.y, bounds.width, bounds.height].map(Math.round).join(',');
      };
      const frameView = (value = viewScale) => {
        viewScale = Math.max(.4, Math.min(3, value));
        const width = host.current?.clientWidth ?? 0, height = host.current?.clientHeight ?? 0;
        renderer!.setViewScale(viewScale);
        renderer!.setViewOffset({ x: width * viewX, y: height * (viewY + (fullBody ? 0 : Math.max(0, viewScale - 1) * .48)) });
        reportFigure();
      };
      frameView(); resize = new ResizeObserver(() => frameView()); resize.observe(host.current!);
      const idleMotions = catalog.motions.filter(item => /^idle$/iu.test(item.group) && item.duration > 0);
      let previous = clock(), token = 0, selectedExpression = '';
      let selectedMotion: BotCallModelCatalog['motions'][number] | undefined;
      let stageActive = false, idleEnabled = true, idleIndex = -1, idleUntil = 0, idleAt = 0, manualMotionUntil = 0;
      const scheduleIdle = (soon = false) => { idleAt = clock() + (soon ? 1.5 : 3 + Math.random() * 4); };
      const stopMotion = () => {
        manualMotionUntil = 0;
        if (!selectedMotion) return;
        renderer!.stopNativeMotion();
        renderer!.restoreMotionParameters(selectedMotion.params);
        selectedMotion = undefined;
      };
      const stopIdle = () => {
        if (idleUntil) {
          stopMotion();
          renderer!.applyNativeAnimation(null);
        }
        idleUntil = 0;
        scheduleIdle();
      };
      const apply = (playMotion: boolean) => {
        const expression = catalog.expressions.find(item => item.name === selectedExpression);
        const motion = selectedMotion;
        renderer!.applyNativeAnimation(expression || motion ? {
          token: ++token,
          expression: expression?.name ?? null,
          motion: playMotion && motion ? { group: motion.group, index: motion.index, priority: 'force' } : null,
          suppressParamIds: [...new Set([...(expression?.params ?? []), ...(motion?.params ?? [])])],
        } : null);
      };
      scheduleIdle(true);
      controls.current = { catalog,
        audio: value => performanceState.audio(value),
        expression(name) { stopIdle(); selectedExpression = name; apply(false); },
        motion(index) {
          stopIdle(); stopMotion();
          selectedMotion = catalog.motions[index];
          if (selectedMotion) manualMotionUntil = clock() + selectedMotion.duration + .1;
          apply(true);
        },
        reset() {
          stopIdle();
          selectedExpression = ''; selectedMotion = undefined; stageActive = false; manualMotionUntil = 0;
          performanceState.reset(); renderer!.resetPose();
        },
        scale(value) { frameView(value); },
        present(cue) {
          stopIdle();
          stopMotion();
          stageActive = !!cue;
          selectedExpression = cue?.expression ?? '';
          performanceState.setGesture(cue?.gesture);
          // Each beat owns its pose, including a fresh start when replaying.
          renderer!.applyNativeAnimation(null);
          selectedMotion = catalog.motions.find(item => botCallMotionId(item) === cue?.motion);
          apply(true);
        },
        pose(values) { performanceState.pose(values); },
        gesture(kind) { stopIdle(); performanceState.setGesture(kind); },
        idle(enabled) { idleEnabled = enabled; stopIdle(); if (enabled) scheduleIdle(true); performanceState.idle(enabled); },
        presence(value) { performanceState.setPresence(value); },
        gaze(enabled) { performanceState.gaze(enabled); gaze?.enabled(enabled); },
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
        const now = clock(), snapshot = performanceState.update(now, now - previous);
        if (idleUntil && now >= idleUntil) stopIdle();
        if (manualMotionUntil && now >= manualMotionUntil) {
          stopMotion(); apply(false); scheduleIdle();
        }
        if (idleEnabled && !reducedMotion && !stageActive && !selectedExpression && !selectedMotion && idleMotions.length && !idleUntil && now >= idleAt) {
          idleIndex = (idleIndex + 1) % idleMotions.length;
          const motion = idleMotions[idleIndex]!;
          selectedMotion = motion;
          idleUntil = now + motion.duration;
          renderer!.applyNativeAnimation({ token: ++token, expression: null,
            motion: { group: motion.group, index: motion.index, priority: 'idle' }, suppressParamIds: motion.params });
        }
        renderer!.setParameters(snapshot.live2dParams);
        previous = now; frame = requestAnimationFrame(update);
      };
      let lastRatio: number | undefined, lastMinimum = 0;
      update(); onReady(controls.current);
    };
    void load().catch(error => { loaded = true; if (!cancelled) onError(error instanceof Error ? error.message : '形象暂时无法载入。'); dispose(); });
    return () => { cancelled = true; cancelAnimationFrame(frame); resize?.disconnect(); gaze?.stop(); performanceLayer.current = undefined; controls.current = undefined; if (loaded) dispose(); };
  }, [model, name, onReady, onError]);
  return <div className="bot-call-live2d" ref={host} aria-label={name + ' Live2D'} />;
}

import { useEffect, useRef } from 'react';
import type { Live2DRenderer } from '@soullink-emotion/live2d-pixi';
import type { NativeAnimationDirective, PartialFACSLikeState } from '@soullink-emotion/engine';
import { botAssetUrl } from './BotAvatar';
import { BOT_CALL_PORTRAIT_SCALE, botCallProfile, type BotCallModelCatalog } from './call-presentation';
import { BotCallPerformance, type BotCallSpeechState } from './call-performance';
import { trackCallGaze } from './call-gaze';

export interface BotLive2DControls {
  catalog: BotCallModelCatalog;
  expression(name: string): void; motion(index: number): void; reset(): void; scale(value: number): void; react(text: string): void;
  pose(values: PartialFACSLikeState): void; gesture(kind: 'nod' | 'shake' | 'blink'): void; idle(enabled: boolean): void; gaze(enabled: boolean): void; view(upper: boolean): void;
  speech(state: BotCallSpeechState): void;
}
export function BotLive2DStage({ onReady, onError, reaction }: { onReady(controls: BotLive2DControls): void; onError(message: string): void; reaction?: { id: string; text: string } }) {
  const host = useRef<HTMLDivElement>(null), performanceLayer = useRef<BotCallPerformance>(undefined), controls = useRef<BotLive2DControls>(undefined), lastReaction = useRef('');
  const latestReaction = useRef(reaction);
  useEffect(() => {
    let cancelled = false, frame = 0, loaded = false, disposed = false, renderer: Live2DRenderer | undefined, timer: ReturnType<typeof setTimeout> | undefined, resize: ResizeObserver | undefined, gaze: ReturnType<typeof trackCallGaze> | undefined;
    const dispose = () => { if (renderer && !disposed) { disposed = true; renderer.destroy(); } };
    const load = async () => {
      // Pixi's interpreter patch keeps JavaScript eval blocked by the app CSP.
      const [{ Live2DRenderer, createScriptTagCubismLoader }, { SoullinkRuntime, SpeechPerformancePlanner, deriveSpeechPerformanceCapabilities }] = await Promise.all([import('@soullink-emotion/live2d-pixi'), import('@soullink-emotion/engine'), import('@pixi/unsafe-eval')]);
      if (cancelled || !host.current) return;
      const modelUrl = botAssetUrl('companion-call/deepseek/call.model3.json');
      const response = await fetch(botAssetUrl('companion-call/deepseek/catalog.json'));
      if (!response.ok) throw Error('本机的大肥鱼模型尚未安装。');
      const catalog = await response.json() as BotCallModelCatalog;
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
      const parameters = await renderer.load(modelUrl); loaded = true;
      if (cancelled) { dispose(); return; }
      const startedAt = performance.now(), clock = () => (performance.now() - startedAt) / 1000;
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
      const profile = botCallProfile(parameters, modelUrl, catalog);
      const engine = new SoullinkRuntime({ profile, motionStyle: { seed: 20261105, spontaneity: reducedMotion ? .25 : 1, microMotionGain: reducedMotion ? .5 : 1.15, idleActionGain: reducedMotion ? .4 : 1.1, gazeStability: .64 } });
      const performanceState = new BotCallPerformance(engine, new SpeechPerformancePlanner(), profile, deriveSpeechPerformanceCapabilities(profile, { reducedMotion }), clock, reducedMotion);
      performanceLayer.current = performanceState;
      gaze = trackCallGaze(host.current!, performanceState);
      let viewScale = BOT_CALL_PORTRAIT_SCALE;
      const frameView = (value = viewScale) => { viewScale = Math.max(.65, Math.min(2.2, value)); renderer!.setViewScale(viewScale); renderer!.setViewOffset({ x: 0, y: (host.current?.clientHeight ?? 0) * (viewScale - 1) * .48 }); };
      frameView(); resize = new ResizeObserver(() => frameView()); resize.observe(host.current!);
      let previous = clock(), token = 1, selectedExpression = '', selectedMotion = -1, revision = 0, motionRevision = 0;
      let renderedSource = '', renderedMotion = '', activeDirective: NativeAnimationDirective | null = null;
      const mouthIds = profile.parameterMap.mouthOpen?.targets ?? [];
      const apply = (automatic: NativeAnimationDirective | null = null, speaking = false) => {
        const expression = catalog.expressions.find(item => item.name === selectedExpression), motion = catalog.motions[selectedMotion];
        const manual = !!expression || !!motion;
        const source = manual ? `manual:${revision}` : automatic ? `runtime:${automatic.token}` : '';
        const desiredMotion = manual ? motion ? { group: motion.group, index: motion.index, priority: 'force' as const } : null : automatic?.motion ?? null;
        const motionKey = desiredMotion ? manual ? `manual:${selectedMotion}:${motionRevision}` : `${source}:${desiredMotion.group}:${desiredMotion.index}` : '';
        const suppressed = manual ? [...new Set([...(expression?.params ?? []), ...(motion?.params ?? [])])] : automatic?.suppressParamIds ?? [];
        if (source !== renderedSource) {
          activeDirective = source ? { token: token++, expression: manual ? expression?.name ?? null : automatic?.expression ?? null,
            motion: motionKey !== renderedMotion ? desiredMotion : null, suppressParamIds: suppressed } : null;
          renderedSource = source; renderedMotion = motionKey;
        }
        // Update ownership with the same token so audio frames do not restart a native clip.
        renderer!.applyNativeAnimation(activeDirective ? { ...activeDirective, suppressParamIds: speaking ? suppressed.filter(id => !mouthIds.includes(id)) : suppressed } : null);
      };
      controls.current = { catalog,
        expression(name) { selectedExpression = name; ++revision; },
        motion(index) { clearTimeout(timer); selectedMotion = index; ++revision; ++motionRevision;
          const motion = catalog.motions[index]; if (motion) timer = setTimeout(() => { selectedMotion = -1; ++revision; }, Math.max(500, motion.duration * 1000 + 300)); },
        reset() { clearTimeout(timer); selectedExpression = ''; selectedMotion = -1; ++revision; performanceState.reset(); renderer!.resetPose(); renderedSource = ''; renderedMotion = ''; activeDirective = null; },
        scale(value) { frameView(value); }, react(text) { performanceState.react(text); }, speech(state) { performanceState.speech(state); },
        pose(values) { performanceState.pose(values); }, gesture(kind) { performanceState.triggerGesture(kind); }, idle(enabled) { performanceState.idle(enabled); }, gaze(enabled) { performanceState.gaze(enabled); gaze?.enabled(enabled); },
        view(upper) { frameView(upper ? BOT_CALL_PORTRAIT_SCALE : 1); },
      };
      const update = () => {
        if (cancelled) return;
        const now = clock(), snapshot = performanceState.update(now, now - previous);
        renderer!.setParameters(snapshot.live2dParams);
        apply(['IDLE', 'RECOVERING'].includes(snapshot.state) ? null : snapshot.nativeAnimation, snapshot.speaking);
        previous = now; frame = requestAnimationFrame(update);
      };
      update(); onReady(controls.current);
      // Opening a visit must not replay an old message's emotional performance.
      if (latestReaction.current) lastReaction.current = latestReaction.current.id;
    };
    void load().catch(error => { loaded = true; if (!cancelled) onError(error instanceof Error ? error.message : '形象暂时无法载入。'); dispose(); });
    return () => { cancelled = true; clearTimeout(timer); cancelAnimationFrame(frame); resize?.disconnect(); gaze?.stop(); performanceLayer.current?.speech({ playing: false, level: 0 }); performanceLayer.current = undefined; controls.current = undefined; if (loaded) dispose(); };
  }, [onReady, onError]);
  useEffect(() => { latestReaction.current = reaction; if (!reaction || reaction.id === lastReaction.current || !controls.current) return; lastReaction.current = reaction.id; controls.current.react(reaction.text); }, [reaction]);
  return <div className="bot-call-live2d" ref={host} aria-label="大肥鱼 Live2D 互动形象" />;
}

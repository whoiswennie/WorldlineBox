import type { Live2DRenderer, Live2DMotionParameterInfo, Live2DParamState } from '@soullink-emotion/live2d-pixi';
import { SoullinkRuntime, type PartialFACSLikeState } from '@soullink-emotion/engine';
import { botCallMotionId, type BotCallCue, type BotCallModel, type BotCallModelCatalog } from '../../shared/companion-call';
import { botCallProfile } from './call-presentation';
import { BotCallPerformance } from './call-performance';
import { CallCharacterMotion } from './call-character-motion';

interface CallAvatarOptions {
  host: HTMLElement;
  renderer: Live2DRenderer;
  parameters: Record<string, Live2DMotionParameterInfo>;
  catalog: BotCallModelCatalog;
  modelUrl: string;
  name: string;
  vts?: BotCallModel['vtsParameters'];
}

/** Shared by desktop video, the Windows desktop pet and the Android WebView. */
export function createCallAvatar({ host, renderer, parameters, catalog, modelUrl, name, vts }: CallAvatarOptions) {
  const startedAt = performance.now(), clock = () => (performance.now() - startedAt) / 1000;
  const reducedMotion = host.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const profile = botCallProfile(parameters, modelUrl, name, vts);
  const idleMotions = catalog.motions.filter(item => /^idle$/iu.test(item.group) && item.duration > 0);
  const character = new CallCharacterMotion(profile, parameters, { reduced: reducedMotion, nativeIdle: !!idleMotions.length });
  const hasBodyShape = character.dafeiyu && Object.hasOwn(parameters, 'Clothes2');
  const appearanceModes = ['default', 'heart', 'glasses'] as const;
  let appearance = 0, bodyShape = parameters.Clothes2?.default ?? 0;
  let bodyShapeTarget: number | undefined;
  let greeting = character.dafeiyu && Object.hasOwn(parameters, 'Movement3') && !reducedMotion;
  const engine = new SoullinkRuntime({ profile, motionStyle: { seed: crypto.getRandomValues(new Uint32Array(1))[0], spontaneity: reducedMotion ? .25 : 1, microMotionGain: reducedMotion ? .5 : 1.15, idleActionGain: reducedMotion ? .4 : character.proceduralIdle ? 0 : 1.1, gazeStability: .64 } });
  const performanceState = new BotCallPerformance(engine, clock, reducedMotion);
  performanceState.gaze(false);
  let previous = clock(), token = 0, selectedExpression = '';
  let selectedMotion: BotCallModelCatalog['motions'][number] | undefined;
  let stageActive = false, idleEnabled = true, idleIndex = -1, idleUntil = 0, idleAt = 0, manualMotionUntil = 0;
  const scheduleIdle = (soon = false) => { idleAt = clock() + (soon ? 1.5 : 3 + Math.random() * 4); };
  const stopMotion = () => {
    manualMotionUntil = 0;
    if (!selectedMotion) return;
    renderer.stopNativeMotion();
    renderer.restoreMotionParameters(selectedMotion.params);
    selectedMotion = undefined;
  };
  const stopIdle = () => {
    if (idleUntil) {
      stopMotion();
      renderer.applyNativeAnimation(null);
    }
    idleUntil = 0;
    scheduleIdle();
  };
  const apply = (playMotion: boolean) => {
    const expression = catalog.expressions.find(item => item.name === selectedExpression);
    const motion = selectedMotion;
    renderer.applyNativeAnimation(expression || motion ? {
      token: ++token,
      expression: expression?.name ?? null,
      motion: playMotion && motion ? { group: motion.group, index: motion.index, priority: 'force' } : null,
      suppressParamIds: [...new Set([...(expression?.params ?? []), ...(motion?.params ?? [])])],
    } : null);
  };
  scheduleIdle(true);
  const stopTouch = trackCharacterTouch(host, renderer, character, clock, () => {
    greeting = false;
    stopIdle();
  }, () => {
    if (!stageActive && ['爱心眼', '黑框眼镜'].includes(selectedExpression)) {
      selectedExpression = '';
      renderer.applyNativeAnimation(null);
      apply(false);
    }
    appearance = (appearance + 1) % appearanceModes.length;
  });
  const controls = { catalog,
    hasBodyShape,
    bodyShape(value: number) {
      if (!hasBodyShape || !Number.isFinite(value)) return;
      bodyShapeTarget = Math.max(0, Math.min(1, value));
      if (!stageActive && catalog.expressions.some(item => item.name === selectedExpression && item.params.includes('Clothes2'))) {
        selectedExpression = '';
        renderer.applyNativeAnimation(null);
        apply(false);
      }
    },
    audio: (value: number) => performanceState.audio(value),
    expression(name: string) { stopIdle(); selectedExpression = name; apply(false); },
    motion(index: number) {
      stopIdle(); stopMotion();
      selectedMotion = catalog.motions[index];
      if (selectedMotion) manualMotionUntil = clock() + selectedMotion.duration + .1;
      apply(true);
    },
    reset() {
      stopIdle();
      selectedExpression = ''; selectedMotion = undefined; stageActive = false; manualMotionUntil = 0;
      appearance = 0; bodyShapeTarget = undefined; bodyShape = parameters.Clothes2?.default ?? 0; greeting = false;
      character.reset(); performanceState.reset(); renderer.resetPose();
    },
    present(cue?: BotCallCue, text?: string) {
      stopIdle();
      stopMotion();
      stageActive = !!(cue?.expression || cue?.motion || cue?.gesture);
      selectedExpression = cue?.expression ?? '';
      performanceState.setGesture(cue?.gesture);
      performanceState.setSpeech(text, cue?.durationMs);
      // Each beat owns its pose, including a fresh start when replaying.
      renderer.applyNativeAnimation(null);
      selectedMotion = catalog.motions.find(item => botCallMotionId(item) === cue?.motion);
      apply(true);
    },
    pose(values: PartialFACSLikeState) { performanceState.pose(values); },
    gesture(kind: 'nod' | 'shake' | 'blink') { stopIdle(); performanceState.setGesture(kind); },
    idle(enabled: boolean) { idleEnabled = enabled; stopIdle(); if (enabled) scheduleIdle(true); performanceState.idle(enabled); },
    presence(value: 'idle' | 'waiting' | 'speaking') { performanceState.setPresence(value); },
  };

  const update = (petWindow?: Window) => {
    const now = clock(), dt = Math.min(.1, Math.max(0, now - previous));
    character.moveWindow(petWindow, dt);
    const canIdle = idleEnabled && !stageActive && performanceState.calm;
    if (idleUntil && (!canIdle || character.engaged)) stopIdle();
    if (idleUntil && now >= idleUntil) stopIdle();
    if (manualMotionUntil && now >= manualMotionUntil) {
      stopMotion(); apply(false); scheduleIdle();
    }
    if (canIdle && !character.proceduralIdle && !character.engaged && !reducedMotion && !selectedExpression && !selectedMotion && idleMotions.length && now >= idleAt) {
      idleIndex = (idleIndex + 1) % idleMotions.length;
      const motion = idleMotions[idleIndex]!;
      selectedMotion = motion;
      idleUntil = now + motion.duration;
      renderer.applyNativeAnimation({ token: ++token, expression: null,
        motion: { group: motion.group, index: motion.index, priority: 'idle' }, suppressParamIds: motion.params });
    }
    const canReact = !stageActive && !selectedMotion && !performanceState.gesturing;
    const motion = character.update(now, dt, canIdle && !selectedMotion, canReact, performanceState.pointerWeight, idleEnabled);
    const snapshot = performanceState.update(now, dt, motion.pose, stageActive || !!selectedMotion || performanceState.gesturing);
    const appearanceParams: Live2DParamState = {};
    if (character.dafeiyu) {
      const set = (id: string, value: number) => {
        if (Object.hasOwn(parameters, id)) appearanceParams[id] = value;
      };
      const eyeOwned = ['key3', 'key4', 'key5', 'key6'].some(id => renderer.suppressedParameterIds.has(id));
      const touch = motion.touch;
      const ticklish = touch?.zone === 'waist' || touch?.zone === 'foot';
      if (appearanceModes[appearance] === 'glasses') set('key11', 1);
      if (!eyeOwned) {
        if (ticklish) set('key5', touch.weight);
        else if (motion.dizzy) set('key3', 1);
        else if (appearanceModes[appearance] === 'heart' && !(stageActive && selectedExpression)) set('key4', 1);
      }
      if (touch && (ticklish || ['head', 'cheek', 'hip', 'skirt'].includes(touch.zone))) {
        set('key7', touch.zone === 'head' ? Math.max(touch.pressure, touch.settling ? touch.weight * .66 : 0) : touch.weight);
      }
      if (touch?.zone === 'cheek') {
        const pull = Math.min(1, Math.hypot(touch.pull, touch.verticalPull));
        const pinch = touch.pressure * (.35 + .65 * pull);
        set('CheeckPuff', Math.max(touch.weight * .35, pinch));
        set(touch.direction < 0 ? 'CheeckPuffL' : 'CheeckPuffR', pinch);
        set('CheeksWiggleX', touch.pull * pinch * .7);
        set('CheeksWiggleY', touch.verticalPull * pinch * .5);
        if (pinch > .02) set('LeanInput', -4 - 13 * pinch);
      }
      if (touch?.zone === 'hip' || touch?.zone === 'skirt') set('Movement2', Math.min(1, touch.weight * 1.5));
      if (touch?.zone === 'hand') set('Movement3', Math.min(1, touch.weight * 1.4));
      if (touch?.zone === 'leg' && touch.pressure > .24) set('key8', touch.pressure);
      if (bodyShapeTarget !== undefined) {
        bodyShape += (bodyShapeTarget - bodyShape) * (1 - Math.exp(-dt * 13));
        set('Clothes2', bodyShape);
      }
      if (!canReact || now >= 1.65 || performanceState.speaking) greeting = false;
      if (greeting && now > .30) {
        set('Movement3', Math.max(0, Math.min(1, (now - .30) / .24, (1.65 - now) / .30)));
      }
    }
    renderer.setParameters({ ...snapshot.live2dParams, ...appearanceParams });
    renderer.setSecondaryOffsets(motion.secondary);
    previous = now;
  };
  return { controls, performance: performanceState, update, dispose: stopTouch,
    captionHead() {
      const figure = renderer.getFigureBounds();
      if (!figure) return;
      const center = character.dafeiyu ? .44 : .5;
      const width = figure.width * (character.dafeiyu ? .47 : .55);
      const inset = character.dafeiyu ? .036 * figure.height : 0;
      const height = character.dafeiyu ? .18 * figure.height : Math.min(.28 * figure.height, width);
      return { x: figure.x + center * figure.width - width / 2, y: figure.y + inset, width, height };
    },
  };
}

function trackCharacterTouch(host: HTMLElement, renderer: Live2DRenderer, motion: CallCharacterMotion,
  clock: () => number, stopIdle: () => void, cycleAppearance: () => void) {
  let held: { id: number; x: number; y: number; width: number; forehead: boolean; zone: string; start: number; distance: number } | undefined;
  const hitAt = (event: MouseEvent) => {
    const figure = renderer.getFigureBounds();
    if (!figure) return;
    const bounds = host.getBoundingClientRect();
    const hit = motion.hit(event.clientX - bounds.left, event.clientY - bounds.top, figure);
    if (hit) return { ...hit, width: figure.width };
  };
  const clearHover = () => { host.removeAttribute('data-character-hover'); motion.hover(clock()); };
  const start = (event: PointerEvent) => {
    if (held || (event.button !== 0 && event.button !== 2)) return;
    const hit = hitAt(event);
    if (!hit || event.button === 2 && hit.zone !== 'head' && hit.zone !== 'cheek') return;
    const start = clock();
    held = { id: event.pointerId, x: event.clientX, y: event.clientY, width: hit.width, forehead: event.button === 0 && hit.forehead, zone: hit.zone, start, distance: 0 };
    host.setPointerCapture(event.pointerId);
    stopIdle();
    motion.press(start, hit.zone, hit.direction);
  };
  const move = (event: PointerEvent) => {
    const hit = hitAt(event);
    if (!held) {
      host.toggleAttribute('data-character-hover', event.pointerType === 'mouse' && !!hit);
      motion.hover(clock(), event.pointerType === 'mouse' ? hit : undefined);
      return;
    }
    if (event.pointerId !== held.id) return;
    motion.move((event.clientX - held.x) * 4 / held.width, (event.clientY - held.y) * 4 / held.width, hit?.zone === held.zone);
    held.distance += Math.hypot(event.clientX - held.x, event.clientY - held.y);
    held.x = event.clientX;
    held.y = event.clientY;
  };
  const menu = (event: MouseEvent) => {
    const zone = hitAt(event)?.zone;
    if (zone === 'head' || zone === 'cheek') event.preventDefault();
  };
  const end = (event: PointerEvent) => {
    if (event.pointerId !== held?.id) return;
    const completed = event.type === 'pointerup';
    const now = clock();
    if (completed && held.forehead && now - held.start < .36 && held.distance < held.width * .04 && hitAt(event)?.forehead) {
      motion.cancelTouch();
      cycleAppearance();
    } else motion.release(now, completed);
    held = undefined;
    move(event);
  };
  const endings = ['pointerup', 'pointercancel', 'lostpointercapture'] as const;
  host.addEventListener('pointerdown', start);
  host.addEventListener('pointermove', move);
  host.addEventListener('pointerleave', clearHover);
  host.addEventListener('contextmenu', menu);
  for (const type of endings) host.addEventListener(type, end);
  return () => {
    host.removeEventListener('pointerdown', start);
    host.removeEventListener('pointermove', move);
    host.removeEventListener('pointerleave', clearHover);
    host.removeEventListener('contextmenu', menu);
    for (const type of endings) host.removeEventListener(type, end);
    clearHover();
  };
}

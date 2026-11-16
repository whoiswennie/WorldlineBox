import type { ModelProfile, PartialFACSLikeState } from '@soullink-emotion/engine';
import type { Live2DMotionParameterInfo, Live2DParamState } from '@soullink-emotion/live2d-pixi';

type Pose = PartialFACSLikeState;
type Keyframe = readonly [progress: number, pose: Pose];
type Routine = { duration: number; frames: readonly Keyframe[] };
type TouchZone = 'head' | 'cheek' | 'body' | 'waist' | 'hip' | 'hand' | 'skirt' | 'leg' | 'foot' | 'tail';
type Hit = { zone: TouchZone; direction: number; forehead: boolean };
type Figure = { x: number; y: number; width: number; height: number };
type SecondaryDetail = { id: string; axis: 'x' | 'y' | 'ear'; delay: number; skirt?: boolean };

const rest: Keyframe = [0, {}], end: Keyframe = [1, {}];
const idleRoutines: readonly Routine[] = [
  { duration: 3.8, frames: [rest,
    [.27, { bodyX: .44, bodyZ: -.23, headX: -.10, headZ: .15 }],
    [.67, { bodyX: .33, bodyZ: -.18, headX: -.06, headZ: .10 }], end] },
  { duration: 3.5, frames: [rest,
    [.13, { gazeX: .38 }], [.29, { gazeX: .42, headX: .29, headZ: -.10, bodyX: .18 }],
    [.51, { gazeX: -.36, headX: .19, bodyX: .17 }],
    [.73, { gazeX: -.30, headX: -.24, headZ: .09, bodyX: -.12 }], end] },
  { duration: 4.15, frames: [rest,
    [.30, { headY: -.25, headZ: .12, bodyY: -.23, eyeBlinkL: .32, eyeBlinkR: .34 }],
    [.52, { headY: -.34, headZ: .14, bodyY: -.30, eyeBlinkL: .76, eyeBlinkR: .78 }],
    [.64, { headY: .13, headZ: -.07, bodyY: -.10, browInnerUp: .15 }],
    [.81, { headY: -.045, bodyY: .05 }], end] },
  { duration: 3.25, frames: [rest,
    [.29, { headY: .21, headZ: -.11, bodyX: -.16, bodyY: .32, eyeBlinkL: .22, eyeBlinkR: .25 }],
    [.53, { headY: .18, bodyX: -.12, bodyY: .30, eyeSmile: .17 }],
    [.77, { headY: -.04, bodyY: .10 }], end] },
];
const touchRoutines: Record<TouchZone, Routine> = {
  head: { duration: 1.35, frames: [rest,
    [.24, { headY: -.15, headZ: .19, bodyY: -.12, eyeBlinkL: .66, eyeBlinkR: .66, eyeSmile: .42 }],
    [.59, { headY: .05, headZ: .12, eyeBlinkL: .26, eyeBlinkR: .26, eyeSmile: .25 }], end] },
  cheek: { duration: 1.05, frames: [rest,
    [.22, { headX: -.16, headZ: .24, bodyZ: .12, eyeBlinkL: .75, eyeBlinkR: .37, browInnerUp: .18 }],
    [.56, { headX: -.09, headZ: .08, eyeBlinkL: .27, eyeBlinkR: .12 }], end] },
  body: { duration: 1.16, frames: [rest,
    [.18, { headY: .17, headZ: -.15, bodyX: -.30, bodyZ: .19, browInnerUp: .26 }],
    [.42, { headY: -.09, headZ: .10, bodyX: .12, bodyZ: -.09, eyeBlinkL: .45, eyeBlinkR: .45 }], end] },
  waist: { duration: 1.45, frames: [rest,
    [.19, { bodyX: -.34, bodyZ: .28, headZ: -.12, eyeBlinkL: .65, eyeBlinkR: .65 }],
    [.39, { bodyX: .12, bodyZ: -.18, headZ: .10, eyeSmile: .36 }],
    [.58, { bodyX: -.17, bodyZ: .13, eyeBlinkL: .55, eyeBlinkR: .55 }],
    [.77, { bodyZ: -.06, eyeSmile: .26 }], end] },
  hip: { duration: 1.5, frames: [rest,
    [.21, { bodyY: -.30, bodyX: -.32, headX: -.20, headY: .08, browDown: .27 }],
    [.58, { bodyY: -.24, bodyX: -.21, headX: -.15, eyeBlinkL: .22, eyeBlinkR: .22 }], end] },
  hand: { duration: 1.45, frames: [rest,
    [.22, { headX: .20, gazeX: .30, gazeY: -.25, bodyZ: -.13 }],
    [.61, { headZ: .16, eyeSmile: .38, browInnerUp: .12 }], end] },
  skirt: { duration: 1.7, frames: [rest,
    [.24, { headY: -.18, bodyX: -.27, gazeY: -.28, browDown: .20 }],
    [.65, { headZ: -.16, bodyY: -.21, eyeBlinkL: .32, eyeBlinkR: .32 }], end] },
  leg: { duration: 1.35, frames: [rest,
    [.22, { headY: -.19, bodyY: -.10, gazeY: -.42, browInnerUp: .16 }],
    [.67, { headZ: .19, gazeY: -.20, eyeSmile: .23 }], end] },
  foot: { duration: 1.35, frames: [rest,
    [.17, { headY: -.24, bodyX: -.42, bodyZ: .26, gazeY: -.50, browInnerUp: .24 }],
    [.45, { headY: -.13, bodyX: -.26, bodyZ: .17, gazeY: -.34 }],
    [.69, { headY: .08, bodyX: .07, bodyZ: -.05 }], end] },
  tail: { duration: 1.55, frames: [rest,
    [.16, { headY: .22, bodyY: .29, bodyZ: -.25, gazeX: .36, browInnerUp: .45 }],
    [.38, { headX: .24, bodyX: -.27, bodyZ: .18, eyeBlinkL: .58, eyeBlinkR: .58 }],
    [.68, { bodyX: .12, headZ: -.13, browInnerUp: .09 }], end] },
};
const afterStroke: Routine = { duration: 1.2, frames: [rest,
  [.28, { headY: -.06, headZ: .16, eyeSmile: .52, eyeBlinkL: .56, eyeBlinkR: .56 }],
  [.64, { headY: .07, headZ: .09, eyeSmile: .30, eyeBlinkL: .22, eyeBlinkR: .22 }], end] };
const sideways = new Set(['headX', 'headZ', 'bodyX', 'bodyZ', 'gazeX']);
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

function sample(routine: Routine, progress: number, direction: number, weight: number): Pose {
  const next = routine.frames.findIndex(([at]) => progress < at);
  if (next < 1) return {};
  const [fromTime, from] = routine.frames[next - 1]!;
  const [toTime, to] = routine.frames[next]!;
  const p = clamp((progress - fromTime) / (toTime - fromTime), 0, 1);
  const blend = p * p * (3 - 2 * p);
  const pose: Pose = {};
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)]) as Set<keyof Pose>) {
    const start = from[key] ?? 0;
    pose[key] = (start + ((to[key] ?? 0) - start) * blend) * weight * (sideways.has(key) ? direction : 1);
  }
  if (direction < 0) [pose.eyeBlinkL, pose.eyeBlinkR] = [pose.eyeBlinkR, pose.eyeBlinkL];
  return pose;
}

export class CallCharacterMotion {
  readonly proceduralIdle: boolean;
  readonly dafeiyu: boolean;
  private readonly details: SecondaryDetail[];
  private idleAt = Infinity;
  private lastIdle = -1;
  private idle?: { index: number; at: number; direction: number };
  private touch?: { zone: TouchZone; at: number; direction: number; stroked?: boolean; duration?: number; hover?: boolean };
  private hoverTarget?: { hit: Hit; since: number };
  private hoverCooldown = 0;
  private held = false;
  private stroke = 0;
  private pullY = 0;
  private pressure = 0;
  private activity = 0;
  private strokeTravel = 0;
  private drag = { x: 0, y: 0 };
  private dragDirection = 0;
  private shake = 0;
  private dizzy = 0;
  private windowPosition?: { x: number; y: number };
  private readonly reduced: boolean;
  private readonly random: () => number;

  constructor(profile: ModelProfile, parameters: Record<string, Live2DMotionParameterInfo>,
    { reduced, nativeIdle = false, random = Math.random }: { reduced: boolean; nativeIdle?: boolean; random?: () => number }) {
    this.reduced = reduced;
    this.random = random;
    this.dafeiyu = ['LEar1', 'REar1', 'FrontHairX1', 'LeanInput'].every(id => Object.hasOwn(parameters, id));
    this.proceduralIdle = !!(profile.capabilities?.headControl && profile.capabilities.bodyControl && (this.dafeiyu || !nativeIdle));
    this.details = this.dafeiyu ? Object.keys(parameters).flatMap<SecondaryDetail>(id => {
      const hair = /^(?:Front|Side|Late|LateSide)Hair([XY])([1-5])$/u.exec(id);
      const ear = /^[LR]Ear([1-3])$/u.exec(id);
      const skirt = /^Skirt(?:Layer)?([XY])(\d+)$/u.exec(id);
      if (hair) return [{ id, axis: hair[1] === 'X' ? 'x' : 'y', delay: Number(hair[2]) * .14 }];
      if (ear) return [{ id, axis: 'ear', delay: Number(ear[1]) * .22 }];
      if (skirt) return [{ id, axis: skirt[1] === 'X' ? 'x' : 'y', delay: Number(skirt[2]) * .17, skirt: true }];
      return [];
    }) : [];
  }

  hit(x: number, y: number, figure: Figure) {
    const u = (x - figure.x) / figure.width, v = (y - figure.y) / figure.height;
    const tail = this.dafeiyu && u > .72 && u < .99 && v > .60 && v < .87;
    if (!(v >= 0 && v <= 1 && (tail || Math.abs(u - .46) < .31))) return;
    if (this.dafeiyu && v < .183 && Math.abs(u - .44) > (v < .117 ? .24 : .16)) return;
    let zone: TouchZone = 'body';
    if (this.dafeiyu) {
      if (v < .117) zone = 'head';
      else if (v < .183) zone = 'cheek';
      else if (v >= .31 && v < .40 && Math.abs(u - .44) < .24) zone = 'waist';
      else if (v >= .40 && v < .54 && Math.abs(u - .44) < .19) zone = 'hip';
      else if (v > .90 && Math.abs(u - .44) < .22) zone = 'foot';
      else if (tail) zone = 'tail';
      else if (v > .34 && v < .52 && Math.abs(u - .44) > .25) zone = 'hand';
      else if (v >= .40 && v < .58) zone = 'skirt';
      else if (v >= .58 && Math.abs(u - .44) < .22) zone = 'leg';
    }
    const forehead = this.dafeiyu && v >= .094 && v < .117 && Math.abs(u - .44) < .13;
    return { zone, forehead, direction: u < .44 ? -1 : 1 } as const;
  }

  press(time: number, zone: TouchZone, direction: number) {
    this.touch = { zone, at: time, direction };
    this.hoverTarget = undefined;
    this.held = true;
    this.stroke = 0;
    this.pullY = 0;
    this.pressure = 0;
    this.activity = 0;
    this.strokeTravel = 0;
  }

  hover(time: number, hit?: Hit) {
    if (!hit) this.hoverTarget = undefined;
    else if (hit.zone !== this.hoverTarget?.hit.zone || hit.direction !== this.hoverTarget?.hit.direction) {
      this.hoverTarget = { hit, since: time };
    }
  }

  move(delta: number, vertical = 0, overZone = true) {
    this.stroke = clamp(this.stroke + delta, -1, 1);
    this.pullY = clamp(this.pullY + vertical, -1, 1);
    const distance = Math.hypot(delta, vertical);
    if (overZone) {
      this.strokeTravel += distance;
      this.activity = clamp(this.activity + distance * 1.5, 0, 1);
    }
  }
  release(time: number, completed = true) {
    const touch = this.touch;
    if (completed && touch && time - touch.at >= .25 && this.strokeTravel >= .38) {
      const scale = clamp(1 + (time - touch.at - 1) * .15, 1, 2.2);
      this.touch = { ...touch, at: time, stroked: touch.zone === 'head', duration: (touch.zone === 'head' ? afterStroke : touchRoutines[touch.zone]).duration * scale };
    }
    this.held = false;
  }
  cancelTouch() {
    this.touch = undefined; this.held = false; this.stroke = 0; this.pullY = 0; this.pressure = 0; this.activity = 0; this.strokeTravel = 0;
  }
  get engaged() { return !!this.touch || Math.abs(this.drag.x) + Math.abs(this.drag.y) >= .10; }
  reset() {
    this.idleAt = Infinity; this.idle = undefined; this.cancelTouch(); this.hoverTarget = undefined;
    this.drag = { x: 0, y: 0 }; this.windowPosition = undefined;
    this.dragDirection = 0; this.shake = 0; this.dizzy = 0;
  }

  /** Sample the actual pet window movement so a drag at the screen edge stays still. */
  moveWindow(surface: Pick<Window, 'screenX' | 'screenY'> | undefined, dt: number) {
    const position = surface && { x: surface.screenX, y: surface.screenY };
    const previous = this.windowPosition;
    this.windowPosition = position;
    const mix = 1 - Math.exp(-dt * 10);
    const velocity = (axis: 'x' | 'y') => position && previous && dt > 0
      ? clamp((position[axis] - previous[axis]) / (dt * 850), -1, 1) : 0;
    const horizontal = velocity('x');
    this.shake = Math.max(0, this.shake - dt * 1.3);
    if (Math.abs(horizontal) > .55) {
      const direction = Math.sign(horizontal);
      if (this.dragDirection && direction !== this.dragDirection) this.shake += .72;
      this.dragDirection = direction;
    } else if (this.shake > 1.1) {
      this.dizzy = 1.45;
      this.shake = 0;
      this.dragDirection = 0;
    } else if (this.shake === 0 && Math.abs(this.drag.x) < .06) this.dragDirection = 0;
    this.drag.x += (horizontal - this.drag.x) * mix;
    this.drag.y += (velocity('y') - this.drag.y) * mix;
  }

  update(time: number, dt: number, canIdle: boolean, canReact: boolean, pointerWeight: number, ambient: boolean) {
    const hover = this.hoverTarget;
    if (hover && ambient && !this.engaged && canIdle && canReact && !this.reduced && time >= this.hoverCooldown && time - hover.since > 2.2) {
      this.touch = { zone: hover.hit.zone, direction: hover.hit.direction, at: time, hover: true };
      this.hoverCooldown = time + 14;
      this.hoverTarget = undefined;
    }
    const touch = this.touch;
    const reaction = touch && (touch.stroked ? afterStroke : touchRoutines[touch.zone]);
    const touchAge = touch ? time - touch.at : 0;
    const touchProgress = touch && reaction ? touchAge / (touch.duration ?? reaction.duration) : 1;
    this.activity *= Math.exp(-dt * 2.6);
    const grip = this.held && touchAge >= .16 && canReact;
    const pressureTarget = grip ? clamp((touchAge - .16) / .55, 0, 1) * (.26 + .74 * this.activity) : 0;
    this.pressure += (pressureTarget - this.pressure) * (1 - Math.exp(-dt * 9));
    const followsPull = grip && (touch?.zone === 'head' || touch?.zone === 'cheek');
    if (!followsPull) { this.stroke *= Math.exp(-dt * 5); this.pullY *= Math.exp(-dt * 5); }
    if (touchProgress >= 1 && !this.held && this.pressure < .005 && Math.abs(this.stroke) < .005) this.touch = undefined;
    const drag = Math.abs(this.drag.x) + Math.abs(this.drag.y);
    this.dizzy = Math.max(0, this.dizzy - dt);
    const idleAllowed = canIdle && this.proceduralIdle && !this.reduced && !this.engaged && !this.dizzy;
    if (!idleAllowed) { this.idle = undefined; this.idleAt = Infinity; }
    else if (this.idleAt === Infinity) this.idleAt = time + 1.8 + this.random() * 2.3;
    else if (time >= this.idleAt) {
      const first = this.lastIdle < 0;
      const pick = Math.floor(this.random() * (idleRoutines.length - Number(!first)));
      const index = first || pick < this.lastIdle ? pick : pick + 1;
      const routine = idleRoutines[index]!;
      this.lastIdle = index;
      this.idle = { index, at: time, direction: this.random() < .5 ? -1 : 1 };
      this.idleAt = time + routine.duration + 3.2 + this.random() * 5.2;
    }
    const idle = this.idle;
    const routine = idle && idleRoutines[idle.index]!;
    const idleProgress = idle && routine ? (time - idle.at) / routine.duration : 1;
    const pose: Pose = idle && routine ? sample(routine, idleProgress, idle.direction, 1 - pointerWeight * .50) : {};
    const gain = this.reduced ? .28 : 1;
    if (touch && reaction && canReact && (touchProgress < 1 || grip || this.pressure > .005 || Math.abs(this.stroke) > .005)) {
      Object.assign(pose, sample(reaction, touchProgress, touch.direction, gain * (touch.hover ? .38 : 1)));
      const response = this.pressure * gain;
      if (!touch.hover && (touch.zone === 'head' || touch.zone === 'cheek')) {
        pose.headZ = (pose.headZ ?? 0) - this.stroke * .26 * gain;
        pose.headY = (pose.headY ?? 0) - this.pullY * .21 * gain;
        pose.headX = (pose.headX ?? 0) + this.stroke * .20 * gain;
        pose.eyeSmile = Math.max(pose.eyeSmile ?? 0, .48 * response);
        const soften = .30 + .28 * clamp(touchAge / 3, 0, 1);
        pose.eyeBlinkL = Math.max(pose.eyeBlinkL ?? 0, response * (touch.direction < 0 ? soften : soften * .6));
        pose.eyeBlinkR = Math.max(pose.eyeBlinkR ?? 0, response * (touch.direction > 0 ? soften : soften * .6));
      } else if (!touch.hover && response > .01) {
        const twist = Math.sin(time * (touch.zone === 'foot' || touch.zone === 'waist' ? 17 : 8));
        pose.bodyZ = (pose.bodyZ ?? 0) + twist * response * .34;
        pose.bodyX = (pose.bodyX ?? 0) - response * touch.direction * .22;
        pose.headZ = (pose.headZ ?? 0) - twist * response * .18;
      }
    }
    if (canReact && drag > .002) {
      pose.bodyX = (pose.bodyX ?? 0) - this.drag.x * .34 * gain;
      pose.bodyZ = (pose.bodyZ ?? 0) + this.drag.x * .26 * gain;
      pose.headY = (pose.headY ?? 0) + this.drag.y * .18 * gain;
    }
    const dizzy = canReact && !this.reduced && this.dizzy > 0 && !this.held;
    if (dizzy) {
      pose.headZ = (pose.headZ ?? 0) + Math.sin(time * 12) * this.dizzy * .12;
      pose.bodyZ = (pose.bodyZ ?? 0) - Math.sin(time * 12) * this.dizzy * .07;
    }
    const secondary: Live2DParamState = {};
    if (!this.reduced && (ambient || drag > .002 || canReact && touchProgress < 1)) {
      for (const { id, axis, delay, skirt } of this.details) {
        const drift = ambient && !skirt ? .038 * Math.sin(time * .91 - delay) + .019 * Math.sin(time * 1.49 + delay) : 0;
        const flickProgress = canReact && touch?.zone === 'head' ? touchProgress * 2 : (idleProgress - .25) * 5;
        const flick = axis === 'ear' && flickProgress > 0 && flickProgress < 1
          && (touch?.zone === 'head' || idle?.index === 3 && id.startsWith(idle.direction < 0 ? 'L' : 'R'))
          ? .32 * Math.sin(flickProgress * Math.PI * 3) * (1 - flickProgress) ** 2 : 0;
        secondary[id] = drift + flick - (axis === 'x' ? this.drag.x * .31 : this.drag.y * .20) * (skirt ? .8 : 1);
      }
    }
    const reactionWeight = canReact && touch && !touch.hover
      ? Math.max(touchProgress > 0 && touchProgress < 1 ? Math.sin(Math.PI * touchProgress) ** 2 : 0, this.pressure)
      : 0;
    return { pose, secondary, touch: reactionWeight && touch ? {
      zone: touch.zone, direction: touch.direction, weight: reactionWeight, pressure: this.pressure,
      pull: this.stroke, verticalPull: this.pullY, settling: !!touch.stroked,
    } : undefined, dizzy: dizzy || undefined };
  }
}

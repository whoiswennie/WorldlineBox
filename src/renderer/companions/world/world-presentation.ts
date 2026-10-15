import type { CompanionWorldActor, CompanionWorldSnapshot, CompanionWorldVisit, CompanionWorldWork } from '../../../shared/companion-world';
import type { WorldArtAction } from '../../../shared/companion-world-art';

export const WORLD_ACTIVITY_LABELS: Record<CompanionWorldActor['activity'], string> = { idle: '自在地待着', walking: '正在走动', seating: '正在坐下', standingUp: '正在起身', lyingDown: '正在躺下', waking: '正在醒来', turning: '正在转身', sitting: '坐着休息', working: '在电脑前工作', sleeping: '正在睡觉', eating: '正在用餐', resting: '正在休息', habit: '自己的小日常' };
export const WORLD_WORK_LABELS: Record<CompanionWorldWork['status'], string> = { waiting: '等待合适的时间', moving: '正在前往电脑', seating: '正在电脑前坐稳', ready: '已就座，可以处理', ended: '这次工作已结束' };
export function worldWorkLabel(work: CompanionWorldWork) {
  return work.kind === 'chat' ? { waiting: '等方便时回复聊天', moving: '正在准备看消息', seating: '正在准备回复', ready: '正在回复聊天', ended: '这次聊天已结束' }[work.status] : WORLD_WORK_LABELS[work.status];
}
export const WORLD_VISIT_LABELS: Record<CompanionWorldVisit['status'], string> = { requested: '等待对方回应', allowed: '已获准拜访', denied: '对方暂不方便', left: '拜访已结束', expired: '邀请已过期' };
export const WORLD_WEATHER_LABELS = { clear: '晴朗', cloudy: '多云', rain: '下雨', snow: '下雪' } as const;
export interface WorldActorStatus {
  label: string;
  detail?: string;
  kind: 'work' | 'movement' | 'sleep' | 'meal' | 'rest' | 'social' | 'habit' | 'idle';
}
/** Describe received physical facts first; queued work never pretends that a sleeping actor is executing it. */
export function worldActorStatus(actor: CompanionWorldActor, snapshot: CompanionWorldSnapshot, companions: readonly { id: string; name: string }[]): WorldActorStatus {
  const works = snapshot.works.filter(item => item.companionId === actor.companionId && item.status !== 'ended' && item.kind !== 'chat');
  const work = works.find(item => item.status === 'ready') ?? works.find(item => item.status === 'seating') ?? works.find(item => item.status === 'moving') ?? works[0];
  const destination = snapshot.scenes.flatMap(scene => scene.objects.map(object => ({ object, scene }))).find(item => item.object.id === (work?.status === 'moving' ? work.computerId : actor.destinationId));
  const name = (id: string | undefined) => companions.find(item => item.id === id)?.name ?? snapshot.residents.find(item => item.companionId === id)?.name ?? '伙伴';
  const detail = work?.reason;
  const communication = actor.communication;
  const phone = communication && Date.parse(communication.untilReal) > Date.parse(snapshot.clock.realNow) ? {
    kind: 'social' as const,
    label: communication.phase === 'responding' ? '正在回复聊天' : communication.phase === 'typing'
      ? communication.recipientIds.length > 1 ? '正在群聊里发消息' : '正在给' + name(communication.recipientIds[0]) + '发消息'
      : '收到' + name(communication.recipientIds[0]) + '的消息',
  } : undefined;
  switch (actor.activity) {
    case 'walking': {
      const verb = actor.locomotion === 'run' ? '跑向' : '走向';
      if (work?.status === 'moving' && destination) return { kind: 'movement', label: destination.scene.ownerId === actor.companionId ? (actor.sceneId === actor.homeSceneId ? verb + '自己的电脑' : '赶回家里的电脑前') : verb + name(destination.scene.ownerId) + '家的电脑', detail };
      const visit = snapshot.visits.find(item => item.guestId === actor.companionId && item.status === 'allowed' && snapshot.scenes.some(scene => scene.ownerId === item.hostId && (scene.id === actor.destinationId || scene.objects.some(object => object.id === actor.destinationId))));
      if (visit) return { kind: 'movement', label: '去' + name(visit.hostId) + '家做客', detail: visit.reason };
      if (destination) return { kind: 'movement', label: verb + destination.object.name, detail };
      const targetScene = snapshot.scenes.find(scene => scene.id === actor.destinationId);
      return { kind: 'movement', label: targetScene?.kind === 'home' ? (targetScene.ownerId === actor.companionId ? '正在回家' : '前往' + name(targetScene.ownerId) + '的小屋') : actor.locomotion === 'run' ? '正在跑动' : '正在走动', detail };
    }
    case 'seating': return { kind: 'movement', label: work?.status === 'seating' ? '正在电脑前坐稳' : '正在坐下', detail };
    case 'standingUp': return { kind: 'movement', label: '正在起身' };
    case 'lyingDown': return { kind: 'sleep', label: '正在躺下准备睡觉' };
    case 'waking': return { kind: 'sleep', label: '刚睡醒，正在起床' };
    case 'turning': return { kind: 'movement', label: '正在转身' };
    case 'sleeping': return { kind: 'sleep', label: '正在睡觉', detail: work?.status === 'waiting' ? '有事项等醒来后处理' : undefined };
    case 'eating': return { kind: 'meal', label: '正在用餐', detail: work?.status === 'waiting' ? '用餐后再处理待办' : undefined };
    case 'resting': return { kind: 'rest', label: '正在休息' };
    case 'working': {
      const ready = works.filter(item => item.status === 'ready').length;
      return { kind: 'work', label: ready > 1 ? `正在处理 ${ready} 件事` : work?.status === 'ready' ? work.kind === 'chat' ? '正在回复消息' : work.kind === 'schedule' ? '正在处理定时事项' : '正在处理任务' : '在电脑前工作', detail };
    }
    case 'sitting': return work?.status === 'ready' ? { kind: 'work', label: '已就座，准备处理', detail } : phone ?? { kind: 'rest', label: '坐着休息', detail };
    case 'habit': {
      if (phone) return phone;
      const labels: Partial<Record<WorldArtAction, string>> = { read: '正在读书', standingRead: '正在读书', exercise: '正在锻炼', cook: '正在做饭', communicate: '正在交谈', think: '正在思考', handle: '正在整理物品', phoneCallingStanding: '正在打电话', phoneCallingSeated: '坐着打电话', phoneTypingStanding: '正在看手机', phoneTypingSeated: '坐着看手机', follow: '正在跟随' };
      return { kind: actor.artAction === 'communicate' ? 'social' : actor.artAction === 'cook' ? 'meal' : 'habit', label: labels[actor.artAction] ?? (actor.activityLabel && actor.activityLabel !== '个人日常活动' ? actor.activityLabel : '自己的小日常') };
    }
    default: return phone ?? { kind: 'idle', label: actor.activityLabel ?? '自在地待着', detail: work?.status === 'waiting' ? '有事项等待合适的时间' : undefined };
  }
}
export function worldArtAction(actor: Pick<CompanionWorldActor, 'activity' | 'activityLabel'> & Partial<Pick<CompanionWorldActor, 'artAction'>>): WorldArtAction {
  if (actor.artAction) return actor.artAction;
  switch (actor.activity) {
    case 'walking': return 'walk';
    case 'seating': return 'sitDown';
    case 'standingUp': return 'standUp';
    case 'lyingDown': return 'lieDown';
    case 'waking': return 'wake';
    case 'turning': return 'turn';
    case 'sitting': return 'sit';
    case 'working': return 'work';
    case 'sleeping': return 'sleep';
    case 'eating': return 'eat';
    case 'resting': return 'rest';
    case 'habit': return 'idle';
    default: return 'idle';
  }
}
/** Interpolate only the distance between received facts; never extrapolate a route. */
export function interpolateWorldPosition(from: { x: number; y: number }, to: { x: number; y: number }, elapsed: number, duration = 750) {
  const t = Math.min(1, Math.max(0, elapsed / Math.max(1, duration)));
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}
export function worldClockLabel(hour: number) {
  const minutes = Math.floor(hour * 60) % 1440;
  return Math.floor(minutes / 60).toString().padStart(2, '0') + ':' + (minutes % 60).toString().padStart(2, '0');
}
export function worldAssetUrl(url: string) { return url.startsWith('/') ? '.' + url : url; }
/** One height per drop: a rain segment's two vertices must wrap together. */
export function worldPrecipitationHeight(index: number, elapsedMs: number, kind: 'rain' | 'snow') {
  const phase = (index * 17 % 131) / 131 * 18 - Math.max(0, elapsedMs) / (kind === 'rain' ? 100 : 900);
  return (phase % 18 + 18) % 18;
}
export function worldAnimationFrame(startedAt: string, durationMs: number, playback: 'loop' | 'transition', realNow: number): 0 | 1 | 2 {
  const elapsed = Math.max(0, realNow - Date.parse(startedAt)), duration = Math.max(1, durationMs);
  return Math.min(2, Math.floor((playback === 'loop' ? elapsed % duration : Math.min(elapsed, duration)) / duration * 3)) as 0 | 1 | 2;
}
/** Catch-up snapshots are one coherent instant; wall time must not finish their transitions early. */
export function worldActorAnimationFrame(actor: Pick<CompanionWorldActor, 'frame' | 'activityStartedAtReal' | 'artStartedAtReal'>, animation: { duration: number; playback: 'loop' | 'transition' }, backlog: boolean, realNow: number): 0 | 1 | 2 {
  return backlog ? actor.frame : worldAnimationFrame(actor.artStartedAtReal ?? actor.activityStartedAtReal, animation.duration, animation.playback, realNow);
}
/** Sheets face screen-left. Mirror from the camera basis, including after orbit rotation. */
export function worldFacingMirrored(facing: CompanionWorldActor['facing'], cameraRight: { x: number; z: number }) {
  const direction = { north: { x: 0, z: -1 }, east: { x: 1, z: 0 }, south: { x: 0, z: 1 }, west: { x: -1, z: 0 } }[facing];
  return direction.x * cameraRight.x + direction.z * cameraRight.z > 0;
}
/** Follow corners already present in the previous authoritative route, only as far as the next fact. */
export function worldInterpolationPath(actor: Pick<CompanionWorldActor, 'sceneId' | 'position' | 'route'>, target: { x: number; y: number }) {
  const points = [actor.position];
  for (const node of actor.route) {
    if (node.sceneId !== actor.sceneId) break;
    const previous = points.at(-1)!;
    const onSegment = Math.abs(previous.x - node.x) < .001 && Math.abs(target.x - node.x) < .001 && target.y >= Math.min(previous.y, node.y) - .001 && target.y <= Math.max(previous.y, node.y) + .001 || Math.abs(previous.y - node.y) < .001 && Math.abs(target.y - node.y) < .001 && target.x >= Math.min(previous.x, node.x) - .001 && target.x <= Math.max(previous.x, node.x) + .001;
    if (onSegment) return [...points, target];
    points.push({ x: node.x, y: node.y });
  }
  return [actor.position, target];
}
export function interpolateWorldPath(points: Array<{ x: number; y: number }>, elapsed: number, duration = 750) {
  if (points.length < 2) return points[0] ?? { x: 0, y: 0 };
  const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y));
  let distance = lengths.reduce((sum, length) => sum + length, 0) * Math.min(1, Math.max(0, elapsed / Math.max(1, duration)));
  for (let i = 0; i < lengths.length; i++) { if (distance <= lengths[i]! && lengths[i]! > 0) return interpolateWorldPosition(points[i]!, points[i + 1]!, distance, lengths[i]); distance -= lengths[i]!; }
  return points.at(-1)!;
}

import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { CompanionCabinArguments } from '../../shared/companion-apps';
import type { CabinWorld } from '../cabin-world';
import { abortable } from './abortable';

type Companion = { id: string; name: string };
const recentWindowMs = 2 * 60 * 60 * 1000;
const residentKey = (id: string) => 'wlb_' + createHash('sha256').update(id).digest('hex').slice(0, 32);
const label = (value: unknown) => typeof value === 'string' ? value.slice(0, 120) : undefined;
const record = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
const rows = (value: unknown) => Array.isArray(value) ? value.map(record) : [];

export class BotCabinWorldApp {
  private readonly registering = new Map<string, Promise<void>>();

  constructor(private readonly cabin: Pick<CabinWorld, 'open' | 'request'>) {}

  async connect(signal: AbortSignal, companion?: Companion): Promise<void> {
    signal.throwIfAborted();
    await this.cabin.open();
    const readiness = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    try {
      for (;;) {
        // Listing residents is allowed during initialization. The read-only
        // activity list becomes available once the bridge is ready for actions.
        const activity = await this.tool('cabin_process', { action: 'list' }, readiness);
        if (activity.ok === true) break;
        await delay(150, undefined, { signal: readiness });
      }
    } catch {
      signal.throwIfAborted();
      throw Error('小屋世界的住户尚未就绪，请重新连接。');
    }
    if (companion) {
      const status = await this.status(companion, residentKey(companion.id), readiness);
      if (status.connected !== true) throw Error('小屋世界的住户尚未就绪，请重新连接。');
    }
  }

  private tool(name: string, args: object, signal: AbortSignal) {
    return this.cabin.request('/v1/tool', signal, { name, arguments: args });
  }

  private async status(companion: Companion, actor: string, signal: AbortSignal) {
    const status = await this.tool('cabin_status', { actor }, signal);
    if (status.ok === true) return status;
    const pending = this.registering.get(actor) ?? this.register(companion, actor).finally(() => this.registering.delete(actor));
    this.registering.set(actor, pending);
    await abortable(pending, signal);
    return this.tool('cabin_status', { actor }, signal);
  }

  private async register(companion: Companion, actor: string) {
    // Registration has its own short deadline so either of two chats can stop waiting without cancelling the other.
    const signal = AbortSignal.timeout(2200);
    const roster = await this.tool('cabin_residents', {}, signal);
    if (roster.ok === false || !Array.isArray(roster.residents)) throw Error('小屋住户暂不可用。');
    if (Array.isArray(roster.deleted) && roster.deleted.includes(actor)) throw Error('这个伙伴的小屋住户已在游戏内移除。');
    if (rows(roster.residents).some(row => row.key === actor)) return;
    const name = Array.from(companion.name.replace(/\p{Cc}/gu, ' ').trim()).slice(0, 32).join('') || '伙伴';
    const registered = await this.tool('cabin_add_resident', { key: actor, name }, signal);
    if (registered.ok !== true || registered.key !== actor) throw Error('小屋住户暂不可用。');
  }

  async observe(companion: Companion, signal: AbortSignal) {
    const actor = residentKey(companion.id), snapshotSignal = AbortSignal.any([signal, AbortSignal.timeout(2500)]);
    try {
      const status = await this.status(companion, actor, snapshotSignal);
      if (status.connected !== true || status.actor !== actor) return { status: 'unavailable' as const };
      const events = await this.cabin.request('/v1/events', snapshotSignal).catch(() => undefined);
      signal.throwIfAborted();
      const now = Date.now(), { position, weather, doing, environment } = status;
      const here = record(position), sky = record(weather);
      const recent = rows(events?.events).filter(event => event.actor === actor && event.type === 'task' && event.status === 'done'
        && event.kind !== 'walk' && typeof event.at === 'number' && event.at >= now - recentWindowMs && event.at <= now)
        .slice(-3).map(event => ({ at: new Date(event.at as number).toISOString(), activity: label(event.label) }));
      return { status: 'online' as const, observedAt: new Date(now).toISOString(),
        place: label(here.place), spot: label(here.zoneName), weather: label(sky.name),
        temperatureC: typeof sky.temp === 'number' ? sky.temp : undefined, light: label(sky.phase),
        activity: label(record(doing).label), mood: label(record(status.mood).word), surroundings: label(record(environment).note), recent };
    } catch {
      signal.throwIfAborted();
      return { status: 'unavailable' as const };
    }
  }

  async execute(companion: Companion, input: CompanionCabinArguments, signal: AbortSignal, stillAttached: () => boolean) {
    if (JSON.stringify(input.arguments).length > 16000) throw Error('小屋世界工具参数过长。');
    const actor = residentKey(companion.id);
    try {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
      const status = await this.status(companion, actor, deadline);
      if (!stillAttached()) return { ok: false, error: '当前话题已断开小屋世界。' };
      if (status.connected !== true || status.actor !== actor) return { ok: false, error: '小屋世界暂未连接。' };
      if (input.tool === 'cabin_status') return status;
      // The model can neither select another resident nor hold the chat open for a long game activity.
      return await this.tool(input.tool, { ...input.arguments, actor, waitMs: input.tool === 'cabin_use' ? 0 : 750 }, deadline);
    } catch {
      signal.throwIfAborted();
      return { ok: false, error: '小屋世界没有返回结果。如果刚发过动作，先查看状态或原任务回执再重试。' };
    }
  }
}

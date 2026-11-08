import type { DshInstance } from '../../shared/dsh-launcher';
import type { DshLauncher } from '../dsh/launcher';
import type { BotStore } from './store';
import { botNativeHostBindingKey } from './host-migration';

/** Every worker belongs to one companion environment. Persisted native work
 * never moves or falls back to a shared/default Host when bindings change. */
export async function selectBotWorkerInstance(launcher: Pick<DshLauncher, 'resolveBotInstance' | 'resolveCompanionInstance'>,
  store: BotStore | undefined, laneId?: string, explicitId?: string): Promise<DshInstance> {
  const bound = laneId && store?.getMetadata(botNativeHostBindingKey(laneId));
  if (bound && explicitId && bound !== explicitId) throw Object.assign(new Error('任务已绑定原执行环境，不能改投其他环境或重发。'), { code: 'BOT_HOST_MIGRATION_BLOCKED' });
  const task = laneId?.startsWith('worker-') ? store?.getTask(laneId.slice('worker-'.length)) : undefined;
  const lane = laneId && !task ? store?.getLane(laneId) ?? store?.getLane(laneId.replace(/-epoch-[1-9]\d*$/u, '')) : undefined;
  const ownerId = task?.companionId ?? (lane || undefined)?.companionId;
  const companion = ownerId && store?.getCompanion(ownerId);
  if (!companion) throw Object.assign(new Error('执行任务缺少角色身份，不能使用默认 DSH 实例。'), { code: 'BOT_COMPANION_INSTANCE_REQUIRED' });
  if (bound || explicitId) {
    const instance = await launcher.resolveBotInstance(bound || explicitId);
    if (instance.companionId !== companion.id) throw Object.assign(
      new Error('原任务属于旧的共享环境或其他角色环境，已保留执行记录；不能在当前角色的专属环境中自动重发。'),
      { code: 'BOT_HOST_MIGRATION_BLOCKED' });
    return instance;
  }
  return launcher.resolveCompanionInstance(companion.id, companion.name);
}

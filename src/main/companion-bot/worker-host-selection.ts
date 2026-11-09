import type { DshInstance } from '../../shared/dsh-launcher';
import type { DshLauncher } from '../dsh/launcher';
import type { BotStore } from './store';
import { botNativeHostBindingKey } from './host-migration';

/** Companions share the selected executor, not each other's Sessions or task
 * authority. Persisted native work stays on its original Host across selection
 * changes, including tasks accepted by the former per-companion environments. */
export async function selectBotWorkerInstance(launcher: Pick<DshLauncher, 'resolveBotInstance'>,
  store: BotStore | undefined, laneId?: string, explicitId?: string): Promise<DshInstance> {
  const bound = laneId && store?.getMetadata(botNativeHostBindingKey(laneId));
  if (bound && explicitId && bound !== explicitId) throw Object.assign(new Error('任务已绑定原执行环境，不能改投其他环境或重发。'), { code: 'BOT_HOST_MIGRATION_BLOCKED' });
  const lane = laneId ? store?.getLane(laneId) ?? store?.getLane(laneId.replace(/-epoch-[1-9]\d*$/u, '')) : undefined;
  const event = laneId?.startsWith('turn-') ? store?.getEvent(laneId.slice('turn-'.length)) : undefined;
  const ownerId = event?.companionId ?? (lane || undefined)?.companionId;
  const companion = ownerId && store?.getCompanion(ownerId);
  if (!companion) throw Object.assign(new Error('执行任务缺少有效角色身份，不能使用 DSH 执行环境。'), { code: 'BOT_WORKER_IDENTITY_REQUIRED' });
  if (bound || explicitId) {
    const id = bound || explicitId;
    const instance = await launcher.resolveBotInstance(id);
    if (instance.id !== id) throw Object.assign(
      new Error('原任务执行环境不可用，已保留执行记录；不能改投其他环境或自动重发。'),
      { code: 'BOT_HOST_MIGRATION_BLOCKED' });
    return instance;
  }
  return launcher.resolveBotInstance();
}

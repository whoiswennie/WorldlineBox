import type { DshInstance } from '../../shared/dsh-launcher';
import type { DshLauncher } from '../dsh/launcher';
import type { BotStore } from './store';
import { botNativeHostBindingKey } from './host-migration';

/** Existing native work never moves when equipment/default selection changes. */
export async function selectBotWorkerInstance(launcher: Pick<DshLauncher, 'resolveBotInstance' | 'resolveCompanionInstance'>,
  store: BotStore | undefined, laneId?: string, explicitId?: string): Promise<DshInstance> {
  const bound = laneId && store?.getMetadata(botNativeHostBindingKey(laneId));
  if (bound && explicitId && bound !== explicitId) throw Object.assign(new Error('任务已绑定原执行环境，不能改投其他环境或重发。'), { code: 'BOT_HOST_MIGRATION_BLOCKED' });
  if (bound || explicitId) return launcher.resolveBotInstance(bound || explicitId);
  const task = laneId?.startsWith('worker-') ? store?.getTask(laneId.slice('worker-'.length)) : undefined;
  if (task) {
    const companion = store?.getCompanion(task.companionId);
    if (!companion) throw new Error('任务所属伙伴不存在。');
    return launcher.resolveCompanionInstance(companion.id, companion.name);
  }
  return launcher.resolveBotInstance();
}

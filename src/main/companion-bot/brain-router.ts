import type { BotDshBrain } from './dsh-brain';

/** Public protocol only: implementation-private Session/transport fields are
 * deliberately absent so App-owned conversation loops and DSH can compose. */
export type BotBrain = Pick<BotDshBrain, 'run' | 'cancel' | 'cancelDurable' | 'send' | 'inspectEffects' | 'inspectQuestionAnswers' | 'handoff' | 'archive' | 'close'>
  & Partial<Pick<BotDshBrain, 'upgradeWorkerAccess'>>;
export type BotAppBrain = Pick<BotBrain, 'run' | 'cancel' | 'cancelDurable' | 'handoff' | 'archive' | 'close'>;
export interface BotBrainRouterOptions {
  app: BotAppBrain;
  worker: BotBrain;
  /** A durable engine binding, not a guess from whether App has a receipt.
   * Old DSH brain admissions must be reconciled/migrated before App owns them. */
  isLegacyNativeLane?(laneId: string): boolean;
}
const workerLane = (laneId: string) => laneId.startsWith('worker-');
const blocked = () => Object.assign(new Error('旧 DSH 主脑执行尚待核实，已保留原记录；不会改投应用主脑或重发。'), { code: 'BOT_HOST_MIGRATION_BLOCKED' });
const invalidControl = () => Object.assign(new Error('执行器检查与指导仅适用于伙伴委派的 worker 通道。'), { code: 'BOT_BRAIN_ROUTE_INVALID' });

/** Routes conversation and memory-encoder loops to App; native worker work and
 * its durable inspection/control stay on DSH. A backend error never causes a
 * fallback to the other engine, which could repeat effects under a new receipt. */
export class BotBrainRouter implements BotBrain {
  private closing?: Promise<void>;
  constructor(private readonly options: BotBrainRouterOptions) {}
  private open(): void {
    if (this.closing) throw Object.assign(new Error('伙伴主脑与执行器正在关闭。'), { code: 'BOT_BRAIN_CLOSED' });
  }
  private app(laneId: string): BotAppBrain {
    this.open();
    if (this.options.isLegacyNativeLane?.(laneId)) throw blocked();
    return this.options.app;
  }
  private execution(laneId: string): BotBrain {
    this.open(); if (!workerLane(laneId)) throw invalidControl(); return this.options.worker;
  }
  async run(input: Parameters<BotBrain['run']>[0]): ReturnType<BotBrain['run']> {
    this.open(); input.signal?.throwIfAborted();
    if (input.role === 'worker' || input.role === undefined && workerLane(input.laneId)) return this.options.worker.run(input);
    if (workerLane(input.laneId)) throw invalidControl();
    return this.app(input.laneId).run(input);
  }
  async cancel(laneId: string): ReturnType<BotBrain['cancel']> {
    return workerLane(laneId) ? this.execution(laneId).cancel(laneId) : this.app(laneId).cancel(laneId);
  }
  async cancelDurable(input: Parameters<BotBrain['cancelDurable']>[0], suspend = false): ReturnType<BotBrain['cancelDurable']> {
    this.open(); input.signal?.throwIfAborted();
    if (input.role === 'worker' || workerLane(input.laneId)) return this.options.worker.cancelDurable(input, suspend);
    return this.app(input.laneId).cancelDurable(input, suspend);
  }
  async send(laneId: string, input: Parameters<BotBrain['send']>[1]): ReturnType<BotBrain['send']> {
    return this.execution(laneId).send(laneId, input);
  }
  async upgradeWorkerAccess(input: Parameters<BotDshBrain['upgradeWorkerAccess']>[0]): ReturnType<BotDshBrain['upgradeWorkerAccess']> {
    const worker = this.execution(input.laneId);
    if (!worker.upgradeWorkerAccess) throw new Error('The worker adapter does not support same-Session access upgrades.');
    return worker.upgradeWorkerAccess(input);
  }
  async inspectEffects(input: Parameters<BotBrain['inspectEffects']>[0]): ReturnType<BotBrain['inspectEffects']> {
    return this.execution(input.laneId).inspectEffects(input);
  }
  async inspectQuestionAnswers(input: Parameters<BotBrain['inspectQuestionAnswers']>[0]): ReturnType<BotBrain['inspectQuestionAnswers']> {
    return this.execution(input.laneId).inspectQuestionAnswers(input);
  }
  async handoff(input: Parameters<BotBrain['handoff']>[0]): ReturnType<BotBrain['handoff']> {
    this.open(); input.signal?.throwIfAborted();
    if (input.role === 'worker' || workerLane(input.laneId)) return this.options.worker.handoff(input);
    return this.app(input.laneId).handoff(input);
  }
  async archive(laneId: string, instanceId?: string): ReturnType<BotBrain['archive']> {
    return workerLane(laneId) ? this.execution(laneId).archive(laneId, instanceId) : this.app(laneId).archive(laneId, instanceId);
  }
  async close(): Promise<void> {
    this.closing ??= (async () => {
      const settled = await Promise.allSettled([
        Promise.resolve().then(() => this.options.app.close()),
        Promise.resolve().then(() => this.options.worker.close()),
      ]);
      const errors = settled.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []);
      if (errors.length) throw new AggregateError(errors, '伙伴主脑或 DSH 执行器关闭失败。');
    })();
    return this.closing;
  }
}

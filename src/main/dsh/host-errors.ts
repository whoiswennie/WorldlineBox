export type DshHostUnavailableReason = 'configuration' | 'stopped' | 'startup' | 'closing';

export const bundledDshUpdatingMessage = '内置 DSH 正在更新，请等待更新完成后再操作。';

/** No native admission was attempted by the operation that raised this error.
 * This describes Host availability, never the outcome of earlier native work. */
export class DshHostUnavailableError extends Error {
  readonly code = 'DSH_HOST_UNAVAILABLE';
  constructor(readonly reason: DshHostUnavailableReason, message: string, readonly instanceId?: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export function isDshHostUnavailableError(value: unknown): value is DshHostUnavailableError {
  return value instanceof DshHostUnavailableError;
}

export class DshMessageNotReadyError extends DshHostUnavailableError {
  constructor(reason: DshHostUnavailableReason, state: string, instanceId?: string) {
    super(reason, state + '，本次消息未发送。请在电脑启动器确认共享 DSH 已就绪后重新发送。', instanceId);
  }
}

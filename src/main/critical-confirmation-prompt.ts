import { randomUUID } from 'node:crypto';

import {
  criticalConfirmationPromptSchema,
  criticalConfirmationRespondSchema,
  type CriticalConfirmationInitialFocus,
  type CriticalConfirmationPayload,
  type CriticalConfirmationPrompt,
} from '../shared/critical-confirmation';
import {
  CRITICAL_CONFIRMATION_PROMPT_CHANNEL,
  CRITICAL_CONFIRMATION_RESPOND_CHANNEL,
} from '../shared/protocol/channels';
import type {
  CriticalConfirmationIpcHost,
  CriticalConfirmationLogger,
} from './critical-confirmation-window';

export interface CriticalConfirmationPromptTarget {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: CriticalConfirmationPrompt): void;
  once(event: 'destroyed', listener: () => void): void;
  removeListener(event: 'destroyed', listener: () => void): void;
}

export type CriticalConfirmationPromptRequest = CriticalConfirmationPayload & {
  readonly initialFocus: CriticalConfirmationInitialFocus;
};

interface PendingPrompt {
  payload: CriticalConfirmationPrompt;
  resolve: (confirmed: boolean) => void;
}

interface ActivePrompt extends PendingPrompt {
  target: CriticalConfirmationPromptTarget;
  onDestroyed: () => void;
}

export interface RendererCriticalConfirmationBrokerOptions {
  getTarget(): CriticalConfirmationPromptTarget | null;
  ipcMain: CriticalConfirmationIpcHost;
  logger?: CriticalConfirmationLogger;
}

/**
 * Asks the main renderer to show a DialogShell confirmation.
 * The separate unthemed window is not used for these prompts.
 * Fails closed when the window is gone or the sender does not match.
 */
export class RendererCriticalConfirmationBroker {
  readonly #options: RendererCriticalConfirmationBrokerOptions;
  readonly #queue: PendingPrompt[] = [];
  #active: ActivePrompt | undefined;
  #disposed = false;

  public constructor(options: RendererCriticalConfirmationBrokerOptions) {
    this.#options = options;
    options.ipcMain.handle(CRITICAL_CONFIRMATION_RESPOND_CHANNEL, (event, input) => {
      const active = this.#active;
      const parsed = criticalConfirmationRespondSchema.safeParse(input);
      if (
        active === undefined
        || active.target.id !== event.sender.id
        || !parsed.success
        || parsed.data.requestId !== active.payload.requestId
      ) {
        return false;
      }
      this.#finish(parsed.data.decision === 'confirm');
      return true;
    });
  }

  public request(input: CriticalConfirmationPromptRequest): Promise<boolean> {
    if (this.#disposed) return Promise.resolve(false);
    const requestId = randomUUID();
    const parsed = criticalConfirmationPromptSchema.safeParse({ ...input, requestId });
    if (!parsed.success) return Promise.resolve(false);
    this.#options.logger?.info?.(
      'critical-confirmation.prompt',
      'Queued an in-app critical confirmation.',
      { title: parsed.data.title },
    );
    return new Promise((resolve) => {
      this.#queue.push({ payload: parsed.data, resolve });
      this.#pump();
    });
  }

  public dispose(): void {
    this.#disposed = true;
    this.#options.ipcMain.removeHandler(CRITICAL_CONFIRMATION_RESPOND_CHANNEL);
    this.#finish(false);
    while (this.#queue.length > 0) {
      this.#queue.shift()?.resolve(false);
    }
  }

  #pump(): void {
    if (this.#active !== undefined || this.#disposed) return;
    const next = this.#queue.shift();
    if (next === undefined) return;
    const target = this.#options.getTarget();
    if (target === null || target.isDestroyed()) {
      next.resolve(false);
      this.#pump();
      return;
    }
    const onDestroyed = () => {
      this.#finish(false);
    };
    this.#active = { ...next, target, onDestroyed };
    target.once('destroyed', onDestroyed);
    try {
      target.send(CRITICAL_CONFIRMATION_PROMPT_CHANNEL, next.payload);
    } catch (error) {
      this.#options.logger?.error('critical-confirmation.prompt', error);
      this.#finish(false);
    }
  }

  #finish(confirmed: boolean): void {
    const active = this.#active;
    if (active === undefined) return;
    this.#active = undefined;
    if (!active.target.isDestroyed()) {
      active.target.removeListener('destroyed', active.onDestroyed);
    }
    active.resolve(confirmed);
    this.#pump();
  }
}

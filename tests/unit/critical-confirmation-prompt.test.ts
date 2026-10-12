import { describe, expect, it } from 'vitest';

import {
  RendererCriticalConfirmationBroker,
  type CriticalConfirmationPromptTarget,
} from '../../src/main/critical-confirmation-prompt';
import {
  criticalConfirmationInitialFocusForOperation,
  criticalDiskDeleteConfirmLabel,
} from '../../src/shared/critical-confirmation';
import {
  CRITICAL_CONFIRMATION_PROMPT_CHANNEL,
  CRITICAL_CONFIRMATION_RESPOND_CHANNEL,
} from '../../src/shared/protocol/channels';
import type { CriticalConfirmationIpcHost } from '../../src/main/critical-confirmation-window';

const payload = {
  title: '确认危险操作',
  heading: '从磁盘删除这个文件夹？',
  message: '选定文件夹及其中的托管资产将被永久删除。',
  detail: '此操作无法撤销，文件不会进入应用回收站。',
  cancelLabel: '取消',
  confirmLabel: '强制删除',
  initialFocus: 'confirm' as const,
};

class FakeIpcMain implements CriticalConfirmationIpcHost {
  readonly handlers = new Map<string, (event: { sender: { id: number } }, input?: unknown) => unknown>();

  handle(channel: string, listener: (event: { sender: { id: number } }, input?: unknown) => unknown): void {
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  invoke(senderId: number, input?: unknown): unknown {
    const handler = this.handlers.get(CRITICAL_CONFIRMATION_RESPOND_CHANNEL);
    if (handler === undefined) throw new Error('Missing respond handler');
    return handler({ sender: { id: senderId } }, input);
  }
}

class FakeTarget implements CriticalConfirmationPromptTarget {
  readonly id: number;
  readonly sent: unknown[] = [];
  destroyed = false;
  readonly #listeners = new Set<() => void>();

  constructor(id: number) {
    this.id = id;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, body: unknown): void {
    expect(channel).toBe(CRITICAL_CONFIRMATION_PROMPT_CHANNEL);
    this.sent.push(body);
  }

  once(_event: 'destroyed', listener: () => void): void {
    this.#listeners.add(listener);
  }

  removeListener(_event: 'destroyed', listener: () => void): void {
    this.#listeners.delete(listener);
  }

  destroy(): void {
    this.destroyed = true;
    for (const listener of [...this.#listeners]) listener();
  }
}

describe('in-app critical confirmation', () => {
  it('asks the renderer and accepts only the matching sender', async () => {
    const ipcMain = new FakeIpcMain();
    const target = new FakeTarget(7);
    const broker = new RendererCriticalConfirmationBroker({
      getTarget: () => target,
      ipcMain,
    });
    const pending = broker.request(payload);
    expect(target.sent).toHaveLength(1);
    const prompt = target.sent[0] as { requestId: string; confirmLabel: string };
    expect(prompt.confirmLabel).toBe('强制删除');
    expect(ipcMain.invoke(99, { requestId: prompt.requestId, decision: 'confirm' })).toBe(false);
    expect(ipcMain.invoke(7, { requestId: prompt.requestId, decision: 'confirm' })).toBe(true);
    await expect(pending).resolves.toBe(true);
    broker.dispose();
  });

  it('cancels when the window goes away', async () => {
    const ipcMain = new FakeIpcMain();
    const target = new FakeTarget(3);
    const broker = new RendererCriticalConfirmationBroker({
      getTarget: () => target,
      ipcMain,
    });
    const pending = broker.request(payload);
    target.destroy();
    await expect(pending).resolves.toBe(false);
    broker.dispose();
  });

  it('defaults disk delete to the force-delete button and other confirms to cancel', () => {
    expect(criticalConfirmationInitialFocusForOperation('folder')).toBe('confirm');
    expect(criticalConfirmationInitialFocusForOperation('asset')).toBe('confirm');
    expect(criticalConfirmationInitialFocusForOperation('linked-asset')).toBe('confirm');
    expect(criticalConfirmationInitialFocusForOperation('asset-permanent')).toBe('cancel');
    expect(criticalDiskDeleteConfirmLabel(false)).toBe('强制删除');
    expect(criticalDiskDeleteConfirmLabel(true)).toBe('Force delete');
  });
});

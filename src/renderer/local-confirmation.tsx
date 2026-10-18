import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react';

import { CriticalConfirmationDialog } from './CriticalConfirmationDialog';
import { useT } from './i18n';
import { isImeKeyboardEvent } from './ime-safe-dismiss';
import { createShellPortal } from './ui/ShellStyleScope';

type LocalConfirmation = {
  readonly id: string;
  readonly detail: string;
  readonly danger: boolean;
  readonly scopeBound: boolean;
};

let active: LocalConfirmation | null = null;
let resolveActive: ((confirmed: boolean) => void) | null = null;
let hostMounted = false;
const listeners = new Set<() => void>();
const snapshot = () => active;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const publish = () => { for (const listener of listeners) listener(); };

/** One decision at a time; repeated clicks and blur cannot queue stale actions. */
export function requestConfirmation(detail: string, danger = false, options: {
  readonly scopeBound?: boolean;
} = {}): Promise<boolean> {
  if (!hostMounted || active !== null) return Promise.resolve(false);
  return new Promise((resolve) => {
    resolveActive = resolve;
    active = { id: crypto.randomUUID(), detail, danger, scopeBound: options.scopeBound !== false };
    publish();
  });
}

export function settleLocalConfirmation(confirmed: boolean): void {
  const resolve = resolveActive;
  resolveActive = null;
  active = null;
  publish();
  resolve?.(confirmed);
}

export function useLocalConfirmation() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** App owns the modal focus trap; this host only owns the decision lifecycle. */
export function LocalConfirmationHost({ scopeKey, blocked = false }: {
  readonly scopeKey?: string;
  readonly blocked?: boolean;
}) {
  const request = useLocalConfirmation();
  const t = useT();
  useLayoutEffect(() => {
    hostMounted = !blocked;
    return () => {
      hostMounted = false;
      settleLocalConfirmation(false);
    };
  }, [blocked]);
  useLayoutEffect(() => {
    // Explicit destination choices may wait behind another library opening.
    // Mutations of the old library must instead cancel when identity changes.
    if (active?.scopeBound !== false) settleLocalConfirmation(false);
  }, [scopeKey]);
  useEffect(() => {
    if (!request) return;
    // Window capture precedes App's document capture: Escape closes only this
    // decision, retaining a rename or settings surface beneath it.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isImeKeyboardEvent(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      settleLocalConfirmation(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [request]);
  if (!request) return null;
  return createShellPortal(
    <CriticalConfirmationDialog
      dialogId="local-confirmation-dialog"
      confirmVariant={request.danger ? 'danger' : 'primary'}
      onDecide={(decision) => settleLocalConfirmation(decision === 'confirm')}
      request={{
        requestId: request.id,
        title: t('common.confirm'),
        heading: t('common.confirm'),
        message: request.detail,
        detail: '',
        cancelLabel: t('common.cancel'),
        confirmLabel: t('common.confirm'),
        initialFocus: 'cancel',
      }}
    />,
    document.body,
  );
}

import { useId, type ReactNode } from 'react';
import { Button, DialogShell } from '../ui';
import { useT } from '../i18n';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';

/** Transient workflows live above the page, keeping its geometry and scroll position intact. */
export function LauncherDrawer({ title, description, children, onClose }: {
  readonly title: string; readonly description?: string; readonly children: ReactNode; readonly onClose: () => void;
}) {
  const t = useT();
  const id = useId();
  useDialogFocusTrap(true, id);
  return <div className="launcher-drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <DialogShell className="launcher-drawer" contentClassName="launcher-drawer-content" description={description}
      dialogId={`launcher-drawer-${id}`} headerActions={<Button aria-label={t('launcher.close')} data-dialog-initial-focus="true" iconName="close" onClick={onClose} size="sm" variant="quiet" />}
      onRequestClose={onClose} title={title}>{children}</DialogShell>
  </div>;
}

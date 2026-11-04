import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createShellPortal } from './ui/ShellStyleScope';

/** A body portal still belongs to its retained module. React Activity hides
 * the module's host nodes but does not hide portals elsewhere in the body;
 * its layout-effect cleanup must detach this host as well. */
export function WorkspaceNoticeStack({ active, children }: { readonly active: boolean; readonly children: ReactNode }) {
  const [container] = useState(() => {
    if (typeof document === 'undefined') return null;
    const element = document.createElement('div');
    element.dataset.workspaceNoticePortal = '';
    element.style.display = 'contents';
    return element;
  });
  useLayoutEffect(() => {
    if (!active || !container) return;
    document.body.append(container);
    return () => container.remove();
  }, [active, container]);
  return active && container ? createShellPortal(children, container) : null;
}

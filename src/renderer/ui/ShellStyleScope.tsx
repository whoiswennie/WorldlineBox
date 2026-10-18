import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useShellLayout } from './use-shell-layout';

/** The same visual boundary as App, without a box or stacking context. */

export function ShellStyleScope({ children }: { readonly children: ReactNode }) {
  const layout = useShellLayout();
  return (
    <div className="app-shell ui-shell-style-scope" data-shell-layout={layout}>
      {children}
    </div>
  );
}

/** Portals retain the live theme, radius and Islands cascade without copying tokens. */
export function createShellPortal(children: ReactNode, container: Element) {
  return createPortal(<ShellStyleScope>{children}</ShellStyleScope>, container);
}

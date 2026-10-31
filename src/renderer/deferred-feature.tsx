import { createElement, lazy, Suspense, type ReactNode } from 'react';

/** Optional panels suspend locally so loading one never hides the live chat. */
export function deferredFeature<P extends object>(load: () => Promise<{ default: (props: P) => ReactNode }>) {
  const View = lazy(load);
  return function DeferredFeature(props: P) {
    return <Suspense fallback={<div className="feature-loading" role="status"><span className="feature-loading-dot" aria-hidden="true" />正在打开…</div>}>
      {createElement(View, props)}
    </Suspense>;
  };
}

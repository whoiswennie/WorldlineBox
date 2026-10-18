import { browserLoadFailureKind } from '../../shared/browser-load-error';
import { Icon } from '../Icons';
import { useT } from '../i18n';
import { Button } from '../ui';

export function BrowserLoadFailure({ error, onReload, onOpenNetwork }: { error: string; onReload(): void; onOpenNetwork(): void }) {
  const t = useT();
  const b = (key: string) => t('browser.' + key);
  return <div className="browser-failure" role="alert">
    <Icon name="globe" size={32} />
    <h2>{b('pageError')}</h2>
    <p>{b('loadFailure.' + browserLoadFailureKind(error))}</p>
    <div className="browser-actions"><Button onClick={onReload}>{b('reload')}</Button><Button variant="quiet" onClick={onOpenNetwork}>{b('network')}</Button></div>
    <details><summary>{b('failureDetails')}</summary><code>{error}</code></details>
  </div>;
}

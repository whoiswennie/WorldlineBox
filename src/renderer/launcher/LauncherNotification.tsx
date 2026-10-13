import { useEffect, useEffectEvent, useState } from 'react';
import { Icon } from '../Icons';
import { useT } from '../i18n';
import { Notice } from '../ui/patterns';
import { TOAST_NOTICE_DURATION_MS } from '../toast-notifications';

/** A module-owned floating notice, using the shared shell notice appearance. */
export function LauncherNotification({ message, title, error = false, pending = false, operationId, onDismiss, onViewOperation }: {
  readonly message: string;
  readonly title?: string;
  readonly error?: boolean;
  readonly pending?: boolean;
  readonly operationId?: string;
  readonly onDismiss: () => void;
  readonly onViewOperation?: () => void;
}) {
  const t = useT();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const [expanded, setExpanded] = useState(false);
  const dismiss = useEffectEvent(onDismiss);
  useEffect(() => {
    if (error || pending || paused) return;
    const timer = window.setTimeout(() => dismiss(), TOAST_NOTICE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [error, pending, paused]);

  return <aside className="launcher-notification-region" data-dsh-notification>
    <Notice
      actions={error ? <span className="workspace-notice-actions">
        <button aria-expanded={expanded} className="launcher-notice-action" onClick={() => setExpanded(!expanded)} type="button">{t('inspector.rawDetails')}</button>
        {onViewOperation ? <button className="launcher-notice-action" onClick={onViewOperation} type="button">{t('launcher.viewOperation')}</button> : null}
      </span> : undefined}
      className={`workspace-notice-item launcher-notice launcher-banner${error ? ' is-error' : ''}`}
      data-dsh-operation-alert={operationId}
      dismissible={!pending}
      dismissLabel={t('launcher.close')}
      leading={<span aria-hidden="true" className={`workspace-notice-icon${pending ? ' launcher-spinning' : ''}`}><Icon name={error ? 'alert-circle' : pending ? 'refresh' : 'check'} size={16} /></span>}
      message={<div className="launcher-notice-summary">{title ? <strong>{title}</strong> : null}<span>{message}</span></div>}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
      onDismiss={onDismiss}
      onFocusCapture={() => setFocused(true)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      tone={error ? 'error' : pending ? 'info' : 'success'}
    >{expanded ? <pre className="launcher-notice-details">{message}</pre> : null}</Notice>
  </aside>;
}

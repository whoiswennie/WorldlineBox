import { useEffect } from 'react';
import type { Companion, CompanionConversation, CompanionsRequest, CompanionsResponse, CompanionMessage, WorldlineBoxCompanionsApi } from '../../shared/companions';
import { CompanionMemoryPanel, type CompanionMemoryDraft } from './CompanionMemoryPanel';
import { Avatar } from './CompanionVisuals';
import { Icon } from '../Icons';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';

export function CompanionMemoryManager({ companions, ownerId, conversation, request, api, draft, onDraftConsumed, requestError, onDismissError, authorName, onOwnerChange, onLocateSource, onClose }: {
  readonly companions: Companion[]; readonly ownerId: string; readonly conversation: CompanionConversation;
  readonly request: (input: CompanionsRequest) => Promise<CompanionsResponse | undefined>; readonly api?: WorldlineBoxCompanionsApi;
  readonly draft?: CompanionMemoryDraft; readonly onDraftConsumed: () => void; readonly authorName: (id: string) => string;
  readonly requestError?: string; readonly onDismissError: () => void;
  readonly onOwnerChange: (id: string) => void; readonly onLocateSource: (message: CompanionMessage) => void; readonly onClose: () => void;
}) {
  useDialogFocusTrap(true, '共同记忆管理');
  useEffect(() => { const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }; document.addEventListener('keydown', listener); return () => document.removeEventListener('keydown', listener); }, [onClose]);
  const owner = companions.find(role => role.id === ownerId);
  return <div className="companions-modal-backdrop companions-workspace-backdrop" onClick={onClose}>
    <section className="companions-memory-manager" role="dialog" aria-modal="true" aria-label="共同记忆管理" onClick={event => event.stopPropagation()}>
      <header><div className="companions-workspace-title"><span className="companions-workspace-symbol"><Icon name="archive" /></span><div><h2>共同记忆</h2><p>相处的细节，都有来处</p></div></div><div className="companions-memory-manager-owner"><Avatar companion={owner} showPresence={false} />{companions.length > 1 ? <select aria-label="记忆所属伙伴" value={ownerId} onChange={event => onOwnerChange(event.target.value)}>{companions.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select> : <span>{owner?.name}</span>}<button className="companion-icon-button" aria-label="关闭共同记忆管理" onClick={onClose}>×</button></div></header>
      {requestError && <div className="companions-workspace-request-error" role="alert"><span>{requestError}</span><button aria-label="关闭错误提示" onClick={onDismissError}>×</button></div>}
      <CompanionMemoryPanel key={conversation.id + '/' + ownerId} companionId={ownerId} conversationId={conversation.id} conversationKind={conversation.kind} request={request} api={api} draft={draft} onDraftConsumed={onDraftConsumed} authorName={authorName} onLocateSource={onLocateSource} />
    </section>
  </div>;
}

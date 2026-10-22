import { useCallback, useState } from 'react';
import type { Companion, CompanionConversation, CompanionsRequest, CompanionsResponse, CompanionMessage, WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionMemoryDraft } from './companion-memory-draft';
import { CompanionMemoryLibraryWorkspace, type CompanionMemoryDocumentDraft } from './CompanionMemoryLibraryWorkspace';
import { CompanionLearningSources } from './CompanionLearningSources';

export function CompanionMemoryManager({ companions, ownerId, request, api, draft, onDraftConsumed, requestError, onDismissError, authorName, onOwnerChange, onLocateSource, onClose, onLearningSources, active = true, processingRequest, onProcessingRequestConsumed }: {
  readonly companions: Companion[]; readonly ownerId: string; readonly conversation?: CompanionConversation;
  readonly request: (input: CompanionsRequest) => Promise<CompanionsResponse | undefined>; readonly api?: WorldlineBoxCompanionsApi;
  readonly draft?: CompanionMemoryDraft; readonly onDraftConsumed: () => void; readonly authorName: (id: string) => string;
  readonly requestError?: string; readonly onDismissError: () => void;
  readonly onLearningSources?: () => void; readonly onOwnerChange: (id: string) => void; readonly onLocateSource: (message: CompanionMessage) => void; readonly onClose: () => void;
  readonly active?: boolean; readonly processingRequest?: number; readonly onProcessingRequestConsumed?: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, CompanionMemoryDocumentDraft>>({});
  const [learningOpen, setLearningOpen] = useState(false);
  const consumeProcessingRequest = useCallback(() => { setLearningOpen(false); onProcessingRequestConsumed?.(); }, [onProcessingRequestConsumed]);
  const owner = companions.find(companion => companion.id === ownerId);
  const rememberEditor = useCallback((id: string, value?: CompanionMemoryDocumentDraft) => setDrafts(current => {
    if (current[id] === value) return current;
    const next = { ...current }; if (value) next[id] = value; else delete next[id]; return next;
  }), []);
  return <section className="companions-memory-library-manager" role="region" hidden={!active} aria-label="共同记忆管理">
    <div className="learning-workspace-preserved" hidden={learningOpen}><CompanionMemoryLibraryWorkspace key={ownerId} active={active && !learningOpen} processingRequest={processingRequest} onProcessingRequestConsumed={consumeProcessingRequest} companions={companions} companionId={ownerId} request={request} api={api} draft={draft} onDraftConsumed={onDraftConsumed} authorName={authorName} onLocateSource={onLocateSource} onOwnerChange={onOwnerChange} onClose={onClose} requestError={requestError} onDismissError={onDismissError} initialEditor={drafts[ownerId]} onEditorChange={rememberEditor} onLearningSources={onLearningSources ?? (() => setLearningOpen(true))} /></div>
    {active && learningOpen && owner && <CompanionLearningSources key={ownerId} embedded owner={owner} api={api} onClose={() => setLearningOpen(false)} />}
  </section>;
}

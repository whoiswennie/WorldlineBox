import { useCallback, useEffect, useRef, useState } from 'react';
import type { Companion, CompanionConversation, CompanionsRequest, CompanionsResponse, CompanionMessage, WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionMemoryDraft } from './companion-memory-draft';
import { CompanionMemoryLibraryWorkspace, type CompanionMemoryDocumentDraft } from './CompanionMemoryLibraryWorkspace';
import { CompanionLearningSources } from './CompanionLearningSources';
import { CompanionMemoryTraceWorkspace } from './CompanionMemoryTraceWorkspace';
import { CompanionMemoryProbeWorkspace } from './CompanionMemoryProbeWorkspace';

export function CompanionMemoryManager({ companions, ownerId, request, api, draft, onDraftConsumed, requestError, onDismissError, authorName, onOwnerChange, onLocateSource, onClose, onLearningSources, active = true, processingRequest, onProcessingRequestConsumed, learningRequest, onLearningRequestConsumed, traceRequest, onTraceRequestConsumed }: {
  readonly companions: Companion[]; readonly ownerId: string; readonly conversation?: CompanionConversation;
  readonly request: (input: CompanionsRequest) => Promise<CompanionsResponse | undefined>; readonly api?: WorldlineBoxCompanionsApi;
  readonly draft?: CompanionMemoryDraft; readonly onDraftConsumed: () => void; readonly authorName: (id: string) => string;
  readonly requestError?: string; readonly onDismissError: () => void;
  readonly onLearningSources?: () => void; readonly onOwnerChange: (id: string) => void; readonly onLocateSource: (message: CompanionMessage) => void; readonly onClose: () => void;
  readonly active?: boolean; readonly processingRequest?: number; readonly onProcessingRequestConsumed?: () => void;
  readonly learningRequest?: number; readonly onLearningRequestConsumed?: () => void;
  readonly traceRequest?: number; readonly onTraceRequestConsumed?: () => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, CompanionMemoryDocumentDraft>>({});
  const [learningOpen, setLearningOpen] = useState(false);
  const [traceOwner, setTraceOwner] = useState<string>();
  const [probeOwner, setProbeOwner] = useState<string>();
  const [probeQuery, setProbeQuery] = useState('');
  const [localProcessing, setLocalProcessing] = useState<{ owner: string; nonce: number }>();
  const [noteRequest, setNoteRequest] = useState<{ owner: string; noteId: string; nonce: number }>();
  const traceOpen = traceOwner === ownerId, probeOpen = probeOwner === ownerId;
  const lastTraceRequest = useRef<string | undefined>(undefined);
  const localNonce = useRef(0);
  useEffect(() => {
    const key = `${ownerId}:${traceRequest}`;
    if (!active || traceRequest === undefined || lastTraceRequest.current === key) return;
    lastTraceRequest.current = key;
    void Promise.resolve().then(() => { setLearningOpen(false); setProbeOwner(undefined); setTraceOwner(ownerId); onTraceRequestConsumed?.(); });
  }, [active, ownerId, traceRequest, onTraceRequestConsumed]);
  const lastLearningRequest = useRef<string | undefined>(undefined);
  useEffect(() => {
    const key = `${ownerId}:${learningRequest}`;
    if (!active || learningRequest === undefined || processingRequest !== undefined || lastLearningRequest.current === key) return;
    lastLearningRequest.current = key; setLearningOpen(true); setTraceOwner(undefined); setProbeOwner(undefined); onLearningRequestConsumed?.();
  }, [active, ownerId, learningRequest, processingRequest, onLearningRequestConsumed]);
  const consumeProcessingRequest = useCallback(() => { setLearningOpen(false); setTraceOwner(undefined); setProbeOwner(undefined); setLocalProcessing(undefined); onProcessingRequestConsumed?.(); }, [onProcessingRequestConsumed]);
  const owner = companions.find(companion => companion.id === ownerId);
  const rememberEditor = useCallback((id: string, value?: CompanionMemoryDocumentDraft) => setDrafts(current => {
    if (current[id] === value) return current;
    const next = { ...current }; if (value) next[id] = value; else delete next[id]; return next;
  }), []);
  return <section className="companions-memory-library-manager" role="region" hidden={!active} aria-label="共同记忆管理">
    <div className="learning-workspace-preserved" hidden={learningOpen || traceOpen || probeOpen}><CompanionMemoryLibraryWorkspace key={ownerId} active={active && !learningOpen && !traceOpen && !probeOpen} processingRequest={processingRequest ?? (localProcessing?.owner === ownerId ? localProcessing.nonce : undefined)} onProcessingRequestConsumed={consumeProcessingRequest} noteRequest={noteRequest?.owner === ownerId ? noteRequest : undefined} onNoteRequestConsumed={() => setNoteRequest(undefined)} companions={companions} companionId={ownerId} request={request} api={api} draft={draft} onDraftConsumed={onDraftConsumed} authorName={authorName} onLocateSource={onLocateSource} onOwnerChange={onOwnerChange} onClose={onClose} requestError={requestError} onDismissError={onDismissError} initialEditor={drafts[ownerId]} onEditorChange={rememberEditor} onMemoryProbe={query => { setProbeQuery(query ?? ''); setProbeOwner(ownerId); setTraceOwner(undefined); setLearningOpen(false); }} onMemoryTrace={() => { setTraceOwner(ownerId); setProbeOwner(undefined); setLearningOpen(false); }} onLearningSources={onLearningSources ?? (() => setLearningOpen(true))} /></div>
    {active && learningOpen && owner && <CompanionLearningSources key={ownerId} embedded owner={owner} api={api} onClose={() => setLearningOpen(false)} />}
    {probeOpen && owner && <CompanionMemoryProbeWorkspace key={ownerId} initialQuery={probeQuery} companion={owner} request={request} api={api} active={active} onClose={() => setProbeOwner(undefined)} onOpenNote={noteId => { setProbeOwner(undefined); setNoteRequest({ owner: ownerId, noteId, nonce: ++localNonce.current }); }} />}
    {traceOpen && owner && <CompanionMemoryTraceWorkspace key={ownerId} companion={owner} request={request} api={api} active={active} onClose={() => setTraceOwner(undefined)} onLearningSources={() => { setTraceOwner(undefined); setLearningOpen(true); }} onProcessing={() => { setTraceOwner(undefined); setLocalProcessing({ owner: ownerId, nonce: ++localNonce.current }); }} onOpenNote={noteId => { setTraceOwner(undefined); setNoteRequest({ owner: ownerId, noteId, nonce: ++localNonce.current }); }} />}
  </section>;
}

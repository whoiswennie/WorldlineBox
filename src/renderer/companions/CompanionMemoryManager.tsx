import { useEffect, useMemo, useRef, useState } from 'react';
import type { Companion, CompanionConversation, CompanionsRequest, CompanionsResponse, CompanionMessage, WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionMemoryDraft } from './companion-memory-draft';
import { CompanionMemoryLibraryWorkspace, type CompanionMemoryLibraryRecentRead } from './CompanionMemoryLibraryWorkspace';
import { CompanionRecentReadCache } from './recent-read-cache';
import { CompanionLearningSources } from './CompanionLearningSources';
import { CompanionMemoryTraceWorkspace } from './CompanionMemoryTraceWorkspace';
import { CompanionMemoryProbeWorkspace } from './CompanionMemoryProbeWorkspace';
import type { AgendaViewName } from './companion-agenda-presentation';

export function CompanionMemoryManager({ companions, ownerId, request, api, draft, onDraftConsumed, requestError, onDismissError, authorName, onOwnerChange, onLocateSource, onClose, onLearningSources, onOpenAgenda, active = true, processingRequest, onProcessingRequestConsumed, learningRequest, onLearningRequestConsumed, traceRequest, onTraceRequestConsumed, memoryNoteRequest, onMemoryNoteRequestConsumed }: {
  readonly companions: Companion[]; readonly ownerId: string; readonly conversation?: CompanionConversation;
  readonly request: (input: CompanionsRequest) => Promise<CompanionsResponse | undefined>; readonly api?: WorldlineBoxCompanionsApi;
  readonly draft?: CompanionMemoryDraft; readonly onDraftConsumed: () => void; readonly authorName: (id: string) => string;
  readonly requestError?: string; readonly onDismissError: () => void;
  readonly onLearningSources?: () => void; readonly onOwnerChange: (id: string) => void; readonly onLocateSource: (message: CompanionMessage) => void; readonly onClose: () => void;
  readonly onOpenAgenda?: (ownerId: string, eventId?: string, view?: AgendaViewName) => void;
  readonly active?: boolean; readonly processingRequest?: number; readonly onProcessingRequestConsumed?: () => void;
  readonly learningRequest?: number; readonly onLearningRequestConsumed?: () => void;
  readonly traceRequest?: number; readonly onTraceRequestConsumed?: () => void;
  readonly memoryNoteRequest?: { owner: string; noteId: string; nonce: number }; readonly onMemoryNoteRequestConsumed?: () => void;
}) {
  const recentReads = useMemo(() => new CompanionRecentReadCache<CompanionMemoryLibraryRecentRead>(8, 8 * 1024 * 1024, api), [api]);
  // Keep invalidating retained metadata while hidden, without doing any I/O.
  // Progress cannot publish/revoke a document or change its canonical body.
  useEffect(() => api?.onChanged(change => { if (change?.kind !== 'progress') recentReads.clear(); }), [api, recentReads]);
  const [materialsOwner, setMaterialsOwner] = useState<string>();
  const [traceOwner, setTraceOwner] = useState<string>();
  const [probeOwner, setProbeOwner] = useState<string>();
  const [probeQuery, setProbeQuery] = useState('');
  const [noteRequest, setNoteRequest] = useState<{ owner: string; noteId: string; nonce: number }>();
  const materialsOpen = materialsOwner === ownerId, traceOpen = traceOwner === ownerId, probeOpen = probeOwner === ownerId;
  const lastTraceRequest = useRef<string | undefined>(undefined), lastNoteRequest = useRef<string | undefined>(undefined);
  const lastLearningRequest = useRef<string | undefined>(undefined), lastProcessingRequest = useRef<string | undefined>(undefined), localNonce = useRef(0);
  useEffect(() => {
    if (!active || !memoryNoteRequest || memoryNoteRequest.owner !== ownerId) return;
    const key = JSON.stringify(memoryNoteRequest); if (lastNoteRequest.current === key) return;
    let cancelled = false;
    void Promise.resolve().then(() => { if (cancelled) return; lastNoteRequest.current = key; setMaterialsOwner(undefined); setTraceOwner(undefined); setProbeOwner(undefined); setNoteRequest(memoryNoteRequest); onMemoryNoteRequestConsumed?.(); });
    return () => { cancelled = true; };
  }, [active, ownerId, memoryNoteRequest, onMemoryNoteRequestConsumed]);
  useEffect(() => {
    const key = `${ownerId}:${traceRequest}`;
    if (!active || traceRequest === undefined || lastTraceRequest.current === key) return;
    let cancelled = false;
    void Promise.resolve().then(() => { if (cancelled) return; lastTraceRequest.current = key; setMaterialsOwner(undefined); setProbeOwner(undefined); setTraceOwner(ownerId); onTraceRequestConsumed?.(); });
    return () => { cancelled = true; };
  }, [active, ownerId, traceRequest, onTraceRequestConsumed]);
  useEffect(() => {
    const key = `${ownerId}:${processingRequest}`;
    if (!active || processingRequest === undefined || lastProcessingRequest.current === key) return;
    let cancelled = false;
    void Promise.resolve().then(() => { if (cancelled) return; lastProcessingRequest.current = key; onOpenAgenda?.(ownerId); onProcessingRequestConsumed?.(); });
    return () => { cancelled = true; };
  }, [active, ownerId, processingRequest, onOpenAgenda, onProcessingRequestConsumed]);
  useEffect(() => {
    const key = `${ownerId}:${learningRequest}`;
    if (!active || learningRequest === undefined || processingRequest !== undefined || lastLearningRequest.current === key) return;
    let cancelled = false;
    void Promise.resolve().then(() => { if (cancelled) return; lastLearningRequest.current = key; if (onOpenAgenda) onOpenAgenda(ownerId, undefined, 'goals'); else onLearningSources?.(); onLearningRequestConsumed?.(); });
    return () => { cancelled = true; };
  }, [active, ownerId, learningRequest, processingRequest, onOpenAgenda, onLearningSources, onLearningRequestConsumed]);
  const owner = companions.find(companion => companion.id === ownerId);
  const openGoals = onOpenAgenda ? () => onOpenAgenda(ownerId, undefined, 'goals') : onLearningSources;
  return <section className="companions-memory-library-manager" role="region" hidden={!active} aria-label="共同记忆管理">
    <div className="learning-workspace-preserved" hidden={materialsOpen || traceOpen || probeOpen}><CompanionMemoryLibraryWorkspace recentReads={recentReads} key={ownerId} active={active && !materialsOpen && !traceOpen && !probeOpen} onOpenAgenda={onOpenAgenda} noteRequest={noteRequest?.owner === ownerId ? noteRequest : undefined} onNoteRequestConsumed={() => setNoteRequest(undefined)} companions={companions} companionId={ownerId} request={request} api={api} draft={draft} onDraftConsumed={onDraftConsumed} authorName={authorName} onLocateSource={onLocateSource} onOwnerChange={onOwnerChange} onClose={onClose} requestError={requestError} onDismissError={onDismissError} onMemoryProbe={query => { setProbeQuery(query ?? ''); setProbeOwner(ownerId); setTraceOwner(undefined); setMaterialsOwner(undefined); }} onMemoryTrace={() => { setTraceOwner(ownerId); setProbeOwner(undefined); setMaterialsOwner(undefined); }} onLearningSources={openGoals} onLearningMaterials={() => setMaterialsOwner(ownerId)} /></div>
    {active && materialsOpen && owner && <CompanionLearningSources key={ownerId} owner={owner} api={api} embedded authorizationOnly onClose={() => setMaterialsOwner(undefined)} />}
    {probeOpen && owner && <CompanionMemoryProbeWorkspace key={ownerId} initialQuery={probeQuery} companion={owner} request={request} api={api} active={active} onClose={() => setProbeOwner(undefined)} onOpenNote={noteId => { setProbeOwner(undefined); setNoteRequest({ owner: ownerId, noteId, nonce: ++localNonce.current }); }} />}
    {traceOpen && owner && <CompanionMemoryTraceWorkspace key={ownerId} companion={owner} request={request} api={api} active={active} onClose={() => setTraceOwner(undefined)} onLearningSources={() => { setTraceOwner(undefined); setMaterialsOwner(ownerId); }} onProcessing={onOpenAgenda ? () => onOpenAgenda(ownerId) : undefined} onOpenNote={noteId => { setTraceOwner(undefined); setNoteRequest({ owner: ownerId, noteId, nonce: ++localNonce.current }); }} />}
  </section>;
}

// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionCognitionDossier } from '../../src/renderer/companions/CompanionCognitionDossier';
import { CompanionActualContext } from '../../src/renderer/companions/CompanionActualContext';
import { CompanionCurrentCircumstances, CompanionExperienceView, CompanionRelationshipExperienceView } from '../../src/renderer/companions/CompanionCurrentCircumstances';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionContextSnapshot } from '../../src/shared/companion-cognition';
import type { CompanionWorkspaceResponse } from '../../src/shared/companion-workspace';
import type { CompanionRuntimeState } from '../../src/shared/companion-state';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined, host: HTMLDivElement;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); vi.useRealTimers(); });
const at = '2026-10-28T08:00:00.000Z';
const record: CompanionContextSnapshot = { id: 'ctx_' + '1'.repeat(32), companionId: 'alice', preparedAt: at, sentAt: at, completedAt: at, purpose: 'companion_reply', status: 'response', providerFormat: 'openai_chat', model: 'fixture-model', providerBody: '{"messages":[{"role":"user","content":"ACTUAL_OLD_REQUEST"}]}', bodyHash: 'a'.repeat(64), bodyStorage: 'exact', imageFallback: false, revocationMode: 'conservative_owner_revocation', httpStatus: 200, visualManifest: [], toolDeclarations: '[{"name":"actual_tool"}]',
  frame: { schema: 'worldlinebox.companion-context-v2', companionId: 'alice', purpose: 'companion_reply', conversationId: 'private_room', taskId: 'task1', invocationId: 'alice:private_room:message1', revocationEpoch: 0, profileRevision: 'b'.repeat(64), promptRevision: 'c'.repeat(64), identity: 'OLD_ADOPTED_SELF', roleGuidance: '当时表达指导', processorContract: '当时合同', input: 'ACTUAL_OLD_INPUT' } };
const { frame, providerBody: _body, visualManifest: _visuals, toolDeclarations: _tools, ...metadata } = record; void _body; void _visuals; void _tools;
const summary = { ...metadata, profileRevision: frame.profileRevision, conversationId: frame.conversationId, taskId: frame.taskId, invocationId: frame.invocationId, visualCount: 0, toolDeclarationBytes: 24 };
const assets = { companionId: 'alice', profileRevision: 'd'.repeat(64), promptRevision: 'e'.repeat(64), prompts: [], profile: { name: 'Alice', description: '当前简介', persona: '【当前性格】\nNOW_CURRENT_ONLY\n【表达】\n语气：清楚地承认未知。' }, origin: { revision: 'f'.repeat(64), content: 'CREATION_ORIGIN_ONLY' }, growthReleases: [{ id: 'release1', revision: 2, content: 'RELEASE_EXACT_DIFF_AND_REASON' }] };
function api(workspace: NonNullable<WorldlineBoxCompanionsApi['workspace']>, request: WorldlineBoxCompanionsApi['request'] = async () => ({ ok: true })): WorldlineBoxCompanionsApi { return { workspace, request, onChanged: () => () => undefined, onReplyStream: () => () => undefined }; }
async function mount(element: React.ReactNode) { host = document.createElement('div'); document.body.append(host); root = createRoot(host); await act(async () => root!.render(element)); }
async function click(label: string) { const groups: Record<string, string> = { 当前自我: '当前角色', 起点档案: '经历档案', 成长历程: '经历档案', 本次实际上下文: '运行核对', 正在成长: '学习成长' }; if (![...host.querySelectorAll('button')].some(button => button.textContent === label) && groups[label]) await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === groups[label])!.click()); await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === label || button.getAttribute('aria-label') === label)!.click()); }
it('shows exact creation/release objects and actual selected request content independently of the current persona', async () => {
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async command => command.type === 'cognition.context.list' ? { ok: true, contextSnapshots: [summary], contextSnapshotRetention: { limit: 24, truncated: false, policy: 'recent_attempts_per_owner', bodyLimitBytes: 6291456 } } : command.type === 'cognition.context.read' ? { ok: true, contextSnapshot: record } : { ok: true });
  await mount(<CompanionCognitionDossier companionId="alice" api={api(workspace)} assets={assets} />); expect(host.textContent).toContain('NOW_CURRENT_ONLY'); expect(host.querySelector('textarea, input')).toBeNull(); expect(host.querySelectorAll('[role="tab"]')).toHaveLength(4); expect(host.querySelector('.cognition-nav-group')).toBeNull();
  await click('起点档案'); expect(host.textContent).toContain('CREATION_ORIGIN_ONLY'); expect(host.textContent).not.toContain('NOW_CURRENT_ONLY');
  await click('成长历程'); expect(host.textContent).toContain('RELEASE_EXACT_DIFF_AND_REASON');
  await click('本次实际上下文'); await act(async () => host.querySelector<HTMLButtonElement>('.cognition-context-list button')!.click());
  expect(host.textContent).toContain('ACTUAL_OLD_REQUEST'); expect(host.textContent).toContain('OLD_ADOPTED_SELF'); expect(host.textContent).toContain('actual_tool'); expect(host.textContent).not.toContain('NOW_CURRENT_ONLY');
  expect(host.textContent).toContain('alice:private_room:message1'); expect(workspace).toHaveBeenCalledWith({ type: 'cognition.context.read', companionId: 'alice', id: record.id });
  expect(workspace.mock.calls.some(([command]) => /save|propose/u.test(command.type))).toBe(false);
});
it('shows an explicit empty actual-request index and never substitutes current persona or guidance', async () => {
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async () => ({ ok: true, contextSnapshots: [] }));
  await mount(<CompanionActualContext companionId="alice" api={api(workspace)} />); expect(host.textContent).toContain('尚无可核实的实际请求快照'); expect(host.textContent).not.toContain('NOW_CURRENT_ONLY'); expect(host.querySelector('pre')).toBeNull();
  expect(workspace.mock.calls.some(([command]) => command.type === 'cognition.context.read')).toBe(false);
});
it('loads earlier formal growth releases only on request and follows the exact twentieth release cursor', async () => {
  const first = Array.from({ length: 20 }, (_, index) => ({ id: 'release:' + (25 - index), revision: 25 - index, content: 'EXACT_RELEASE_' + (25 - index) }));
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async command => command.type === 'growth.releases.read'
    ? { ok: true, growthReleasePage: { companionId: 'alice', items: [{ id: 'release:5', revision: 5, content: 'EARLIEST_EXACT_RELEASE' }], hasMore: false, revocationEpoch: 0 } } : { ok: false });
  await mount(<CompanionCognitionDossier companionId="alice" api={api(workspace)} assets={{ ...assets, growthReleases: first, growthReleaseContinuation: { hasMore: true, nextId: 'release:6', revocationEpoch: 0 } }} />);
  await click('成长历程'); expect(host.querySelectorAll('.cognition-releases > li')).toHaveLength(20); expect(workspace).not.toHaveBeenCalled(); expect(host.textContent).toContain('还有更早的正式发布记录');
  await click('加载更早的成长记录'); expect(workspace).toHaveBeenCalledExactlyOnceWith({ type: 'growth.releases.read', companionId: 'alice', afterId: 'release:6', expectedRevocationEpoch: 0 });
  expect(host.querySelectorAll('.cognition-releases > li')).toHaveLength(21); expect(host.textContent).toContain('EARLIEST_EXACT_RELEASE'); expect(host.textContent).not.toContain('加载更早的成长记录');
});
it('keeps the exact history cursor on a failed page and discards a late result after changing companions', async () => {
  let finish!: (value: CompanionWorkspaceResponse) => void, calls = 0;
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async command => {
    if (command.type !== 'growth.releases.read') return { ok: false };
    if (++calls === 1) return { ok: true, growthReleasePage: { companionId: 'foreign', items: [{ id: 'other', revision: 1, content: 'FOREIGN_HISTORY' }], hasMore: false, revocationEpoch: 0 } };
    return new Promise(resolve => { finish = resolve; });
  });
  const connection = api(workspace);
  await mount(<CompanionCognitionDossier companionId="alice" api={connection} assets={{ ...assets, growthReleaseContinuation: { hasMore: true, nextId: 'release1', revocationEpoch: 0 } }} />);
  await click('成长历程'); await click('加载更早的成长记录'); expect(host.querySelector('[role="alert"]')?.textContent).toContain('归属或分页位置不一致'); expect(host.textContent).not.toContain('FOREIGN_HISTORY');
  await click('重试加载更早记录'); expect(workspace.mock.calls.map(([command]) => command)).toEqual([
    { type: 'growth.releases.read', companionId: 'alice', afterId: 'release1', expectedRevocationEpoch: 0 }, { type: 'growth.releases.read', companionId: 'alice', afterId: 'release1', expectedRevocationEpoch: 0 },
  ]);
  await act(async () => root!.render(<CompanionCognitionDossier companionId="bob" api={connection} assets={{ ...assets, companionId: 'bob', profile: { ...assets.profile, name: 'Bob' }, growthReleases: [] }} />));
  await act(async () => finish({ ok: true, growthReleasePage: { companionId: 'alice', items: [{ id: 'late', revision: 1, content: 'LATE_ALICE_HISTORY' }], hasMore: false, revocationEpoch: 0 } }));
  expect(host.textContent).not.toContain('LATE_ALICE_HISTORY'); expect(host.textContent).not.toContain('RELEASE_EXACT_DIFF_AND_REASON'); expect(host.textContent).not.toContain('还有更早的正式发布记录');
});
it('clears previously visible history immediately when an older-page response has a newer withdrawal epoch, and resets on a fresh dossier version', async () => {
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async () => ({ ok: false, error: '依据已变化',
    growthReleasePage: { companionId: 'alice', items: [], hasMore: false, revocationEpoch: 1 } }));
  const connection = api(workspace);
  await mount(<CompanionCognitionDossier companionId="alice" api={connection} assets={{ ...assets, growthReleaseContinuation: { hasMore: true, nextId: 'release1', revocationEpoch: 0 } }} />);
  await click('成长历程'); expect(host.textContent).toContain('RELEASE_EXACT_DIFF_AND_REASON');
  await click('加载更早的成长记录'); expect(host.textContent).not.toContain('RELEASE_EXACT_DIFF_AND_REASON'); expect(host.querySelector('[role="alert"]')?.textContent).toContain('旧分页已清除');
  await act(async () => root!.render(<CompanionCognitionDossier companionId="alice" api={connection} assets={{ ...assets, growthReleases: [{ id: 'new', revision: 1, content: 'CURRENT_AUTHORIZED_RELEASE' }], growthReleaseContinuation: { hasMore: false, revocationEpoch: 1 } }} />));
  expect(host.textContent).toContain('CURRENT_AUTHORIZED_RELEASE'); expect(host.textContent).not.toContain('旧分页已清除'); expect(host.textContent).not.toContain('RELEASE_EXACT_DIFF_AND_REASON');
});
it('shows the exact original and finite repair chain without treating a response or unknown repair as a published memory', async () => {
  const make = (attempt: 1 | 2, status: 'response' | 'unknown'): CompanionContextSnapshot => ({ ...record, id: 'ctx_' + String(attempt + 1).repeat(32), purpose: 'companion_structured_repair', status,
    providerBody: 'EXACT_REPAIR_BODY_' + attempt, frame: { ...record.frame, purpose: 'companion_structured_repair', invocationId: 'repair:' + attempt, input: 'BAD_OUTPUT_AND_VALIDATION_ERRORS_' + attempt,
      structuredRepair: { rootInvocationId: record.frame.invocationId!, previousInvocationId: attempt === 1 ? record.frame.invocationId! : 'repair:1', attempt, reason: attempt === 1 ? 'syntax' : 'schema', originalPurpose: 'vcp_sleep_reflection' } } });
  const one = make(1, 'response'), two = make(2, 'unknown'), records = [record, one, two], summaries = records.map(value => { const { frame, providerBody, visualManifest, toolDeclarations, ...rest } = value; void providerBody; void visualManifest; void toolDeclarations; return { ...rest, profileRevision: frame.profileRevision, invocationId: frame.invocationId, structuredRepair: frame.structuredRepair, visualCount: 0, toolDeclarationBytes: 0 }; });
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async command => command.type === 'cognition.context.read' ? { ok: true, contextSnapshot: records.find(item => item.id === command.id)! } : { ok: true, contextSnapshots: summaries });
  await mount(<CompanionActualContext companionId="alice" api={api(workspace)} />); await act(async () => host.querySelector<HTMLButtonElement>(`[data-context-snapshot="${two.id}"] button`)!.click());
  const chain = host.querySelector('[aria-label="结构化修复调用链"]')!; expect(chain.textContent).toContain('第 2 次，最多两次'); expect(chain.textContent).toContain('输出结构未通过'); expect(chain.textContent).toContain('不代表记忆或人格已发布'); expect(chain.textContent).toContain('不自动重发'); expect(chain.querySelectorAll('button')).toHaveLength(3); expect(host.textContent).toContain('EXACT_REPAIR_BODY_2');
  await act(async () => chain.querySelectorAll('button')[0]!.click()); expect(host.textContent).toContain('ACTUAL_OLD_REQUEST'); expect(host.textContent).not.toContain('EXACT_REPAIR_BODY_2'); expect(workspace.mock.calls.every(([command]) => command.type === 'cognition.context.list' || command.type === 'cognition.context.read')).toBe(true);
});
it('ignores a late previous-owner snapshot and clears a denied body instead of falling back to a preview', async () => {
  let finish!: (value: CompanionWorkspaceResponse) => void;
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async command => command.type === 'cognition.context.read' ? new Promise(resolve => { finish = resolve; }) : { ok: true, contextSnapshots: 'companionId' in command && command.companionId === 'alice' ? [summary] : [] });
  const connection = api(workspace); await mount(<CompanionActualContext companionId="alice" api={connection} />);
  await act(async () => host.querySelector<HTMLButtonElement>('.cognition-context-list button')!.click());
  await act(async () => root!.render(<CompanionActualContext companionId="bob" api={connection} />)); await act(async () => finish({ ok: true, contextSnapshot: record }));
  expect(host.textContent).not.toContain('ACTUAL_OLD_REQUEST'); expect(host.querySelector('pre')).toBeNull(); expect(host.textContent).toContain('尚无可核实');
});
it('coalesces unrelated change bursts without abandoning a selected request, and removes its body after formal revocation', async () => {
  vi.useFakeTimers(); let changed!: () => void, finish!: (value: CompanionWorkspaceResponse) => void, reads = 0, revoked = false;
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async command => {
    if (command.type === 'cognition.context.read') { reads++; return reads === 1 ? new Promise(resolve => { finish = resolve; }) : { ok: true, contextSnapshot: record }; }
    return { ok: true, contextSnapshots: [{ ...summary, status: revoked ? 'redacted' : 'response' }] };
  });
  const connection = api(workspace); connection.onChanged = listener => { changed = listener; return () => undefined; };
  await mount(<CompanionActualContext companionId="alice" api={connection} />); await act(async () => host.querySelector<HTMLButtonElement>('.cognition-context-list button')!.click());
  await act(async () => { for (let index = 0; index < 80; index++) changed(); await vi.advanceTimersByTimeAsync(350); });
  expect(host.textContent).toContain('ACTUAL_OLD_REQUEST'); expect(host.querySelector<HTMLButtonElement>('.cognition-context-list button')!.getAttribute('aria-pressed')).toBe('true');
  await act(async () => finish({ ok: false, error: 'a superseded read' })); expect(host.textContent).toContain('ACTUAL_OLD_REQUEST'); expect(host.textContent).not.toContain('a superseded read');
  await act(async () => { revoked = true; changed(); await vi.advanceTimersByTimeAsync(350); });
  expect(host.querySelector('article')).toBeNull(); expect(host.textContent).not.toContain('ACTUAL_OLD_REQUEST'); expect(host.querySelector<HTMLButtonElement>('.cognition-context-list button')!.disabled).toBe(true); expect(reads).toBe(2);
});
it('clears the selected exact body when authorization is denied during refresh even if an older index still listed it', async () => {
  vi.useFakeTimers(); let changed!: () => void, denied = false;
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async command => command.type === 'cognition.context.read' ? denied ? { ok: false, error: '此来源已撤回，无权读取正文。' } : { ok: true, contextSnapshot: record } : { ok: true, contextSnapshots: [summary] });
  const connection = api(workspace); connection.onChanged = listener => { changed = listener; return () => undefined; };
  await mount(<CompanionActualContext companionId="alice" api={connection} />); await act(async () => host.querySelector<HTMLButtonElement>('.cognition-context-list button')!.click()); expect(host.textContent).toContain('ACTUAL_OLD_REQUEST');
  await act(async () => { denied = true; changed(); await vi.advanceTimersByTimeAsync(350); });
  expect(host.querySelector('article')).toBeNull(); expect(host.textContent).not.toContain('ACTUAL_OLD_REQUEST'); expect(host.querySelector('[role="alert"]')?.textContent).toContain('已撤回'); expect(host.textContent).not.toContain('正在核对这次实际请求');
});
it('loads source-backed cultivation only on its dossier page and leaves published persona/history read-only', async () => {
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>(async command => command.type === 'growth.goals.read' ? { ok: true, growthGoals: [] } : { ok: false });
  const request = vi.fn<WorldlineBoxCompanionsApi['request']>(async command => command.type === 'state' ? { ok: true, state: { companions: [{ id: 'alice', name: 'Alice', description: '', persona: '当前人格只读。', model: '', avatar: 'custom', builtin: false, proactive: false, createdAt: at }], conversations: [{ id: 'private_room', kind: 'private', title: 'Alice', memberIds: ['alice'], pinned: false, muted: false, unread: 0, updatedAt: at, lastMessage: '' }], activities: [], configured: false } } : { ok: false });
  await mount(<CompanionCognitionDossier companionId="alice" api={api(workspace, request)} assets={assets} />);
  expect(host.querySelector('form,textarea,input,select')).toBeNull(); expect(workspace).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  await click('正在成长'); await act(async () => { await import('../../src/renderer/companions/CompanionGrowthGoals'); });
  expect(workspace).toHaveBeenCalledExactlyOnceWith({ type: 'growth.goals.read', companionId: 'alice', conversationId: 'private_room' });
  expect(request).toHaveBeenCalledExactlyOnceWith({ type: 'state', readiness: 'navigation' });
  expect(host.querySelector('form,textarea,input,select')).toBeNull();
  await click('当前自我'); expect(host.textContent).toContain('NOW_CURRENT_ONLY');
  await click('成长历程'); expect(host.textContent).toContain('RELEASE_EXACT_DIFF_AND_REASON');
  expect(host.querySelector('form,textarea,input,select')).toBeNull();
  expect(workspace.mock.calls.some(([command]) => /propose|status|integrat/u.test(command.type))).toBe(false);
});
it('displays only sourced subjective experience and automatically stops presenting it as current after its expiry', async () => {
  vi.useFakeTimers(); vi.setSystemTime(at);
  const runtime: CompanionRuntimeState = { schema: 'companion-runtime-qualitative-v1', companionId: 'alice', energy: 99, expression: 'gentle', relationshipRecords: [], updatedAt: at, revision: 1,
    experience: { type: 'current_experience', id: 'experience1', companionId: 'alice', sourceConversationId: 'private_room', sourceMessageIds: ['source1'], sourceVersions: [{ messageId: 'source1', revision: 2, checksum: 'a'.repeat(64) }], occurredAt: at, recordedAt: at, revision: 3, situation: '刚遇到一个还不确定的问题。', statement: '我有些犹豫，想先核对条件。', uncertainty: '现有资料是否适用于这个情境。', responsePreference: '先让我把不确定的条件说清楚。', reassessWhen: ['取得原始资料以后'], touchedGoalIds: [], validUntil: '2026-10-28T08:00:01.000Z' } };
  await mount(<CompanionExperienceView runtime={runtime} />); expect(host.textContent).toContain('我有些犹豫'); expect(host.textContent).toContain('来源修订 2'); expect(host.textContent).not.toContain('99'); expect(host.querySelector('meter,progress,[role="progressbar"]')).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(1002)); expect(host.textContent).toContain('已过有效时间'); expect(host.textContent).not.toContain('我有些犹豫');
});
it('shows concrete relationship events and reassessment conditions without inferring closeness or a growth stage', async () => {
  const runtime: CompanionRuntimeState = { schema: 'companion-runtime-qualitative-v1', companionId: 'alice', energy: 50, expression: 'reserved', updatedAt: at, revision: 1,
    relationshipRecords: [{ type: 'relationship_record', id: 'relation1', companionId: 'alice', targetId: 'user', topic: '遇到争论时怎样沟通', context: '上次交流节奏太快。', kind: 'agreement', statement: '先各自说明依据，再讨论结论。', currentExpectation: '下次争论时一起实践。', reassessWhen: ['双方发现这个约定不再适用'], replacesRecordIds: [], sourceConversationId: 'private_room', sourceMessageIds: ['source2'], sourceVersions: [{ messageId: 'source2', revision: 1, checksum: 'b'.repeat(64) }], occurredAt: at, recordedAt: at, revision: 1 }] };
  await mount(<CompanionRelationshipExperienceView runtime={runtime} />); expect(host.textContent).toContain('共同约定'); expect(host.textContent).toContain('先各自说明依据'); expect(host.textContent).toContain('双方发现这个约定不再适用'); expect(host.textContent).not.toMatch(/好感|信任分数|熟悉阶段/u); expect(host.querySelector('meter,progress,[role="progressbar"]')).toBeNull();
});
it('unsubscribes an old companion scope and refuses its late current-circumstances result',async()=>{
  let finishAlice!:(value:Awaited<ReturnType<WorldlineBoxCompanionsApi['request']>>)=>void;
  const runtime=(ownerId:string):CompanionRuntimeState=>({schema:'companion-runtime-qualitative-v1',companionId:ownerId,energy:50,expression:'reserved',updatedAt:at,revision:1,
    relationshipRecords:[{type:'relationship_record',id:'relation_'+ownerId,companionId:ownerId,targetId:'user',topic:ownerId+'范围内的真实约定',context:'只属于当前私聊。',kind:'agreement',statement:ownerId+'自己的关系表达',reassessWhen:['双方重新讨论'],replacesRecordIds:[],sourceConversationId:'private_'+ownerId,sourceMessageIds:['source_'+ownerId],sourceVersions:[{messageId:'source_'+ownerId,revision:1,checksum:'a'.repeat(64)}],occurredAt:at,recordedAt:at,revision:1}]});
  const request=vi.fn<WorldlineBoxCompanionsApi['request']>(async command=>command.type==='state'?{ok:true,state:{companions:[],activities:[],configured:true,
    conversations:['alice','bob'].map(id=>({id:'private_'+id,kind:'private' as const,title:id,memberIds:[id],pinned:false,muted:false,unread:0,updatedAt:at,lastMessage:''}))}}:
    command.type==='state.get'&&command.companionId==='alice'?new Promise(resolve=>{finishAlice=resolve;}):{ok:true,runtimeState:runtime('bob')});
  const connection=api(async()=>({ok:true}),request),unsubscribe=vi.fn();connection.onChanged=()=>unsubscribe;
  await mount(<CompanionCurrentCircumstances companionId="alice" api={connection} relationships />);
  await act(async()=>root!.render(<CompanionCurrentCircumstances companionId="bob" api={connection} relationships />));
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  await act(async()=>finishAlice({ok:true,runtimeState:runtime('alice')}));
  expect(host.textContent).toContain('bob自己的关系表达');expect(host.textContent).not.toContain('alice自己的关系表达');
  expect(request).toHaveBeenCalledWith({type:'state.get',companionId:'bob',conversationId:'private_bob'});
});


it('does not reload full role assets for progress, and hides loaded private data before full revalidation', async () => {
  vi.useFakeTimers();
  let changed: Parameters<WorldlineBoxCompanionsApi['onChanged']>[0] | undefined;
  let deny!: (value: CompanionWorkspaceResponse) => void;
  const workspace = vi.fn<NonNullable<WorldlineBoxCompanionsApi['workspace']>>().mockResolvedValueOnce({ ok: true, companionAssets: assets })
    .mockImplementation(() => new Promise(resolve => { deny = resolve; }));
  const current: WorldlineBoxCompanionsApi = { workspace, request: async () => ({ ok: true }), onChanged: listener => { changed = listener; return () => { changed = undefined; }; }, onReplyStream: () => () => undefined };
  await mount(<CompanionCognitionDossier companionId="alice" api={current} />);
  expect(workspace).toHaveBeenCalledOnce(); expect(host.textContent).toContain('NOW_CURRENT_ONLY');
  await act(async () => { for (let index = 0; index < 20; index++) changed?.({ kind: 'progress' }); });
  expect(workspace).toHaveBeenCalledOnce(); expect(host.textContent).toContain('NOW_CURRENT_ONLY');
  await act(async () => changed?.());
  expect(host.textContent).not.toContain('NOW_CURRENT_ONLY');
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(workspace).toHaveBeenCalledTimes(2);
  await act(async () => deny({ ok: false, error: '本次来源已撤回' }));
  expect(host.textContent).toContain('本次来源已撤回'); expect(host.textContent).not.toContain('NOW_CURRENT_ONLY');
});

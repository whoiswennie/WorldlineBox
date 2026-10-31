import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Companion, WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionWorkspaceResponse } from '../../shared/companion-workspace';
import { companionGrowthReleasePageSchema } from '../../shared/companion-workspace';
import { parseCharacterDocument } from '../../shared/companion-character-document';
import { CompanionPromptAssets } from './CompanionPromptAssetsEditor';
import { CompanionActualContext, ContextSnapshotText } from './CompanionActualContext';
import { CompanionCurrentCircumstances } from './CompanionCurrentCircumstances';
import { Icon, type IconName } from '../Icons';
import { createCoalescedRefresh } from './coalesced-refresh';
import './companion-cognition-dossier.css';

type Assets = NonNullable<CompanionWorkspaceResponse['companionAssets']>;
const CompanionGrowthGoals = lazy(() => import('./CompanionGrowthGoals').then(module => ({ default: module.CompanionGrowthGoals })));
const pages = [
  ['self', '当前自我'], ['expression', '表达与相处'], ['beliefs', '价值与认知'],
  ['circumstances', '当前处境'], ['relationships', '关系经历'], ['knowledge', '知识与记忆'], ['growth', '正在成长'],
  ['history', '成长历程'], ['origin', '起点档案'], ['instructions', '职能指导'], ['context', '本次实际上下文'],
] as const;
type Page = typeof pages[number][0];
const pageInfo: Record<Page, { icon: IconName; description: string }> = {
  self: { icon: 'user', description: '当前已发布的完整人格，保留每一项设定的原文与条件。' },
  expression: { icon: 'message-circle', description: '说话方式、语气与相处边界，来自当前生效的人格正文。' },
  beliefs: { icon: 'globe', description: '已经明确写下的价值取向、认识和偏好。没有写下的内容保留未知。' },
  circumstances: { icon: 'activity', description: '伙伴对当前情境的本人表达，以及需要重新评估它的条件。' },
  relationships: { icon: 'users', description: '区分角色中的关系设定与实际发生的共同经历、约定和修复。' },
  knowledge: { icon: 'collection', description: '经历、知识、方法和自我认识分别保存，按需要参与回忆。' },
  growth: { icon: 'sparkles', description: '从具体反馈提出方向，经由实际练习和有来源的反思形成变化。' },
  history: { icon: 'clock', description: '已经正式发布的人格变化及其准确凭证。日记数量不代表成长。' },
  origin: { icon: 'archive', description: '创建时确认的封存原稿，保留伙伴从哪里开始的依据。' },
  instructions: { icon: 'layers', description: '按具体职能选用的指导与规则，完整只读查看。' },
  context: { icon: 'code', description: '核对某一次实际请求采用的身份、资料、工具与最终协议正文。' },
};
const groups: Array<{ label: string; icon: IconName; pages: Page[] }> = [
  { label: '当前角色', icon: 'user', pages: ['self', 'expression', 'beliefs', 'circumstances'] },
  { label: '学习成长', icon: 'sparkles', pages: ['growth', 'knowledge'] },
  { label: '经历档案', icon: 'archive', pages: ['relationships', 'history', 'origin'] },
  { label: '运行核对', icon: 'shield', pages: ['context', 'instructions'] },
];
const selectors: Partial<Record<Page, RegExp>> = {
  expression: /说话|表达|语气|口癖|小动作|相处|底线|雷点|边界/u,
  beliefs: /价值|信念|认识|认知|世界观|喜欢|讨厌|喜好|偏好/u,
  relationships: /关系|玩家|称呼|熟人|陌生人|联系人|约定/u,
};
function PersonaProjection({ persona, page }: { persona: string; page: Page }) {
  const sections = parseCharacterDocument(persona), matcher = selectors[page];
  if (!matcher) return <>
    {sections.length ? <div className="cognition-sections">{persona.slice(0, sections[0]!.start).trim() && <p className="cognition-prose">{persona.slice(0, sections[0]!.start)}</p>}{sections.map(section => <section className="cognition-card" key={section.start}><h4>{section.title}</h4><div className="cognition-prose">{persona.slice(section.headingEnd, section.end).trim() || '本节未提供正文。'}</div></section>)}</div> : <div className="cognition-prose">{persona}</div>}
  </>;
  const fields = sections.flatMap(section => matcher.test(section.title)
    ? [{ label: section.title, value: persona.slice(section.headingEnd, section.end).trim(), start: section.start }]
    : section.fields.filter(field => matcher.test(field.label)));
  return fields.some(field => field.value.trim()) ? <dl className="cognition-fields">{fields.filter(field => field.value.trim()).map(field => <div key={field.start}><dt>{field.label}</dt><dd>{field.value}</dd></div>)}</dl> : <p className="cognition-empty">当前角色正文没有单独列明这一方向。完整正文保留在“当前自我”，这里不推断未写下的设定。</p>;
}
function OriginView({ origin, companionId }: { origin: NonNullable<Assets['origin']>; companionId: string }) {
  let parsed: { name: string; description: string; persona: string } | undefined;
  try {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/u.exec(origin.content.replace(/^\uFEFF/u, ''));
    const header = match && JSON.parse(match[1]!) as Record<string, unknown>;
    if (match && header && header.schema === 'worldlinebox.companion-profile-v2' && header.companionId === companionId && typeof header.name === 'string' && typeof header.description === 'string') parsed = { name: header.name, description: header.description, persona: match[2]!.trim() };
  } catch { /* Exact original remains available; malformed data is not repaired. */ }
  return <><p className="cognition-caption">这是创建时确认的原稿，只承担起点和审计职责；当前人格请查看“当前自我”。</p>{parsed ? <><div className="cognition-origin-identity"><strong>{parsed.name}</strong><p>{parsed.description}</p></div><PersonaProjection persona={parsed.persona} page="self" /></> : <p className="cognition-empty">这份原稿未提供可解析的角色资料头，可在下方查看完整原文。</p>}<details className="cognition-source"><summary>查看原稿</summary><ContextSnapshotText text={origin.content} /></details><details className="cognition-source"><summary>封存版本</summary><code>{origin.revision}</code></details></>;
}

function GrowthHistory({ companionId, assets, api }: { companionId: string; assets?: Assets; api?: WorldlineBoxCompanionsApi }) {
  const [items, setItems] = useState(assets?.growthReleases ?? []), [next, setNext] = useState(assets?.growthReleaseContinuation?.nextId);
  const [hasMore, setHasMore] = useState(assets?.growthReleaseContinuation?.hasMore ?? false), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const lifecycle = useRef({ alive: false, sequence: 0, busy: false });
  useEffect(() => { const state = lifecycle.current; state.alive = true; return () => { state.alive = false; ++state.sequence; }; }, []);
  const more = async () => {
    const state = lifecycle.current;
    const expectedRevocationEpoch = assets?.growthReleaseContinuation?.revocationEpoch;
    if (state.busy || !hasMore || !next || expectedRevocationEpoch === undefined) return;
    state.busy = true; const epoch = ++state.sequence; setLoading(true); setError('');
    try {
      const response = await api?.workspace?.({ type: 'growth.releases.read', companionId, afterId: next, expectedRevocationEpoch });
      if (!state.alive || state.sequence !== epoch) return;
      if (!response?.growthReleasePage) throw new Error(response?.error || '更早的成长记录暂不可核实。');
      const page = companionGrowthReleasePageSchema.parse(response.growthReleasePage), known = new Set(items.map(item => item.id));
      if (page.companionId !== companionId) throw new Error('成长记录的归属或分页位置不一致，请重新核对档案。');
      if (page.revocationEpoch !== expectedRevocationEpoch) { setItems([]); setHasMore(false); setNext(undefined); throw new Error('成长记录的依据已变化，旧分页已清除，请重新核对当前档案。'); }
      if (!response.ok) throw new Error(response.error || '更早的成长记录暂不可核实。');
      if (page.hasMore && page.nextId === next || page.items.some(item => known.has(item.id))
        || new Set(page.items.map(item => item.id)).size !== page.items.length) throw new Error('成长记录的归属或分页位置不一致，请重新核对档案。');
      setItems(previous => [...previous, ...page.items]); setHasMore(page.hasMore); setNext(page.nextId);
    } catch (cause) { if (state.alive && state.sequence === epoch) setError(cause instanceof Error ? cause.message : '更早的成长记录读取失败。'); }
    finally { state.busy = false; if (state.alive && state.sequence === epoch) setLoading(false); }
  };
  return <><h4>已发布的人格变化</h4>{items.length ? <ol className="cognition-releases">{items.map(release => <li key={release.id}><h4>人格发布 · 修订 {release.revision}</h4><ContextSnapshotText text={release.content} /><details><summary>发布凭证</summary><code>{release.id}</code></details></li>)}</ol> : <p className="cognition-empty">{error ? '成长记录暂不可核实，请重新核对当前档案。' : '当前没有可展示的正式成长发布记录。日记数量不代表人格已经成长。'}</p>}
    {error && <p role="alert">{error}</p>}
    {hasMore && <div className="cognition-history-continuation"><p className="cognition-caption">还有更早的正式发布记录，按需逐页读取，不会全部加入伙伴推理上下文。</p><button type="button" className="companion-secondary-button" disabled={loading || !next || !api?.workspace} onClick={() => void more()}>{loading ? '正在核对更早记录…' : error ? '重试加载更早记录' : '加载更早的成长记录'}</button></div>}
  </>;
}

/** Displays source text; no generated personality summary and no inference from document counts. */
export function CompanionCognitionDossier({ companionId, companion, api, assets: supplied, initialPage = 'self', onOpenMemory, onOpenLearning, compactHeader = false }: {
  companionId: string; companion?: Companion; api?: WorldlineBoxCompanionsApi; assets?: Assets; initialPage?: Page; onOpenMemory?(): void; onOpenLearning?(): void; compactHeader?: boolean;
}) {
  const [page, setPage] = useState<Page>(initialPage), [loaded, setLoaded] = useState<Assets>();
  const [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const serial = useRef(0), alive = useRef(false);
  const invalidate = useCallback(() => { ++serial.current; }, []);
  const assets = supplied?.companionId === companionId ? supplied : loaded?.companionId === companionId ? loaded : undefined;
  const role = assets?.profile;
  const activeGroup = groups.find(group => group.pages.includes(page))!;
  const load = useCallback(async () => {
    const sequence = ++serial.current; setLoading(true); setError('');
    try {
      const result = await api?.workspace?.({ type: 'companion.assets.read', companionId });
      if (!alive.current || sequence !== serial.current) return;
      if (!result?.ok || result.companionAssets?.companionId !== companionId || !result.companionAssets.profile) throw new Error(result?.error || '当前认知档案暂不可核实。');
      setLoaded(result.companionAssets);
    } catch (cause) { if (alive.current && sequence === serial.current) { setLoaded(undefined); setError(cause instanceof Error ? cause.message : '档案读取失败。'); } }
    finally { if (alive.current && sequence === serial.current) setLoading(false); }
  }, [api, companionId]);
  useLayoutEffect(() => {
    alive.current = true;
    const updates = createCoalescedRefresh(load, undefined, 400);
    if (!supplied) void updates.trigger();
    const unsubscribe = !supplied ? api?.onChanged(change => {
      if (change?.kind === 'progress') return;
      invalidate(); setLoaded(undefined); setError(''); setLoading(true);
      void updates.trigger();
    }) : undefined;
    return () => { alive.current = false; invalidate(); setLoaded(undefined); updates.dispose(); unsubscribe?.(); };
  }, [supplied, api, load, invalidate]);
  return <section className="companion-cognition-dossier" aria-label="伙伴认知档案">
    <header className={'cognition-heading' + (compactHeader ? ' is-compact' : '')}>
      {!compactHeader && <span className="cognition-portrait" aria-hidden="true">{companion?.assetImages?.avatar ? <img src={companion.assetImages.avatar.url} alt="" /> : <Icon name="user" size={25} />}</span>}
      <div>{!compactHeader && <span className="cognition-eyebrow">伙伴认知档案</span>}<h3>{compactHeader ? '角色档案' : role?.name ?? companion?.name ?? '当前伙伴'}</h3>{!compactHeader && <p>{role?.description || '从当前设定了解这位伙伴，从来源与版本理解变化。'}</p>}</div>
      <span className="cognition-readonly"><Icon name="shield" size={13} />只读档案</span>
    </header>
    <div className="cognition-overview" aria-label="档案状态">
      <div><Icon name="user" size={16} /><span>当前人格<strong>{role ? '采用已发布正文' : loading ? '正在核对' : '尚未核实'}</strong></span></div>
      <div><Icon name="archive" size={16} /><span>角色起点<strong>{assets?.origin ? '创建原稿已封存' : '尚未取得封存凭证'}</strong></span></div>
      <div><Icon name="sparkles" size={16} /><span>变化依据<strong>{assets?.growthReleases?.length ? '可查看正式发布记录' : '尚无正式发布记录'}</strong></span></div>
    </div>
    <div className="cognition-horizontal-navigation"><div className="cognition-group-tabs" role="tablist" aria-label="角色档案分类">{groups.map(group => <button type="button" role="tab" key={group.label} aria-selected={activeGroup === group} onClick={() => setPage(group.pages[0]!)}><Icon name={group.icon} size={16} /><span>{group.label}</span></button>)}</div><nav className="cognition-navigation" aria-label="认知档案栏目">{activeGroup.pages.map(key => <button type="button" key={key} aria-current={page === key ? 'page' : undefined} onClick={() => setPage(key)}><Icon name={pageInfo[key].icon} size={14} /><span>{pages.find(([id]) => id === key)![1]}</span></button>)}</nav></div>
    <div className="cognition-layout">
    <div className="cognition-reading">
    <header className="cognition-page-heading"><span aria-hidden="true"><Icon name={pageInfo[page].icon} size={20} /></span><div><h4>{pages.find(([key]) => key === page)?.[1]}</h4><p>{pageInfo[page].description}</p></div></header>
    {error && <div className="cognition-error" role="alert"><Icon name="shield" size={17} /><div><strong>档案暂时无法核实</strong><p>{error}</p>{!supplied && <button type="button" onClick={() => void load()}>重新核对档案</button>}</div></div>}
    <section className="cognition-page" aria-label={pages.find(([key]) => key === page)?.[1]} aria-busy={loading}>
      {!assets ? <p className="cognition-empty">{loading ? '正在核对当前角色正文…' : '当前角色正文尚未核实，暂不展示缓存人设。'}</p> : ['self', 'expression', 'beliefs', 'relationships'].includes(page) ? role ? <>
        {page !== 'self' && <p className="cognition-caption">以下逐项展示当前角色正文中明确写下的内容，保留原来的条件和措辞。</p>}
        <PersonaProjection persona={role.persona} page={page} />
        {page === 'relationships' && <><p className="cognition-caption">角色中的关系设定不证明已经发生过共同经历；关系经历不以亲近进度或好感分数表示。</p><CompanionCurrentCircumstances companionId={companionId} api={api} relationships /></>}
        {page === 'self' && <details className="cognition-source"><summary>完整当前人格正文</summary><pre>{role.persona}</pre></details>}
      </> : <p className="cognition-empty">{loading ? '正在核对当前角色正文…' : '当前角色正文尚未核实，暂不展示缓存人设。'}</p>
        : page === 'knowledge' ? <><h4>知识与记忆分别保存</h4><p>日记记录经历，学习资料保留知识及方法，自我认识保留带来源和条件的本人认识。保存、索引、召回和实际发送是不同状态。</p>{onOpenMemory ? <button type="button" className="companion-secondary-button" onClick={onOpenMemory}>查看知识与记忆</button> : <p className="cognition-empty">请从记忆资料库查看具体记录、来源及处理状态。此处尚未取得按类型汇总的数据。</p>}</>
        : page === 'circumstances' ? <CompanionCurrentCircumstances companionId={companionId} api={api} />
        : page === 'growth' ? <div className="cognition-growth"><h4>沿着真实经历，慢慢形成自己</h4><p>下方管理来自真实交流的培养方向；日程中的长期学习计划可另行查看。目标只描述准备尝试什么；只有经过核对并正式发布的变化，才会进入当前人格。</p><button type="button" className="companion-secondary-button" onClick={onOpenLearning} disabled={!onOpenLearning}>查看学习与培养方向</button><p className="cognition-caption">当前人格保持只读。已发布变化的差异、理由与来源，可在“成长历程”中逐条核对。</p><Suspense fallback={<p className="cognition-empty">正在打开培养方向…</p>}><CompanionGrowthGoals key={companionId} companionId={companionId} api={api} /></Suspense></div>
        : page === 'history' ? <GrowthHistory key={companionId + ':' + (assets?.profileRevision ?? 'unverified') + ':' + assets?.growthReleaseContinuation?.revocationEpoch + ':' + assets?.growthReleases?.map(release => release.id + ':' + release.revision).join(',')} companionId={companionId} assets={assets} api={api} />
        : page === 'origin' ? <><h4>创建时的封存原稿</h4>{assets?.origin ? <OriginView origin={assets.origin} companionId={companionId} /> : <p className="cognition-empty">尚未取得可核实的起点版本，不能用当前角色正文冒充创建原稿。</p>}</>
        : page === 'instructions' ? <CompanionPromptAssets companionId={companionId} api={api} snapshot={assets} initiallyOpen />
        : <CompanionActualContext key={companionId} companionId={companionId} api={api} />}
    </section>
    {assets && <details className="cognition-source cognition-version-card"><summary><Icon name="shield" size={14} /><span>当前资料的来源与版本</span></summary><dl><dt>伙伴</dt><dd>{companion?.id ?? companionId}</dd><dt>角色正文版本</dt><dd><code>{assets.profileRevision}</code></dd><dt>职能指导版本</dt><dd><code>{assets.promptRevision}</code></dd></dl><p className="cognition-caption">这里展示的是当前资料。某次实际采用了什么，以“本次实际上下文”中的独立请求凭证为准。</p></details>}
    </div></div>
  </section>;
}

import { useEffect, useRef, useState } from 'react';
import type { DshTaskCapabilities, DshTaskCapabilityDetail, DshTaskCapabilityQuery } from '../../shared/dsh-task-spec';
import type { WorldlineBoxDshLauncherApi } from '../../shared/dsh-launcher';
import type { DshInstalledPlugin } from '../../shared/dsh-plugins';
import type { DshInstalledSkill } from '../../shared/dsh-marketplace';
import { useLocale } from '../i18n';
import { Icon } from '../Icons';
import { Button, Select, TextField } from '../ui';

type Entry = { kind: 'tool' | 'skill'; name: string; description: string };
/** Installed packages are source records, never evidence that a tool is callable. */
export function CompanionNativeCapabilities({ api, companion, instanceId, onCapabilities }: { api: WorldlineBoxDshLauncherApi; companion: { id: string; name: string }; instanceId: string; onCapabilities?(value: DshTaskCapabilities): void }) {
  const { locale } = useLocale(), zh = locale === 'zh-CN';
  const [tab, setTab] = useState<'callable' | 'sources'>('callable'), [category, setCategory] = useState<'all' | 'tool' | 'skill'>('all');
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0), [value, setValue] = useState<DshTaskCapabilities>(), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Entry>(), [detail, setDetail] = useState<DshTaskCapabilityDetail>(), [detailLoading, setDetailLoading] = useState(false), [detailError, setDetailError] = useState('');
  const [sourceState, setSourceState] = useState<{ plugins: DshInstalledPlugin[]; skills: DshInstalledSkill[] }>(), [sourceError, setSourceError] = useState(''), [sourceQuery, setSourceQuery] = useState(''), [sourcePage, setSourcePage] = useState(0);
  const ticket = useRef(0), detailTicket = useRef(0), sourceTicket = useRef(0);
  useEffect(() => {
    const requests = ticket, current = ++requests.current;
    const timer = setTimeout(() => {
      setLoading(true); setError('');
      void api.request({ type: 'companion.environment.capabilities', companionId: companion.id, name: companion.name,
        query: { kind: 'catalog', category, query: query.trim(), offset, limit: 30 } }).then(result => {
        if (current !== requests.current) return;
        if (!result.ok) setError(result.error);
        else if (result.taskCapabilities?.instanceId === instanceId) { setValue(result.taskCapabilities); onCapabilities?.(result.taskCapabilities); }
        else setError(zh ? '能力目录与当前执行环境不匹配，请刷新档案。' : 'The catalog does not match this environment. Refresh the archive.');
      }).catch(failure => { if (current === requests.current) setError(String(failure)); }).finally(() => { if (current === requests.current) setLoading(false); });
    }, query ? 200 : 0);
    return () => { clearTimeout(timer); requests.current++; };
  }, [api, category, companion.id, companion.name, instanceId, offset, onCapabilities, query, zh]);
  useEffect(() => {
    if (tab !== 'sources' || sourceState) return;
    const requests = sourceTicket, current = ++requests.current;
    void Promise.all([api.request({ type: 'instance.plugins', instanceId }), api.request({ type: 'skill.list', instanceId })]).then(([plugins, skills]) => {
      if (requests.current !== current) return;
      if (!plugins.ok || !skills.ok) { setSourceError(!plugins.ok ? plugins.error : !skills.ok ? skills.error : ''); return; }
      setSourceState({ plugins: plugins.installedPlugins ?? [], skills: skills.installedSkills ?? [] });
    }).catch(failure => { if (requests.current === current) setSourceError(String(failure)); });
    return () => { requests.current++; };
  }, [api, instanceId, sourceState, tab]);
  useEffect(() => () => { detailTicket.current++; }, []);
  const readDetail = async (entry: Entry, textOffset = 0) => {
    const current = ++detailTicket.current; setSelected(entry); setDetailLoading(true); setDetailError(''); setDetail(undefined);
    const query: DshTaskCapabilityQuery = entry.kind === 'skill' ? { kind: 'skill', name: entry.name, textOffset, maxChars: 4000 } : { kind: 'tool', name: entry.name };
    try { const response = await api.request({ type: 'companion.environment.capabilities', companionId: companion.id, name: companion.name, query });
      if (current !== detailTicket.current) return;
      if (!response.ok) setDetailError(response.error);
      else if (response.taskCapabilities?.instanceId === instanceId && response.taskCapabilities.detail?.name === entry.name) setDetail(response.taskCapabilities.detail);
      else setDetailError(zh ? '没有收到这项能力的原生详情。' : 'No matching native capability details were returned.');
    } catch (failure) { if (current === detailTicket.current) setDetailError(String(failure)); } finally { if (current === detailTicket.current) setDetailLoading(false); }
  };
  const entries = value?.catalog?.items ?? [], total = value?.catalog?.total ?? 0, next = value?.catalog?.nextOffset;
  const sources = sourceState ? [...sourceState.plugins.map(plugin => ({ kind: 'plugin' as const, name: plugin.name, description: plugin.description, enabled: plugin.enabled, source: plugin.sourceUrl || plugin.spec, path: plugin.installPath, version: plugin.version, error: plugin.error })),
    ...sourceState.skills.map(skill => ({ kind: 'skill' as const, name: skill.name, description: skill.description, enabled: skill.enabled, source: skill.repository || (zh ? '本地技能' : 'Local skill'), path: skill.path, version: skill.commit?.slice(0, 12), error: undefined }))]
    .filter(item => `${item.name} ${item.description} ${item.source}`.toLowerCase().includes(sourceQuery.trim().toLowerCase())) : [];
  const page = Math.min(sourcePage, Math.max(0, Math.ceil(sources.length / 30) - 1));
  return <section className="companion-native-capabilities capability-archive-catalog" aria-busy={loading}>
    <nav className="capability-archive-tabs" aria-label={zh ? '档案内容' : 'Archive sections'}><button type="button" aria-pressed={tab === 'callable'} onClick={() => setTab('callable')}><Icon name="sparkles" size={15} />{zh ? '能力目录' : 'Capabilities'}</button><button type="button" aria-pressed={tab === 'sources'} onClick={() => setTab('sources')}><Icon name="layers" size={15} />{zh ? '装载来源' : 'Sources'}</button></nav>
    {tab === 'callable' ? <>
      <header className="capability-archive-catalog-heading"><h4>{zh ? '已注册能力' : 'Registered capabilities'}</h4><span>{value?.capturedAt ? `${zh ? '读取于' : 'Read at'} ${new Date(value.capturedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}` : zh ? '原生注册表' : 'Native registry'}</span></header>
      <div className="capability-archive-filter"><TextField aria-label={zh ? '搜索可调用能力' : 'Search callable capabilities'} value={query} onChange={event => { setQuery(event.target.value); setOffset(0); }} placeholder={zh ? '查找工具或技能…' : 'Find a tool or skill…'} maxLength={200} /><Select label={zh ? '能力类型' : 'Capability type'} value={category} onValueChange={value => { setCategory(value as typeof category); setOffset(0); }} options={[{ value: 'all', label: zh ? '全部能力' : 'All capabilities' }, { value: 'tool', label: zh ? '原生工具' : 'Native tools' }, { value: 'skill', label: zh ? '技能' : 'Skills' }]} /></div>
      {value?.scope?.pending && <aside className="capability-archive-pending" role="status"><Icon name="clock" size={15} /><div><strong>{zh ? '能力配置待生效' : 'Capability updates pending'}</strong><p>{zh ? '部分执行会话仍保留原能力。实际生效情况以 DSH 原生状态为准。' : 'Some sessions retain their previous capability scope. DSH remains the source of truth.'}</p>{value.scope.reason && <details><summary>{zh ? '原生说明' : 'Native details'}</summary><p>{value.scope.reason}</p></details>}</div></aside>}
      {error && <p className="companion-capability-error" role="alert">{error}</p>}
      <div className="capability-archive-entries">{entries.map(entry => <button type="button" className="capability-archive-entry" data-callable-capability={entry.name} key={`${entry.kind}:${entry.name}`} onClick={() => void readDetail(entry)}><span className="capability-archive-entry-icon"><Icon name={entry.kind === 'tool' ? 'code' : 'file-text'} size={19} /></span><span className="capability-archive-entry-copy"><strong>{entry.name}</strong><span>{entry.description}</span><small>{entry.kind === 'tool' ? zh ? '原生工具' : 'Native tool' : zh ? '生效技能' : 'Effective skill'} · {zh ? '原生注册表' : 'Native registry'}</small></span><Icon name="chevron-right" size={15} /></button>)}</div>
      {!entries.length && !error && <p className="capability-archive-empty" role="status">{loading ? zh ? '正在读取原生能力…' : 'Reading native capabilities…' : zh ? '没有匹配的可调用能力。' : 'No matching callable capabilities.'}</p>}
      {(offset > 0 || next !== undefined) && <nav className="capability-archive-pagination" aria-label={zh ? '能力分页' : 'Capability pages'}><Button size="sm" variant="quiet" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 30))}>{zh ? '上一页' : 'Previous'}</Button><span>{Math.floor(offset / 30) + 1} / {Math.max(1, Math.ceil(total / 30))}</span><Button size="sm" variant="quiet" disabled={loading || next === undefined} onClick={() => { if (next !== undefined) setOffset(next); }}>{zh ? '下一页' : 'Next'}</Button></nav>}
      {selected && <article className="capability-archive-detail" aria-label={zh ? '能力详情' : 'Capability details'} aria-busy={detailLoading}><header><div><span className="capability-archive-eyebrow">NATIVE CAPABILITY</span><h4>{selected.name}</h4></div><Button size="sm" variant="quiet" aria-label={zh ? '收起详情' : 'Close details'} iconName="close" onClick={() => { detailTicket.current++; setSelected(undefined); }} /></header><p>{selected.description}</p>
        {detailError && <p className="companion-capability-error" role="alert">{detailError}</p>}{detailLoading && <p role="status">{zh ? '正在读取原生详情…' : 'Reading native details…'}</p>}
        {detail && <><span className="capability-archive-detail-status">{zh ? detail.available ? '原生状态：可用' : '原生状态：当前不可用' : detail.available ? 'Native status: available' : 'Native status: unavailable'}</span><dl><div><dt>{zh ? '登记来源' : 'Registry source'}</dt><dd>DSH · native-agent-scope</dd></div>{detail.skill?.provider && <div><dt>{zh ? '提供方' : 'Provider'}</dt><dd>{detail.skill.provider}</dd></div>}{detail.skill?.source && <div><dt>{zh ? '资料来源' : 'Source'}</dt><dd>{detail.skill.source}</dd></div>}{detail.skill?.path && <div><dt>{zh ? '原生路径' : 'Native path'}</dt><dd>{detail.skill.path}</dd></div>}</dl>
          {detail.skill && <><pre>{detail.skill.content}</pre><nav className="capability-archive-pagination"><span>{detail.skill.textOffset + 1}–{Math.min(detail.skill.totalChars, detail.skill.textOffset + detail.skill.content.length)} / {detail.skill.totalChars}</span><Button size="sm" variant="quiet" disabled={detailLoading || detail.skill.nextTextOffset === undefined} onClick={() => { if (detail.skill?.nextTextOffset !== undefined) void readDetail(selected, detail.skill.nextTextOffset); }}>{zh ? '继续读取技能' : 'Continue reading'}</Button></nav></>}
          {detail.tool !== undefined && <details><summary>{zh ? '工具参数与原生定义' : 'Native tool definition'}</summary><pre>{JSON.stringify(detail.tool, null, 2)?.slice(0, 16000)}</pre></details>}</>}
      </article>}
    </> : <><header className="capability-archive-catalog-heading"><h4>{zh ? '原生装载记录' : 'Native source records'}</h4><span>{zh ? '仅供查阅' : 'Read only'}</span></header><p className="capability-archive-source-note">{zh ? '启用或安装的插件可能只提供皮肤、桌宠或后台服务。装载记录不代表新增了可调用能力；请以“能力目录”为准。' : 'Installed or enabled plugins may provide only themes, pets or background services. These records are not evidence of callable capabilities.'}</p>
      <TextField aria-label={zh ? '搜索装载来源' : 'Search sources'} value={sourceQuery} onChange={event => { setSourceQuery(event.target.value); setSourcePage(0); }} placeholder={zh ? '搜索插件、技能或来源…' : 'Find a plugin, skill or source…'} maxLength={200} />
      {sourceError && <p className="companion-capability-error" role="alert">{sourceError}</p>}
      <div className="capability-archive-sources">{sources.slice(page * 30, page * 30 + 30).map(item => <article key={`${item.kind}:${item.name}`} data-capability-source={item.name}><Icon name={item.kind === 'plugin' ? 'box' : 'file-text'} size={18} /><div><strong>{item.name}</strong><p>{item.description}</p><span>{item.kind === 'plugin' ? zh ? '插件装载记录' : 'Plugin source record' : zh ? '技能文件记录' : 'Skill file record'} · {zh ? item.enabled ? 'DSH 中启用' : 'DSH 中停用' : item.enabled ? 'Enabled in DSH' : 'Disabled in DSH'}{item.version ? ` · ${item.version}` : ''}</span><code>{item.source}</code>{item.path && <details><summary>{zh ? '原生文件位置' : 'Native file location'}</summary><code>{item.path}</code></details>}{item.error && <p className="companion-capability-error">{item.error}</p>}</div></article>)}</div>
      {!sources.length && !sourceError && <p className="capability-archive-empty" role="status">{!sourceState ? zh ? '正在读取装载记录…' : 'Reading source records…' : zh ? '暂无匹配的装载记录。' : 'No matching source records.'}</p>}
      {sources.length > 30 && <nav className="capability-archive-pagination" aria-label={zh ? '装载记录分页' : 'Source pages'}><Button size="sm" variant="quiet" disabled={page === 0} onClick={() => setSourcePage(page - 1)}>{zh ? '上一页' : 'Previous'}</Button><span>{page + 1} / {Math.ceil(sources.length / 30)}</span><Button size="sm" variant="quiet" disabled={(page + 1) * 30 >= sources.length} onClick={() => setSourcePage(page + 1)}>{zh ? '下一页' : 'Next'}</Button></nav>}
    </>}
  </section>;
}

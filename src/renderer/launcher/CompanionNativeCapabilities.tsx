import { useEffect, useRef, useState } from 'react';
import type { DshTaskCapabilities } from '../../shared/dsh-task-spec';
import type { WorldlineBoxDshLauncherApi } from '../../shared/dsh-launcher';
import { useLocale } from '../i18n';
import { Button, Select, TextField } from '../ui';

/** The native registry decides what is callable; installed package names do not. */
export function CompanionNativeCapabilities({ api, companion, onApplyUpdate, applying = false }: { api: WorldlineBoxDshLauncherApi; companion: { id: string; name: string }; onApplyUpdate?(): void; applying?: boolean }) {
  const { locale } = useLocale(), zh = locale === 'zh-CN';
  const [category, setCategory] = useState<'all' | 'tool' | 'skill'>('all'), [query, setQuery] = useState(''), [offset, setOffset] = useState(0);
  const [value, setValue] = useState<DshTaskCapabilities>(), [error, setError] = useState(''), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0);
  const ticket = useRef(0);
  useEffect(() => {
    const requests = ticket, current = ++requests.current;
    const timer = setTimeout(() => {
      setLoading(true); setError('');
      void api.request({ type: 'companion.environment.capabilities', companionId: companion.id, name: companion.name,
        query: { kind: 'catalog', category, query: query.trim(), offset, limit: 30 } }).then(result => {
        if (current !== requests.current) return;
        if (!result.ok) setError(result.error);
        else if (result.taskCapabilities) setValue(result.taskCapabilities);
        else setError(zh ? '执行器没有返回能力目录。' : 'The executor returned no capability catalog.');
      }).catch(error => { if (current === requests.current) setError(String(error)); }).finally(() => { if (current === requests.current) setLoading(false); });
    }, query ? 250 : 0);
    return () => { clearTimeout(timer); requests.current++; };
  }, [api, category, companion.id, companion.name, offset, query, revision, zh]);
  const entries = value?.catalog?.items ?? [], total = value?.catalog?.total ?? 0, next = value?.catalog?.nextOffset;
  return <section className="launcher-card companion-native-capabilities" aria-busy={loading}>
    <div className="launcher-card-heading"><div><h2>{zh ? '原生可调用能力' : 'Native callable capabilities'}</h2><p>{zh ? '这里列出执行器实际注册的工具与技能。皮肤、桌宠和服务类插件不一定提供模型可调用能力。' : 'Tools and skills registered by the executor. Themes, pets and service plugins may not expose callable capabilities.'}</p></div><Button size="sm" iconName="refresh" variant="quiet" onClick={() => { setLoading(true); setRevision(value => value + 1); }}>{zh ? '刷新' : 'Refresh'}</Button></div>
    <div className="companion-capability-catalog-filter"><TextField aria-label={zh ? '搜索可调用能力' : 'Search callable capabilities'} value={query} onChange={event => { setLoading(true); setQuery(event.target.value); setOffset(0); }} placeholder={zh ? '搜索工具或技能' : 'Search tools or skills'} maxLength={200} />
      <Select label={zh ? '能力类型' : 'Capability type'} value={category} onValueChange={value => { setLoading(true); setCategory(value as typeof category); setOffset(0); }} options={[{ value: 'all', label: zh ? '工具与技能' : 'Tools and skills' }, { value: 'tool', label: zh ? '工具' : 'Tools' }, { value: 'skill', label: zh ? '技能' : 'Skills' }]} /></div>
    {value && <p className="launcher-help">{zh ? `原生工具 ${value.toolsTotal ?? value.effective?.toolCount ?? 0} · 原生技能 ${value.skillsTotal ?? value.effective?.skillCount ?? 0}` : `${value.toolsTotal ?? value.effective?.toolCount ?? 0} native tools · ${value.skillsTotal ?? value.effective?.skillCount ?? 0} native skills`}</p>}
    {value?.scope?.pending && <div className="companion-capability-notice" role="status"><p>{zh ? '已有任务保留原能力，新任务使用新配置。' : 'Existing tasks retain their capabilities. New tasks use the new configuration.'}</p>
      {onApplyUpdate && <><p>{zh ? '应用更新会在执行器空闲时重连原生环境，任务记录保留。' : 'Applying updates reconnects the native environment when idle, preserving task records.'}</p><Button size="sm" variant="quiet" disabled={applying} onClick={onApplyUpdate}>{zh ? '应用待更新能力' : 'Apply pending capabilities'}</Button></>}
      {value.scope.reason && <details><summary>{zh ? '查看原生说明' : 'Native details'}</summary><p>{value.scope.reason}</p></details>}</div>}
    {error && <p role="alert" className="companion-capability-error">{error}</p>}
    {entries.map(entry => <article className="launcher-installed-skill" data-callable-capability={entry.name} key={`${entry.kind}:${entry.name}`}><div><strong>{entry.name}</strong><p>{entry.description}</p><span>{entry.kind === 'tool' ? zh ? '原生工具' : 'Native tool' : zh ? '原生技能' : 'Native skill'}</span></div></article>)}
    {!entries.length && !error && <p className="launcher-help" role="status">{loading ? zh ? '正在读取原生能力…' : 'Loading native capabilities…' : zh ? '没有匹配的可调用能力。' : 'No matching callable capabilities.'}</p>}
    {(offset > 0 || next !== undefined) && <nav className="launcher-catalog-pagination" aria-label={zh ? '可调用能力分页' : 'Callable capability pages'}><Button size="sm" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 30))}>{zh ? '上一页' : 'Previous'}</Button><span>{Math.floor(offset / 30) + 1} / {Math.max(1, Math.ceil(total / 30))}</span><Button size="sm" disabled={loading || next === undefined} onClick={() => { if (next !== undefined) setOffset(next); }}>{zh ? '下一页' : 'Next'}</Button></nav>}
  </section>;
}

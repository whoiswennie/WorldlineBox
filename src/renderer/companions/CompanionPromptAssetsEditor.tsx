import { useCallback, useEffect, useRef, useState } from 'react';
import type { WorldlineBoxCompanionsApi } from '../../shared/companions';
import type { CompanionWorkspaceResponse } from '../../shared/companion-workspace';
import { companionPurposeLabel } from './companion-purpose-labels';
import { createCoalescedRefresh } from './coalesced-refresh';
import './companion-prompt-assets.css';

type Snapshot = NonNullable<CompanionWorkspaceResponse['companionAssets']>;
const purposeLabels: Record<string, string> = {
  common: '共同原则', chat: '交流', autonomous: '自主活动', activity: '活动与任务',
  proactive: '主动联系', world: '世界行动', social: '伙伴交往', reflection: '经历反思',
  diary: '经历记录', memory_capture: '经历记录', memory_consolidation: '记忆整合',
  memory_reflection: '经历反思', memory_dream: '梦境联想', memory_recall: '记忆回忆',
  vcp_focus_guidance: '记忆聚焦指导', vcp_focus: '记忆聚焦', host_policy: '运行策略',
};
function label(file: Snapshot['prompts'][number]) {
  const labels = [...new Set(file.purposes.map(purpose => purposeLabels[purpose] ?? companionPurposeLabel(purpose)))];
  return (labels.length > 3 ? labels.slice(0, 3).join(' · ') + '等职能指导' : labels.join(' · ')) || '其他职能指导';
}

/** Exact, read-only role instructions. This is a current asset view, never a request snapshot. */
export function CompanionPromptAssets({ companionId, api, snapshot: supplied, initiallyOpen = false }: {
  companionId: string; api?: Pick<WorldlineBoxCompanionsApi, 'workspace'>; snapshot?: Snapshot; initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen), [loaded, setLoaded] = useState<Snapshot>();
  const [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const lifecycle = useRef({ serial: 0, alive: false });
  const snapshot = supplied?.companionId === companionId ? supplied : loaded?.companionId === companionId ? loaded : undefined;
  const refresh = useCallback(async () => {
    const state = lifecycle.current, sequence = ++state.serial; setLoading(true); setError('');
    try {
      const response = await api?.workspace?.({ type: 'companion.assets.read', companionId });
      if (!state.alive || sequence !== state.serial) return;
      if (!response?.ok || response.companionAssets?.companionId !== companionId) throw new Error(response?.error || '当前职能指导暂不可读取。');
      setLoaded(response.companionAssets);
    } catch (cause) { if (state.alive && sequence === state.serial) { setLoaded(undefined); setError(cause instanceof Error ? cause.message : '读取失败。'); } }
    finally { if (state.alive && sequence === state.serial) setLoading(false); }
  }, [api, companionId]);
  useEffect(() => {
    const state = lifecycle.current, updates = createCoalescedRefresh(refresh);
    state.alive = true;
    if (open && !supplied) void updates.trigger();
    return () => { state.alive = false; ++state.serial; updates.dispose(); };
  }, [open, supplied, refresh]);
  return <section className="companion-prompt-assets"><details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>角色相关职能指导 · 只读</summary>
    {open && <div className="companion-prompt-assets-body">
      <p className="companions-subtle">下列是当前资料中按用途配置的完整指导，运行时按任务选择。它们不代表某次模型实际收到的全部上下文；实际采用情况请查看“本次实际上下文”。</p>
      {snapshot?.memoryPolicyError && <p role="alert">{snapshot.memoryPolicyError}</p>}
      {error && <p role="alert">{error}</p>}
      {loading ? <p role="status">正在核对当前职能指导…</p> : snapshot ? <>
        {!snapshot.prompts.length && <p>当前没有可展示的职能指导。</p>}
        {snapshot.prompts.filter(file => !file.purposes.includes('host_policy')).map(file => <details className="companion-instruction" key={file.path}>
          <summary>{label(file)}</summary><pre className="companion-instruction-text">{file.content}</pre>
          <details className="companion-instruction-source"><summary>来源与版本</summary><dl><dt>来源</dt><dd>{file.path}</dd><dt>版本</dt><dd><code>{file.revision}</code></dd><dt>用途标识</dt><dd>{file.purposes.join('、') || '未提供'}</dd></dl></details>
        </details>)}
        {snapshot.prompts.some(file => file.purposes.includes('host_policy')) && <details className="companion-instruction"><summary>记忆运行规则（不作为角色正文）</summary><p>这些规则安排记录和维护工作，不作为提示词发送给模型。</p>{snapshot.prompts.filter(file => file.purposes.includes('host_policy')).map(file => <div key={file.path}><pre className="companion-instruction-text">{file.content}</pre><small>来源 {file.path} · 版本 <code>{file.revision}</code></small></div>)}</details>}
      </> : !error && <p>尚未读取当前职能指导。</p>}
      {!supplied && <button type="button" className="companion-secondary-button" disabled={loading} onClick={() => void refresh()}>重新核对指导</button>}
    </div>}
  </details></section>;
}

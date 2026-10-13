import { useState } from 'react';
import { DSH_EXECUTION_ACCESS_OPTIONS } from '../../shared/dsh-access';
import type { DshLauncherState } from '../../shared/dsh-launcher';
import type { LauncherRunRequest } from './DshLauncher';

export function LauncherTaskAccess({ state, run, disabled }: { state: DshLauncherState; run: LauncherRunRequest; disabled: boolean }) {
  const [saving, setSaving] = useState(false);
  const mode = state.taskAccess?.mode ?? 'danger-full-access';
  return <section className="launcher-page"><div className="launcher-page-heading"><div><h1>执行权限</h1><p className="launcher-help">所有伙伴共用这份 DSH 执行策略。任务启动时固定权限，已经运行的任务保留原设置。</p></div></div>
    <div className="launcher-card" style={{ maxWidth: 850, padding: 24 }}><fieldset style={{ border: 0, margin: 0, padding: 0 }} disabled={disabled || saving}>
      <legend style={{ fontWeight: 600, marginBottom: 16 }}>伙伴的 DSH CLI 访问范围</legend>
      {DSH_EXECUTION_ACCESS_OPTIONS.map(option => <label key={option.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '16px 14px', marginBottom: 8,
        border: `1px solid ${mode === option.value ? 'var(--ui-border-focus)' : 'var(--ui-border-subtle)'}`, borderRadius: 12,
        background: mode === option.value ? 'var(--ui-surface-selected)' : 'var(--ui-surface-canvas)', cursor: saving ? 'wait' : 'pointer' }}>
        <input type="radio" name="dsh-task-access" value={option.value} checked={mode === option.value} onChange={() => {
          setSaving(true); void run({ type: 'task.access.save', mode: option.value }).finally(() => setSaving(false));
        }} style={{ marginTop: 3 }} /><span><strong style={{ display: 'block', marginBottom: 5 }}>{option.label}{option.value === 'danger-full-access' ? ' · 默认' : ''}</strong>
          <span className="launcher-help">{option.description}</span></span>
      </label>)}
    </fieldset><p className="launcher-help" style={{ marginTop: 16 }}>主脑负责理解、聊天和委托，文件与终端操作由 DSH 的原生工具执行。受限模式下，超出范围的操作会被执行器拒绝。</p></div>
  </section>;
}

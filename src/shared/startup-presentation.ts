/** Shared startup copy; counts represent completed stages, never estimated time. */
export const STARTUP_PHASES = [
  { id: 'environment', label: '读取启动设置' },
  { id: 'services', label: '注册服务入口' },
  { id: 'storage', label: '准备数据入口' },
  { id: 'interface', label: '打开首页' },
] as const;
export type StartupPhase = typeof STARTUP_PHASES[number]['id'];
export function escapeStartupText(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
export function startupMarkup(logo: string, title = '正在打开世界线盒子', detail = '连接本地数据与界面资源', compact = false): string {
  return `<section class="startup-screen${compact ? ' is-compact' : ''}" aria-label="启动进度" aria-busy="true"><div class="startup-card"><div class="startup-brand"><div class="startup-logo-wrap"><img class="startup-logo" src="${escapeStartupText(logo)}" alt="WorldlineBox" draggable="false"></div><div class="startup-brand-copy"><span class="startup-wordmark">WorldlineBox</span><span class="startup-tagline">世界线盒子</span></div></div><div class="startup-heading"><span class="startup-activity" aria-hidden="true"></span><h1 data-startup-title>${escapeStartupText(title)}</h1></div><p class="startup-description" data-startup-detail>${escapeStartupText(detail)}</p><div class="startup-track" aria-hidden="true"><span></span></div><div class="startup-meta"><span data-startup-stage>正在初始化</span><span data-startup-elapsed>0.0 秒</span></div><ol class="startup-steps" data-startup-steps>${STARTUP_PHASES.map((phase, index) => `<li data-phase="${phase.id}"${index === 0 ? ' aria-current="step"' : ''}><i aria-hidden="true"></i>${phase.label}</li>`).join('')}</ol><p class="startup-hint" data-startup-hint>进度随实际完成的步骤更新</p></div></section>`;
}

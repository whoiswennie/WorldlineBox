import type { CompanionAction } from '../../shared/companions';
import { companionDshPendingApproval } from '../../shared/companion-dsh-receipt';

export function companionCapabilityTitle(action: CompanionAction): string {
  const name = action.capability?.name;
  if (!name) return action.title;
  if (name === 'observe') return '看看你正在忙什么';
  const labels: Record<string, string> = { research: '查阅公开资料', think: '深入想一想', agenda_files: '读取与整理文件', memory: '回忆与整理记忆', world: '在自己的世界里活动', agenda: '安排自己的日程', state: '了解当前状态', routine: '调整日常作息' };
  return labels[name] || (name.startsWith('memory.') ? '回忆与整理记忆' : action.title);
}

/** Presentation only. The original diagnostic remains in action.error/events. */
export function companionCapabilityDiagnostic(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (Array.isArray(record.argumentIssues) || typeof record.error === 'string' && /argumentIssues|参数无效/u.test(record.error)) return '这次操作未能开始，伙伴需要先补全调用参数。';
      const readable = ['error', 'summary', 'text', 'reason', 'message'].flatMap(key => typeof record[key] === 'string' && record[key].trim() ? [record[key] as string] : [])[0];
      if (readable) return readable;
      if (record.ok === false || record.outcome === 'failed') return '这次操作没有完成，可以展开过程查看原因。';
      return '本次调用已返回，展开过程可查看具体结果。';
    }
  } catch { /* Ordinary human-readable stages are already suitable. */ }
  return text;
}

export function companionCapabilityFeedback(action: CompanionAction): string | undefined {
  if (companionDshPendingApproval(action)) return '正在等待你在 DSH 中确认权限。';
  const text = action.status === 'failed' ? action.error || action.stage || action.result : action.stage || action.error || action.result;
  return text ? companionCapabilityDiagnostic(text) : undefined;
}
